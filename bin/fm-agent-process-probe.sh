#!/usr/bin/env bash
# Classify JSON process samples from fm_agent_process.py through the existing
# native family/process owners. Input: array of bounded samples; output: JSONL
# with family and kind, never full command arguments. No ancestor attribution.
set -eu
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bin/fm-agent-process-lib.sh
. "$SCRIPT_DIR/fm-agent-process-lib.sh"
# Load definitions without detecting the caller's own harness.
# shellcheck source=bin/fm-harness.sh
. "$SCRIPT_DIR/fm-harness.sh" validate-native-effort

# Structural family proof, never an arbitrary prompt or a wrapper's title.
family_for() (
  local sampled_comm=$1 process_pid=$2 verdict
  ps() {
    case "$*" in
      "-o comm= -p $process_pid") printf '%s\n' "$sampled_comm" ;;
      "-o args= -p $process_pid") printf '%s\n' "$sampled_comm" ;;
      *) return 1 ;;
    esac
  }
  verdict=$(harness_process_verdict "$process_pid")
  case "$verdict" in comm\ *) harness_family "${verdict#comm }" ;; esac
)
while IFS= read -r p; do
  pid=$(jq -er '.pid' <<<"$p") actual='' kind=other
  name=$(jq -r '.name' <<<"$p") argv0=$(jq -r '.argv0' <<<"$p")
  owner_kind=$(fm_agent_process_classify "$name" "$argv0" '' "$pid")
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    candidate=$(fm_harness_path_name "$path" || family_for "$path" "$pid" || true)
    if [ -z "$candidate" ]; then
      if fm_cursor_path_is_cursor "$path"; then candidate=cursor
      elif fm_gemini_path_is_gemini "$path"; then candidate=gemini; fi
    fi
    if [ -n "$candidate" ] && [ "$(fm_agent_process_classify "$path" "$path" '' "$pid")" = agent ]; then
      actual=$(harness_family "$candidate" || true)
      break
    fi
  done < <(jq -r '.identity_paths[]' <<<"$p")
  if [ -z "$actual" ] && [ "$owner_kind" = agent ] && jq -e '.interpreter == true' <<<"$p" >/dev/null; then
    named=$(family_for "$name" "$pid" || true)
    arg_family=$(fm_harness_path_name "$argv0" || family_for "$argv0" "$pid" || true)
    if [ -n "$named" ] && [ "$named" = "$(harness_family "$arg_family")" ]; then actual=$named; fi
  fi
  if [ -z "$actual" ] && fm_gemini_pid_is_gemini "$pid"; then actual=gemini; fi
  if [ -z "$actual" ] && fm_dsh_pid_matches "$pid"; then actual=dsh; fi
  [ -z "$actual" ] || kind=agent
  jq -c --arg family "$actual" --arg kind "$kind" --arg owner "$owner_kind" \
    '. + {family:$family,kind:$kind,owner_kind:$owner} | del(.args)' <<<"$p"
done < <(jq -c '.[]')
