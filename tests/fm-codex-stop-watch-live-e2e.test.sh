#!/usr/bin/env bash
# Opt-in native API proof. Only a newly owned CODEX_HOME/lab is used; no shared
# daemon, vendor settings, tmux, Herdr, browser, or other task is controlled.
# The per-thread hook bypass requires separate review of the generated hooks
# and this driver: FM_CODEX_STOP_LIVE_HOOKS_REVIEWED=1. Never persist hook trust.
# FM_CODEX_STOP_NATIVE_CASE=standalone limits the proof to one private thread;
# it retains the native 20-second Stop and 180-second quiet successor bounds.
set -eu
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
fm_live_gate opt-in FM_CODEX_STOP_WATCH_LIVE_E2E codex python3 git jq perl
[ "${FM_CODEX_STOP_LIVE_HOOKS_REVIEWED:-}" = 1 ] || {
  printf 'error: isolated native hooks require an explicit review; no hook trust was changed\n' >&2
  exit 1
}
LAB=$(fm_test_tmproot fm-codex-stop-native)
python3 "$ROOT/tests/fm-codex-stop-watch-native.py" "$ROOT" "$LAB"
