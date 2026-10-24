#!/usr/bin/env bash
# Behavior tests for bin/fm-ask.sh and for the three gates that consume it:
# dispatch (bin/fm-spawn.sh), captain hold (bin/fm-captain-hold.sh hold), and
# outcome acceptance (bin/fm-captain-hold.sh complete).
#
# The fixtures are public-safe synthetic asks that carry the same requirements
# shape as the real delegation failure: one goal line that also states an extra
# criterion, and a separate line placing authority for another workstream. They
# exist to show, through the public commands, that a narrowed brief is refused,
# that a narrowed RESULT is refused at outcome acceptance, that another task's
# restriction cannot stop this one at hold time, and that a complete or a
# properly bounded child brief is accepted.
#
# The critic runner is faked here on purpose: a fake verdict proves how a verdict
# is handled, never that a real model notices a real omission. The real
# one-shot call is recorded with its exact command in the task report.
set -u

# shellcheck source=tests/fixtures.sh
. "$(dirname "${BASH_SOURCE[0]}")/fixtures.sh"

ASK="$ROOT/bin/fm-ask.sh"
CAPTAIN_HOLD="$ROOT/bin/fm-captain-hold.sh"
BRIEF="$ROOT/bin/fm-brief.sh"
TMP_ROOT=$(fm_test_tmproot fm-ask)

# One task's recorded ask, equivalent to the delegated requirement set with the
# private conversation replaced by a neutral subject.
ask_text() {
  cat <<'EOF'
Bring the refactored module in line with the agreed refactoring rules and additionally minimize the use of the unknown type through type inference.
The companion agent already commits and pushes its own branch. Your job is only to report what still needs fixing.
EOF
}

write_ask_source() {  # <path>
  ask_text > "$1"
}

# A brief that carries the ask verbatim, cites each clause id, and declares the
# authority the ask records.
write_complete_brief() {  # <path> [authority]
  local path=$1 authority=${2:-'Authority: none'}
  {
    printf '# Task\n'
    printf "## Captain's intent\n"
    ask_text
    printf '\n'
    printf '## Firstmate spec\n'
    printf -- '- A1.1: compare the diff with the agreed refactoring rules and list every remaining type inference fix.\n'
    printf -- '- A1.2: report the remaining fixes only; the companion agent owns its commits and pushes.\n'
    printf '%s\n' "$authority"
  } > "$path"
}

write_narrow_brief() {  # <path>
  cat > "$1" <<'EOF'
# Task
## Captain's intent
Audit the current pull request against the agreed refactoring rules.

## Firstmate spec
- A1.1: audit the diff of the pull request.
Authority: none
EOF
}

write_guarded_dispatch_config() {  # <home> [profile-json]
  local home=$1 profile=${2:-'{"harness":"pi","model":"litellm/deepseek/deepseek-v4-flash","effort":"high"}'}
  mkdir -p "$home/config"
  printf '{"default":%s}\n' "$profile" > "$home/config/crew-dispatch.json"
}

# A fake critic binary. It receives the guarded profile flags and the prompt on
# stdin; it echoes the canned verdict the case expects, so the test asserts how
# a verdict is handled rather than what a model would say.
write_fake_critic() {  # <path> <verdict-json>
  local path=$1 verdict=$2
  {
    printf '#!/usr/bin/env bash\n'
    # shellcheck disable=SC2016  # Literal expansions belong to the fixture script.
    printf 'printf "%%s\\n" "$*" >> "${FM_TEST_CRITIC_ARGS:?}"\n'
    # shellcheck disable=SC2016  # Same: the expansion runs inside the fixture.
    printf 'printf "call\\n" >> "${FM_TEST_CRITIC_CALLS:?}"\n'
    printf 'cat > /dev/null\n'
    printf 'printf "%%s\\n" %q\n' "$verdict"
  } > "$path"
  chmod +x "$path"
}

run_ask() {  # <home> <args...>
  local home=$1
  shift
  FM_HOME="$home" FM_CONFIG_OVERRIDE="$home/config" "$ASK" "$@"
}

run_captain_with_critic() {  # <home> <critic> <args...>
  local home=$1 critic=$2
  shift 2
  FM_TEST_CRITIC_ARGS="$home/critic-args.txt" FM_TEST_CRITIC_CALLS="$home/critic-calls.txt" \
    FM_ASK_CRITIC_BIN="$critic" run_captain "$home" "$@"
}

