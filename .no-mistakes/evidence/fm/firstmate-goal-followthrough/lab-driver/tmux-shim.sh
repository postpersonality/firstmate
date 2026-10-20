#!/usr/bin/env bash
# Sandbox workaround only: bwrap's PID namespace hides /proc/<pane-pid>/cwd from
# the lab tmux server, so #{pane_current_path} is answered from the cwd the
# pane's own shell recorded (pane-cwd/<pane-id>); every other call is real tmux.
REAL=/usr/bin/tmux; LAB=$(cat "$TMPDIR/fm-lab-path")
case "$*" in
  *'#{pane_current_path}'*)
    args=("$@"); target=''
    for ((i=0; i<${#args[@]}; i++)); do [ "${args[i]}" = -t ] && target=${args[i+1]}; done
    pid=$("$REAL" display-message -p ${target:+-t "$target"} '#{pane_id}') || exit $?
    cwd=$(cat "$LAB/pane-cwd/$pid" 2>/dev/null || "$REAL" display-message -p ${target:+-t "$target"} '#{pane_start_path}')
    for ((i=0; i<${#args[@]}; i++)); do args[i]=${args[i]//'#{pane_current_path}'/$cwd}; done
    exec "$REAL" "${args[@]}" ;;
esac
exec "$REAL" "$@"
