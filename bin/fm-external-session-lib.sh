#!/usr/bin/env bash
# External binding lookup and exact-process guard for existing send/control
# owners. bin/fm-attach.sh owns the binding and lifecycle command contract.
_FM_EXTERNAL_BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fm_external_find() {  # <task-id-or-exact-Herdr-target> -> own binding path
  local selector=$1 state=${FM_STATE_OVERRIDE:-$FM_HOME/state} path target found=
  case "$selector" in
    *:*)
      for path in "$state"/*.external.json; do
        if [ ! -e "$path" ] && [ ! -L "$path" ]; then continue; fi
        [ -f "$path" ] && [ ! -L "$path" ] || return 2
        target=$(jq -er '.identity | .session + ":" + .pane_id' "$path") || return 2
        [ "$selector" = "$target" ] || continue
        [ -z "$found" ] || return 2
        found=$path
      done
      [ -n "$found" ] || return 1
      printf '%s' "$found"
      ;;
    *)
      if [ ! -e "$state/$selector.external.json" ]; then selector=${selector#fm-}; fi
      case "$selector" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
      path="$state/$selector.external.json"
      [ -f "$path" ] && [ ! -L "$path" ] || return 1
      printf '%s' "$path"
      ;;
  esac
}

fm_external_verify() {  # <binding-path>
  local task=${1##*/}
  task=${task%.external.json}
  [ "$1" = "${FM_STATE_OVERRIDE:-$FM_HOME/state}/$task.external.json" ] || return 1
  python3 "$_FM_EXTERNAL_BIN/fm-external-session.py" verify "$task"
}

fm_external_guard_target() {  # <exact-Herdr-target>
  local binding rc=0
  if [ -n "${FM_EXTERNAL_BINDING:-}" ]; then
    binding=$FM_EXTERNAL_BINDING
    [ "$(jq -er '.identity | .session + ":" + .pane_id' "$binding")" = "$1" ] || return 1
  else
    binding=$(fm_external_find "$1") || rc=$?
    [ "$rc" -ne 1 ] || return 0
    [ "$rc" -eq 0 ] || return 1
  fi
  fm_external_verify "$binding" >/dev/null || return 1
  if [ "${FM_EXTERNAL_CONTROL_EXIT:-0}" = 1 ]; then
    python3 "$_FM_EXTERNAL_BIN/fm-external-session.py" exit-gate "$(basename "$binding" .external.json)" >/dev/null || return 1
  fi
}
