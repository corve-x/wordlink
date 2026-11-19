import json
import os
import random
import re
import secrets
import time
from functools import lru_cache
from typing import Literal
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field
from redis import Redis, RedisError, WatchError
from . import puzzles

router = APIRouter(prefix="/api/rooms")
LEASE = 90
HINT_LIMIT = 3
LETTER_WAIT, WORD_WAIT = 10, 20
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


@lru_cache(maxsize=1)
def database():
    url = os.getenv("REDIS_URL")
    if not url:
        raise HTTPException(503, "Room storage is not configured.")
    return Redis.from_url(url, decode_responses=True, socket_connect_timeout=3, socket_timeout=3)


class Guest(BaseModel):
    name: str = Field(min_length=1, max_length=24)


class Action(BaseModel):
    action: Literal["join", "sync", "ready", "guess", "hint", "leave", "rematch"]
    name: str = Field(default="", max_length=24)
    guess: str = Field(default="", max_length=9)
    index: int = 0
    kind: Literal["letter", "word"] = "letter"
    used: int = -1
    round: int = 1


def guest(name, ts):
    name = name.strip()
    if not name or not name.isprintable():
        raise HTTPException(400, "Enter a display name of 1–24 visible characters.")
    return dict(name=name, seen=ts, ready=False, index=1)


def identity(token):
    if not re.fullmatch(r"[a-f0-9]{32}", token):
        raise HTTPException(400, "Invalid guest session.")
    return token


def remove(room, pid):
    del room["players"][pid]
    if room["phase"] == "racing" and room["players"]:
        winner = next(iter(room["players"]))
        room.update(phase="finished", winner=winner, reason="opponent left")
    elif room["phase"] == "waiting":
        for member in room["players"].values():
            member["ready"] = False


def hint_times(room, member):
    row_start = member.get("row_start", room["start"])
    return member.get("last_letter", row_start) + LETTER_WAIT, row_start + WORD_WAIT


def public(room, pid, ts):
    members = room["players"]
    words = room["words"]
    state = dict(round=room.get("round", 1), code=room["code"], phase=room["phase"], players=[
        dict(name=p["name"], you=k == pid, ready=p["ready"], rematch=p.get("rematch", False), score=p["index"] - 1)
        for k, p in members.items()
    ], total=len(words) - 1)
    if room["phase"] == "finished":
        state.update(won=pid == room["winner"], reason=room["reason"])
    elif room["phase"] == "racing":
        remaining = max(0, room["start"] - ts)
        state["countdown"] = remaining
        if not remaining:
            i = members[pid]["index"]
            member = members[pid]
            letter_at, word_at = hint_times(room, member)
            used = member.get("used", 0)
            state.update(prefix=words[i][:member.get("fixed", 1)], used=used,
                         hints_left=HINT_LIMIT - used, letter_wait=max(0, letter_at - ts),
                         word_wait=max(0, word_at - ts))
            state.update(solved=words[:i], index=i, initial=words[i][0], length=len(words[i]))
    return state


@router.post("")
def create(body: Guest, x_room_token: str = Header(...)):
    pid = identity(x_room_token)
    ts = time.time()
    room = dict(players={pid: guest(body.name, ts)}, phase="waiting",
                words=puzzles.make_chain(random.SystemRandom()))
    try:
        while True:
            code = "".join(secrets.choice(ALPHABET) for _ in range(6))
            room["code"] = code
            if database().set("wordlink:room:" + code, json.dumps(room), nx=True, ex=LEASE):
                return public(room, pid, ts)
    except RedisError:
        raise HTTPException(503, "Room storage is unavailable. Try again.")


def apply(room, pid, body, ts):
    members = room["players"]
    for key in list(members):
        if ts - members[key]["seen"] >= LEASE:
            remove(room, key)
    if not members:
        raise HTTPException(404, "This room has expired.")
    if body.action == "join" and pid not in members:
        if room["phase"] != "waiting" or len(members) >= 2:
            raise HTTPException(409, "This room is full or the race has ended.")
        members[pid] = guest(body.name, ts)
    if pid not in members:
        raise HTTPException(403, "Your room session has ended.")
    me = members[pid]
    me["seen"] = ts
    if body.action == "leave":
        remove(room, pid)
        return {"left": True}
    current_round = room.get("round", 1)
    if body.action in ("rematch", "guess", "hint") and body.round != current_round:
        return public(room, pid, ts)
    if body.action == "rematch" and room["phase"] == "finished" and len(members) == 2:
        me["rematch"] = True
        if all(p.get("rematch") for p in members.values()):
            words = puzzles.make_chain(random.SystemRandom(), avoid=room["words"])
            room.update(words=words, round=current_round + 1, phase="racing", start=ts + 3)
            del room["winner"], room["reason"]
            for key, p in members.items():
                members[key] = guest(p["name"], p["seen"])
    if body.action == "ready" and room["phase"] == "waiting":
        me["ready"] = True
        if len(members) == 2 and all(p["ready"] for p in members.values()):
            room.update(phase="racing", start=ts + 3)
    correct = None
    if (body.action in ("guess", "hint") and room["phase"] == "racing"
            and ts >= room["start"] and body.index == me["index"]):
        word = room["words"][me["index"]]
        advance = False
        if body.action == "guess":
            correct = body.guess.upper() == word
            advance = correct
        else:
            used = me.get("used", 0)
            letter_at, word_at = hint_times(room, me)
            unlock = letter_at if body.kind == "letter" else word_at
            if used < HINT_LIMIT and body.used == used and ts >= unlock:
                me["used"] = used + 1
                if body.kind == "word":
                    advance = True
                else:
                    me["last_letter"] = ts
                    me["fixed"] = me.get("fixed", 1) + 1
                    advance = me["fixed"] == len(word)
        if advance:
            me.update(index=me["index"] + 1, fixed=1, row_start=ts)
            me.pop("last_letter", None)
            if me["index"] == len(room["words"]):
                room.update(phase="finished", winner=pid, reason="chain solved")
    return dict(public(room, pid, ts), correct=correct)


@router.post("/{code}")
def update(code: str, body: Action, x_room_token: str = Header(...)):
    pid = identity(x_room_token)
    if not re.fullmatch(r"[A-Z2-9]{6}", code):
        raise HTTPException(404, "Check the six-character room code.")
    key = "wordlink:room:" + code
    try:
        for _ in range(12):
            with database().pipeline() as pipe:
                try:
                    pipe.watch(key)
                    raw = pipe.get(key)
                    if raw is None:
                        raise HTTPException(404, "Room not found or expired.")
                    room = json.loads(raw)
                    result = apply(room, pid, body, time.time())
                    pipe.multi()
                    if room["players"]:
                        pipe.set(key, json.dumps(room), ex=LEASE)
                    else:
                        pipe.delete(key)
                    pipe.execute()
                    return result
                except WatchError:
                    continue
    except RedisError:
        pass
    raise HTTPException(503, "Room update interrupted. Try again.")
