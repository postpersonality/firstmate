#!/usr/bin/env bash
# Opt-in real DSH + Herdr worker proof. No global install, auth or pool changes.
# FM_DSH_BIN must name the supported official CLI; FM_DSH_LIVE_MODEL selects an
# existing native provider/model. Every Herdr operation routes through the lab
# helper, including operations made by real fm-spawn/fm-send/fm-control.
set -eu
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
fm_live_gate opt-in FM_DSH_LIVE_E2E herdr jq node git
[ "$(uname -s)" = Linux ] || { echo 'skip: Linux DSH worker adapter only'; exit 0; }
: "${FM_DSH_BIN:?set FM_DSH_BIN to the native DSH entrypoint}"
: "${FM_DSH_LIVE_MODEL:?set FM_DSH_LIVE_MODEL to an existing provider/model}"
# shellcheck source=tests/dsh-herdr-fixture.sh
. "$ROOT/tests/dsh-herdr-fixture.sh"
cat > "$FM_HOME/data/$ID/brief.md" <<EOF
# Task
Work by yourself, do not delegate. Use bash to write pwd to '$FM_HOME/data/$ID/cwd-proof' and calculate 12345+67890 into '$FM_HOME/data/$ID/sum-proof'. Then wait for steering. Never inspect environment, credentials, profiles, other projects, or personal files. Your only inbox is '$FM_HOME/state/$ID.inbox': on a doorbell read its .msg files in order, follow each message exactly, then move each into handled/. Reply briefly.
EOF
"$LAB_HELPER" provision "$SESSION"
export PATH="$LAB/fakebin:$ORIGINAL_PATH" HERDR_SESSION="$SESSION"
FM_SPAWN_NO_GUARD=1 "$ROOT/bin/fm-spawn.sh" "$ID" "$LAB/project" --harness dsh --model "$FM_DSH_LIVE_MODEL" --effort low --scout --backend herdr >"$LAB/spawn.out" 2>"$LAB/spawn.err" || { cat "$LAB/spawn.err"; exit 1; }
TARGET=$(sed -n 's/^window=//p' "$FM_HOME/state/$ID.meta")
# shellcheck source=bin/fm-backend.sh
. "$ROOT/bin/fm-backend.sh"
fm_backend_source herdr
wait_file() {
  local path=$1
  for _ in $(seq 1 90); do [ ! -s "$path" ] || return 0; sleep 1; done
  echo "not ok - DSH did not produce ${path##*/}" >&2
  fm_backend_capture herdr "$TARGET" 60 >&2 || true
  return 1
}
wait_file "$FM_HOME/data/$ID/sum-proof"
[ "$(tr -d '[:space:]' < "$FM_HOME/data/$ID/sum-proof")" = 80235 ]
[ "$(tr -d '\r\n' < "$FM_HOME/data/$ID/cwd-proof")" = "$LAB/worktree" ]
[ "$(fm_backend_agent_state herdr "$TARGET")" = alive ]
for _ in $(seq 1 20); do [ "$(fm_backend_composer_state herdr "$TARGET")" != empty ] || break; sleep 0.5; done
[ "$(fm_backend_composer_state herdr "$TARGET")" = empty ]
echo 'ok - real DSH canonical supervised launch, cwd, model tool and Herdr liveness/composer'
"$ROOT/bin/fm-send.sh" "$ID" "Use bash to write STEER_OK to '$FM_HOME/data/$ID/steer-proof'." >/dev/null 2>"$LAB/send.err"
wait_file "$FM_HOME/data/$ID/steer-proof"
[ "$(cat "$FM_HOME/data/$ID/steer-proof")" = STEER_OK ]
[ -f "$FM_HOME/state/$ID.inbox/handled/001.msg" ]
echo 'ok - real DSH fm-send durable inbox delivery and acknowledgement'
# A durable steer must preserve a real draft and remain unread until the
# existing inbox ring owner is explicitly allowed to ring again.
fm_backend_herdr_send_literal "$TARGET" DRAFT
[ "$(fm_backend_composer_state herdr "$TARGET")" = pending ]
"$ROOT/bin/fm-send.sh" "$ID" "Use bash to write DRAFT_OK to '$FM_HOME/data/$ID/draft-proof'." >/dev/null 2>"$LAB/send.err"
[ -f "$FM_HOME/state/$ID.inbox/002.msg" ]
[ "$(fm_backend_composer_state herdr "$TARGET")" = pending ]
fm_backend_send_key herdr "$TARGET" C-u
# shellcheck source=bin/fm-task-inbox-lib.sh
. "$ROOT/bin/fm-task-inbox-lib.sh"
fm_task_inbox_ring herdr "$TARGET" "$FM_HOME/state/$ID.inbox/002.msg"
wait_file "$FM_HOME/data/$ID/draft-proof"
wait_file "$FM_HOME/state/$ID.inbox/handled/002.msg"
# The cancellable tool is a typed test prompt, not a durable unread steer that
# the model is supposed to replay after cancellation. Native bash background
# jobs use separate job cancellation, so explicitly request the foreground mode.
DSH_TEST_PHASE=foreground-tool-cancel
fm_backend_send_text_submit herdr "$TARGET" "Use bash with run_in_background=false and timeoutMs=60000 to execute exactly: printf '%s' \"\$BASHPID\" > '$FM_HOME/data/$ID/tool.pid'; printf START > '$FM_HOME/data/$ID/running'; sleep 30; printf AFTER > '$FM_HOME/data/$ID/after'. Use no background job or delegation." 3 0.5 0.5 >/dev/null
wait_file "$FM_HOME/data/$ID/running"
# shellcheck source=bin/fm-busy-lib.sh
. "$ROOT/bin/fm-busy-lib.sh"
[ "$(fm_busy_classify herdr "$TARGET" dsh "$ID" "$FM_HOME/state")" = 'busy dsh-acp' ]
"$ROOT/bin/fm-send.sh" "$ID" "Use bash to write BUSY_DELIVERY_OK to '$FM_HOME/data/$ID/busy-proof'." >/dev/null 2>"$LAB/send.err"
"$ROOT/bin/fm-control.sh" "$ID" interrupt >"$LAB/interrupt.out" 2>"$LAB/interrupt.err" || { cat "$LAB/interrupt.err"; exit 1; }
wait_file "$FM_HOME/data/$ID/busy-proof"
DSH_TEST_PHASE=busy-steer-result
[ "$(cat "$FM_HOME/data/$ID/busy-proof")" = BUSY_DELIVERY_OK ]
TOOL_PID=$(cat "$FM_HOME/data/$ID/tool.pid")
case "$TOOL_PID" in ''|*[!0-9]*) echo 'invalid owned tool pid'; exit 1 ;; esac
for _ in $(seq 1 20); do ! kill -0 "$TOOL_PID" 2>/dev/null && break; sleep 0.1; done
if kill -0 "$TOOL_PID" 2>/dev/null; then echo "cancelled tool survived"; exit 1; fi
DSH_TEST_PHASE=cancelled-tool-did-not-complete
[ ! -f "$FM_HOME/data/$ID/after" ]
echo 'ok - real DSH draft deferral, steering during busy, control cancellation and owned tool termination'
"$ROOT/bin/fm-control.sh" "$ID" exit >"$LAB/exit.out" 2>"$LAB/exit.err" || { cat "$LAB/exit.err"; exit 1; }
for _ in $(seq 1 30); do [ "$(fm_backend_agent_state herdr "$TARGET")" = alive ] || break; sleep 1; done
[ "$(fm_backend_agent_state herdr "$TARGET")" = dead ]
echo 'ok - real DSH session close and EOF leave the pane shell alive'
