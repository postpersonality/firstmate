#!/usr/bin/env bash
# Native Codex app-server Stop return owner, called by fm-turnend-guard.sh.
# Retains one foreground checkpoint and delivers its close through synchronous
# exit-2 Stop feedback, even when another hook set stop_hook_active. No async
# hook, detached process, extra wake queue or model-owned callback is involved.
# Usage: fm-codex-stop-watch.sh < native-Stop-payload.json
#
# Only a genuine primary, the native thread id and the existing session lock
# may park. fm-lock.sh remains the sole writer of the lock and its sidecar.
# A legacy PID-only lock is bound by that writer before the first park. The
# lock verification is bounded to 8s plus 1s termination grace. It is skipped
# for an already bound and verified owner. Lock verification and the checkpoint
# share a 20s budget beneath the existing 30s hook registration, with
# 1s watcher termination grace. A healthy existing watcher is followed through
# its durable queue rather than duplicated or killed. Pending rows always go
# to main; this script never drains, acknowledges, decides or dispatches work.
# A successful bounded wait may continue repeatedly; failures get one repair
# continuation per native turn, then an explicit error instead of a Stop loop.
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
# Revalidate through the existing writer, including a stale PID recorded by a
# sandboxed tool in another PID namespace. A live foreign owner is never stolen.
if ! fm_session_lock_recorded_session_id "$STATE" >/dev/null || ! owned; then
  lock_status=0
  (fm_exec_timed 8 1 "$SCRIPT_DIR/fm-lock.sh") >/dev/null 2>&1 || lock_status=$?
  if [ "$lock_status" -ne 0 ]; then
    notice "FIRSTMATE SUPERVISION: another session owns this home or session-lock verification failed (exit $lock_status); no checkpoint was started."
    exit 0
  fi
fi
if ! owned; then
  notice 'FIRSTMATE SUPERVISION: session-lock ownership is unproved; no checkpoint was started.'
  exit 0
fi
fm_supervision_status "$STATE"
if [ "$FM_SUP_NEEDED" = false ] && [ "$FM_SUP_QUEUE_PENDING" = false ]; then exit 0; fi
if fm_afk_daemon_owns_supervision "$STATE"; then exit 0; fi

bound=${FM_CODEX_STOP_CHECKPOINT:-20}
case "$bound" in ''|*[!0-9]*|0) bound=20 ;; esac
[ "$bound" -le 20 ] || bound=20
out=$(mktemp "$STATE/.codex-stop-output.XXXXXX") || exit 1
stop_lock="$STATE/.codex-stop.lock"
if ! fm_lock_try_acquire "$stop_lock"; then rm -f "$out"; exit 0; fi
trap 'rm -f "$out"; fm_lock_release "$stop_lock"' EXIT
failure="$STATE/.codex-stop-repair"
delivery="$STATE/.codex-stop-delivery"
key="$session:$turn"
failed() {
  if [ "$(cat "$failure" 2>/dev/null || true)" = "$key" ]; then
    notice "FIRSTMATE SUPERVISION FAILED: repeated continuation failure in this native turn; automatic repair stopped: $1"
    exit 0
  fi
  printf '%s\n' "$key" > "$failure"
  continuation "$1"
}
continuation() {
  owned || { notice 'FIRSTMATE SUPERVISION: ownership changed during Stop; checkpoint feedback withheld.'; exit 0; }
  printf 'firstmate watcher wake: %s\n' "$1" >&2
  printf 'Drain bin/fm-wake-drain.sh, handle its current wakes and permitted next fleet actions, then run its exact WAKE_ACK_REQUIRED command. Respect real captain/security waits and explicit stops.\n' >&2
  exit 2
}
delivered() {
  local fingerprint previous
  if [ -s "$STATE/.wake-queue" ]; then
    fingerprint="$key:$(cksum < "$STATE/.wake-queue")"
    previous=$(cat "$delivery" 2>/dev/null || true)
    [ "$previous" != "$fingerprint" ] || failed 'the previous durable wake was not handled/acknowledged; repair the primary handler before ending'
    printf '%s\n' "$fingerprint" > "$delivery"
  else
    rm -f "$delivery"
  fi
  rm -f "$failure"
  continuation "$1"
}

if [ -s "$STATE/.wake-queue" ]; then delivered 'pending durable wake at Stop boundary'; fi
deadline=$((SECONDS + bound))
[ "$deadline" -le "$end_by" ] || deadline=$end_by
if fm_watcher_healthy "$STATE" "$SCRIPT_DIR/fm-watch.sh" "${FM_GUARD_GRACE:-300}" "$FM_HOME"; then
  # A previously yielded checkpoint may still own the singleton. Retain a
  # native return path while it finishes; its queue, not its output, is durable.
  while [ "$SECONDS" -lt "$deadline" ]; do
    owned || exit 0
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
failed "checkpoint failed (exit $status); repair the existing watcher owner before continuing: $(cat "$out")"
