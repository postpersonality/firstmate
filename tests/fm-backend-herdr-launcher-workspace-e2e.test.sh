#!/usr/bin/env bash
# Real Herdr project-Space placement through public spawn/backend/teardown.
# All endpoints, homes, repositories and fake harnesses belong to this lab.
# The fixture shell allocates ordinary scratch clones, never shared pool slots.
set -eu
# shellcheck source=tests/herdr-project-fixture.sh
. "$(dirname "${BASH_SOURCE[0]}")/herdr-project-fixture.sh"
project_a="$TMP_ROOT/alpha"; make_project "$project_a"
project_b="$TMP_ROOT/beta"; make_project "$project_b"
# The launcher exists in an unrelated, focused project and is never replaced.
parent=$(lab workspace create --cwd "$project_b" --label beta --focus)
parent_ws=$(printf '%s' "$parent" | jq -r '.result.workspace.workspace_id')
parent_tab=$(printf '%s' "$parent" | jq -r '.result.tab.tab_id')
parent_pane=$(printf '%s' "$parent" | jq -r '.result.root_pane.pane_id')
existing=$(lab workspace create --cwd "$project_a" --label alpha --no-focus)
existing_ws=$(printf '%s' "$existing" | jq -r '.result.workspace.workspace_id')
existing_pane=$(printf '%s' "$existing" | jq -r '.result.root_pane.pane_id')
spawn_in_pane "$parent_pane" reuse "$project_a" || fail 'pane-bound spawn failed'
[ "$(field reuse herdr_workspace_id)" = "$existing_ws" ] || fail 'worker followed unrelated launcher instead of existing project Space'
[ "$(field reuse herdr_tab_id)" != "$parent_tab" ] || fail 'worker reused orchestration tab'
[ ! -e "$FM_HOME/state/reuse.herdr-presentation" ] || fail 'fresh spawn created a disposable presentation Space'
[ "$(lab workspace list | jq -r '.result.workspaces[] | select(.focused) | .workspace_id')" = "$parent_ws" ] || fail 'spawn stole focus'
lab pane get "$existing_pane" >/dev/null || fail 'adopted project seed was closed'
pass 'pane-bound worker reuses project Space despite unrelated launcher and focus; existing panes survive'
# Detached/app-server caller has no pane claim, but resolves the identical Space.
spawn detached "$project_a" || fail 'detached spawn failed'
[ "$(field detached herdr_workspace_id)" = "$existing_ws" ] || fail 'detached caller used a home or focused Space'
[ "$(field detached herdr_tab_id)" != "$(field reuse herdr_tab_id)" ] || fail 'workers share a tab'
pass 'detached caller uses the same project Space and a separate worker tab'
old_detached=$(field detached herdr_pane_id)
spawn detached "$project_a" || fail 'own restored husk recovery failed'
[ "$(field detached herdr_workspace_id)" = "$existing_ws" ] || fail 'own husk recovery moved project Space'
[ "$(field detached herdr_pane_id)" != "$old_detached" ] || fail 'own husk was not replaced'
if lab pane get "$old_detached" >/dev/null 2>&1; then fail 'own old husk survived replacement'; fi
lab pane get "$(field reuse herdr_pane_id)" >/dev/null || fail 'own recovery closed another worker'
pass 'public spawn replaces only its own exactly recorded shell husk'
# A recorded live endpoint in another Space refuses before a second worker or record.
spawn elsewhere "$project_b" || fail 'other-Space setup spawn failed'
[ "$(field elsewhere herdr_workspace_id)" = "$parent_ws" ] || fail 'setup worker did not land in the other Space'
live_pane=$(field elsewhere herdr_pane_id)
lab pane run "$live_pane" 'sleep 600' >/dev/null || fail 'could not start a foreground process in the recorded pane'
lab pane report-agent "$live_pane" --source fm-launcher-e2e --agent fm-launcher-live-agent --state idle >/dev/null \
  || fail 'could not register a live agent on the recorded pane'
for ((i=0; i<50; i++)); do
  state=$(bash -c '. "$1/bin/backends/herdr.sh"; fm_backend_herdr_pane_agent_state "$2" "$3"' _ "$ROOT" "$HERDR_LAB_SESSION" "$live_pane")
  [ "$state" != live ] || break
  sleep 0.1
