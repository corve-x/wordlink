#!/usr/bin/env bash
# Boots the app on a throwaway DB with a controllable clock, then drives the UI in jsdom.
set -e
cd "$(dirname "$0")/../.."
export WORDLINK_DB="$(mktemp -d)/e2e.db" WL_OFFSET_FILE="$(mktemp)" PORT=8123
echo 0 > "$WL_OFFSET_FILE"
python3 tests/serve_fake_clock.py $PORT & SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 2
cd tests/e2e
DB="$WORDLINK_DB" OFFSET_FILE="$WL_OFFSET_FILE" node e2e.mjs