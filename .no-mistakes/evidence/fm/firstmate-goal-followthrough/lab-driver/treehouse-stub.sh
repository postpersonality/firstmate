#!/usr/bin/env bash
printf 'treehouse %s\n' "$*" >> "/tmp/claude-1000/fm-lab.2BsUNJ/stub-calls.log"
if [ "${1:-}" = get ]; then
  n=$(cat "/tmp/claude-1000/fm-lab.2BsUNJ/next-wt" 2>/dev/null || echo 1); echo $((n + 1)) > "/tmp/claude-1000/fm-lab.2BsUNJ/next-wt"
  cd "/tmp/claude-1000/fm-lab.2BsUNJ/projects/sample-wt$n" && pwd -P > "/tmp/claude-1000/fm-lab.2BsUNJ/pane-cwd/$TMUX_PANE" && exec bash --norc --noprofile -i
fi
exit 0