done
[ "$state" = live ] || fail "recorded pane did not read live (got $state)"
cp "$FM_HOME/state/elsewhere.meta" "$TMP_ROOT/elsewhere.meta.before"
alpha_tabs=$(lab tab list --workspace "$existing_ws" | jq -c '[.result.tabs[].tab_id]')
if spawn elsewhere "$project_a" 2>/dev/null; then fail 'fresh spawn launched a second worker beside a live recorded endpoint'; fi
case "$(cat "$TMP_ROOT/elsewhere.err")" in *"existing herdr endpoint for elsewhere is live; refusing duplicate launch"*) ;; *) fail 'live recorded endpoint refusal diagnostic missing' ;; esac
cmp -s "$FM_HOME/state/elsewhere.meta" "$TMP_ROOT/elsewhere.meta.before" || fail 'refused spawn rewrote the task record'
[ "$(lab tab list --workspace "$existing_ws" | jq -c '[.result.tabs[].tab_id]')" = "$alpha_tabs" ] || fail 'refused spawn opened a tab in the project Space'
lab pane get "$live_pane" >/dev/null || fail 'refused spawn closed the live recorded endpoint'
pass 'live endpoint recorded in another Space refuses fresh spawn before any tab or record change'
# A source checkout and clone resolve through the established origin identity.
git clone -q "$project_a.origin.git" "$TMP_ROOT/alpha-clone"
raw=$(container "$TMP_ROOT/alpha-clone") || fail 'same-origin lookup failed'
[ "${raw%%$'\t'*}" = "$HERDR_LAB_SESSION:$existing_ws" ] || fail 'source and clone created different project Spaces'
pass 'source checkout and same-origin clone share project identity'
# The management home shares Firstmate's origin but is not its project Space.
firstmate="$TMP_ROOT/firstmate"; make_project "$firstmate"
git -C "$FM_HOME" init -q -b main
git -C "$FM_HOME" remote add origin "$firstmate.origin.git"
git -C "$FM_HOME" -c user.name=Tests -c user.email=tests@example.invalid commit -q --allow-empty -m initial
git clone -q "$firstmate.origin.git" "$FM_HOME/projects/firstmate"
main=$(lab workspace create --cwd "$FM_HOME" --label 'operator desk' --no-focus)
main_ws=$(printf '%s' "$main" | jq -r '.result.workspace.workspace_id')
main_tab=$(printf '%s' "$main" | jq -r '.result.tab.tab_id')
main_pane=$(printf '%s' "$main" | jq -r '.result.root_pane.pane_id')
before_count=$(lab workspace list | jq '.result.workspaces | length')
spawn_in_pane "$main_pane" home-a "$FM_HOME" || fail 'home project spawn failed'
core_ws=$(field home-a herdr_workspace_id)
[ "$core_ws" != "$main_ws" ] || fail 'home worker entered management Space'
[ "$(field home-a herdr_tab_id)" != "$main_tab" ] || fail 'home worker replaced management tab'
[ "$(cat "$TMP_ROOT/$(basename "$(field home-a worktree)").source")" = "$FM_HOME" ] || fail 'home project allocation source checkout changed'
spawn_in_pane "$main_pane" home-b "$FM_HOME" || fail 'repeat home project spawn failed'
[ "$(field home-b herdr_workspace_id)" = "$core_ws" ] || fail 'repeat home worker duplicated the project Space'
[ "$(field home-b herdr_tab_id)" != "$(field home-a herdr_tab_id)" ] || fail 'repeat home workers share a tab'
spawn_in_pane "$main_pane" home-copy "$FM_HOME/projects/firstmate" || fail 'project copy spawn failed'
[ "$(field home-copy herdr_workspace_id)" = "$core_ws" ] || fail 'project copy did not reuse home worker Space'
spawn_in_pane "$main_pane" core "$firstmate" || fail 'Firstmate project spawn failed'
[ "$(field core herdr_workspace_id)" = "$core_ws" ] || fail 'Firstmate source did not reuse project Space'
[ "$(lab workspace list | jq '.result.workspaces | length')" = "$((before_count + 1))" ] || fail 'absent Firstmate project Space was not created once'
[ "$(field core herdr_tab_id)" != "$main_tab" ] || fail 'Firstmate worker replaced orchestration tab'
spawn core-detached "$firstmate" || fail 'detached Firstmate spawn failed'
[ "$(field core-detached herdr_workspace_id)" = "$core_ws" ] || fail 'detached Firstmate caller did not reuse project Space'
[ "$(field core-detached herdr_tab_id)" != "$(field core herdr_tab_id)" ] || fail 'Firstmate workers shared a tab'
lab pane get "$main_pane" >/dev/null || fail 'Firstmate orchestration pane was closed'
lab pane get "$(field core herdr_pane_id)" >/dev/null || fail 'detached spawn replaced existing Firstmate worker'
pass 'repeat home, projects/firstmate copy and source spawns share one project Space with separate tabs; management and source checkout are preserved'
# Simultaneous public backend calls in separate homes share the session lock.
project_c="$TMP_ROOT/gamma"; make_project "$project_c"
mkdir -p "$TMP_ROOT/home-two/state"
before_count=$(lab workspace list | jq '.result.workspaces | length')
container "$project_c" > "$TMP_ROOT/concurrent-a" & one=$!
FM_HOME="$TMP_ROOT/home-two" container "$project_c" > "$TMP_ROOT/concurrent-b" & two=$!
wait "$one" || fail 'first concurrent ensure failed'
wait "$two" || fail 'second concurrent ensure failed'
raw_a=$(cat "$TMP_ROOT/concurrent-a"); raw_b=$(cat "$TMP_ROOT/concurrent-b")
[ "${raw_a%%$'\t'*}" = "${raw_b%%$'\t'*}" ] || fail 'concurrent launch duplicated project Space'
[ "$(lab workspace list | jq '.result.workspaces | length')" = "$((before_count + 1))" ] || fail 'absent project created duplicate Spaces'
spawn absent "$project_c" || fail 'new project spawn failed'
[ "$HERDR_LAB_SESSION:$(field absent herdr_workspace_id)" = "${raw_a%%$'\t'*}" ] || fail 'spawn did not reuse concurrently created Space'
pass 'absent project Space is created once across concurrent homes, then reused by public spawn'
# Two path-identified Spaces still require an explicit choice, regardless of focus.
duplicate=$(lab workspace create --cwd "$project_b" --label beta --no-focus)
if container "$project_b" > "$TMP_ROOT/duplicate.out" 2> "$TMP_ROOT/duplicate.err"; then
  fail 'two project Spaces were arbitrarily resolved'
