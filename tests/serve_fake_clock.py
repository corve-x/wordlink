"""Test-only launcher: runs the app with a clock = real time + offset read from a file."""
import os, sys, time
import uvicorn
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import main

OFFSET_FILE = os.environ["WL_OFFSET_FILE"]

def now():
    try:
        return time.time() + float(open(OFFSET_FILE).read() or 0)
    except OSError:
        return time.time()

main.now = now
uvicorn.run(main.app, host="127.0.0.1", port=int(sys.argv[1]), log_level="warning")