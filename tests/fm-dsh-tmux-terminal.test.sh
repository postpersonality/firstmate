#!/usr/bin/env bash
# Portable real PTY/process/composer behavior with deterministic ACP, no model.
set -eu
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
fm_live_gate default-on FM_DSH_TMUX_TERMINAL tmux node
[ "$(uname -s)" = Linux ] || { echo 'skip: Linux DSH worker adapter only'; exit 0; }
LAB=$(fm_test_tmproot fm-dsh-tmux-terminal)
export FM_HOME="$LAB/home"
"$ROOT/bin/fm-lab-home.sh" create "$FM_HOME" >/dev/null
export TMUX_TMPDIR
TMUX_TMPDIR=$("$ROOT/bin/fm-lab-home.sh" tmux-dir "$FM_HOME")
unset TMUX
cleanup() {
  local rc=$?
  trap - EXIT
  tmux kill-server >/dev/null 2>&1 || true
  "$ROOT/bin/fm-lab-home.sh" teardown "$FM_HOME" || rc=1
  fm_test_cleanup
  exit "$rc"
}
trap cleanup EXIT
mkdir -p "$LAB/cwd" "$LAB/config"
NODE=$(node -p 'process.execPath')
FAKE=$("$NODE" "$ROOT/tests/assets/fm-dsh-fixture.mjs" "$LAB" 0.2.1-rc.2)
printf 'INITIAL_BRIEF\n' > "$LAB/brief"
GEN=$("$ROOT/bin/fm-busy-event.sh" arm "$FM_HOME/state" fixture)
tmux new-session -d -s dsh -n worker -c "$LAB/cwd" "$NODE" "$ROOT/bin/fm-dsh-worker.mjs" --dsh-bin "$FAKE" --config-home "$LAB/config" --runtime-home "$LAB/runtime" --cwd "$LAB/cwd" --state "$FM_HOME/state" --id fixture --gen "$GEN" --brief "$LAB/brief"
# shellcheck source=bin/fm-backend.sh
. "$ROOT/bin/fm-backend.sh"
fm_backend_source tmux
TARGET=dsh:worker
for _ in $(seq 1 40); do [ ! -f "$FM_HOME/state/fixture.turn-ended" ] || break; sleep 0.1; done
[ -f "$FM_HOME/state/fixture.turn-ended" ]
[ "$(fm_backend_agent_state tmux "$TARGET")" = alive ]
[ "$(fm_backend_composer_state tmux "$TARGET")" = empty ]
fm_backend_send_text_submit tmux "$TARGET" WAIT 3 0.2 0.2 >/dev/null
fm_backend_tmux_send_literal "$TARGET" DRAFT
[ "$(fm_backend_composer_state tmux "$TARGET")" = pending ]
fm_backend_send_key tmux "$TARGET" Escape
for _ in $(seq 1 30); do grep -q 'event=cancelled' "$FM_HOME/state/fixture.busy-state" && break; sleep 0.1; done
grep -q 'state=unknown.*event=cancelled' "$FM_HOME/state/fixture.busy-state"
[ "$(fm_backend_composer_state tmux "$TARGET")" = pending ]
tmux capture-pane -pt "$TARGET" | grep -q '❯ DRAFT'
fm_backend_send_key tmux "$TARGET" C-u
[ "$(fm_backend_composer_state tmux "$TARGET")" = empty ]
fm_backend_send_text_submit tmux "$TARGET" '/exit' 3 0.2 0.2 >/dev/null
for _ in $(seq 1 30); do [ "$(fm_backend_agent_state tmux "$TARGET")" = alive ] || break; sleep 0.1; done
[ "$(fm_backend_agent_state tmux "$TARGET")" != alive ]
echo 'ok - DSH tmux process identity, real draft preservation across cancel and clean terminal exit (fixture ACP)'
