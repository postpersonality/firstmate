#!/usr/bin/env bash
# Native Codex app-server Stop return owner, called by fm-turnend-guard.sh.
# Retains one foreground checkpoint and delivers its close through synchronous
# exit-2 Stop feedback, even when another hook set stop_hook_active. No async
# hook, detached process, extra wake queue or model-owned callback is involved.
# Usage: fm-codex-stop-watch.sh < native-Stop-payload.json
#
# Only a genuine primary, the native thread id and the existing session lock
# may park. fm-lock.sh remains the sole writer of the lock and its sidecar.
# Stop only revalidates the thread already recorded in that sidecar and never
# binds a free, stale, legacy PID-only or other thread's lock; the ordinary
# binding path is the native SessionStart hook's host-side fm-lock.sh run, and
# fm-lock.sh does not verify hook provenance. fm-turnend-guard.sh calls this
# script only for the recorded thread and keeps its non-claiming one-block
# guard for every other thread. The recorded thread attached to another live
# app-server that holds the lock stays read-only here.
# The lock verification is bounded to 8s plus 1s termination grace. It is
# skipped for an already bound and verified owner.
# Lock verification and the checkpoint share a 20s budget beneath the existing
# 30s hook registration, with 1s watcher termination grace. A healthy existing
# watcher is followed through its durable queue rather than duplicated or killed.
# Pending rows always go to main; this script never drains, acknowledges,
# decides or dispatches work.
# Once the recorded thread has pending work, Stop fails closed: lock failure,
# checkpoint-lock contention, checkpoint failure and an unhandled repeated wake
# each return another continuation. A fleet whose only in-flight items are
# durably transferred to captain-held records, with no independent checks or
# event sources, is a legitimate human wait and may return normally. Another
# thread's Stop never parks here, and a duplicate attachment while the owning
# app-server lives is never blocked. Interrupting the native turn cancels its
# synchronous hook and its foreground checkpoint. Empty homes and a verified
# away daemon with a fresh watcher beacon do not park here.
# FM_CODEX_STOP_CHECKPOINT may shorten the bound (1..20), never raise it.
# A state/.codex-stop-checkpoint-paused file containing "stop" records an
# explicit home-local stop; removing it resumes Codex checkpoints.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
end_by=$((SECONDS + 20))
PAYLOAD=$(cat 2>/dev/null || true)
# shellcheck source=bin/fm-primary-scope-lib.sh
. "$SCRIPT_DIR/fm-primary-scope-lib.sh"
fm_primary_scope_matches "$FM_ROOT" "$STATE" || exit 0
# shellcheck source=bin/fm-session-lock-lib.sh
. "$SCRIPT_DIR/fm-session-lock-lib.sh"
# shellcheck source=bin/fm-supervision-lib.sh
. "$SCRIPT_DIR/fm-supervision-lib.sh"
# shellcheck source=bin/fm-classify-lib.sh
. "$SCRIPT_DIR/fm-classify-lib.sh"
# shellcheck source=bin/fm-wake-lib.sh
. "$SCRIPT_DIR/fm-wake-lib.sh"
# shellcheck source=bin/fm-timeout-lib.sh
. "$SCRIPT_DIR/fm-timeout-lib.sh"
fm_session_lock_codex_api_pid >/dev/null || exit 0
printf '%s' "$PAYLOAD" | jq -e \
  '.hook_event_name == "Stop" and (.session_id | type == "string" and length > 0) and (.turn_id | type == "string" and length > 0)' >/dev/null 2>&1 || exit 0
FM_CODEX_HOOK_SESSION_ID=$(printf '%s' "$PAYLOAD" | jq -r '.session_id')
export FM_CODEX_HOOK_SESSION_ID
session=$(fm_session_lock_codex_session_id) || exit 0

notice() { jq -cn --arg message "$1" '{systemMessage:$message}'; }
owned() { fm_session_lock_owned_by_self "$STATE"; }
recorded() { [ "$(fm_session_lock_recorded_session_id "$STATE" || true)" = "$session" ]; }
mine() { recorded && ! fm_session_lock_foreign_owner_live "$STATE"; }
if ! recorded; then
  notice 'FIRSTMATE SUPERVISION: the session lock does not record this native thread; Stop never claims it, so no checkpoint was started. Only the native SessionStart hook records a primary thread.'
  exit 0
fi
if fm_session_lock_foreign_owner_live "$STATE"; then
  notice "FIRSTMATE SUPERVISION: live process $FM_SESSION_LOCK_FOREIGN_OWNER_PID owns the session lock for this thread; this attachment is read-only, so no checkpoint was started."
  exit 0
fi
# Revalidate through the existing writer. A live foreign owner is never stolen.
lock_status=0
owned || (fm_exec_timed 8 1 "$SCRIPT_DIR/fm-lock.sh") >/dev/null 2>&1 || lock_status=$?
if owned && [ -f "$STATE/.codex-stop-checkpoint-paused" ] \
  && [ ! -L "$STATE/.codex-stop-checkpoint-paused" ] \
  && [ "$(cat "$STATE/.codex-stop-checkpoint-paused")" = stop ]; then
  exit 0
