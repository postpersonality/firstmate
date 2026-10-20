#!/usr/bin/env bash
# Persistent secondmates keep home Spaces; their workers use project Spaces.
# Recorded metadata restricts recovery even when homes share one project Space.
set -eu
# shellcheck source=tests/herdr-project-fixture.sh
. "$(dirname "${BASH_SOURCE[0]}")/herdr-project-fixture.sh"
primary=$FM_HOME
project="$TMP_ROOT/shared-project"; make_project "$project"
secondmate="$TMP_ROOT/secondmate"
mkdir -p "$secondmate/state" "$secondmate/config" "$secondmate/data" "$secondmate/projects" "$secondmate/bin"
echo mate > "$secondmate/.fm-secondmate-home"
printf '# Fixture home\n' > "$secondmate/AGENTS.md"
printf 'No model work.\n' > "$secondmate/data/charter.md"
printf 'state/\nconfig/\ndata/\nprojects/\n.no-mistakes/\n' > "$secondmate/.gitignore"
git -C "$secondmate" init -q -b main
git -C "$secondmate" add .
git -C "$secondmate" -c user.name=Tests -c user.email=tests@example.invalid commit -qm initial
mkdir -p "$primary/data/mate"
echo 'Run fixture command only.' > "$primary/data/mate/brief.md"
FM_SKIP_SECONDMATE_SYNC=1 FM_SKIP_SECONDMATE_INHERIT=1 \
  "$ROOT/bin/fm-spawn.sh" mate "$secondmate" "sh -c 'echo secondmate-fixture'" --secondmate --backend herdr > "$TMP_ROOT/mate.out" 2> "$TMP_ROOT/mate.err" \
  || { cat "$TMP_ROOT/mate.err" >&2; fail 'persistent secondmate spawn failed'; }
mate_ws=$(field mate herdr_workspace_id); mate_pane=$(field mate herdr_pane_id)
# A persistent secondmate's existing restored-shell recovery remains unchanged.
old_mate_pane=$mate_pane
FM_SKIP_SECONDMATE_SYNC=1 FM_SKIP_SECONDMATE_INHERIT=1 \
  "$ROOT/bin/fm-spawn.sh" mate "$secondmate" "sh -c 'echo secondmate-fixture'" --secondmate --backend herdr > "$TMP_ROOT/mate-recover.out" 2> "$TMP_ROOT/mate-recover.err" \
  || { cat "$TMP_ROOT/mate-recover.err" >&2; fail 'persistent secondmate recovery failed'; }
mate_pane=$(field mate herdr_pane_id)
[ "$(field mate herdr_workspace_id)" = "$mate_ws" ] || fail 'secondmate recovery moved its home Space'
[ "$mate_pane" != "$old_mate_pane" ] || fail 'secondmate recovery did not replace its saved husk'
if lab pane get "$old_mate_pane" >/dev/null 2>&1; then fail 'secondmate recovery left its old husk'; fi
pass 'persistent secondmate recovery retains its home Space and replaces only its own husk'
spawn primary-worker "$project" || fail 'primary worker spawn failed'
project_ws=$(field primary-worker herdr_workspace_id)
[ "$project_ws" != "$mate_ws" ] || fail 'project worker entered secondmate home Space'
FM_HOME="$secondmate" spawn child-worker "$project" || fail 'secondmate child spawn failed'
[ "$(FM_HOME="$secondmate" field child-worker herdr_workspace_id)" = "$project_ws" ] || fail 'same project workers did not share Space across homes'
pass 'secondmate keeps its home Space; primary and secondmate workers share the project Space'
# shellcheck source=bin/fm-backend.sh
. "$ROOT/bin/fm-backend.sh"
fm_backend_source herdr
primary_live=$(fm_backend_herdr_list_live "$HERDR_LAB_SESSION")
child_live=$(FM_HOME="$secondmate" fm_backend_herdr_list_live "$HERDR_LAB_SESSION")
case "$primary_live" in *fm-primary-worker*) ;; *) fail 'primary recovery omitted its worker' ;; esac
case "$primary_live" in *fm-child-worker*) fail 'primary claimed another home child' ;; esac
case "$child_live" in *fm-child-worker*) ;; *) fail 'secondmate recovery omitted its child' ;; esac
case "$child_live" in *fm-primary-worker*|*fm-mate*) fail 'secondmate claimed a parent-owned endpoint' ;; esac
pass 'each home recovers only its own recorded endpoints inside the shared project Space'
"$ROOT/bin/fm-teardown.sh" primary-worker > "$TMP_ROOT/teardown.out" 2>&1 \
  || { cat "$TMP_ROOT/teardown.out" >&2; fail 'primary fixture teardown failed'; }
lab pane get "$(FM_HOME="$secondmate" field child-worker herdr_pane_id)" >/dev/null || fail 'teardown closed another home worker'
lab pane get "$mate_pane" >/dev/null || fail 'teardown closed persistent secondmate'
pass 'teardown preserves another home worker and persistent secondmate endpoint'
