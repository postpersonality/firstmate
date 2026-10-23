#!/usr/bin/env bash
# tests/fm-spawn-herdr-project-space.test.sh - public fm-spawn.sh contract for
# --herdr-project-space: the refusals around it, its threading into Herdr
# project-Space placement for ship and scout launches, and an unchanged default
# path. A stateful fake herdr CLI backs the adapter, so no live Herdr session is
# touched and no default endpoint exists.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=tests/herdr-test-safety.sh
. "$(dirname "${BASH_SOURCE[0]}")/herdr-test-safety.sh"
# shellcheck source=tests/fixtures.sh
. "$(dirname "${BASH_SOURCE[0]}")/fixtures.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found (required by the herdr adapter)"; exit 0; }
herdr_forget_inherited_pane

SPAWN="$ROOT/bin/fm-spawn.sh"
TMP_ROOT=$(fm_test_tmproot fm-spawn-herdr-project-space)
FAKE_HERDR_DIR="$TMP_ROOT/fake-herdr"
PROJECT="$TMP_ROOT/project"
mkdir -p "$FAKE_HERDR_DIR"
git init -q "$PROJECT" || fail 'could not initialize the project fixture'
export HERDR_SESSION=fm-herdr-space-selector-fake
export FM_BACKEND=herdr
export FM_FAKE_HERDR_DIR="$FAKE_HERDR_DIR"
export FM_FAKE_HERDR_PROJECT="$PROJECT"

# A stateful fake CLI: two identity-matching project Spaces in the selected
# session, an empty tab list, and a deliberately unparseable tab-create
# response. Placement therefore reaches the creation step - which is where the
# selected Space becomes observable - and then stops without launching a worker.
cat > "$FAKE_HERDR_DIR/herdr" <<'SH'
#!/usr/bin/env bash
set -u
D=${FM_FAKE_HERDR_DIR:?}
{ printf 'HERDR_SESSION=%s' "${HERDR_SESSION:-}"; for a in "$@"; do printf '\x1f%s' "$a"; done; printf '\n'; } >> "$D/log"
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
  --session) shift 2 ;;
  *)
    args+=("$1")
    shift
    ;;
  esac
done
set -- "${args[@]+"${args[@]}"}"
case "${1:-} ${2:-}" in
'status --json') printf '{"client":{"version":"0.7.1","protocol":14},"server":{"running":true,"protocol":14}}\n' ;;
'session list') printf '{"sessions":[{"name":"%s","running":true,"socket_path":"%s/herdr.sock"}]}\n' "${HERDR_SESSION:-default}" "$D" ;;
'workspace list') printf '{"result":{"workspaces":[{"workspace_id":"w1","label":"project"},{"workspace_id":"w2","label":"project"}]}}\n' ;;
'pane list') jq -n --arg p "$FM_FAKE_HERDR_PROJECT" '{result:{panes:[{workspace_id:"w1",tab_id:"w1:t1",pane_id:"w1:p1",cwd:$p},{workspace_id:"w2",tab_id:"w2:t1",pane_id:"w2:p1",cwd:$p}]}}' ;;
'tab list') printf '{"result":{"tabs":[]}}\n' ;;
'pane get') printf '{"error":{"code":"pane_not_found"}}\n' >&2; exit 1 ;;
'tab create') : ;;
'workspace create') printf '{"result":{"workspace":{"workspace_id":"wnew"},"tab":{"tab_id":"seed"}}}\n' ;;
*) : ;;
esac
exit 0
SH
chmod +x "$FAKE_HERDR_DIR/herdr"

herdr_log() {
  cat "$FAKE_HERDR_DIR/log"
}

reset_herdr_log() {
  : > "$FAKE_HERDR_DIR/log"
}

setup_home() { # <suffix> -> echoes the home path
  local home="$TMP_ROOT/home-$1"
  fm_test_spawn_home "$home"
  printf '%s\n' "$home"
}

