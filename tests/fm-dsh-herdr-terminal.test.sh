#!/usr/bin/env bash
# Real isolated Herdr terminal + deterministic ACP peer: no model/auth calls.
set -eu
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
fm_live_gate default-on FM_DSH_HERDR_TERMINAL herdr jq node
[ "$(uname -s)" = Linux ] || { echo 'skip: Linux DSH worker adapter only'; exit 0; }
# shellcheck source=tests/herdr-test-safety.sh
. "$ROOT/tests/herdr-test-safety.sh"
herdr_forget_inherited_pane
ORIGINAL_PATH=$PATH
LAB_HELPER=${HERDR_LAB_HELPER:-$ROOT/bin/fm-herdr-lab.sh}
SESSION=$("$LAB_HELPER" name dsh-terminal)
LAB=$(fm_test_tmproot fm-dsh-herdr-terminal)
cleanup() {
  local rc=$?
  trap - EXIT
  if [ "$rc" != 0 ] && [ -n "${PANE:-}" ]; then
    env PATH="$ORIGINAL_PATH" "$LAB_HELPER" run "$SESSION" pane read "$PANE" --source recent --lines 80 >&2 || true
  fi
  env PATH="$ORIGINAL_PATH" "$LAB_HELPER" teardown "$SESSION" || rc=1
  fm_test_cleanup
  exit "$rc"
}
trap cleanup EXIT
mkdir -p "$LAB/shim" "$LAB/state" "$LAB/cwd" "$LAB/config"
NODE=$(node -p 'process.execPath')
FAKE=$("$NODE" "$ROOT/tests/assets/fm-dsh-fixture.mjs" "$LAB")
# Embed only public task paths; this shim also runs from inside the pane, where
# controller exports are not guaranteed to be present in the server environment.
{
  printf '#!/usr/bin/env bash\nset -eu\n'
  printf 'DSH_LAB_SESSION=%q\nDSH_LAB_PATH=%q\nDSH_LAB_HELPER=%q\n' "$SESSION" "$ORIGINAL_PATH" "$LAB_HELPER"
  cat <<'WRAP'
args=("$@")
n=${#args[@]}
if [ "$n" -ge 2 ] && [ "${args[n-2]}" = --session ]; then
  [ "${args[n-1]}" = "$DSH_LAB_SESSION" ] || exit 97
  args=("${args[@]:0:n-2}")
fi
exec env PATH="$DSH_LAB_PATH" "$DSH_LAB_HELPER" run "$DSH_LAB_SESSION" "${args[@]}"
WRAP
} > "$LAB/shim/herdr"
chmod +x "$LAB/shim/herdr"
"$LAB_HELPER" provision "$SESSION"
export PATH="$LAB/shim:$ORIGINAL_PATH"
# shellcheck source=bin/fm-backend.sh
. "$ROOT/bin/fm-backend.sh"
fm_backend_source herdr
WS=$(env PATH="$ORIGINAL_PATH" "$LAB_HELPER" run "$SESSION" workspace create --cwd "$LAB/cwd" --label dsh-terminal --no-focus)
PANE=$(printf '%s' "$WS" | jq -er '.result.root_pane.pane_id')
TARGET="$SESSION:$PANE"
fm_backend_herdr_wait_shell_prompt "$TARGET"
printf 'INITIAL_BRIEF\n' > "$LAB/brief"
GEN=$("$ROOT/bin/fm-busy-event.sh" arm "$LAB/state" fixture)
printf -v COMMAND '/usr/bin/env %q %q --dsh-bin %q --config-home %q --runtime-home %q --cwd %q --state %q --id fixture --gen %q --brief %q --herdr-bin %q --herdr-session %q --herdr-pane %q' "$NODE" "$ROOT/bin/fm-dsh-worker.mjs" "$FAKE" "$LAB/config" "$LAB/runtime" "$LAB/cwd" "$LAB/state" "$GEN" "$LAB/brief" "$LAB/shim/herdr" "$SESSION" "$PANE"
fm_backend_herdr_send_text_line "$TARGET" "$COMMAND"
for _ in $(seq 1 40); do [ ! -f "$LAB/state/fixture.turn-ended" ] || break; sleep 0.25; done
[ -f "$LAB/state/fixture.turn-ended" ] || { echo 'not ok - bridge did not complete its initial fixture prompt'; exit 1; }
[ "$(fm_backend_agent_state herdr "$TARGET")" = alive ] || { echo 'not ok - custom DSH report did not establish live registration'; exit 1; }
[ "$(fm_backend_composer_state herdr "$TARGET")" = empty ]
fm_backend_herdr_send_literal "$TARGET" 'DRAFT'
[ "$(fm_backend_composer_state herdr "$TARGET")" = pending ]
fm_backend_send_key herdr "$TARGET" C-u
[ "$(fm_backend_composer_state herdr "$TARGET")" = empty ]
fm_backend_send_text_submit herdr "$TARGET" WAIT 3 0.2 0.3 >/dev/null
[ "$(fm_backend_agent_state herdr "$TARGET")" = alive ]
# The control plane can follow its interrupt with an exit immediately. A
# pending readline Escape must never consume the slash as a Meta prefix.
# shellcheck source=bin/fm-control-lib.sh
. "$ROOT/bin/fm-control-lib.sh"
fm_backend_send_key herdr "$TARGET" "$(fm_control_interrupt_key dsh)"
fm_backend_herdr_send_literal "$TARGET" '/exit'
fm_backend_send_key herdr "$TARGET" Enter
for _ in $(seq 1 30); do [ "$(fm_backend_agent_state herdr "$TARGET")" = alive ] || break; sleep 0.2; done
[ "$(fm_backend_agent_state herdr "$TARGET")" = dead ]
echo 'ok - DSH custom Herdr reporting, actual draft composer, immediate Ctrl+C/exit and release/EOF (fixture ACP; no model)'