run_captain() {  # <home> <args...>
  local home=$1
  shift
  FM_HOME="$home" FM_STATE_OVERRIDE="$home/state" FM_DATA_OVERRIDE="$home/data" \
    FM_CONFIG_OVERRIDE="$home/config" "$CAPTAIN_HOLD" "$@"
}

make_home() {  # <name>
  local home="$TMP_ROOT/$1"
  mkdir -p "$home/data" "$home/state" "$home/config" "$home/projects"
  printf '%s\n' "$home"
}

assert_rc() {  # <expected> <actual> <detail>
  [ "$2" = "$1" ] || fail "$3 (expected exit $1, got $2)"
}

test_record_keeps_the_captain_words_and_derives_clauses() {
  local home out clauses
  home=$(make_home record)
  write_ask_source "$home/message-1.txt"
  out=$(run_ask "$home" record demo-audit --file "$home/message-1.txt") \
    || fail "recording the captain ask failed: $out"
  assert_contains "$out" "ask-record: A1 recorded (2 clause(s))" \
    "the record did not report the derived clause count"
  clauses=$(run_ask "$home" clauses demo-audit) || fail "reading the recorded clauses failed"
  assert_contains "$clauses" "A1.1" "no first clause id was derived"
  assert_contains "$clauses" "additionally minimize the use of the unknown type" \
    "the extra criterion from the ask is missing from the derived clauses"
  assert_contains "$clauses" "A1.2" "no second clause id was derived"
  run_ask "$home" show demo-audit > "$home/show.out" || fail "showing the record failed"
  assert_grep "The companion agent already commits and pushes its own branch." "$home/show.out" \
    "the record dropped the verbatim captain words"
  pass "record keeps the captain words verbatim and derives one clause per source line"
}

test_record_replays_idempotently_and_appends_clarifications() {
  local home out
  home=$(make_home record-replay)
  write_ask_source "$home/message-1.txt"
  run_ask "$home" record demo-audit --file "$home/message-1.txt" >/dev/null \
    || fail "first record failed"
  out=$(run_ask "$home" record demo-audit --file "$home/message-1.txt") \
    || fail "replayed record failed"
  assert_contains "$out" "unchanged" "replaying the same words was not a no-op"
  [ "$(grep -c '^## Ask ' "$home/data/demo-audit/ask.md")" = 1 ] \
    || fail "a replay duplicated the recorded message"
  printf '%s\n' 'Report the remaining fixes as one bounded task for the companion agent.' \
    > "$home/message-2.txt"
  run_ask "$home" record demo-audit --file "$home/message-2.txt" >/dev/null \
    || fail "appending a clarification failed"
  [ "$(grep -c '^## Ask ' "$home/data/demo-audit/ask.md")" = 2 ] \
    || fail "a later clarification was not recorded as its own message"
  out=$(run_ask "$home" clauses demo-audit)
  assert_contains "$out" "A2.1" "the clarification produced no clause id"
  assert_contains "$out" "A1.1" "appending a clarification lost the earlier clause"
  pass "record is idempotent per message and appends later clarifications"
}

test_check_detects_the_dropped_criterion() {
  local home out rc
  home=$(make_home dropped)
  write_ask_source "$home/ask.txt"
  run_ask "$home" record demo-audit --file "$home/ask.txt" >/dev/null || fail "recording failed"
  write_narrow_brief "$home/brief.md"
  out=$(run_ask "$home" check demo-audit --brief "$home/brief.md" 2>&1); rc=$?
  assert_rc 1 "$rc" "a brief that dropped a recorded criterion was not refused"
  assert_contains "$out" "status: incomplete" "the refusal did not report an incomplete brief"
  assert_contains "$out" "missing-intent: A1.1" \
    "the refusal did not name the dropped criterion"
  pass "check refuses a brief whose intent replaced the recorded ask with a summary"
}

test_check_passes_a_complete_criterion_set() {
  local home out rc
  home=$(make_home complete)
  write_ask_source "$home/ask.txt"
  run_ask "$home" record demo-audit --file "$home/ask.txt" >/dev/null || fail "recording failed"
  write_complete_brief "$home/brief.md" \
    'Authority: allow:commit,push "The companion agent already commits and pushes its own branch."'
  out=$(run_ask "$home" check demo-audit --brief "$home/brief.md" 2>&1); rc=$?
  assert_rc 0 "$rc" "a complete brief was refused: $out"
  assert_contains "$out" "status: pass" "the complete brief did not pass"
  assert_contains "$out" "authority: allow:push" "the recorded authority was not read"
  pass "check passes a brief that carries every recorded criterion and its authority"
}

