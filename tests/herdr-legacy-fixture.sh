#!/usr/bin/env bash
# Serialized old-journal fixtures, never a production projection creation path.
# A fixed token is safe because each fixture owns its state and isolated session.
herdr_fixture_journal_create() {  # <state> <id>
  local journal="$1/$2.herdr-presentation" token=ABCDEFGHIJKLMNOPQRSTUV
  [ ! -e "$journal" ] && [ ! -L "$journal" ] || return 1
  printf 'version=1\ntask_id=%s\nprojection_id=%s\n' "$2" "$token" > "$journal"
  printf '%s' "$token"
}
herdr_fixture_journal_bind() {  # <journal> <id> <home> <session> <ws> <tab> <pane> <parent-ws> <parent-label> <ws-label> <task-label>
  local token
  token=$(fm_backend_herdr_projection_journal_token "$1" "$2") || return 1
  fm_backend_herdr_projection_journal_write_v2 "$1" "$2" "$token" "${@:3}"
}
export -f herdr_fixture_journal_create herdr_fixture_journal_bind
