#!/usr/bin/env bash
# External attachment behavior with real Linux processes and an isolated fake
# Herdr transport. No native chats, credentials or paid model calls.
set -eu
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
if [ ! -d /proc/self ]; then
  echo 'skip: exact external binding requires Linux /proc'
  exit 0
fi
python3 "$ROOT/tests/fm-external-session.test.py" "$ROOT"