run_spawn() { # <home> [fm-spawn args...]
  local home=$1
  shift
  FM_ROOT_OVERRIDE='' FM_HOME="$home" HOME="$home/user-home" \
    FM_STATE_OVERRIDE="$home/state" FM_DATA_OVERRIDE="$home/data" \
    FM_PROJECTS_OVERRIDE="$home/projects" FM_CONFIG_OVERRIDE="$home/config" \
    FM_SPAWN_NO_GUARD=1 PATH="$FAKE_HERDR_DIR:$PATH" \
    "$SPAWN" "$@" 2>&1
}

# The option is public surface: it must be discoverable in --help.
test_help_documents_the_option() {
  local out
  out=$("$SPAWN" --help)
  printf '%s\n' "$out" | grep -F -- '--herdr-project-space <workspace-id>' >/dev/null \
    || fail '--help does not document --herdr-project-space'
  pass 'fm-spawn --help documents --herdr-project-space'
}

# With no selector the ambiguity refusal is unchanged, and the run creates no
# tab and no Space.
test_default_path_keeps_refusing_ambiguity() {
  local home out rc
  home=$(setup_home ambiguity)
  fm_test_spawn_brief "$home" space-amb
  reset_herdr_log
  out=$(run_spawn "$home" space-amb "$PROJECT" --mode no-mistakes --yolo off)
  rc=$?
  [ "$rc" -ne 0 ] || fail 'two identity-matching project Spaces were resolved without a selection'
  assert_contains "$out" 'ambiguous herdr project Space' 'ambiguity refusal diagnostic missing'
  assert_contains "$out" 'w1 w2' 'ambiguity refusal did not name both candidate Spaces'
  assert_not_contains "$(herdr_log)" $'\x1ftab\x1fcreate' 'refused spawn opened a tab'
  assert_not_contains "$(herdr_log)" $'\x1fworkspace\x1fcreate' 'refused spawn created a Space'
  [ ! -e "$home/state/space-amb.meta" ] || fail 'refused spawn published a task record'
  pass 'without a selector, several matching project Spaces still refuse without creating anything'
}

# A ship launch with an exact valid selector places its tab in that Space and
# never creates, moves, renames, closes or adopts a Space.
test_ship_launch_uses_the_selected_space() {
  local home out rc log
  home=$(setup_home selected)
  fm_test_spawn_brief "$home" space-sel
  reset_herdr_log
  out=$(run_spawn "$home" space-sel "$PROJECT" --mode no-mistakes --yolo off --herdr-project-space w2)
  rc=$?
  # The fake's tab-create response is unparseable on purpose, so placement stops
  # right after the creation call this case asserts on.
  [ "$rc" -ne 0 ] || fail 'the fake tab-create response should have stopped the spawn'
  assert_contains "$out" 'could not parse tab/pane id from herdr tab create output' 'spawn did not reach the tab-create step'
  log=$(herdr_log)
  assert_contains "$log" $'\x1ftab\x1fcreate\x1f--workspace\x1fw2' 'the worker tab was not created in the selected Space'
  assert_contains "$log" $'\x1f--no-focus' 'the worker tab was created without the no-focus behavior'
  assert_not_contains "$log" $'\x1f--workspace\x1fw1' 'placement used another matching Space'
  assert_not_contains "$log" $'\x1fworkspace\x1fcreate' 'a selected placement created a Space'
  for out in move rename close; do
    assert_not_contains "$log" $'\x1f'"$out" "a selected placement ran $out"
  done
  [ ! -e "$home/state/space-sel.meta" ] || fail 'the stopped spawn published a task record'
  pass 'a ship launch with an exact valid selection opens its tab in that Space and mutates no other Space'
}

# A scout launch shares the placement path, so it accepts the same selection.
test_scout_launch_uses_the_selected_space() {
  local home rc log
  home=$(setup_home scout)
  fm_test_spawn_brief "$home" space-scout
  reset_herdr_log
  run_spawn "$home" space-scout "$PROJECT" --scout --herdr-project-space w1 >/dev/null
  rc=$?
  [ "$rc" -ne 0 ] || fail 'the fake tab-create response should have stopped the scout spawn'
  log=$(herdr_log)
  assert_contains "$log" $'\x1ftab\x1fcreate\x1f--workspace\x1fw1' 'the scout tab was not created in the selected Space'
  assert_not_contains "$log" $'\x1fworkspace\x1fcreate' 'a selected scout placement created a Space'
  pass 'a scout launch with an exact valid selection opens its tab in that Space'
}

