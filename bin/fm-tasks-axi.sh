#!/usr/bin/env bash
# fm-tasks-axi.sh - run tasks-axi against THIS home's backlog from any working directory.
#
# Usage: fm-tasks-axi.sh [<tasks-axi command> [args...]]
#        fm-tasks-axi.sh archive <list|show> [args...]
#        fm-tasks-axi.sh --help
#
# Every routine firstmate backlog read or mutation goes through this command
# rather than a bare `tasks-axi`; `fm-tasks-axi.sh <command> --help` prints
# tasks-axi's own help. Arguments reach tasks-axi as given, apart from
# tasks-axi's optional leading `task` noun, which this command drops before
# reading the command, and one rewrite that keeps file arguments meaning what
# the caller meant: a relative value of `--to` or any `--*-file` flag
# (`--body-file`, `--relation-file`, ...) is made absolute against the caller's
# working directory, because tasks-axi starts from the backlog root instead.
# `--report` stays as given: tasks-axi stores it verbatim as a link, which
# lifecycle transitions record relative to that same root.
#
# `show` (including `view`) and `list` decode stored captain-hold reasons
# through bin/fm-hold-reason-lib.sh, which owns the field-only decoding contract.
# Decoded reasons use quoted strings so embedded line breaks remain intact.
#
# `archive list` and `archive show` read this home's Done archive, read-only,
# with the ordinary list and show flags (for example `--fields body,closed,links`
# or `--full`). A markdown backlog only: the archive is the root `.tasks.toml`
# `[markdown] archive` path, else `done-archive.md` beside the backlog. The
# wrapper copies it into a private temporary directory, rewrites every
# `## Archived <date>` heading into the standard In flight / Queued / Done
# sections there, and runs tasks-axi on that copy alone, so nothing the reader
# does can reach the real archive or backlog. An absent archive reads as an
# empty one. Every other command in archive mode is refused.
#
# Why it exists: a bare `tasks-axi` resolves the tracked `.tasks.toml` paths
# against its working directory, so from the code root it forks the queue
# whenever the home lives elsewhere; docs/configuration.md ("Backlog backend")
# owns that rationale.
#
# Addressing is bin/fm-backlog-transition-lib.sh's fm_backlog_tasks_axi_addressing,
# the same resolution the lifecycle transitions use: tasks-axi runs from the
# configured data directory's parent, so that home's own `.tasks.toml` (or
# tasks-axi's built-in defaults, which keep the archive beside the backlog)
# supplies the adapter, done_keep, and the archive path; a markdown backlog is
# additionally pinned to `<data>/backlog.md` through TASKS_AXI_FILE. The
# environment carries the pin rather than a trailing --file so the no-command
# dashboard works too. A configured non-markdown adapter is addressed by that
# root alone, so an inherited TASKS_AXI_FILE is cleared for it.
#
# The data directory is FM_DATA_OVERRIDE, else $FM_HOME/data, else the code
# root's data/ (FM_HOME unset keeps the single-home layout unchanged).
#
# Refusals (exit 2, nothing run):
#   - tasks-axi missing from PATH;
#   - a caller-supplied --file, because this command owns the addressing and
#     tasks-axi would silently let the last --file win;
#   - `add` (or its `create` alias) with --start, so neither spelling places a
#     row In flight without the dispatch artifacts bin/fm-spawn.sh creates -
#     the task record, status file, and inbox that go with the row - which such
#     a row would lack, counting as live work nobody is doing that nothing
#     later would notice (`start <id>` stays a documented direct transition);
#   - closing a live completion_required=1 task before its outcome review;
#   - holding a kind=firstmate action behind an undated future/parked/load
#     wait instead of a captain, external, date or dependency gate, or behind an
#     `external` condition with no live dependency row and no date, because only
#     those two referents are re-read after the write;
#   - `archive` with any command but `list` or `show`, or on a home whose
#     backlog is not markdown;
#   - a data directory that cannot be resolved, or whose backend configuration
#     cannot be read (bin/fm-tasks-axi-lib.sh owns that diagnostic);
#   - a markdown `<data>/backlog.md` that is itself a symlink, because the
#     first write would replace the link with a private copy, exactly the fork
#     this command exists to prevent. Lifecycle transitions refuse the same file.
# Otherwise the exit status is tasks-axi's own, unless decoding a read fails;
# in that case the decoder's nonzero status is returned.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
# shellcheck source=bin/fm-tasks-axi-lib.sh disable=SC1091
. "$SCRIPT_DIR/fm-tasks-axi-lib.sh"
# shellcheck source=bin/fm-backlog-transition-lib.sh disable=SC1091
. "$SCRIPT_DIR/fm-backlog-transition-lib.sh"
# shellcheck source=bin/fm-hold-reason-lib.sh disable=SC1091
. "$SCRIPT_DIR/fm-hold-reason-lib.sh"