fi
lab pane get "$parent_pane" >/dev/null || fail 'duplicate refusal closed the original Space'
lab pane get "$(printf '%s' "$duplicate" | jq -r '.result.root_pane.pane_id')" >/dev/null || fail 'duplicate refusal closed the second Space'
pass 'multiple path-identified project Spaces refuse without choosing the focused one'
# Equal task labels from another home never grant husk-replacement authority.
existing_label=$(lab tab get "$(field detached herdr_tab_id)" | jq -r '.result.tab.label')
if FM_HOME="$TMP_ROOT/home-two" bash -c '
  . "$1/bin/backends/herdr.sh"
  fm_backend_herdr_create_task "$2" "$3" "$4" "" preserve-existing
' _ "$ROOT" "$HERDR_LAB_SESSION:$existing_ws" "$existing_label" "$project_a" > "$TMP_ROOT/same-name.out" 2> "$TMP_ROOT/same-name.err"; then
  fail 'same-name task endpoint from another home was replaced'
fi
lab pane get "$(field detached herdr_pane_id)" >/dev/null || fail 'same-name task refusal closed existing worker'
pass 'shared project Space preserves another home same-name task endpoint'
# Same-name unknown metadata refuses without creating or changing any Space.
mkdir -p "$TMP_ROOT/unknown"
lab workspace create --cwd "$TMP_ROOT/unknown" --label alpha --no-focus >/dev/null
before=$(lab workspace list | jq -c '[.result.workspaces[] | {workspace_id,active_tab_id,pane_count,tab_count}]')
if container "$project_a" > "$TMP_ROOT/ambiguous.out" 2> "$TMP_ROOT/ambiguous.err"; then
  fail 'same-name Space without identity was guessed'
fi
case "$(cat "$TMP_ROOT/ambiguous.err")" in *'ambiguous herdr project Space'*) ;; *) fail 'ambiguity diagnostic missing' ;; esac
[ "$(lab workspace list | jq -c '[.result.workspaces[] | {workspace_id,active_tab_id,pane_count,tab_count}]')" = "$before" ] || fail 'ambiguity mutated existing Spaces'
pass 'ambiguous same-name Spaces are preserved and reported'
# Teardown uses recorded endpoints, never a project-wide sweep.
pane=$(field reuse herdr_pane_id)
"$ROOT/bin/fm-teardown.sh" reuse > "$TMP_ROOT/teardown.out" 2>&1 || { cat "$TMP_ROOT/teardown.out" >&2; fail 'fixture teardown failed'; }
if lab pane get "$pane" >/dev/null 2>&1; then fail 'teardown left its task pane'; fi
lab pane get "$(field detached herdr_pane_id)" >/dev/null || fail 'teardown closed another worker'
lab pane get "$parent_pane" >/dev/null || fail 'teardown closed parent'
lab pane get "$main_pane" >/dev/null || fail 'teardown closed orchestration pane'
pass 'teardown closes only its recorded fixture endpoint; other workers and orchestration survive'