# An id that is not an identity-confirmed match - a stale or other-session id,
# a label, an unrelated Space - never becomes authority and never creates one.
test_unverified_selection_refuses() {
  local home out log
  home=$(setup_home unverified)
  fm_test_spawn_brief "$home" space-bad
  reset_herdr_log
  if out=$(run_spawn "$home" space-bad "$PROJECT" --mode no-mistakes --yolo off --herdr-project-space w9); then
    fail 'an unverified selection id was accepted'
  fi
  assert_contains "$out" 'is not one of the identity-confirmed project Spaces' 'unverified-selection refusal missing'
  log=$(herdr_log)
  assert_not_contains "$log" $'\x1ftab\x1fcreate' 'an unverified selection opened a tab'
  assert_not_contains "$log" $'\x1fworkspace\x1fcreate' 'an unverified selection created a Space'
  reset_herdr_log
  if out=$(run_spawn "$home" space-bad "$PROJECT" --mode no-mistakes --yolo off --herdr-project-space project); then
    fail 'a Space label was accepted as a selection'
  fi
  assert_contains "$out" 'is not one of the identity-confirmed project Spaces' 'label selection refusal missing'
  assert_not_contains "$(herdr_log)" $'\x1fworkspace\x1fcreate' 'a label selection created a Space'
  reset_herdr_log
  if out=$(run_spawn "$home" space-bad "$PROJECT" --mode no-mistakes --yolo off --herdr-project-space $'w1\nw9'); then
    fail 'a multiline selection was accepted'
  fi
  assert_contains "$out" 'is not one of the identity-confirmed project Spaces' 'multiline selection refusal missing'
  assert_not_contains "$(herdr_log)" $'\x1ftab\x1fcreate' 'a multiline selection opened a tab'
  pass 'an unverified selection id or a label refuses and creates nothing'
}

# The option belongs to fresh Herdr ship and scout launches only.
test_option_is_refused_outside_its_scope() {
  local home out rc
  home=$(setup_home scope)
  fm_test_spawn_brief "$home" space-tmux
  fm_test_spawn_brief "$home" space-mate
  reset_herdr_log
  out=$(FM_BACKEND=tmux run_spawn "$home" space-tmux "$PROJECT" --mode no-mistakes --yolo off --herdr-project-space w1)
  rc=$?
  [ "$rc" -ne 0 ] || fail 'the option was accepted on a non-herdr backend'
  assert_contains "$out" "applies only to the herdr backend" 'non-herdr refusal diagnostic missing'
  out=$(run_spawn "$home" space-mate "$home" --secondmate --herdr-project-space w1)
  rc=$?
  [ "$rc" -ne 0 ] || fail 'the option was accepted on a secondmate launch'
  assert_contains "$out" 'a secondmate keeps its own home container' 'secondmate refusal diagnostic missing'
  out=$(run_spawn "$home" space-rel --relaunch --herdr-project-space w1)
  rc=$?
  [ "$rc" -ne 0 ] || fail 'the option was accepted on a relaunch'
  assert_contains "$out" "stays bound to the task's recorded endpoint" 'relaunch refusal diagnostic missing'
  out=$(run_spawn "$home" "space-b1=$PROJECT" --mode no-mistakes --yolo off --herdr-project-space w1)
  rc=$?
  [ "$rc" -ne 0 ] || fail 'the option was accepted in batch dispatch'
  assert_contains "$out" 'single-task only' 'batch refusal diagnostic missing'
  out=$(run_spawn "$home" space-b1 "$PROJECT" --mode no-mistakes --yolo off --herdr-project-space=)
  rc=$?
  [ "$rc" -ne 0 ] || fail 'an empty selection value was accepted'
  assert_contains "$out" 'requires a non-empty value' 'empty-value refusal diagnostic missing'
  out=$(run_spawn "$home" space-b1 "$PROJECT" --mode no-mistakes --yolo off --herdr-project-space)
  rc=$?
  [ "$rc" -ne 0 ] || fail 'a missing selection value was accepted'
  assert_contains "$out" 'requires a value' 'missing-value refusal diagnostic missing'
  assert_not_contains "$(herdr_log)" $'\x1ftab\x1fcreate' 'a refused option still created an endpoint'
  pass 'the option refuses on a non-herdr backend, a secondmate launch, a relaunch, batch dispatch, and a missing or empty value'
}

