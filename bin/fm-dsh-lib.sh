#!/usr/bin/env bash
# DSH identity is its actual Node entrypoint, never the ambiguous `dsh` name
# (also a distributed shell), an environment marker, or later prompt arguments.
# Linux argv boundaries are required; unsupported process views stay unknown.

_FM_DSH_WORKER_PATH="${BASH_SOURCE[0]%/*}/fm-dsh-worker.mjs"
_FM_DSH_WORKER_PATH="$(cd "${_FM_DSH_WORKER_PATH%/*}" && pwd -P)/fm-dsh-worker.mjs"

fm_dsh_script_matches() { # <script-path>
  case "${1:-}" in
    "$_FM_DSH_WORKER_PATH"|*/@deepseek-ai/dsh/lib/bin.js) return 0 ;;
    *) return 1 ;;
  esac
}

fm_dsh_pid_matches() { # <pid>
  local pid=${1:-} token index=0 skip=0
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  [ -r "/proc/$pid/cmdline" ] || return 1
  while IFS= read -r -d '' token; do
    if [ "$index" = 0 ]; then
      case "${token##*/}" in node|node[0-9]*|node-*) ;; *) return 1 ;; esac
    elif [ "$skip" = 1 ]; then
      skip=0
    else
      case "$token" in
        --import|--require|-r) skip=1 ;;
        --import=*|--require=*|--max-old-space-size=*) ;;
        --) ;; # the next argument is still required to be the script
        -*) return 1 ;; # -e/-p and unknown option operands cannot prove identity
        *) fm_dsh_script_matches "$token"; return $? ;;
      esac
    fi
    index=$((index + 1))
  done < "/proc/$pid/cmdline"
  return 1
}
