#!/usr/bin/env bash
# Native Codex app-server Stop return owner, called by fm-turnend-guard.sh.
# Retains one foreground checkpoint and delivers its close through synchronous
# exit-2 Stop feedback, even when another hook set stop_hook_active. No async
# hook, detached process, extra wake queue or model-owned callback is involved.
# Usage: fm-codex-stop-watch.sh < native-Stop-payload.json
#
# Only a genuine primary, the native thread id and the existing session lock
# may park. fm-lock.sh remains the sole writer of the lock and its sidecar.
# Stop only revalidates the thread already recorded in that sidecar; a free,
# legacy PID-only or other thread's lock is bound only by the native
# SessionStart hook. fm-turnend-guard.sh keeps its one-block legacy
# guard for a PID-only lock this app-server holds. The recorded thread attached
# to another live app-server that holds the lock stays read-only here.
# The lock verification is bounded to 8s plus 1s termination grace. It is
# skipped for an already bound and verified owner.
# Lock verification and the checkpoint share a 20s budget beneath the existing
# 30s hook registration, with 1s watcher termination grace. A healthy existing
# watcher is followed through its durable queue rather than duplicated or killed.
# Pending rows always go to main; this script never drains, acknowledges,
# decides or dispatches work.
# Once the recorded thread has pending work, Stop fails closed: lock failure,
# checkpoint-lock contention, checkpoint failure and an unhandled repeated wake
# each return another continuation. Another thread's Stop, or a duplicate
# attachment while the owning app-server lives, is never blocked.
# Interrupting the native turn cancels its synchronous hook and its foreground
# checkpoint. Empty homes and a verified away daemon do not park here.
# FM_CODEX_STOP_CHECKPOINT may shorten the bound (1..20), never raise it.
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
turn=$(printf '%s' "$PAYLOAD" | jq -r '.turn_id')

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
fm_supervision_status "$STATE"
if [ "$FM_SUP_NEEDED" = false ] && [ "$FM_SUP_QUEUE_PENDING" = false ]; then exit 0; fi
if fm_afk_daemon_owns_supervision "$STATE"; then exit 0; fi

continuation() {
  mine || { notice 'FIRSTMATE SUPERVISION: session-lock ownership changed during Stop; checkpoint feedback withheld.'; exit 0; }
  printf 'firstmate watcher wake: %s\n' "$1" >&2
  printf 'Drain bin/fm-wake-drain.sh, handle its current wakes and permitted next fleet actions, then run its exact WAKE_ACK_REQUIRED command. Respect real captain/security waits and explicit stops.\n' >&2
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
delivery="$STATE/.codex-stop-delivery"
key="$session:$turn"
delivered() {
  local fingerprint
  if [ -s "$STATE/.wake-queue" ]; then
    fingerprint="$key:$(cksum < "$STATE/.wake-queue")"
    [ "$(cat "$delivery" 2>/dev/null || true)" != "$fingerprint" ] \
      || continuation 'the previous durable wake was not handled/acknowledged; repair the primary handler before ending'
    printf '%s\n' "$fingerprint" > "$delivery"
  else
    rm -f "$delivery"
  fi
  continuation "$1"
}

if [ -s "$STATE/.wake-queue" ]; then delivered 'pending durable wake at Stop boundary'; fi
if fm_watcher_healthy "$STATE" "$SCRIPT_DIR/fm-watch.sh" "${FM_GUARD_GRACE:-300}" "$FM_HOME"; then
  # A previously yielded checkpoint may still own the singleton. Retain a
  # native return path while it finishes; its queue, not its output, is durable.
  while [ "$SECONDS" -lt "$deadline" ]; do
    mine || exit 0
    [ ! -s "$STATE/.wake-queue" ] || delivered 'existing watcher published a durable wake'
    fm_watcher_healthy "$STATE" "$SCRIPT_DIR/fm-watch.sh" "${FM_GUARD_GRACE:-300}" "$FM_HOME" || break
    sleep 1
  done
  if [ "$SECONDS" -ge "$deadline" ]; then delivered "checkpoint: existing watcher retained for ${bound}s"; fi
fi

status=0
remaining=$((deadline - SECONDS))
[ "$remaining" -gt 0 ] || delivered "checkpoint: existing watcher retained for ${bound}s"
FM_SIGNAL_GRACE=1 "$SCRIPT_DIR/fm-watch-checkpoint.sh" --seconds "$remaining" --hard-bound >"$out" 2>&1 || status=$?
if [ "$status" -eq 0 ] || [ "$status" -eq 124 ]; then
  delivered "$(cat "$out")"
fi
continuation "checkpoint failed (exit $status); repair the existing watcher owner before continuing: $(cat "$out")"
