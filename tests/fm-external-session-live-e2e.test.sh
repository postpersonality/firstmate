#!/usr/bin/env bash
# Token-free native Pi attachment through a generated non-default Herdr lab.
# Uses the installed integration and local /name builtin; never submits a
# model prompt. Evidence stays outside the checkout for operator inspection.
set -euo pipefail
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
fm_live_gate default-on FM_EXTERNAL_SESSION_LIVE herdr pi jq
[ -d /proc/self ] || { echo 'skip: exact native binding requires Linux /proc'; exit 0; }
PI_NATIVE=$(command -v pi)
PI_HERDR_EXTENSION=${FM_PI_HERDR_EXTENSION:-$HOME/.pi/agent/extensions/herdr-agent-state.ts}
[ -f "$PI_HERDR_EXTENSION" ] || { echo 'skip: installed native Pi Herdr extension is missing'; exit 0; }
OUT=${FM_EXTERNAL_SESSION_EVIDENCE:-$(mktemp -d "${TMPDIR:-/tmp}/fm-external-live.XXXXXX")}
mkdir -p "$OUT"
HERDR_LAB_HELPER=${FM_HERDR_LAB_HELPER:-$ROOT/bin/fm-herdr-lab.sh}
HERDR_LAB_SESSION=$("$HERDR_LAB_HELPER" name external-native)
export FM_HERDR_LAB_HELPER=$HERDR_LAB_HELPER
FM_HOME=$(mktemp -d "$OUT/home.XXXXXX")
export FM_HOME
cleanup() {
  local result=$?
  trap - EXIT
  if [ -n "${pane:-}" ]; then
    "$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" pane read "$pane" --source visible > "$OUT/final-pane.json" 2>"$OUT/final-pane.stderr" || true
  fi
  "$HERDR_LAB_HELPER" teardown "$HERDR_LAB_SESSION" > "$OUT/teardown.stdout" 2> "$OUT/teardown.stderr" || result=1
  printf '%s\n' "$result" > "$OUT/exit-code.txt"
  exit "$result"
}
trap cleanup EXIT
"$HERDR_LAB_HELPER" provision "$HERDR_LAB_SESSION"
printf '%s\n' "$HERDR_LAB_SESSION" > "$OUT/session.txt"
printf '%s\n' "$FM_HOME" > "$OUT/home.txt"
mkdir -p "$FM_HOME/data" "$FM_HOME/state" "$FM_HOME/user-folder" "$FM_HOME/native-sessions"
printf '## In flight\n\n## Queued\n\n## Done\n' > "$FM_HOME/data/backlog.md"
printf 'uncommitted user material\n' > "$FM_HOME/user-folder/private.txt"
"$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" workspace create --label external-binding-recovery --cwd "$FM_HOME/user-folder" --no-focus > "$OUT/workspace.json"
workspace=$(jq -er '.result.workspace.workspace_id' "$OUT/workspace.json")
"$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" tab create --workspace "$workspace" --cwd "$FM_HOME/user-folder" --label existing-pi --no-focus > "$OUT/tab.json"
pane=$(jq -er '.result.root_pane.pane_id' "$OUT/tab.json")
bash -c '. "$1/bin/fm-backend.sh"; fm_backend_source herdr; fm_backend_herdr_wait_shell_prompt "$2"' lab "$ROOT" "$HERDR_LAB_SESSION:$pane"
session_id=$(python3 -c 'import uuid;print(uuid.uuid4())')
printf '%s\n' "$session_id" > "$OUT/native-requested-id.txt"
launch="env -u FM_TASK_ID -u FM_HOME $PI_NATIVE --no-extensions -e $PI_HERDR_EXTENSION --no-mcp --no-skills --no-approve --session-id $session_id --session-dir $FM_HOME/native-sessions"
printf '%s\n' "$launch" > "$OUT/launch.txt"
"$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" pane run "$pane" "$launch"
for ((attempt=0; attempt<100; attempt++)); do
  "$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" pane process-info --pane "$pane" > "$OUT/process.json"
  "$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" agent get "$pane" > "$OUT/agent.json" 2>"$OUT/agent.stderr" || true
  "$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" pane read "$pane" --source visible > "$OUT/pane.json"
  if jq -e '.result.agent.agent_session.value | length > 0' "$OUT/agent.json" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
PYTHONPATH="$ROOT/bin" python3 - "$ROOT" "$OUT/process.json" "$pane" "$OUT" <<'PY'
import json, subprocess, sys
from pathlib import Path
from fm_agent_process import pane_sample
sample=pane_sample(json.load(open(sys.argv[2])),sys.argv[3])
rows=subprocess.run(['bash',sys.argv[1]+'/bin/fm-agent-process-probe.sh'],input=json.dumps(sample['procs']),capture_output=True,text=True,check=True)
rows=[json.loads(l) for l in rows.stdout.splitlines()]
found=[p for p in rows if p['family']=='pi']
Path(sys.argv[4]+'/native-processes.json').write_text(json.dumps(found,indent=2))
for p in found:
    keys={}
    for v in Path(f'/proc/{p["pid"]}/environ').read_bytes().split(b'\0'):
        key, _, value=v.partition(b'=')
        if key in (b'HERDR_ENV',b'HERDR_SOCKET_PATH',b'HERDR_PANE_ID',b'HERDR_TAB_ID',b'HERDR_SESSION',b'FM_TASK_ID',b'FM_HOME'):
            keys[key.decode()]=value.decode()
    Path(sys.argv[4]+'/native-routing.json').write_text(json.dumps(keys,indent=2))