test_check_requires_a_spec_instruction_per_clause() {
  local home out rc
  home=$(make_home spec-gap)
  write_ask_source "$home/ask.txt"
  run_ask "$home" record demo-audit --file "$home/ask.txt" >/dev/null || fail "recording failed"
  cat > "$home/brief.md" <<'EOF'
# Task
## Captain's intent
Bring the refactored module in line with the agreed refactoring rules and additionally minimize the use of the unknown type through type inference.
The companion agent already commits and pushes its own branch. Your job is only to report what still needs fixing.

## Firstmate spec
- A1.1: compare the diff with the agreed rules.
Authority: none
EOF
  out=$(run_ask "$home" check demo-audit --brief "$home/brief.md" 2>&1); rc=$?
  assert_rc 1 "$rc" "a spec that never visited the authority clause was not refused"
  assert_contains "$out" "missing-spec: A1.2" \
    "the refusal did not name the clause the spec never visited"
  pass "check refuses a spec that silently drops a recorded clause"
}

test_check_skips_a_task_without_a_record() {
  local home out rc
  home=$(make_home no-record)
  write_narrow_brief "$home/brief.md"
  out=$(run_ask "$home" check older-task --brief "$home/brief.md" 2>&1); rc=$?
  assert_rc 0 "$rc" "a task with no recorded ask was blocked"
  assert_contains "$out" "status: skipped" "the skip was not explicit"
  pass "check skips a task that predates the record"
}

test_new_scaffold_requires_its_source() {
  local home out rc brief
  home=$(make_home scaffold)
  FM_HOME="$home" "$BRIEF" scaffold-task sample-project --scout >/dev/null \
    || fail "scouting the new task failed"
  assert_present "$home/data/scaffold-task/ask.md" \
    "a newly scaffolded task got no captain-ask record"
  brief="$home/data/scaffold-task/brief.md"
  out=$(run_ask "$home" check scaffold-task --brief "$brief" 2>&1); rc=$?
  assert_rc 1 "$rc" "a freshly scaffolded task passed the check with no recorded words"
  assert_contains "$out" "missing-ask: no captain words recorded yet" \
    "the refusal did not say the record is empty"
  pass "a newly scaffolded task cannot pass without recording the captain words"
}

test_dispatch_refuses_a_narrowed_brief_and_accepts_a_bounded_child() {
  local case_dir home proj wt fakebin out id=bounded-step
  case_dir="$TMP_ROOT/spawn"
  home=$(make_home spawn)
  proj="$case_dir/project"
  wt="$case_dir/wt"
  fakebin=$(fm_test_make_spawn_fakebin "$case_dir/fake")
  fm_test_spawn_home "$home" codex
  fm_git_worktree "$proj" "$wt" "wt-bounded"
  mkdir -p "$home/data/$id"
  write_ask_source "$home/data/$id/ask.txt"
  run_ask "$home" record "$id" --file "$home/data/$id/ask.txt" >/dev/null \
    || fail "recording the dispatch fixture ask failed"
  write_narrow_brief "$home/data/$id/brief.md"
  out=$(fm_test_run_spawn "$home" "$wt" "$fakebin" "$id" "$proj" --scout 2>&1) && {
    fail "dispatch launched a brief that dropped a recorded captain clause: $out"
  }
  assert_contains "$out" "missing-intent: A1.1" \
    "the dispatch refusal did not name the dropped clause"
  # A bounded step worker records only the step it was given, never the parent
  # program's whole ask, and its brief is accepted on its own terms.
  printf '%s\n' 'Move the payment command behind the effects boundary and keep its tests passing.' \
    > "$home/data/$id/step-ask.txt"
  rm -rf "$home/data/$id/ask.md"
  run_ask "$home" record "$id" --file "$home/data/$id/step-ask.txt" >/dev/null \
    || fail "recording the bounded step ask failed"
  cat > "$home/data/$id/brief.md" <<'EOF'
# Task
## Captain's intent
Move the payment command behind the effects boundary and keep its tests passing.

## Public intent
Move the payment command behind the declared effects boundary without changing behavior.

## Firstmate spec
- A1.1: move the payment command behind the effects boundary and keep its tests passing.
Authority: none
EOF
  out=$(fm_test_run_spawn "$home" "$wt" "$fakebin" "$id" "$proj" --scout 2>&1) \
    || fail "dispatch refused a properly bounded child brief: $out"
  pass "dispatch refuses a narrowed brief and launches a bounded one-clause child"
}