fi

fm_codex_only_captain_held() {
  local meta id status wait_line count=0
  [ "$FM_SUP_IN_FLIGHT" -gt 0 ] || return 1
  [ "$FM_SUP_SOURCES" -eq 0 ] && [ "$FM_SUP_CHECKS" -eq 0 ] || return 1
  [ ! -f "$STATE/x-watch.check.sh" ] || return 1
  for meta in "$STATE"/*.meta; do
    [ -e "$meta" ] || continue
    [ -f "$meta" ] && [ ! -L "$meta" ] || return 1
    id=${meta##*/}
    id=${id%.meta}
    [ -n "$id" ] || return 1
    status="$STATE/$id.status"
    [ -f "$status" ] && [ ! -L "$status" ] || return 1
    wait_line=$(status_declared_wait_line "$status") || return 1
    [ -n "$wait_line" ] && status_is_captain_held "$wait_line" || return 1
    count=$((count + 1))
  done
  [ "$count" -eq "$FM_SUP_IN_FLIGHT" ] && [ "$count" -gt 0 ]
}

fm_supervision_status "$STATE"
if [ "$FM_SUP_NEEDED" = false ] && [ "$FM_SUP_QUEUE_PENDING" = false ]; then exit 0; fi
if fm_codex_only_captain_held; then
  # Re-read immediately before yielding; pending wakes and unrelated check owners
  # still require the primary even when every task itself is captain-held.
  fm_supervision_status "$STATE"
  if [ "$FM_SUP_QUEUE_PENDING" = false ] && fm_codex_only_captain_held; then exit 0; fi
fi
if fm_afk_daemon_owns_supervision "$STATE" && [ "$FM_SUP_WATCHER_FRESH" = true ]; then exit 0; fi

continuation() {
  mine || { notice 'FIRSTMATE SUPERVISION: session-lock ownership changed during Stop; checkpoint feedback withheld.'; exit 0; }
  printf 'firstmate watcher wake: %s\n' "$1" >&2
  printf '%s\n' "Continue on this same primary. Drain bin/fm-wake-drain.sh, handle its current wakes and permitted next fleet actions, then run its exact WAKE_ACK_REQUIRED command. Process any newly submitted user message; never synthesize user text. If no actionable wake remains while tasks, process-event sources, registered checks or Relay polling still need supervision, start the next bounded foreground checkpoint with bin/fm-watch-checkpoint.sh --seconds \"\${FM_CODEX_WATCH_CHECKPOINT:-180}\"; a quiet checkpoint alone is not completion. Respect durable captain-held/security waits and explicit stops." >&2
  exit 2
}
owned || continuation "session-lock verification failed (exit $lock_status); the next native Stop retries it outside the tool sandbox"

bound=${FM_CODEX_STOP_CHECKPOINT:-20}
case "$bound" in ''|*[!0-9]*|0) bound=20 ;; esac
[ "$bound" -le 20 ] || bound=20
deadline=$((SECONDS + bound))
[ "$deadline" -le "$end_by" ] || deadline=$end_by
out=$(mktemp "$STATE/.codex-stop-output.XXXXXX") || continuation 'cannot create the checkpoint output file'
stop_lock="$STATE/.codex-stop.lock"
if ! fm_lock_acquire_wait_max "$stop_lock" $((deadline - SECONDS)); then
  rm -f "$out"
  continuation "another Stop held the checkpoint lock for the whole ${bound}s bound"
fi
trap 'rm -f "$out"; fm_lock_release "$stop_lock"' EXIT

if [ -s "$STATE/.wake-queue" ]; then continuation 'pending durable wake at Stop boundary'; fi
if fm_watcher_healthy "$STATE" "$SCRIPT_DIR/fm-watch.sh" "${FM_GUARD_GRACE:-300}" "$FM_HOME"; then
  # A previously yielded checkpoint may still own the singleton. Retain a
  # native return path while it finishes; its queue, not its output, is durable.
  while [ "$SECONDS" -lt "$deadline" ]; do
    mine || exit 0
    [ ! -s "$STATE/.wake-queue" ] || continuation 'existing watcher published a durable wake'
    fm_watcher_healthy "$STATE" "$SCRIPT_DIR/fm-watch.sh" "${FM_GUARD_GRACE:-300}" "$FM_HOME" || break
    sleep 1
  done
  if [ "$SECONDS" -ge "$deadline" ]; then continuation "checkpoint: existing watcher retained for ${bound}s"; fi
fi

status=0
remaining=$((deadline - SECONDS))
[ "$remaining" -gt 0 ] || continuation "checkpoint: existing watcher retained for ${bound}s"
FM_SIGNAL_GRACE=1 "$SCRIPT_DIR/fm-watch-checkpoint.sh" --seconds "$remaining" --hard-bound >"$out" 2>&1 || status=$?
if [ "$status" -eq 0 ] || [ "$status" -eq 124 ]; then
  continuation "$(cat "$out")"
fi
continuation "checkpoint failed (exit $status); repair the existing watcher owner before continuing: $(cat "$out")"