assert len(found)==1, 'one exact native Pi process not proven'
Path(sys.argv[4]+'/pid.txt').write_text(str(found[0]['pid']))
PY
pid=$(cat "$OUT/pid.txt")
"$ROOT/bin/fm-attach.sh" inspect --session "$HERDR_LAB_SESSION" --pane "$pane" --pid "$pid" > "$OUT/selection.json"
echo 'ok: native Pi session and lab routing proven without a model prompt'
printf 'Laboratory-only authorization for exact native process and zero-model verification.\n' > "$FM_HOME/authorization.txt"
printf 'Same native Pi session; actual builtin receipt; watcher wake; graceful exit with all user material retained.\n' > "$FM_HOME/criteria.txt"
"$ROOT/bin/fm-attach.sh" attach live-pi --selection "$OUT/selection.json" --source-file "$FM_HOME/authorization.txt" --dod-file "$FM_HOME/criteria.txt" --title 'Лабораторная проверка Pi' --observe-file "$OUT/reply.txt" --human-required > "$OUT/attachment.json"
"$ROOT/bin/fm-attach.sh" verify live-pi > "$OUT/before-send.json"
if "$ROOT/bin/fm-control.sh" live-pi exit > "$OUT/unconfirmed-exit.txt" 2>&1; then echo 'unconfirmed DoD permitted exit'; exit 1; fi
"$ROOT/bin/fm-attach.sh" observe live-pi > "$OUT/initial-observation.txt"
[ -z "$("$ROOT/bin/fm-attach.sh" observe live-pi)" ]
token="ATTACH_LAB_RECEIPT_$session_id"
# Installed interactive-mode.js handleNameCommand is a local builtin, with no model call.
send_rc=0
"$ROOT/bin/fm-send.sh" live-pi "/name $token" > "$OUT/send.stdout" 2> "$OUT/send.stderr" || send_rc=$?
printf '%s\n' "$send_rc" > "$OUT/send-exit.txt"
for ((attempt=0; attempt<100; attempt++)); do
  "$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" pane read "$pane" --source visible > "$OUT/reply.txt"
  grep -F "Session name set: $token" "$OUT/reply.txt" >/dev/null && break
  sleep 0.1
done
grep -F "Session name set: $token" "$OUT/reply.txt" >/dev/null
"$ROOT/bin/fm-attach.sh" verify live-pi > "$OUT/after-reply.json"
"$ROOT/bin/fm-attach.sh" receipt live-pi --file "$OUT/reply.txt" --token "$token" --format ack-file --ack "Session name set: $token" > "$OUT/native-receipt.json"
# Exercise the existing watcher, not the check's stdout alone.
FM_POLL=1 FM_SIGNAL_GRACE=1 FM_CHECK_INTERVAL=1 "$ROOT/bin/fm-watch-checkpoint.sh" --seconds 15 > "$OUT/watcher.stdout" 2> "$OUT/watcher.stderr"
grep -F 'check:' "$OUT/watcher.stdout" >/dev/null
grep -F 'external-live-pi' "$FM_HOME/state/.wake-queue" > "$OUT/watcher-queue-receipt.txt"
"$ROOT/bin/fm-fleet-snapshot.sh" --json > "$OUT/fleet-snapshot.json"
"$ROOT/bin/fm-workers-status.py" --fm-home "$FM_HOME" --herdr-session "$HERDR_LAB_SESSION" --evidence "$OUT/workers-evidence.json" > "$OUT/workers-status.md"
version=$("$ROOT/bin/fm-attach.sh" state live-pi | jq -er '.completion.version')
printf 'Laboratory fixture confirms exactly the proposed version; no production approval.\n' > "$FM_HOME/confirm.txt"
"$ROOT/bin/fm-attach.sh" dod live-pi confirm --version "$version" --file "$FM_HOME/confirm.txt" > "$OUT/dod-confirmed.json"
printf 'Same identity; actual /name receipt; durable watcher wake; user file unchanged.\n' > "$FM_HOME/results.txt"
"$ROOT/bin/fm-attach.sh" dod live-pi achieve --version "$version" --file "$FM_HOME/results.txt" > "$OUT/dod-achieved.json"
if "$ROOT/bin/fm-control.sh" live-pi exit > "$OUT/unaccepted-exit.txt" 2>&1; then echo 'human acceptance gate bypassed'; exit 1; fi
"$ROOT/bin/fm-attach.sh" dod live-pi accept --version "$version" --file "$FM_HOME/confirm.txt" > "$OUT/dod-accepted.json"
"$ROOT/bin/fm-control.sh" live-pi exit > "$OUT/graceful-exit.txt" 2>&1
"$ROOT/bin/fm-attach.sh" state live-pi > "$OUT/stopped-state.json"
jq -e '.presence == "stopped" and .state == "done"' "$OUT/stopped-state.json"
"$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" pane get "$pane" > "$OUT/preserved-pane.json"
grep -qx 'uncommitted user material' "$FM_HOME/user-folder/private.txt"
[ ! -e "$FM_HOME/state/live-pi.meta" ]
echo 'ok: actual native builtin send/receipt/watcher/DoD/graceful exit; no model prompt'
