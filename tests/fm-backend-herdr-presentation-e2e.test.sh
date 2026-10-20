#!/usr/bin/env bash
# Legacy presentation Spaces remain exact recovery bindings. New task placement
# never creates projections, even with a retained historical opt-in setting.
set -eu
# shellcheck source=tests/herdr-project-fixture.sh
. "$(dirname "${BASH_SOURCE[0]}")/herdr-project-fixture.sh"
# shellcheck source=bin/fm-backend.sh
. "$ROOT/bin/fm-backend.sh"
fm_backend_source herdr
# shellcheck source=bin/fm-wake-lib.sh
. "$ROOT/bin/fm-wake-lib.sh"
project="$TMP_ROOT/project"; make_project "$project"
parent=$(lab workspace create --cwd "$project" --label firstmate --no-focus)
parent_ws=$(printf '%s' "$parent" | jq -r '.result.workspace.workspace_id')
parent_pane=$(printf '%s' "$parent" | jq -r '.result.root_pane.pane_id')
focus=$(lab workspace create --cwd "$TMP_ROOT" --label unrelated --focus)
focus_tab=$(printf '%s' "$focus" | jq -r '.result.tab.tab_id')
# Explicit owned legacy fixtures, created through the backend, never real fleet
# metadata or native agent impersonation. Their shell and exact journal agree.
id=legacy-fixture
journal=$(fm_backend_herdr_projection_journal_path "$FM_HOME/state" "$id")
token=$(fm_backend_herdr_projection_journal_create "$FM_HOME/state" "$id")
label=$(fm_backend_herdr_projection_workspace_label "$id" "$token")
fm_backend_herdr_projection_create_task "$project" "$label" "fm-$id" || fail 'could not create owned legacy projection fixture'
workspace=$FM_BACKEND_HERDR_PROJECTION_WORKSPACE_ID
tab=$FM_BACKEND_HERDR_PROJECTION_TAB_ID
pane=$FM_BACKEND_HERDR_PROJECTION_PANE_ID
# Wait for the fixture shell, then give the legacy fixture its exact saved
# labels; native shell display updates must not stand in for a recovery defect.
fm_backend_herdr_wait_shell_prompt "$HERDR_LAB_SESSION:$parent_pane" || true
fm_backend_herdr_wait_shell_prompt "$HERDR_LAB_SESSION:$pane" || true
lab workspace rename "$parent_ws" firstmate >/dev/null
lab workspace rename "$workspace" "$label" >/dev/null
lab tab rename "$tab" "fm-$id" >/dev/null
fm_backend_herdr_projection_order_best_effort "$HERDR_LAB_SESSION" "$workspace" firstmate "$parent_ws"
fm_backend_herdr_projection_journal_bind "$journal" "$id" "$FM_HOME" "$HERDR_LAB_SESSION" \
  "$workspace" "$tab" "$pane" "$parent_ws" firstmate "$label" "fm-$id" || fail 'could not bind legacy fixture'
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
# A fresh worker uses a different project Space, so the old projection cannot
# become a candidate through its initial cwd or move during project discovery.
other="$TMP_ROOT/new-project"; make_project "$other"
printf 'on\n' > "$FM_HOME/config/herdr-presentation-spaces"
spawn new-worker "$other" || fail 'fresh spawn with historical setting failed'
[ ! -e "$FM_HOME/state/new-worker.herdr-presentation" ] || fail 'historical setting created a fresh task projection'
[ "$(field new-worker herdr_workspace_id)" != "$workspace" ] || fail 'new project adopted legacy projection'
lab pane get "$new_pane" >/dev/null || fail 'fresh spawn touched legacy endpoint'
pass 'new project placement ignores historical projection opt-in and preserves legacy worker'
fm_backend_herdr_kill "$HERDR_LAB_SESSION:$new_pane"
if lab pane get "$new_pane" >/dev/null 2>&1; then fail 'exact legacy cleanup did not close its pane'; fi
lab pane get "$(field new-worker herdr_pane_id)" >/dev/null || fail 'legacy cleanup closed project worker'
lab pane get "$parent_pane" >/dev/null || fail 'legacy cleanup closed parent'
pass 'legacy exact-pane cleanup preserves project worker and orchestration parent'