# A restarted server or a closed parent leaves a stale HERDR_PANE_ID in the
# caller's environment. The selection, never the parent, decides placement, so
# the launch must still reach the selected Space; without a selection the
# unreadable parent claim keeps refusing exactly as before.
test_stale_inherited_launcher_pane_does_not_block_the_selection() {
  local home out rc log
  home=$(setup_home stale-parent)
  fm_test_spawn_brief "$home" space-stale
  reset_herdr_log
  out=$(HERDR_PANE_ID=w3R:p1 HERDR_SOCKET_PATH="$FAKE_HERDR_DIR/herdr.sock" \
    run_spawn "$home" space-stale "$PROJECT" --mode no-mistakes --yolo off)
  rc=$?
  [ "$rc" -ne 0 ] || fail 'a default-path spawn ignored an unreadable inherited launcher pane'
  assert_contains "$out" "herdr launcher pane 'w3R:p1' could not be read" 'default-path stale-parent refusal missing'
  assert_not_contains "$(herdr_log)" $'\x1ftab\x1fcreate' 'default-path refusal opened a tab'
  reset_herdr_log
  out=$(HERDR_PANE_ID=w3R:p1 HERDR_SOCKET_PATH="$FAKE_HERDR_DIR/herdr.sock" \
    run_spawn "$home" space-stale "$PROJECT" --mode no-mistakes --yolo off --herdr-project-space w2)
  rc=$?
  [ "$rc" -ne 0 ] || fail 'the fake tab-create response should have stopped the spawn'
  assert_not_contains "$out" 'could not be read' 'a stale inherited launcher pane still blocked the selected placement'
  assert_contains "$out" 'could not parse tab/pane id from herdr tab create output' 'the selected placement did not reach the tab-create step'
  log=$(herdr_log)
  assert_contains "$log" $'\x1ftab\x1fcreate\x1f--workspace\x1fw2' 'the worker tab was not created in the selected Space'
  assert_not_contains "$log" $'\x1f''pane'$'\x1f''get' 'the selected placement read the stale parent pane at all'
  assert_not_contains "$log" $'\x1fworkspace\x1fcreate' 'a selected placement created a Space'
  pass 'an explicit valid selection still places its tab when the inherited launcher pane is stale, while the default path keeps refusing'
}

# The stale-parent tolerance is scoped to the claim's session and server
# identity, never to the placement authority: a parent claimed from another
# server still refuses even with a valid selection.
test_cross_session_parent_still_refuses_with_a_selection() {
  local home out rc
  home=$(setup_home cross-session)
  fm_test_spawn_brief "$home" space-cross
  reset_herdr_log
  out=$(HERDR_PANE_ID=w3R:p1 HERDR_SOCKET_PATH="$TMP_ROOT/other-server/herdr.sock" \
    run_spawn "$home" space-cross "$PROJECT" --mode no-mistakes --yolo off --herdr-project-space w1)
  rc=$?
  [ "$rc" -ne 0 ] || fail 'a parent claim from another server was accepted beside a valid selection'
  assert_contains "$out" 'refusing to place a worker from a cross-session parent identity' 'cross-session parent refusal missing'
  assert_not_contains "$(herdr_log)" $'\x1ftab\x1fcreate' 'a cross-session refusal opened a tab'
  pass 'a parent claimed from another server still refuses next to a valid selection'
}

test_help_documents_the_option
test_default_path_keeps_refusing_ambiguity
test_ship_launch_uses_the_selected_space
test_scout_launch_uses_the_selected_space
test_unverified_selection_refuses
test_stale_inherited_launcher_pane_does_not_block_the_selection
test_cross_session_parent_still_refuses_with_a_selection
test_option_is_refused_outside_its_scope
