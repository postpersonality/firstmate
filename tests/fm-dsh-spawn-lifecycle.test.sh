#!/usr/bin/env bash
# Full real Herdr/spawn/control lifecycle with fixture ACP; no model calls.
set -eu
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
fm_live_gate default-on FM_DSH_SPAWN_LIFECYCLE herdr jq node git
[ "$(uname -s)" = Linux ] || { echo 'skip: Linux DSH worker adapter only'; exit 0; }
# shellcheck source=tests/dsh-herdr-fixture.sh
. "$ROOT/tests/dsh-herdr-fixture.sh"
export FM_DSH_BIN DSH_HOME="$LAB/native-config"
mkdir -p "$DSH_HOME"
FM_DSH_BIN=$(node "$ROOT/tests/assets/fm-dsh-fixture.mjs" "$LAB")
printf '# Task\nInitial fixture brief.\n' > "$FM_HOME/data/$ID/brief.md"
"$LAB_HELPER" provision "$SESSION"
export PATH="$LAB/fakebin:$ORIGINAL_PATH" HERDR_SESSION="$SESSION"
FM_SPAWN_NO_GUARD=1 "$ROOT/bin/fm-spawn.sh" "$ID" "$LAB/project" --harness dsh --model litellm/test --effort low --scout --backend herdr >"$LAB/spawn.out" 2>"$LAB/spawn.err" || { cat "$LAB/spawn.err"; exit 1; }
TARGET=$(sed -n 's/^window=//p' "$FM_HOME/state/$ID.meta")
# shellcheck source=bin/fm-backend.sh
. "$ROOT/bin/fm-backend.sh"
# shellcheck source=bin/fm-busy-lib.sh
. "$ROOT/bin/fm-busy-lib.sh"
fm_backend_source herdr
FIRST_GEN=$(cat "$FM_HOME/state/$ID.busy-gen")
FIRST_PID=$(jq -r .pid "$FM_HOME/state/$ID.dsh-ready")
printf 'PRESERVE\n' > "$LAB/worktree/sentinel.txt"
fm_backend_send_text_submit herdr "$TARGET" WAIT 3 0.2 0.3 >/dev/null
[ "$(fm_busy_classify herdr "$TARGET" dsh "$ID" "$FM_HOME/state")" = 'busy dsh-acp' ]
"$ROOT/bin/fm-control.sh" "$ID" interrupt > "$LAB/interrupt.out"
for _ in $(seq 1 30); do grep -q 'event=cancelled' "$FM_HOME/state/$ID.busy-state" && break; sleep 0.1; done
grep -q 'state=unknown.*event=cancelled' "$FM_HOME/state/$ID.busy-state"
"$ROOT/bin/fm-control.sh" "$ID" exit > "$LAB/exit.out" 2> "$LAB/exit.err" || { cat "$LAB/exit.err"; exit 1; }
if kill -0 "$FIRST_PID" 2>/dev/null; then echo "old bridge survived exit"; exit 1; fi
"$ROOT/bin/fm-control.sh" "$ID" relaunch --note "Lifecycle fixture: start a fresh ACP session and preserve the existing sentinel file." > "$LAB/relaunch.out" 2> "$LAB/relaunch.err" || { cat "$LAB/relaunch.err"; exit 1; }
SECOND_GEN=$(cat "$FM_HOME/state/$ID.busy-gen")
[ "$FIRST_GEN" != "$SECOND_GEN" ]
[ "$(jq -r .gen "$FM_HOME/state/$ID.dsh-ready")" = "$SECOND_GEN" ]
[ "$(cat "$LAB/worktree/sentinel.txt")" = PRESERVE ]
[ "$(fm_backend_agent_state herdr "$TARGET")" = alive ]
fm_backend_send_text_submit herdr "$TARGET" CRASH 3 0.2 0.3 >/dev/null
for _ in $(seq 1 30); do [ "$(fm_backend_agent_state herdr "$TARGET")" = alive ] || break; sleep 0.1; done
[ "$(fm_backend_agent_state herdr "$TARGET")" = dead ]
"$ROOT/bin/fm-control.sh" "$ID" relaunch --note "Lifecycle fixture: start a fresh ACP session and preserve the existing sentinel file." > "$LAB/recovery.out" 2> "$LAB/recovery.err" || { cat "$LAB/recovery.err"; exit 1; }
[ "$(cat "$LAB/worktree/sentinel.txt")" = PRESERVE ]
[ "$(fm_backend_agent_state herdr "$TARGET")" = alive ]
"$ROOT/bin/fm-control.sh" "$ID" exit > "$LAB/exit.out" 2> "$LAB/exit.err" || { cat "$LAB/exit.err"; exit 1; }
[ "$(fm_backend_agent_state herdr "$TARGET")" = dead ]
echo 'ok - canonical DSH readiness, semantic busy, control interrupt/exit, fresh-generation relaunch and crash recovery preserve dirty files (fixture ACP)'
