#!/usr/bin/env bash
# Worker profile guard: config/crew-dispatch.json worker_profiles.allowed.
#
# docs/configuration.md "Worker profile guard (worker_profiles.allowed)" owns the
# contract and bin/fm-worker-profile-lib.sh the decision. These tests drive the
# real bin/fm-spawn.sh in a throwaway FM_HOME with a fake launcher that records
# every launch payload, so a refusal is proven by an EMPTY launch log rather than
# by a message alone: no isolated copy, task record, endpoint, or model call.
#
# The relaunch half of the same guarantee lives with the relaunch owner in
# tests/fm-control-relaunch.test.sh. Startup diagnostics for the block are
# covered in tests/fm-bootstrap.test.sh.
set -u

# shellcheck source=tests/fixtures.sh
. "$(dirname "${BASH_SOURCE[0]}")/fixtures.sh"

TMP_ROOT=$(fm_test_tmproot fm-worker-profile-guard)
PI_MODEL=litellm/deepseek/deepseek-v4-flash
unset LAVISH_AXI_HOST

make_guard_probe() {  # <fakebin> <tool>
  cat > "$1/$2" <<'SH'
#!/usr/bin/env bash
set -u
if [ "${1:-}" = --version ]; then
  printf 'Pi %s\n' "${FM_FAKE_PI_VERSION:-0.84.0}"
elif [ "${1:-}" = --help ]; then
  printf '%s\n' "Pi ${FM_FAKE_PI_VERSION:-0.84.0}" 'Options: --help --tui-mode <mode> --approve'
fi
exit 0
SH
  chmod +x "$1/$2"
}

make_case() {  # <name> <crew-harness> <ids...>
  local name=$1 harness=$2
  shift 2
  local case_dir home proj wt launchlog fakebin id
  case_dir="$TMP_ROOT/$name"
  home="$case_dir/home"
  proj="$case_dir/project"
  wt="$case_dir/wt"
  launchlog="$case_dir/launch.log"
  fakebin=$(fm_test_make_spawn_fakebin "$case_dir/fake")
  make_guard_probe "$fakebin" pi
  make_guard_probe "$fakebin" pi-signed
  fm_test_spawn_home "$home" "$harness"
  fm_git_worktree "$proj" "$wt" "wt-$name"
  for id in "$@"; do fm_test_spawn_brief "$home" "$id"; done
  printf '%s\n' "$case_dir|$home|$proj|$wt|$fakebin|$launchlog"
}

read_case() {
  IFS='|' read -r CASE_DIR HOME_DIR PROJ_DIR WT_DIR FAKEBIN_DIR LAUNCH_LOG <<EOF
$1
EOF
}

# The captain-approved pair, plus a second profile that already satisfies the
# standing xhigh pin without any exception.
write_policy() {  # <home>
  printf '%s\n' '{
  "worker_profiles": {
    "allowed": [
      {"harness": "pi", "model": "litellm/deepseek/deepseek-v4-flash", "effort": "high", "effort_pin_override": "high"},
      {"harness": "claude", "model": "claude-opus-4-5", "effort": "xhigh"}
    ]
  },
  "default": {"harness": "pi", "model": "litellm/deepseek/deepseek-v4-flash", "effort": "high"}
}' > "$1/config/crew-dispatch.json"
}

run_spawn() {  # <home> <wt> <fakebin> <launchlog> <args...>
  local home=$1 wt=$2 fakebin=$3 launchlog=$4
  shift 4
  : > "$launchlog"
  : > "$(dirname "$launchlog")/pane.log"
  CLAUDE_CONFIG_DIR="${FM_TEST_CLAUDE_CONFIG_DIR:-}" FM_FAKE_LAUNCH_LOG="$launchlog" \
    FM_FAKE_PANE_LOG="$(dirname "$launchlog")/pane.log" \
    GROK_HOME="$home/grok-home" \
    fm_test_run_spawn "$home" "$wt" "$fakebin" "$@"
}

run_ship_spawn() { run_spawn "$@" --mode no-mistakes --yolo off; }

assert_meta_profile() {  # <meta> <harness> <model> <effort>
  assert_grep "harness=$2" "$1" "meta missing harness=$2"
  assert_grep "model=$3" "$1" "meta missing model=$3"
  assert_grep "effort=$4" "$1" "meta missing effort=$4"
}

