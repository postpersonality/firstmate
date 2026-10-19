#!/usr/bin/env bash
# Public adapter tables and fail-closed unsupported launch surfaces.
set -eu
# shellcheck source=tests/fixtures.sh
. "$(dirname "${BASH_SOURCE[0]}")/fixtures.sh"
# shellcheck source=bin/fm-control-lib.sh
. "$ROOT/bin/fm-control-lib.sh"
# shellcheck source=bin/fm-busy-lib.sh
. "$ROOT/bin/fm-busy-lib.sh"
LAB=$(fm_test_tmproot fm-dsh-harness)
fm_control_harness_supported dsh
fm_control_harness_supports_kind dsh scout
if fm_control_harness_supports_kind dsh secondmate; then echo "DSH secondmate must refuse"; exit 1; fi
[ "$(fm_control_interrupt_key dsh)" = C-c ]
[ "$(fm_control_interrupt_repeat dsh)" = 1 ]
[ -z "$(fm_control_interrupt_clear_key dsh)" ]
[ "$(fm_control_exit_command dsh)" = /exit ]
mkdir -p "$LAB/state"
GEN=$("$ROOT/bin/fm-busy-event.sh" arm "$LAB/state" fixture)
"$ROOT/bin/fm-busy-event.sh" apply "$LAB/state" fixture busy --gen "$GEN" --source dsh-acp --event prompt-start >/dev/null
[ "$(fm_busy_classify herdr fake:w1:p1 dsh fixture "$LAB/state")" = 'busy dsh-acp' ]
[ "$(fm_busy_classify herdr fake:w1:p1 claude fixture "$LAB/state")" = 'unknown source-mismatch' ]
"$ROOT/bin/fm-busy-event.sh" apply "$LAB/state" fixture unknown --gen "$GEN" --source dsh-acp --event prompt-ended >/dev/null
[ "$(fm_busy_classify herdr fake:w1:p1 dsh fixture "$LAB/state")" = 'unknown dsh-acp' ]
echo 'ok - DSH control contract and generation-bound busy trust retain unknown settlement'
mkdir -p "$LAB/home/data/refuse" "$LAB/home/state" "$LAB/home/config" "$LAB/project"
fm_test_spawn_brief "$LAB/home" refuse
FB=$(make_spawn_fakebin "$LAB/fake")
set +e
out=$(PATH="$FB:$PATH" FM_HOME="$LAB/home" FM_BACKEND=tmux FM_SPAWN_NO_GUARD=1 "$ROOT/bin/fm-spawn.sh" refuse "$LAB/project" --harness dsh --scout --backend tmux 2>&1)
rc=$?
set -e
[ "$rc" != 0 ]
assert_contains "$out" 'verified only for local Linux Herdr workers' 'DSH launched on an unsupported backend'
[ ! -f "$LAB/home/state/refuse.meta" ]
set +e
out=$(PATH="$FB:$PATH" FM_HOME="$LAB/home" FM_BACKEND=tmux FM_SPAWN_NO_GUARD=1 "$ROOT/bin/fm-spawn.sh" refuse "$LAB/project" --harness dsh --secondmate --backend tmux 2>&1)
rc=$?
set -e
[ "$rc" != 0 ]
assert_contains "$out" 'cannot run a secondmate' 'DSH launched a secondmate without a primary protocol'
echo 'ok - DSH refuses unsupported backend and secondmate before creating any task record'
