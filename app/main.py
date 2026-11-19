import json
import math
import os
import random
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from . import puzzles

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = os.environ.get("WORDLINK_DB", str(ROOT / "wordlink.db"))
IST = timezone(timedelta(hours=5, minutes=30))
LETTER_WAIT, WORD_WAIT, HISTORY_LIMIT, CHAIN = 10, 20, 10, puzzles.CHAIN_LEN

def now() -> float:
  return time.time()
def today(ts: float) -> str:
  return datetime.fromtimestamp(ts, IST).date().isoformat()

SCHEMA = """
CREATE TABLE IF NOT EXISTS daily_puzzles(day TEXT PRIMARY KEY, words TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS games(
  id TEXT PRIMARY KEY, player_id TEXT NOT NULL, mode TEXT NOT NULL, day TEXT,
  words TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 1, fixed INTEGER NOT NULL DEFAULT 1,
  started_at REAL, row_started_at REAL, last_hint_at REAL, finished_at REAL,
  hints_used INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_daily ON games(player_id, day) WHERE mode='daily';
CREATE INDEX IF NOT EXISTS games_player ON games(player_id, mode, created_at);
CREATE TABLE IF NOT EXISTS history(
  id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL, game_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL, words TEXT NOT NULL, finished_at REAL NOT NULL,
  elapsed_ms INTEGER NOT NULL, hints_used INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS history_player ON history(player_id, finished_at DESC);
"""

def init_db():
  con = sqlite3.connect(DB_PATH)
  con.execute("PRAGMA journal_mode=WAL")
  con.executescript(SCHEMA)
  con.close()

@contextmanager
def tx():
  con = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
  con.row_factory = sqlite3.Row
  try:
    con.execute("BEGIN IMMEDIATE")
    yield con
    con.execute("COMMIT")
  except BaseException:
    if con.in_transaction:
      con.execute("ROLLBACK")
    raise
  finally:
    con.close()

init_db()
app = FastAPI(title="Wordlink")

def player(x_player_id: str = Header(...)) -> str:
  if not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", x_player_id):
    raise HTTPException(400, "Bad player id")
  return x_player_id

#game helpers

def fetch(con, gid, pid=None):
  g = con.execute("SELECT * FROM games WHERE id=?", (gid,)).fetchone()
  if not g or (pid and g["player_id"] != pid):
    raise HTTPException(404, "Game not found")
  return g

def daily_words(con, day):
  row = con.execute("SELECT words FROM daily_puzzles WHERE day=?", (day,)).fetchone()
  if row:
    return json.loads(row["words"])
  words = puzzles.make_chain(random.Random("wordlink-daily-" + day))
  con.execute("INSERT INTO daily_puzzles VALUES(?,?)", (day, json.dumps(words)))
  return words

def create_game(con, pid, mode, words, ts, day=None):
  gid = uuid.uuid4().hex
  con.execute(
    "INSERT INTO games(id,player_id,mode,day,words,created_at) VALUES(?,?,?,?,?,?)",
    (gid, pid, mode, day, json.dumps(words), ts),
    )
  return fetch(con, gid)


def latest_free(con, pid):
  return con.execute(
      "SELECT * FROM games WHERE player_id=? AND mode='free' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      (pid,),
    ).fetchone()


def new_free(con, pid, ts):
  prev = latest_free(con, pid)
  avoid = json.loads(prev["words"]) if prev else None
  return create_game(con, pid, "free", puzzles.make_chain(random.Random(), avoid=avoid), ts)


def current_game(con, pid, mode, ts):
  if mode == "daily":
    day = today(ts)
    g = con.execute(
       "SELECT * FROM games WHERE player_id=? AND mode='daily' AND day=?", (pid, day)
    ).fetchone()
    return g or create_game(con, pid, "daily", daily_words(con, day), ts, day)
  return latest_free(con, pid) or new_free(con, pid, ts)


def waits(g, ts):
  row = g["row_started_at"]
  letter_at = row + LETTER_WAIT
  if g["last_hint_at"] is not None:
    letter_at = max(letter_at, g["last_hint_at"] + LETTER_WAIT)
  return (max(0, math.ceil((letter_at - ts) * 1000)), max(0, math.ceil((row + WORD_WAIT - ts) * 1000)))


def view(g, ts):
  words = json.loads(g["words"])
  done = g["finished_at"] is not None
  started = g["started_at"] is not None
  end = g["finished_at"] if done else ts
  v = {
      "id": g["id"], "mode": g["mode"], "day": g["day"], "today": today(ts),
      "status": "done" if done else "active", "started": started,
      "solved": words if done else words[: g["idx"]],
      "elapsed_ms": int((end - g["started_at"]) * 1000) if started else 0,
      "hints_used": g["hints_used"],
    }
  if not done:
    w = words[g["idx"]]
    letter_ms, word_ms = waits(g, ts) if started else (LETTER_WAIT * 1000, WORD_WAIT * 1000)
    v["current"] = {"index": g["idx"], "length": len(w), "fixed": w[: g["fixed"]]}
    v["hints"] = {"running": started, "letter_ms": letter_ms, "word_ms": word_ms}
  return v


def start_timer(con, g, ts):
  if g["started_at"] is None and g["finished_at"] is None:
    con.execute("UPDATE games SET started_at=?, row_started_at=? WHERE id=?", (ts, ts, g["id"]))
    return fetch(con, g["id"])
  return g