test_accept_refuses_an_oversized_package_before_any_paid_call() {
  local home out rc
  home=$(make_home accept-budget)
  write_guarded_dispatch_config "$home"
  write_ask_source "$home/ask.txt"
  run_ask "$home" record demo-audit --file "$home/ask.txt" >/dev/null || fail "recording failed"
  write_complete_brief "$home/brief.md"
  # A result document over the shared material budget must not be sampled: the
  # check refuses before spending a call and names the document.
  {
    printf '# Report\n'
    head -c 60000 /dev/zero | tr '\0' 'x'
    printf '\n'
  } > "$home/report.md"
  write_fake_critic "$home/critic.sh" \
    '{"clauses":[{"id":"A1.1","covered":true,"why":"ok"},{"id":"A1.2","covered":true,"why":"ok"}]}'
  out=$(FM_TEST_CRITIC_ARGS="$home/critic-args.txt" FM_TEST_CRITIC_CALLS="$home/critic-calls.txt" \
    FM_ASK_CRITIC_BIN="$home/critic.sh" \
    run_ask "$home" accept demo-audit --brief "$home/brief.md" --result "$home/report.md" 2>&1); rc=$?
  assert_rc 2 "$rc" "an oversized package was judged instead of refused"
  assert_contains "$out" "status: error" "the oversized package did not report an error"
  assert_contains "$out" "document: $home/report.md" \
    "the refusal did not name the oversized document"
  assert_contains "$out" "name compact current evidence" \
    "the refusal did not ask for compact current evidence"
  [ ! -s "$home/critic-calls.txt" ] \
    || fail "an oversized package still paid for a critic call"
  pass "accept refuses an oversized package before any paid call"
}

test_accept_refuses_a_result_that_misses_a_recorded_criterion() {
  local home out rc
  home=$(make_home accept-uncovered)
  write_guarded_dispatch_config "$home"
  write_ask_source "$home/ask.txt"
  run_ask "$home" record demo-audit --file "$home/ask.txt" >/dev/null || fail "recording failed"
  write_complete_brief "$home/brief.md"
  printf '# Report\n\nRules conformance only; no type inventory.\n' > "$home/report.md"
  write_fake_critic "$home/bad-critic.sh" \
    '{"clauses":[{"id":"A1.1","covered":false,"why":"no type inference inventory"},{"id":"A1.2","covered":true,"why":"remaining fixes reported"}]}'
  out=$(FM_TEST_CRITIC_ARGS="$home/critic-args.txt" FM_TEST_CRITIC_CALLS="$home/critic-calls.txt" \
    FM_ASK_CRITIC_BIN="$home/bad-critic.sh" \
    run_ask "$home" accept demo-audit --brief "$home/brief.md" --result "$home/report.md" 2>&1)
  rc=$?
  assert_rc 1 "$rc" "a result that omitted a recorded criterion was accepted"
  assert_contains "$out" "uncovered: A1.1: no type inference inventory" \
    "the verdict did not name the missed criterion"
  # The critic ran through the guarded profile, not a hardcoded model.
  assert_grep "--model litellm/deepseek/deepseek-v4-flash --thinking high" "$home/critic-args.txt" \
    "the critic did not receive the declared profile model and effort"
  pass "accept refuses a result whose text carries every id but omits a recorded criterion"
}

test_accept_passes_when_the_result_answers_every_criterion() {
  local home out rc
  home=$(make_home accept-pass)
  write_guarded_dispatch_config "$home"
  write_ask_source "$home/ask.txt"
  run_ask "$home" record demo-audit --file "$home/ask.txt" >/dev/null || fail "recording failed"
  write_complete_brief "$home/brief.md"
  printf '# Report\n\nRules differences and the type inventory are listed.\n' > "$home/report.md"
  write_fake_critic "$home/good-critic.sh" \
    '{"clauses":[{"id":"A1.1","covered":true,"why":"inventory listed"},{"id":"A1.2","covered":true,"why":"remaining fixes reported"}]}'
  out=$(FM_TEST_CRITIC_ARGS="$home/critic-args.txt" FM_TEST_CRITIC_CALLS="$home/critic-calls.txt" \
    FM_ASK_CRITIC_BIN="$home/good-critic.sh" \
    run_ask "$home" accept demo-audit --brief "$home/brief.md" --result "$home/report.md" 2>&1)
  rc=$?
  assert_rc 0 "$rc" "a complete result was refused: $out"
  assert_contains "$out" "status: pass" "the complete result did not pass"
  pass "accept passes a result that accounts for every recorded criterion"
}

