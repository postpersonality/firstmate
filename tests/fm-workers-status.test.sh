#!/usr/bin/env bash
# Regression carried with the existing collector, including native process
# classification seams and delivery/decision rendering. No model calls.
set -eu
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ -d /proc/self ] || { echo 'skip: collector process regression requires Linux /proc'; exit 0; }
python3 "$ROOT/tests/fm-workers-status.test.py"