def advance(con, g, ts):
  words = json.loads(g["words"])
  idx = g["idx"] + 1
  if idx < CHAIN:
    con.execute(
      "UPDATE games SET idx=?, fixed=1, row_started_at=?, last_hint_at=NULL WHERE id=?",
      (idx, ts, g["id"]),
  )
    return fetch(con, g["id"])
  con.execute("UPDATE games SET idx=?, finished_at=? WHERE id=?", (CHAIN, ts, g["id"]))
  g = fetch(con, g["id"])
  pid = g["player_id"]
  con.execute(
    "INSERT OR IGNORE INTO history(player_id,game_id,mode,words,finished_at,elapsed_ms,hints_used)"
    " VALUES(?,?,?,?,?,?,?)",
      (pid, g["id"], g["mode"], json.dumps(words), ts, int((ts - g["started_at"]) * 1000), g["hints_used"]),
    )
  con.execute(  # games/daily results are untouched
      "DELETE FROM history WHERE player_id=? AND id NOT IN "
      "(SELECT id FROM history WHERE player_id=? ORDER BY finished_at DESC, id DESC LIMIT ?)",
      (pid, pid, HISTORY_LIMIT),
  )
  con.execute(  # old finished practice boards no longer needed
    "DELETE FROM games WHERE player_id=? AND mode='free' AND finished_at IS NOT NULL AND id!=? "
    "AND id NOT IN (SELECT game_id FROM history WHERE player_id=?)",
    (pid, g["id"], pid),
  )
  return g


# 2. routes

class Guess(BaseModel):
  guess: str
class Hint(BaseModel):
  kind: Literal["letter", "word"]

@app.get("/api/state")
def state(mode: Literal["daily", "free"], pid: str = Depends(player)):
  ts = now()
  with tx() as con:
    return {"game": view(current_game(con, pid, mode, ts), ts)}

@app.post("/api/free/new")
def free_new(replace_id: str | None = None, pid: str = Depends(player)):
  ts = now()
  with tx() as con:
    game = latest_free(con, pid)
    if replace_id is None:
      if game is None or game["finished_at"] is not None:
          game = new_free(con, pid, ts)
    elif game is None:
      raise HTTPException(404, "Free play game not found")
    elif game["id"] == replace_id and game["finished_at"] is None:
      new_game = new_free(con, pid, ts)
      con.execute("DELETE FROM games WHERE id = ?", (replace_id,))
      game = new_game
    return {"game": view(game, ts)}

@app.post("/api/games/{gid}/start")
def start(gid: str, pid: str = Depends(player)):
  ts = now()
  with tx() as con:
    g = start_timer(con, fetch(con, gid, pid), ts)
    return {"game": view(g, ts)}

@app.post("/api/games/{gid}/guess")
def guess(gid: str, body: Guess, pid: str = Depends(player)):
  ts = now()
  with tx() as con:
    g = fetch(con, gid, pid)
    if g["finished_at"] is not None:
      return {"game": view(g, ts), "correct": None}
    clean = re.sub(r"[^A-Za-z]", "", body.guess).upper()
    if not clean:
      raise HTTPException(400, "Empty guess")
    g = start_timer(con, g, ts)  # typing a wrong guess still starts the clock
    word = json.loads(g["words"])[g["idx"]]
    if len(clean) == len(word) - g["fixed"]:  # only the missing letters were sent
      clean = word[: g["fixed"]] + clean
    ok = clean == word
    if ok:
      g = advance(con, g, ts)
    return {"game": view(g, ts), "correct": ok}


@app.post("/api/games/{gid}/hint")
def hint(gid: str, body: Hint, pid: str = Depends(player)):
  ts = now()
  with tx() as con:
    g = fetch(con, gid, pid)
    if g["finished_at"] is not None or g["started_at"] is None:
      return {"game": view(g, ts), "ok": False}
    letter_ms, word_ms = waits(g, ts)
    if (letter_ms if body.kind == "letter" else word_ms) > 0:
      return {"game": view(g, ts), "ok": False}
    word = json.loads(g["words"])[g["idx"]]
    if body.kind == "word":
      con.execute("UPDATE games SET hints_used=hints_used+1 WHERE id=?", (gid,))
      g = advance(con, fetch(con, gid), ts)
    else:
      con.execute(
          "UPDATE games SET fixed=fixed+1, last_hint_at=?, hints_used=hints_used+1 WHERE id=?", (ts, gid)
            )
      g = fetch(con, gid)
      if g["fixed"] >= len(word):  # the hint filled the last slot
        g = advance(con, g, ts)
    return {"game": view(g, ts), "ok": True}

@app.get("/api/history")
def history(pid: str = Depends(player)):
  with tx() as con:
    rows = con.execute(
      "SELECT * FROM history WHERE player_id=? ORDER BY finished_at DESC, id DESC LIMIT ?",
        (pid, HISTORY_LIMIT),
      ).fetchall()
  return {"history": [
      {"words": json.loads(r["words"]), "mode": r["mode"], "elapsed_ms": r["elapsed_ms"],
       "hints_used": r["hints_used"],
       "finished_at": datetime.fromtimestamp(r["finished_at"], timezone.utc).isoformat()}
      for r in rows
  ]}

@app.get("/")
def index():
  return FileResponse(ROOT / "static" / "index.html", headers={"Cache-Control": "no-cache"})

app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")