test_accept_refuses_an_unguarded_or_non_pi_critic_profile() {
  local home out rc
  home=$(make_home accept-guard)
  write_ask_source "$home/ask.txt"
  run_ask "$home" record demo-audit --file "$home/ask.txt" >/dev/null || fail "recording failed"
  write_complete_brief "$home/brief.md"
  printf '# Report\n' > "$home/report.md"
  mkdir -p "$home/config"
  rm -f "$home/config/crew-dispatch.json"
  out=$(run_ask "$home" accept demo-audit --brief "$home/brief.md" --result "$home/report.md" 2>&1)
  rc=$?
  assert_rc 2 "$rc" "an acceptance check with no declared profile was not refused"
  assert_contains "$out" "no config/crew-dispatch.json" \
    "the refusal did not name the missing declared profile"
  write_guarded_dispatch_config "$home" '{"harness":"codex","model":"gpt-5.6-luna","effort":"high"}'
  out=$(run_ask "$home" accept demo-audit --brief "$home/brief.md" --result "$home/report.md" 2>&1)
  rc=$?
  assert_rc 2 "$rc" "a Codex-backed critic profile was accepted"
  assert_contains "$out" "runs only on the Pi lane" \
    "the refusal did not name the Pi-only critic lane"
  pass "accept refuses an unguarded or non-Pi critic profile instead of running another model"
}

test_hold_refuses_a_restriction_another_task_owns() {
  local home out rc
  command -v tasks-axi >/dev/null 2>&1 || { echo "skip: tasks-axi not found"; return 0; }
  home=$(make_home hold)
  cp "$ROOT/.tasks.toml" "$home/.tasks.toml"
  (cd "$home" && tasks-axi add proto "Prototype steps" --kind program --repo sample --start) >/dev/null 2>&1 \
    || fail "could not create the prototype fixture task"
  (cd "$home" && tasks-axi add audited-pr "Audited PR work" --kind scout --repo sample --start) >/dev/null 2>&1 \
    || fail "could not create the audited-work fixture task"
  mkdir -p "$home/data/proto"
  printf '%s\n' 'Run the prototype steps one bounded step at a time.' > "$home/proto-ask.txt"
  run_ask "$home" record proto --file "$home/proto-ask.txt" >/dev/null || fail "recording failed"
  printf '%s\n' 'Do not push or open a pull request on the audited branch until I say so.' \
    > "$home/other-task-words.txt"
  out=$(run_captain "$home" hold proto --reason "audited PR scope must settle first" \
    --origin audited-pr 2>&1); rc=$?
  assert_rc 1 "$rc" "a hold on a task with a recorded ask was accepted with no basis"
  assert_contains "$out" "--basis" "the refusal did not ask for the hold basis"
  out=$(run_captain "$home" hold proto --basis "captain:$home/other-task-words.txt" \
    --reason "audited PR scope must settle first" --origin audited-pr 2>&1); rc=$?
  assert_rc 1 "$rc" "another task's restriction was accepted as this hold's basis"
  assert_contains "$out" "not recorded for task proto" \
    "the refusal did not say the words belong to another task"
  out=$(run_captain "$home" hold proto --basis dependency:audited-pr \
    --reason "audited PR scope must settle first" --origin audited-pr 2>&1); rc=$?
  assert_rc 1 "$rc" "a dependency the backlog does not record was accepted"
  assert_contains "$out" "records no dependency on audited-pr" \
    "the refusal did not name the unrecorded dependency"
  pass "hold refuses another task's restriction when it claims the captain's words or a dependency"
}

