"""Run with:  python -m pytest -q   (needs: pip install pytest httpx)"""
import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import main

IST = timezone(timedelta(hours=5, minutes=30))
P1, P2 = "player-0001", "player-0002"


class Clock:
    def __init__(self, t): self.t = t
    def __call__(self): return self.t
    def advance(self, s): self.t += s


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", str(tmp_path / "t.db"))
    main.init_db()
    clock = Clock(datetime(2026, 11, 19, 10, 0, tzinfo=IST).timestamp())
    monkeypatch.setattr(main, "now", clock)
    return TestClient(main.app), clock


def call(c, method, path, pid=P1, **kw):
    r = c.request(method, "/api" + path, headers={"X-Player-Id": pid}, **kw)
    assert r.status_code == 200, r.text
    return r.json()


def state(c, mode="daily", pid=P1): return call(c, "GET", f"/state?mode={mode}", pid)["game"]
def guess(c, g, word, pid=P1): return call(c, "POST", f"/games/{g['id']}/guess", pid, json={"guess": word})
def hint(c, g, kind, pid=P1): return call(c, "POST", f"/games/{g['id']}/hint", pid, json={"kind": kind})


def words_of(game_id):
    con = sqlite3.connect(main.DB_PATH)
    w = json.loads(con.execute("SELECT words FROM games WHERE id=?", (game_id,)).fetchone()[0])
    con.close()
    return w


def solve_all(c, clock, g, pid=P1):
    w = words_of(g["id"])
    for word in w[1:]:
        clock.advance(2)
        g = guess(c, g, word, pid)["game"]
    return g


def test_daily_same_for_everyone_and_changes_at_ist_midnight(env):
    c, clock = env
    a, b = state(c, pid=P1), state(c, pid=P2)
    assert words_of(a["id"]) == words_of(b["id"])
    clock.t = datetime(2026, 11, 19, 23, 59, 59, tzinfo=IST).timestamp()
    assert state(c)["id"] == a["id"] and state(c)["day"] == "2026-11-19"
    clock.advance(1)  # 00:00:00 on the 20th in Kolkata (still the 19th in UTC afternoon)
    nxt = state(c)
    assert nxt["day"] == "2026-11-20" and nxt["id"] != a["id"]
    assert state(c, pid=P2)["day"] == "2026-11-20"


def test_timer_only_starts_on_typing_even_if_wrong(env):
    c, clock = env
    g = state(c)
    clock.advance(500)
    g = state(c)
    assert not g["started"] and g["elapsed_ms"] == 0
    assert g["current"]["fixed"] == words_of(g["id"])[1][0] and "words" not in g
    r = guess(c, g, "ZZZ" if g["current"]["length"] == 3 else "Z" * g["current"]["length"])
    assert r["correct"] is False and r["game"]["started"]
    clock.advance(40)
    assert state(c)["elapsed_ms"] == 40000  # includes time "away"; start stored once


def test_hint_timing_rules(env):
    c, clock = env
    g = state(c)
    assert hint(c, g, "letter")["ok"] is False  # locked before the clock starts
    call(c, "POST", f"/games/{g['id']}/start")
    clock.advance(10)
    assert hint(c, g, "letter")["ok"] is False
    clock.advance(5)
    r = hint(c, g, "letter")
    assert r["ok"] and len(r["game"]["current"]["fixed"]) == 2
    word_ms = r["game"]["hints"]["word_ms"]
    assert word_ms == 45000  # letter hint did NOT restart the 60s countdown
    assert r["game"]["hints"]["letter_ms"] == 15000  # another 15s needed
    assert hint(c, g, "word")["ok"] is False
    clock.advance(15)
    assert hint(c, g, "letter")["ok"] is True or g["current"]["length"] <= 3
    clock.advance(60)
    assert hint(c, g, "word")["ok"] is True


def test_letter_hint_filling_last_slot_advances_and_new_row_restarts_clocks(env):
    c, clock = env
    g = state(c)
    call(c, "POST", f"/games/{g['id']}/start")
    idx = g["current"]["index"]
    while g["current"]["index"] == idx:
        clock.advance(15)
        g = hint(c, g, "letter")["game"]
    assert g["current"]["index"] == idx + 1 and g["hints_used"] >= 1
    assert g["hints"]["letter_ms"] == 15000 and g["hints"]["word_ms"] == 60000


def test_hint_refresh_preserves_countdown(env):
    c, clock = env
    g = state(c)
    call(c, "POST", f"/games/{g['id']}/start")
    clock.advance(20)
    again = state(c)
    assert again["hints"]["letter_ms"] == 0 and again["hints"]["word_ms"] == 40000


def test_full_round_history_and_no_duplicate_on_refresh(env):
    c, clock = env
    g = state(c)
    guess(c, g, "WRONGANSWER")  # wrong first guess starts the clock
    g = solve_all(c, clock, g)
    assert g["status"] == "done" and len(g["solved"]) == 6
    for _ in range(3):
        assert state(c)["status"] == "done"
    h = call(c, "GET", "/history")["history"]
    assert len(h) == 1 and h[0]["words"] == g["solved"] and h[0]["mode"] == "daily"
    assert h[0]["elapsed_ms"] == g["elapsed_ms"] > 0
    t = g["elapsed_ms"]
    clock.advance(100)
    assert state(c)["elapsed_ms"] == t  # stopped


def test_history_limit_and_daily_stays_finished(env):
    c, clock = env
    daily = solve_all(c, clock, state(c)) if guess(c, state(c), "X") else None
    assert daily["status"] == "done"
    for _ in range(11):
        f = call(c, "POST", "/free/new")["game"]
        guess(c, f, "X")
        solve_all(c, clock, f)
        clock.advance(1)
    h = call(c, "GET", "/history")["history"]
    assert len(h) == 10 and all(e["mode"] == "free" for e in h)  # daily entry pruned from history...
    again = state(c)
    assert again["status"] == "done" and again["id"] == daily["id"]  # ...but cannot be replayed
    assert [e["finished_at"] for e in h] == sorted((e["finished_at"] for e in h), reverse=True)


def test_modes_independent_and_free_never_repeats_previous(env):
    c, clock = env
    d = state(c)
    guess(c, d, "X")
    f = state(c, "free")
    assert f["id"] != d["id"] and state(c)["id"] == d["id"] and state(c, "free")["id"] == f["id"]
    assert call(c, "POST", "/free/new")["game"]["id"] == f["id"]  # active chain is kept
    seen = words_of(f["id"])
    for _ in range(15):
        f = solve_all(c, clock, f) if f["status"] == "active" else f
        if f["status"] == "active":
            guess(c, f, "X")
        f2 = call(c, "POST", "/free/new")["game"]
        assert words_of(f2["id"]) != seen
        seen, f = words_of(f2["id"]), f2


def test_players_cannot_touch_each_others_games(env):
    c, _ = env
    g = state(c)
    r = c.post(f"/api/games/{g['id']}/guess", headers={"X-Player-Id": P2}, json={"guess": "ABC"})
    assert r.status_code == 404