# A refusal must leave nothing behind: no pane input at all (so no isolated-copy
# acquisition, endpoint step, or launcher invocation), no task record, and no
# per-task lifecycle wiring.
assert_refused_before_launch() {  # <out> <status> <label> <home> <id> <launchlog>
  local out=$1 status=$2 label=$3 home=$4 id=$5 launchlog=$6 pane
  pane=$(dirname "$launchlog")/pane.log
  [ "$status" -ne 0 ] || fail "$label: the launch was accepted (exit 0)"$'\n'"$out"
  [ ! -s "$launchlog" ] || fail "$label: a launcher invocation was recorded: $(cat "$launchlog")"
  [ ! -s "$pane" ] || fail "$label: the pane received input before the refusal: $(cat "$pane")"
  [ ! -e "$home/state/$id.meta" ] || fail "$label: a task record was published"
  [ ! -e "$home/state/$id.busy-gen" ] || fail "$label: lifecycle wiring was provisioned"
}

test_forbidden_explicit_profile_is_refused_before_launch() {
  local rec id=guard-explicit-z1 out status
  rec=$(make_case guard-explicit codex "$id")
  read_case "$rec"
  write_policy "$HOME_DIR"

  out=$(run_ship_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$LAUNCH_LOG" "$id" "$PROJ_DIR" \
    --harness codex --model gpt-5.6-sol --effort xhigh 2>&1)
  status=$?
  assert_refused_before_launch "$out" "$status" "explicit codex/xhigh" "$HOME_DIR" "$id" "$LAUNCH_LOG"
  assert_contains "$out" "is not an allowed worker profile" "the refusal did not name the policy"
  assert_contains "$out" "allowed: pi/litellm/deepseek/deepseek-v4-flash/high" \
    "the refusal did not state the allowed profiles"
  pass "an explicitly requested forbidden profile is refused before any launcher, record, or local copy"
}

test_pi_on_a_codex_backed_model_is_refused() {
  local rec id=guard-pi-provider-z2 out status
  rec=$(make_case guard-pi-provider pi "$id")
  read_case "$rec"
  write_policy "$HOME_DIR"

  # The harness alone is never a boundary: the exact model string decides.
  out=$(run_ship_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$LAUNCH_LOG" "$id" "$PROJ_DIR" \
    --harness pi --model codex-native/gpt-6-astra --effort high 2>&1)
  status=$?
  assert_refused_before_launch "$out" "$status" "pi on a codex-backed model" "$HOME_DIR" "$id" "$LAUNCH_LOG"
  pass "a Pi launch on a disallowed provider/model identity is refused as well"
}

test_scout_forbidden_profile_is_refused() {
  local rec id=guard-scout-z3 out status
  rec=$(make_case guard-scout codex "$id")
  read_case "$rec"
  write_policy "$HOME_DIR"

  out=$(run_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$LAUNCH_LOG" "$id" "$PROJ_DIR" \
    --scout --harness codex --model gpt-5.6-sol --effort xhigh 2>&1)
  status=$?
  assert_refused_before_launch "$out" "$status" "forbidden scout profile" "$HOME_DIR" "$id" "$LAUNCH_LOG"
  pass "scout launches are covered by the same policy"
}

test_raw_launch_command_is_refused() {
  local rec id=guard-raw-z4 out status
  rec=$(make_case guard-raw pi "$id")
  read_case "$rec"
  write_policy "$HOME_DIR"

  out=$(run_ship_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$LAUNCH_LOG" "$id" "$PROJ_DIR" \
    'codex --model gpt-5.6-sol' --effort xhigh 2>&1)
  status=$?
  assert_refused_before_launch "$out" "$status" "raw launch command" "$HOME_DIR" "$id" "$LAUNCH_LOG"
  assert_contains "$out" "raw launch command cannot be verified" "the raw-launch refusal was not actionable"
  pass "a raw launch command cannot bypass the declared worker profiles"
}

test_malformed_policy_fails_closed() {
  local rec id out status body n=0
  rec=$(make_case guard-malformed pi)
  read_case "$rec"
  for body in \
    '{"worker_profiles":{}}' \
    '{"worker_profiles":{"allowed":[]}}' \
    '{"worker_profiles":{"allowed":[{"harness":"pi","model":"litellm/deepseek/deepseek-v4-flash"}]}}' \
    '{"worker_profiles":{"allowed":[{"harness":"pi","model":"m","effort":"high","effort_pin_override":"xhigh"}]}}' \
    '{"worker_profiles":{"allowed":[{"harness":"pi","model":"m","effort":"high"}]},"default":{"harness":"codex","model":"gpt-5.6-sol","effort":"xhigh"}}' \
    '{"worker_profiles":{"allowed":[{"harness":"pi","model":"m","effort":"high"}]},"rules":[{"when":"deep design","use":{"harness":"codex","model":"gpt-5.6-sol","effort":"xhigh"}}]}'; do
    n=$((n + 1))
    id="guard-malformed-z5-$n"
    fm_test_spawn_brief "$HOME_DIR" "$id"
    printf '%s\n' "$body" > "$HOME_DIR/config/crew-dispatch.json"
    out=$(run_ship_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$LAUNCH_LOG" "$id" "$PROJ_DIR" \
      --harness pi --model m --effort high 2>&1)
    status=$?
    assert_refused_before_launch "$out" "$status" "malformed policy $body" "$HOME_DIR" "$id" "$LAUNCH_LOG"
    assert_contains "$out" "worker_profiles" "the malformed-policy refusal did not name the block"
  done
  pass "a malformed, empty, or non-member policy refuses launches instead of reading as no policy"
}

test_batch_cannot_smuggle_a_forbidden_profile() {
  local rec id1=guard-batch-z6a id2=guard-batch-z6b out status
  rec=$(make_case guard-batch codex "$id1" "$id2")
  read_case "$rec"
  write_policy "$HOME_DIR"

  out=$(run_ship_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$LAUNCH_LOG" \
    "$id1=$PROJ_DIR" "$id2=$PROJ_DIR" --harness codex --model gpt-5.6-sol --effort xhigh 2>&1)
  status=$?
  [ "$status" -ne 0 ] || fail "a forbidden shared batch profile was accepted"$'\n'"$out"
  [ ! -s "$LAUNCH_LOG" ] || fail "a batch launcher invocation was recorded: $(cat "$LAUNCH_LOG")"
  [ ! -e "$HOME_DIR/state/$id1.meta" ] && [ ! -e "$HOME_DIR/state/$id2.meta" ] \
    || fail "a refused batch published a task record"
  pass "a batch dispatch cannot smuggle a forbidden profile through its shared harness"
}

test_batch_allowed_profile_still_launches() {
  local rec id1=guard-batch-ok-z7a id2=guard-batch-ok-z7b out status launch
  rec=$(make_case guard-batch-ok claude "$id1" "$id2")
  read_case "$rec"
  write_policy "$HOME_DIR"

  out=$(run_ship_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$LAUNCH_LOG" \
    "$id1=$PROJ_DIR" "$id2=$PROJ_DIR" --harness claude --model claude-opus-4-5 --effort xhigh)
  expect_code 0 "$?" "an allowed batch profile was refused: $out"
  assert_meta_profile "$HOME_DIR/state/$id1.meta" claude claude-opus-4-5 xhigh
  assert_meta_profile "$HOME_DIR/state/$id2.meta" claude claude-opus-4-5 xhigh
  launch=$(cat "$LAUNCH_LOG")
  assert_contains "$launch" "--model 'claude-opus-4-5'" "the allowed batch launch lost its model"
  assert_contains "$launch" "--effort 'xhigh'" "the allowed batch launch lost its effort"
  pass "a batch dispatch of an allowed profile still launches"
}

test_declared_profile_runs_at_its_own_effort_under_the_pin() {
  local rec id=guard-exception-z8 out status launch
  rec=$(make_case guard-exception pi "$id")
  read_case "$rec"
  write_policy "$HOME_DIR"
  printf 'xhigh\n' > "$HOME_DIR/config/crew-effort"

  out=$(run_ship_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$LAUNCH_LOG" "$id" "$PROJ_DIR" \
    --harness pi --model "$PI_MODEL" --effort high 2>&1)
  status=$?
  expect_code 0 "$status" "the declared profile with a standing exception was refused: $out"
  assert_meta_profile "$HOME_DIR/state/$id.meta" pi "$PI_MODEL" high
  launch=$(cat "$LAUNCH_LOG")
  assert_contains "$launch" "--thinking 'high'" "the declared effort did not reach the launcher"
  assert_not_contains "$launch" "--thinking 'xhigh'" "the global pin overrode the declared exception"
  pass "an allowed profile with a declared exception runs at its own level while the pin stays in force"
}

test_unapproved_effort_change_stays_refused() {
  local rec id out status
  rec=$(make_case guard-pin pi)
  read_case "$rec"
  write_policy "$HOME_DIR"
  printf 'xhigh\n' > "$HOME_DIR/config/crew-effort"

  # The approved pair is allowed at high only; asking for the pinned level on it
  # is an unapproved change and must not be selected around.
  id=guard-pin-z9a
  fm_test_spawn_brief "$HOME_DIR" "$id"
  out=$(run_ship_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$LAUNCH_LOG" "$id" "$PROJ_DIR" \
    --harness pi --model "$PI_MODEL" --effort xhigh 2>&1)
  status=$?
  assert_refused_before_launch "$out" "$status" "unapproved effort change on the approved pair" \
    "$HOME_DIR" "$id" "$LAUNCH_LOG"

  # A profile allowed at xhigh is not allowed at high.
  id=guard-pin-z9b
  fm_test_spawn_brief "$HOME_DIR" "$id"
  out=$(run_ship_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$LAUNCH_LOG" "$id" "$PROJ_DIR" \
    --harness claude --model claude-opus-4-5 --effort high 2>&1)
  status=$?
  assert_refused_before_launch "$out" "$status" "allowed profile at another effort" \
    "$HOME_DIR" "$id" "$LAUNCH_LOG"
  pass "the standing pin and the exact allowed tuple still refuse every unapproved effort"
}

test_bare_launch_never_inherits_a_runtime_default_profile() {
  local rec id=guard-bare-z10 out status
  rec=$(make_case guard-bare codex "$id")
  read_case "$rec"
  write_policy "$HOME_DIR"

  # No harness at all: the existing dispatch consultation backstop refuses rather
  # than resolving the primary's own runtime, so nothing is inherited.
  out=$(run_ship_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$LAUNCH_LOG" "$id" "$PROJ_DIR" 2>&1)
  status=$?
  assert_refused_before_launch "$out" "$status" "bare launch" "$HOME_DIR" "$id" "$LAUNCH_LOG"
  assert_contains "$out" "pass an explicit harness resolved from the dispatch rules" \
    "the bare-launch refusal no longer keeps the dispatch consultation backstop"
  pass "a bare launch inherits no runtime default and keeps the dispatch consultation backstop"
}

test_home_without_the_policy_is_unchanged() {
  local rec id=guard-nopolicy-z11 out status
  rec=$(make_case guard-nopolicy codex "$id")
  read_case "$rec"

  out=$(run_ship_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$LAUNCH_LOG" "$id" "$PROJ_DIR" \
    --harness codex --model gpt-5.6-sol --effort xhigh)
  status=$?
  expect_code 0 "$status" "a home without the policy changed behavior: $out"
  assert_meta_profile "$HOME_DIR/state/$id.meta" codex gpt-5.6-sol xhigh
  pass "a home that does not declare worker profiles keeps its current launches"
}

make_seeded_secondmate_home() {  # <home> <id>
  local home=$1 id=$2
  mkdir -p "$home/bin" "$home/data"
  printf '# Firstmate\n' > "$home/AGENTS.md"
  printf '%s\n' "$id" > "$home/.fm-secondmate-home"
  printf 'charter for %s\n' "$id" > "$home/data/charter.md"
  printf '%s\n' 'projects/' 'state/' 'data/' 'config/' '.no-mistakes/' > "$home/.gitignore"
  git -C "$home" init -q -b main
}

test_secondmate_agent_keeps_its_own_separate_scope() {
  local rec id=guard-secondmate-z12 sm out status
  rec=$(make_case guard-secondmate codex "$id")
  read_case "$rec"
  write_policy "$HOME_DIR"
  sm="$CASE_DIR/secondmate-home"
  make_seeded_secondmate_home "$sm" "$id"

  # A secondmate agent is not a crewmate: it keeps its own explicit
  # config/secondmate-harness scope, which the policy block does not govern.
  out=$(run_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$LAUNCH_LOG" "$id" "$sm" --secondmate)
  status=$?
  expect_code 0 "$status" "a secondmate spawn must keep its own scope: $out"
  assert_contains "$out" "spawned $id harness=codex kind=secondmate" \
    "the secondmate launch no longer uses its own harness resolution"
  assert_grep "kind=secondmate" "$HOME_DIR/state/$id.meta" "the secondmate record lost its kind"
  pass "a secondmate agent keeps its documented separate scope while crewmates stay guarded"
}

test_forbidden_explicit_profile_is_refused_before_launch
test_pi_on_a_codex_backed_model_is_refused
test_scout_forbidden_profile_is_refused
test_raw_launch_command_is_refused
test_malformed_policy_fails_closed
test_batch_cannot_smuggle_a_forbidden_profile
test_batch_allowed_profile_still_launches
test_declared_profile_runs_at_its_own_effort_under_the_pin
test_unapproved_effort_change_stays_refused
test_bare_launch_never_inherits_a_runtime_default_profile
test_home_without_the_policy_is_unchanged
test_secondmate_agent_keeps_its_own_separate_scope
echo "# all fm-worker-profile-guard tests passed"