test_question_basis_is_judged_against_the_task_record() {
  local home out rc
  command -v tasks-axi >/dev/null 2>&1 || { echo "skip: tasks-axi not found"; return 0; }
  home=$(make_home hold-question)
  cp "$ROOT/.tasks.toml" "$home/.tasks.toml"
  write_guarded_dispatch_config "$home"
  (cd "$home" && tasks-axi add proto "Prototype steps" --kind program --repo sample --start) >/dev/null 2>&1 \
    || fail "could not create the prototype fixture task"
  mkdir -p "$home/data/proto"
  # This record already permits the companion workstream to commit and push.
  cat > "$home/data/proto/ask.txt" <<'EOF'
Run the prototype steps one bounded step at a time.
The companion agent already commits and pushes its own branch; that is authorized.
EOF
  run_ask "$home" record proto --file "$home/data/proto/ask.txt" >/dev/null || fail "recording failed"
  {
    printf '# Task\n## Captain'"'"'s intent\n'
    cat "$home/data/proto/ask.txt"
    printf '\n## Firstmate spec\n- A1.1: run one bounded step.\n- A1.2: the companion agent commits and pushes.\n'
    printf 'Authority: allow:commit,push "The companion agent already commits and pushes its own branch; that is authorized."\n'
  } > "$home/data/proto/brief.md"
  write_fake_critic "$home/transfer-critic.sh" \
    '{"verdict":"transferred","why":"the reason forbids the push this task record authorizes","correction":"ask only for the human input this task leaves open, or record the captain words that stop it"}'
  write_fake_critic "$home/legit-critic.sh" \
    '{"verdict":"legitimate","why":"the reason asks for a human-only approval this record does not supply","correction":""}'
  # The allowed push is wrongly proposed as a question to forbid it.
  out=$(FM_TEST_CRITIC_ARGS="$home/critic-args.txt" FM_TEST_CRITIC_CALLS="$home/critic-calls.txt" \
    FM_ASK_CRITIC_BIN="$home/transfer-critic.sh" \
    run_captain "$home" hold proto --basis question \
      --reason "the audited branch must not push until the review scope settles" 2>&1); rc=$?
  assert_rc 1 "$rc" "a question used to forbid an authorized push was accepted as a hold"
  assert_contains "$out" "verdict: transferred" "the refusal did not report the transferred basis"
  assert_contains "$out" "correction:" "the refusal named no actionable correction"
  # A genuine missing human-only input stays a normal hold on the same task.
  out=$(FM_TEST_CRITIC_ARGS="$home/critic-args.txt" FM_TEST_CRITIC_CALLS="$home/critic-calls.txt" \
    FM_ASK_CRITIC_BIN="$home/legit-critic.sh" \
    run_captain "$home" hold proto --basis question \
      --reason "the captain must name the human owner of the final release approval" 2>&1); rc=$?
  assert_rc 0 "$rc" "a genuine captain question was refused: $out"
  pass "a question basis is judged against the task record: carried-over restriction refused, real human input held"
}

test_hold_keeps_a_genuine_captain_stop() {
  local home out rc
  command -v tasks-axi >/dev/null 2>&1 || { echo "skip: tasks-axi not found"; return 0; }
  home=$(make_home hold-stop)
  cp "$ROOT/.tasks.toml" "$home/.tasks.toml"
  (cd "$home" && tasks-axi add proto "Prototype steps" --kind program --repo sample --start) >/dev/null 2>&1 \
    || fail "could not create the prototype fixture task"
  mkdir -p "$home/data/proto"
  printf '%s\n' 'Run the prototype steps one bounded step at a time.' > "$home/proto-ask.txt"
  run_ask "$home" record proto --file "$home/proto-ask.txt" >/dev/null || fail "recording failed"
  printf '%s\n' 'Stop the prototype until I say otherwise.' > "$home/stop-words.txt"
  run_ask "$home" record proto --file "$home/stop-words.txt" >/dev/null || fail "recording failed"
  out=$(run_captain "$home" hold proto --basis "captain:$home/stop-words.txt" \
    --reason "the captain stopped the prototype" 2>&1); rc=$?
  assert_rc 0 "$rc" "a genuine recorded captain stop was refused: $out"
  pass "hold keeps a genuine recorded captain stop"
}

