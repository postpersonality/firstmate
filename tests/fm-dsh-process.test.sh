#!/usr/bin/env bash
# Real argv identity, including spaces, later references and inherited markers.
set -eu
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
command -v node >/dev/null 2>&1 || { echo 'skip: node not found'; exit 0; }
NODE=$(node -p 'process.execPath')
[ -d /proc/self ] || { echo 'skip: Linux argv view unavailable'; exit 0; }
LAB=$(fm_test_tmproot fm-dsh-process)
pids=()
cleanup() { for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done; fm_test_remove_tree "$LAB"; }
trap cleanup EXIT
# shellcheck source=bin/fm-dsh-lib.sh
. "$ROOT/bin/fm-dsh-lib.sh"
# shellcheck source=bin/fm-agent-process-lib.sh
. "$ROOT/bin/fm-agent-process-lib.sh"
mkdir -p "$LAB/path with spaces/@deepseek-ai/dsh/lib"
script="$LAB/path with spaces/@deepseek-ai/dsh/lib/bin.js"
printf 'setInterval(() => {}, 1000);\n' > "$script"
"$NODE" "$script" &
pid=$!; pids+=("$pid")
sleep 0.1
fm_dsh_pid_matches "$pid" || { echo 'not ok - native entrypoint with spaces'; exit 1; }
[ "$(fm_agent_process_classify MainThread node '' "$pid")" = agent ]
[ "$(CLAUDECODE=1 "$ROOT/bin/fm-harness.sh" ancestry "$pid")" = 'comm dsh' ]
"$NODE" -e 'setInterval(() => {}, 1000)' "$script" &
pid=$!; pids+=("$pid")
sleep 0.1
! fm_dsh_pid_matches "$pid" || { echo 'not ok - node -e prompt claimed'; exit 1; }
[ "$(fm_agent_process_classify MainThread node '' "$pid")" = other ]
printf 'setInterval(() => {}, 1000);\n' > "$LAB/unrelated.js"
"$NODE" "$LAB/unrelated.js" --cwd "$script" &
pid=$!; pids+=("$pid")
sleep 0.1
if fm_dsh_pid_matches "$pid"; then echo "foreign script claimed"; exit 1; fi
if fm_dsh_script_matches /usr/bin/dsh; then echo "distributed shell claimed"; exit 1; fi
echo 'ok - DSH process identity uses bounded native argv, rejects foreign node and distributed shell'
