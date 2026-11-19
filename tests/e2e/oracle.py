"""Test oracle: reads the SQLite DB directly. usage: oracle.py DB PLAYER MODE FIELD"""
import json, sqlite3, sys
db, pid, mode, field = sys.argv[1:5]
con = sqlite3.connect(db)
row = con.execute("SELECT words, started_at, finished_at, day FROM games WHERE player_id=? AND mode=? "
                  "ORDER BY created_at DESC, rowid DESC LIMIT 1", (pid, mode)).fetchone()
print(json.dumps({"words": json.loads(row[0]), "started": row[1] is not None, "finished": row[2] is not None,
                  "day": row[3], "count": con.execute("SELECT COUNT(*) FROM history WHERE player_id=?", (pid,)).fetchone()[0]}[field]
                 if field != "words" else json.loads(row[0])))
