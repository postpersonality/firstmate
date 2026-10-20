#!/usr/bin/env bash
# Legacy presentation Spaces remain exact recovery bindings. New task placement
# never creates projections, even with a retained historical opt-in setting.
set -eu
# shellcheck source=tests/herdr-project-fixture.sh
. "$(dirname "${BASH_SOURCE[0]}")/herdr-project-fixture.sh"
# shellcheck source=tests/herdr-legacy-fixture.sh
. "$(dirname "${BASH_SOURCE[0]}")/herdr-legacy-fixture.sh"
# shellcheck source=bin/fm-backend.sh
. "$ROOT/bin/fm-backend.sh"
fm_backend_source herdr
# shellcheck source=bin/fm-wake-lib.sh
. "$ROOT/bin/fm-wake-lib.sh"
project="$TMP_ROOT/project"; make_project "$project"
parent=$(lab workspace create --cwd "$project" --label firstmate --no-focus)
parent_ws=$(printf '%s' "$parent" | jq -r '.result.workspace.workspace_id')
parent_pane=$(printf '%s' "$parent" | jq -r '.result.root_pane.pane_id')
# Build the old layout with native fixture commands and serialized journal
# data. No production code still creates or orders these projections.
id='legacy-fixture'
journal=$(fm_backend_herdr_projection_journal_path "$FM_HOME/state" "$id")
token=$(herdr_fixture_journal_create "$FM_HOME/state" "$id")
label=$(fm_backend_herdr_projection_workspace_label "$id" "$token")
legacy=$(lab workspace create --cwd "$project" --label "$label" --no-focus)
workspace=$(printf '%s' "$legacy" | jq -r '.result.workspace.workspace_id')
tab=$(printf '%s' "$legacy" | jq -r '.result.tab.tab_id')
pane=$(printf '%s' "$legacy" | jq -r '.result.root_pane.pane_id')
fm_backend_herdr_wait_shell_prompt "$HERDR_LAB_SESSION:$parent_pane" || true
fm_backend_herdr_wait_shell_prompt "$HERDR_LAB_SESSION:$pane" || true
lab workspace rename "$parent_ws" firstmate >/dev/null
lab workspace rename "$workspace" "$label" >/dev/null
lab tab rename "$tab" "fm-$id" >/dev/null
herdr_fixture_journal_bind "$journal" "$id" "$FM_HOME" "$HERDR_LAB_SESSION" \
  "$workspace" "$tab" "$pane" "$parent_ws" firstmate "$label" "fm-$id" || fail 'could not bind legacy fixture'
focus=$(lab workspace create --cwd "$TMP_ROOT" --label unrelated --focus)
focus_tab=$(printf '%s' "$focus" | jq -r '.result.tab.tab_id')
lock=$(fm_backend_herdr_presentation_session_lock_path "$HERDR_LAB_SESSION")
fm_lock_acquire_wait_max "$lock" 15 || fail 'could not acquire legacy fixture lock'
if fm_backend_herdr_projection_reclaim_task "$HERDR_LAB_SESSION" "$journal" "$id" "$FM_HOME" \
  "$workspace" "$tab" "$pane" firstmate "fm-$id" "$project"; then rc=0; else rc=$?; fi
fm_lock_release "$lock"
if [ "$rc" != 0 ]; then
  lab workspace list >&2
  lab tab list --workspace "$workspace" >&2
  lab pane list --workspace "$workspace" >&2
  cat "$journal" >&2
  fail 'exact legacy recovery failed'
fi
new_pane=$FM_BACKEND_HERDR_PROJECTION_PANE_ID
[ "$new_pane" != "$pane" ] || fail 'legacy recovery retained old husk'
if lab pane get "$pane" >/dev/null 2>&1; then fail 'exact legacy husk was not retired'; fi
lab pane get "$new_pane" >/dev/null || fail 'legacy replacement endpoint missing'
lab pane get "$parent_pane" >/dev/null || fail 'legacy recovery closed parent'
[ "$(lab workspace list | jq -r '.result.workspaces[] | select(.focused) | .active_tab_id')" = "$focus_tab" ] || fail 'legacy recovery stole focus'
pass 'exact owned legacy projection reclaims only its saved husk and preserves parent and focus'
# Preserve a mixed old home container and the exact owned projection while
# placing new work for the SAME project, without waiting for either to drain.
other="$TMP_ROOT/old-other-project"; make_project "$other"
old_other=$(lab tab create --workspace "$parent_ws" --cwd "$other" --label old-other --no-focus)
old_other_pane=$(printf '%s' "$old_other" | jq -r '.result.root_pane.pane_id')
printf 'backend=herdr\nwindow=%s:%s\nherdr_session=%s\nherdr_workspace_id=%s\nherdr_tab_id=%s\nherdr_pane_id=%s\n' \
  "$HERDR_LAB_SESSION" "$new_pane" "$HERDR_LAB_SESSION" "$workspace" \
  "$FM_BACKEND_HERDR_PROJECTION_TAB_ID" "$new_pane" > "$FM_HOME/state/$id.meta"
printf 'on\n' > "$FM_HOME/config/herdr-presentation-spaces"
spawn new-worker "$project" || fail 'same-project legacy transition failed'
new_ws=$(field new-worker herdr_workspace_id)
[ ! -e "$FM_HOME/state/new-worker.herdr-presentation" ] || fail 'historical setting created a fresh task projection'
[ "$new_ws" != "$workspace" ] && [ "$new_ws" != "$parent_ws" ] || fail 'same-project worker adopted a disposable or mixed old Space'
spawn transition-reuse "$project" || fail 'legacy transition project reuse failed'
[ "$(field transition-reuse herdr_workspace_id)" = "$new_ws" ] || fail 'legacy transition duplicated project Space'
lab pane get "$new_pane" >/dev/null || fail 'fresh spawn touched legacy endpoint'
lab pane get "$old_other_pane" >/dev/null || fail 'fresh spawn touched old mixed-project endpoint'
pass 'same-project transition excludes exact own projection and mixed old container, creates/reuses project Space without moving old workers'
fm_backend_herdr_kill "$HERDR_LAB_SESSION:$new_pane"
if lab pane get "$new_pane" >/dev/null 2>&1; then fail 'exact legacy cleanup did not close its pane'; fi
lab pane get "$(field new-worker herdr_pane_id)" >/dev/null || fail 'legacy cleanup closed project worker'
lab pane get "$parent_pane" >/dev/null || fail 'legacy cleanup closed parent'
pass 'legacy exact-pane cleanup preserves project worker and orchestration parent'