test_contains_reports_provenance_only() {
  local home out rc
  home=$(make_home contains)
  write_ask_source "$home/ask.txt"
  run_ask "$home" record demo-audit --file "$home/ask.txt" >/dev/null || fail "recording failed"
  printf '%s\n' 'The companion agent already commits and pushes its own branch.' > "$home/in.txt"
  out=$(run_ask "$home" contains demo-audit --file "$home/in.txt"); rc=$?
  assert_rc 0 "$rc" "recorded words were not found in the record"
  assert_contains "$out" "that proves provenance, not permission" \
    "the answer did not scope what a recorded phrase proves"
  printf '%s\n' 'Never touch the shared pipeline cache.' > "$home/out.txt"
  out=$(run_ask "$home" contains demo-audit --file "$home/out.txt"); rc=$?
  assert_rc 1 "$rc" "words this task never recorded were reported as recorded"
  pass "contains answers provenance only"
}

test_outcome_acceptance_binds_a_drifted_brief_and_the_result() {
  local home id out rc
  command -v tasks-axi >/dev/null 2>&1 || { echo "skip: tasks-axi not found"; return 0; }
  home=$(make_home acceptance)
  cp "$ROOT/.tasks.toml" "$home/.tasks.toml"
  write_guarded_dispatch_config "$home"
  id=drift-audit
  (cd "$home" && tasks-axi add "$id" "Audit the refactored module" --kind scout --repo sample --start) >/dev/null 2>&1 \
    || fail "could not create the acceptance fixture task"
  mkdir -p "$home/data/$id"
  write_ask_source "$home/data/$id/ask.txt"
  run_ask "$home" record "$id" --file "$home/data/$id/ask.txt" >/dev/null || fail "recording failed"
  write_complete_brief "$home/data/$id/brief.md"
  printf '# Audit\n\nRemaining fixes reported.\n' > "$home/data/$id/report.md"
  fm_write_meta "$home/state/$id.meta" "window=firstmate:fm-$id" "kind=scout" \
    "spawn_gen=fixture-$id"
  printf 'working: nothing pending\n' > "$home/state/$id.status"
  write_fake_critic "$home/good-critic.sh" \
    '{"clauses":[{"id":"A1.1","covered":true,"why":"ok"},{"id":"A1.2","covered":true,"why":"ok"}]}'
  out=$(run_captain_with_critic "$home" "$home/good-critic.sh" complete "$id" --none --fulfilled 2>&1); rc=$?
  assert_rc 0 "$rc" "acceptance refused a brief and result that answer the record: $out"
  assert_grep "--thinking high" "$home/critic-args.txt" \
    "the critic did not run with the declared profile for the fulfilled acceptance"
  [ "$(wc -l < "$home/critic-calls.txt")" = 1 ] \
    || fail "the acceptance did not call the critic exactly once"
  # An unchanged replay is answered from the recorded digest, not a second call.
  run_captain_with_critic "$home" "$home/good-critic.sh" complete "$id" --none --fulfilled > "$home/replay.out" 2>&1 \
    || fail "the unchanged replay was refused"
  assert_grep "status: reused" "$home/replay.out" "the replay did not reuse the recorded verdict"
  [ "$(wc -l < "$home/critic-calls.txt")" = 1 ] \
    || fail "an unchanged replay paid for a second critic call"
  # Narrowing the brief after dispatch is the drift acceptance must catch.
  write_narrow_brief "$home/data/$id/brief.md"
  out=$(run_captain_with_critic "$home" "$home/good-critic.sh" complete "$id" --none --fulfilled 2>&1); rc=$?
  assert_rc 1 "$rc" "acceptance accepted a brief that no longer carries the record"
  assert_contains "$out" "missing-intent: A1.1" "the refusal did not name the dropped clause"
  pass "outcome acceptance refuses a brief narrowed after dispatch"
}

