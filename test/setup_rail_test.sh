#!/usr/bin/env bash
# Create sacrificial sessions for rail rename/delete acceptance testing.
# Uses REAL pi mechanics so the sessions look exactly like the user's.
# Bucket is obviously a test dir and is torn down afterwards.
set -u
SESSIONS="${HOME}/.pi/agent/sessions"
WORKDIR=/tmp/piweb-railtest
mkdir -p "$WORKDIR"
cd "$WORKDIR"

echo "=== creating 2 sacrificial sessions (--no-session NOT used; we want real files) ==="
for n in railalpha railbeta; do
  timeout 150 pi --session-id "$n" -p "Reply with exactly: $n" >/dev/null 2>&1
  echo "  $n -> exit=$?"
done

BUCKET="$SESSIONS/--tmp-piweb-railtest--"
echo
echo "=== bucket: $BUCKET ==="
ls -l "$BUCKET" 2>/dev/null | tail -5

echo
echo "=== paths for the harness ==="
find "$BUCKET" -name '*.jsonl' 2>/dev/null | sed 's|^|  |'

echo
echo "=== total sessions now listed by server would include these 2 ==="
find "$SESSIONS" -maxdepth 2 -name '*.jsonl' -not -path '*/.quarantine*' | wc -l
