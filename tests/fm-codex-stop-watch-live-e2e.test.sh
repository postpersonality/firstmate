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
# This optional private receipt keeps the API and hook-result transcript before lab cleanup.
RECEIPT_DIR=${FM_CODEX_STOP_NATIVE_RECEIPT_DIR:-}
if [ -n "$RECEIPT_DIR" ]; then
  case "$RECEIPT_DIR" in /*) ;; *) printf 'error: native receipt directory must be absolute\n' >&2; exit 1 ;; esac
  [ -d "$RECEIPT_DIR" ] && [ ! -L "$RECEIPT_DIR" ] || {
    printf 'error: native receipt directory must already exist and must not be a symlink\n' >&2
    exit 1
  }
  RECEIPT_REAL=$(cd -P -- "$RECEIPT_DIR" && pwd -P)
  [ "$RECEIPT_REAL" = "$RECEIPT_DIR" ] || {
    printf 'error: native receipt directory must be canonical\n' >&2
    exit 1
  }
  case "$RECEIPT_REAL/" in
    "$FM_TEST_TMPDIR/"*) ;;
    *) printf 'error: native receipts must stay under the test temp root\n' >&2; exit 1 ;;
  esac
  case "$RECEIPT_REAL/" in
    "$LAB/"*) printf 'error: native receipts must stay outside the disposable lab\n' >&2; exit 1 ;;
  esac
fi

fm_codex_stop_native_cleanup() {
  local rc=$? source name failed=0
  trap - EXIT INT TERM HUP QUIT
  if [ -n "$RECEIPT_DIR" ]; then
    source="$LAB/after"
    if [ -d "$source" ] && [ ! -L "$source" ]; then
      : > "$RECEIPT_DIR/manifest.txt" || failed=1
      for name in api.jsonl native-stops.jsonl native-results.jsonl native-starts.jsonl native-initial-wake.json native-env server.stderr; do
        if [ -f "$source/$name" ] && [ ! -L "$source/$name" ]; then
          if cp -- "$source/$name" "$RECEIPT_DIR/$name" && chmod 600 "$RECEIPT_DIR/$name"; then
            printf 'captured %s\n' "$name" >> "$RECEIPT_DIR/manifest.txt" || failed=1
          else
            printf 'failed to preserve %s\n' "$name" >&2
            failed=1
          fi
        else
          printf 'absent %s\n' "$name" >> "$RECEIPT_DIR/manifest.txt" || failed=1
          case "$name" in api.jsonl|native-stops.jsonl|native-results.jsonl|native-starts.jsonl|native-initial-wake.json) failed=1 ;; esac
        fi
      done
      chmod 600 "$RECEIPT_DIR/manifest.txt" || failed=1
    else
      printf 'native lab output directory absent; no API/result transcripts to preserve\n' > "$RECEIPT_DIR/manifest.txt" || failed=1
      chmod 600 "$RECEIPT_DIR/manifest.txt" || failed=1
    fi
    if [ "$failed" -ne 0 ]; then rc=1; fi
  fi
  fm_test_cleanup
  exit "$rc"
}
trap fm_codex_stop_native_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 131' QUIT

python3 "$ROOT/tests/fm-codex-stop-watch-native.py" "$ROOT" "$LAB"