usage() {
  awk '
    NR == 1 { next }
    /^#/ { sub(/^# ?/, ""); print; next }
    { exit }
  ' "$0"
}

fail() {
  printf 'fm-tasks-axi: %s\n' "$*" >&2
  exit 2
}

[ "${1:-}" != task ] || shift
case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac

ARCHIVE=0
if [ "${1:-}" = archive ]; then
  case "${2:-}" in
    list|show) ;;
    *) fail "archive mode is read-only and runs only list or show, not '${2:-}'" ;;
  esac
  ARCHIVE=1
  shift
fi

CALLER_DIR=$(pwd)

absolute_from_caller() {  # <path-value>
  case "$1" in
    ''|-|/*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$CALLER_DIR" "$1" ;;
  esac
}

ARGS=()
path_value_next=0
for arg in "$@"; do
  if [ "$path_value_next" = 1 ]; then
    ARGS+=("$(absolute_from_caller "$arg")")
    path_value_next=0
    continue
  fi
  case "$arg" in
    --file|--file=*)
      fail "this command always addresses this home's backlog at $DATA; drop --file, or run tasks-axi directly for another backlog"
      ;;
    --start)
      case "${1:-}" in
        add|create)
          fail "add --start would place a row In flight with no dispatch record; add it Queued and let bin/fm-spawn.sh start it"
          ;;
      esac
      ARGS+=("$arg")
      ;;
    --to|--*-file)
      ARGS+=("$arg")
      path_value_next=1
      ;;
    --to=*|--*-file=*)
      ARGS+=("${arg%%=*}=$(absolute_from_caller "${arg#*=}")")
      ;;
    *)
      ARGS+=("$arg")
      ;;
  esac
done

command -v tasks-axi >/dev/null 2>&1 || fail "tasks-axi is not on PATH; run bin/fm-bootstrap.sh for the install command"

FM_BACKLOG_TRANSITION_ERROR=
if ! fm_backlog_tasks_axi_addressing "$DATA"; then
  fail "${FM_BACKLOG_TRANSITION_ERROR:-data directory cannot be resolved: $DATA}"
fi

if [ -n "$FM_BACKLOG_AXI_FILE" ]; then
  if [ -L "$FM_BACKLOG_AXI_FILE" ]; then
    fail "$FM_BACKLOG_AXI_FILE is a symlink; a tasks-axi write would replace it with a regular file and fork the backlog - make it this home's real file"
  fi
  export TASKS_AXI_FILE="$FM_BACKLOG_AXI_FILE"
else
  unset TASKS_AXI_FILE
fi

# Lifecycle checks below run after this cd; freeze caller-relative roots first.
DATA=$(fm_backlog_data_absolute "$DATA") || fail "cannot resolve data directory $DATA"
TASK_STATE=${FM_STATE_OVERRIDE:-$FM_HOME/state}
case "$TASK_STATE" in /*) ;; *) TASK_STATE="$CALLER_DIR/$TASK_STATE" ;; esac
cd "$FM_BACKLOG_AXI_ROOT" || fail "cannot enter the backlog root $FM_BACKLOG_AXI_ROOT"

# shortcut: reads only the root .tasks.toml, not ~/.tasks-axi/config.toml; extend if a home sets its archive there.
archive_path() {
  local configured=
  if [ -f .tasks.toml ]; then
    configured=$(LC_ALL=C awk '
      { line=$0; sub(/[[:space:]]*#.*/, "", line); sub(/^[[:space:]]+/, "", line); sub(/[[:space:]]+$/, "", line) }
      line ~ /^\[[^]]+\]$/ { section=line; next }
      section == "[markdown]" && line ~ /^archive[[:space:]]*=/ {
        sub(/^archive[[:space:]]*=[[:space:]]*/, "", line)
        if (line ~ /^".*"$/ || line ~ /^\047.*\047$/) print substr(line, 2, length(line) - 2)
        exit
      }
    ' .tasks.toml)
  fi
  case "$configured" in
    '') printf '%s/done-archive.md' "$(dirname "$FM_BACKLOG_AXI_FILE")" ;;
    /*) printf '%s' "$configured" ;;
    *) printf '%s/%s' "$FM_BACKLOG_AXI_ROOT" "$configured" ;;
  esac
}

if [ "$ARCHIVE" = 1 ]; then
  [ -n "$FM_BACKLOG_AXI_FILE" ] || fail "archive mode reads a markdown archive, and this home's backlog adapter is not markdown"
  ARCHIVE_FILE=$(archive_path)
  ARCHIVE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/fm-tasks-axi-archive.XXXXXX") || fail "cannot create a temporary directory for the archive copy"
  trap 'rm -rf "$ARCHIVE_DIR"' EXIT
  {
    printf '## In flight\n\n## Queued\n\n## Done\n\n'
    if [ -f "$ARCHIVE_FILE" ]; then
      sed '/^## Archived /d' "$ARCHIVE_FILE"
    fi
  } > "$ARCHIVE_DIR/backlog.md" || fail "cannot read the archive at $ARCHIVE_FILE"
  cd "$ARCHIVE_DIR" || fail "cannot enter the archive copy"
  set -o pipefail
  TASKS_AXI_BACKEND=markdown TASKS_AXI_FILE="$ARCHIVE_DIR/backlog.md" tasks-axi ${ARGS[@]+"${ARGS[@]}"} | fm_hold_reason_decode_stream
  exit $?
fi
case "${1:-}" in
  show|view|list)
    set -o pipefail
    tasks-axi ${ARGS[@]+"${ARGS[@]}"} | fm_hold_reason_decode_stream
    exit $?
    ;;
esac
# tasks-axi takes these commands' flags on either side of their one task id.
task_id=''
hold_kind=untyped
hold_until=''
dependency=''
gate=''
case "${1:-}" in
  done|close|hold)
    for ((i=1; i<${#ARGS[@]}; i++)); do
      case "${ARGS[i]}" in
        --kind) i=$((i + 1)); hold_kind=${ARGS[i]-} ;;
        --kind=*) hold_kind=${ARGS[i]#*=} ;;
        --until) i=$((i + 1)); hold_until=${ARGS[i]-} ;;
        --until=*) hold_until=${ARGS[i]#*=} ;;
        --reason|--pr|--report|--note|--keep|--backend) i=$((i + 1)) ;;
        -*) ;;
        *) [ -n "$task_id" ] || task_id=${ARGS[i]} ;;
      esac
    done
    ;;
esac
case "${1:-}" in
  done|close)
    case "$task_id" in
      ''|*[!A-Za-z0-9._-]*) ;;
      *)
        task_meta="$TASK_STATE/$task_id.meta"
        if [ -e "$task_meta" ] || [ -L "$task_meta" ]; then
          fm_backlog_record_present "$task_meta" "task record" "$TASK_STATE" \
            || fail "cannot read task $task_id: $FM_BACKLOG_TRANSITION_ERROR"
          if grep -qx 'completion_required=1' "$task_meta"; then
            FM_DATA_OVERRIDE="$DATA" FM_STATE_OVERRIDE="$TASK_STATE" \
              "$SCRIPT_DIR/fm-captain-hold.sh" verify "$task_id" >/dev/null \
              || fail "task $task_id must pass its outcome review before closing"
          else
            [ "$?" = 1 ] || fail "cannot read outcome requirement for task $task_id"
          fi
        fi
        ;;
    esac
    ;;
esac
# A coordinator action retains its owner after the originating milestone is
# cleaned up. Do not hide that ready action behind a wait nothing re-reads: a
# firstmate row may name the captain, a date, or a dependency row, and an
# `external` condition counts only through one of the last two, because the
# backlog itself re-reads exactly those. Prose alone is refused here, at the one
# write that could otherwise park the action outside its owner's next move.
if [ "${1:-}" = hold ] && [ -n "$task_id" ]; then
  fm_backlog_row_probe "$DATA" "$task_id" || fail "cannot read task $task_id before holding it"
  if [ "$FM_BACKLOG_ROW_KIND" = firstmate ]; then
    # The probe's state line is "<state> <held> <blocked>", and a dependency only
    # reaches it while its blocker is unfinished: the backlog drops a completed
    # one, so `blocked: yes` is a live referent rather than a claim. The gate rule
    # itself is bin/fm-backlog-transition-lib.sh's, so this write cannot disagree
    # with the outcome review or the startup audit about what counts as a gate.
    dependency=
    [ "${FM_BACKLOG_ROW_STATE##* }" != yes ] || dependency=live
    gate=$(fm_backlog_gate_verdict "$hold_kind" "$hold_until" "$dependency") || case "$gate" in
      external-unbacked)
        fail "firstmate action $task_id needs an external referent the home can re-read: a live dependency row (tasks-axi block $task_id --by <other>) or a date (--until); a prose-only external wait would never be re-checked"
        ;;
      *)
        fail "firstmate action $task_id needs a real captain, external, date or dependency gate; an undated $hold_kind wait cannot hide its next action"
        ;;
    esac
  fi
fi
exec tasks-axi ${ARGS[@]+"${ARGS[@]}"}