test_partial_acceptance_does_not_pay_for_the_semantic_check() {
  local home id out rc
  command -v tasks-axi >/dev/null 2>&1 || { echo "skip: tasks-axi not found"; return 0; }
  home=$(make_home acceptance-partial)
  cp "$ROOT/.tasks.toml" "$home/.tasks.toml"
  write_guarded_dispatch_config "$home"
  id=partial-audit
  (cd "$home" && tasks-axi add "$id" "Audit the refactored module" --kind scout --repo sample --start) >/dev/null 2>&1 \
    || fail "could not create the acceptance fixture task"
  (cd "$home" && tasks-axi add "$id-more" "Finish the remaining audit" --kind ship --repo sample) >/dev/null 2>&1 \
    || fail "could not create the remaining-work fixture task"
  mkdir -p "$home/data/$id"
  write_ask_source "$home/data/$id/ask.txt"
  run_ask "$home" record "$id" --file "$home/data/$id/ask.txt" >/dev/null || fail "recording failed"
  write_complete_brief "$home/data/$id/brief.md"
  printf '# Audit\n\nPartial.\n' > "$home/data/$id/report.md"
  fm_write_meta "$home/state/$id.meta" "window=firstmate:fm-$id" "kind=scout" "spawn_gen=fixture-$id"
  write_fake_critic "$home/good-critic.sh" \
    '{"clauses":[{"id":"A1.1","covered":true,"why":"ok"},{"id":"A1.2","covered":true,"why":"ok"}]}'
  out=$(FM_TEST_CRITIC_ARGS="$home/critic-args.txt" FM_TEST_CRITIC_CALLS="$home/critic-calls.txt" \
    FM_ASK_CRITIC_BIN="$home/good-critic.sh" \
    run_captain "$home" complete "$id" --none --remaining "$id-more" 2>&1); rc=$?
  assert_rc 0 "$rc" "a partial acceptance with recorded remaining work was refused: $out"
  [ ! -s "$home/critic-calls.txt" ] \
    || fail "a partial acceptance paid for the semantic check instead of checking the named remainder"
  pass "partial acceptance checks the named remainder and spends no critic call"
}

test_outcome_acceptance_refuses_a_narrowed_result() {
  local home id out rc
  command -v tasks-axi >/dev/null 2>&1 || { echo "skip: tasks-axi not found"; return 0; }
  home=$(make_home acceptance-result)
  cp "$ROOT/.tasks.toml" "$home/.tasks.toml"
  write_guarded_dispatch_config "$home"
  id=result-audit
  (cd "$home" && tasks-axi add "$id" "Audit the refactored module" --kind scout --repo sample --start) >/dev/null 2>&1 \
    || fail "could not create the acceptance fixture task"
  mkdir -p "$home/data/$id"
  write_ask_source "$home/data/$id/ask.txt"
  run_ask "$home" record "$id" --file "$home/data/$id/ask.txt" >/dev/null || fail "recording failed"
  write_complete_brief "$home/data/$id/brief.md"
  printf '# Audit\n\nRules conformance only.\n' > "$home/data/$id/report.md"
  fm_write_meta "$home/state/$id.meta" "window=firstmate:fm-$id" "kind=scout" "spawn_gen=fixture-$id"
  write_fake_critic "$home/bad-critic.sh" \
    '{"clauses":[{"id":"A1.1","covered":false,"why":"type inventory absent"},{"id":"A1.2","covered":true,"why":"ok"}]}'
  out=$(FM_TEST_CRITIC_ARGS="$home/critic-args.txt" FM_TEST_CRITIC_CALLS="$home/critic-calls.txt" \
    FM_ASK_CRITIC_BIN="$home/bad-critic.sh" \
    run_captain "$home" complete "$id" --none --fulfilled 2>&1); rc=$?
  assert_rc 1 "$rc" "acceptance accepted a result that omits a recorded criterion"
  assert_contains "$out" "uncovered: A1.1" "the verdict did not name the missed criterion"
  assert_contains "$out" "outcome acceptance refused" "the refusal was not explicit about the gate"
  pass "outcome acceptance refuses a narrowed result before completion"
}

test_record_keeps_the_captain_words_and_derives_clauses
test_record_replays_idempotently_and_appends_clarifications
test_check_detects_the_dropped_criterion
test_check_passes_a_complete_criterion_set
test_check_requires_a_spec_instruction_per_clause
test_check_skips_a_task_without_a_record
test_new_scaffold_requires_its_source
test_dispatch_refuses_a_narrowed_brief_and_accepts_a_bounded_child
test_accept_refuses_an_oversized_package_before_any_paid_call
test_accept_refuses_a_result_that_misses_a_recorded_criterion
test_accept_passes_when_the_result_answers_every_criterion
test_accept_refuses_an_unguarded_or_non_pi_critic_profile
test_hold_refuses_a_restriction_another_task_owns
test_question_basis_is_judged_against_the_task_record
test_hold_keeps_a_genuine_captain_stop
test_contains_reports_provenance_only
test_outcome_acceptance_binds_a_drifted_brief_and_the_result
test_partial_acceptance_does_not_pay_for_the_semantic_check
test_outcome_acceptance_refuses_a_narrowed_result
