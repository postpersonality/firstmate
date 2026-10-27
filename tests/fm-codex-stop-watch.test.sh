#!/usr/bin/env bash
# Codex API Stop continuity through the real guard/checkpoint/drain/inbox.
# The native process shape is synthetic; the opt-in API guard proves delivery.
set -eu
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
LAB=$(fm_test_tmproot fm-codex-stop-watch)
ln -s "$(command -v bash)" "$LAB/codex"

make_home() {
  local home="$LAB/$1"
  mkdir -p "$home/state" "$home/config"
  git init -q "$home"
  : > "$home/AGENTS.md"
  ln -s "$ROOT/bin" "$home/bin"
  # A trusted-check registration counts as supervision need without accessing
  # any terminal or backend. Its execution sweep is disabled in this fixture.
  printf '#!/usr/bin/env bash\nexit 1\n' > "$home/state/lab.check.sh"
  chmod 700 "$home/state/lab.check.sh"
  FM_HOME="$home" bash "$ROOT/bin/fm-check-register.sh" lab >/dev/null
  cat > "$home/app-server" <<'SH'
if [ "${TEST_KEEP_LOCK:-0}" != 1 ]; then printf '%s\n' "$$" > "$FM_HOME/state/.lock"; fi
if [ "${TEST_NO_SESSION:-0}" != 1 ]; then printf '%s\n' "${TEST_LOCK_SESSION:-S1}" > "$FM_HOME/state/.lock-session"; fi
if [ "${TEST_UNKNOWN_ID:-0}" = 1 ]; then unset CODEX_THREAD_ID CODEX_SESSION_ID; fi
if [ "${TEST_HOLD:-0}" = 1 ]; then
  while [ ! -e "$FM_HOME/release" ]; do sleep 0.1; done
  exit 0
fi
if [ "${TEST_LOCK_ONLY:-0}" = 1 ]; then bash "$TEST_ROOT/bin/fm-lock.sh"; exit $?; fi
unset CODEX_THREAD_ID CODEX_SESSION_ID
if [ "${TEST_START:-0}" = 1 ]; then
  printf '{"hook_event_name":"SessionStart","session_id":"S1","source":"%s"}\n' "${TEST_START_SOURCE:-startup}" \
    | bash "$FM_HOME/bin/fm-sessionstart-run.sh"
  exit $?
fi
printf '{"hook_event_name":"Stop","session_id":"%s","turn_id":"T1","stop_hook_active":%s}\n' \
  "${TEST_STOP_SESSION:-S1}" "${TEST_STOP_ACTIVE:-true}" \
  | bash "$TEST_ROOT/bin/fm-turnend-guard.sh"
SH
  printf '%s\n' "$home"
}

stub_session_start() {
  rm "$1/bin"
  cp -R "$ROOT/bin" "$1/bin"
  cat > "$1/bin/fm-session-start.sh" <<'SH'
#!/usr/bin/env bash
bash "$FM_HOME/bin/fm-lock.sh"
SH
}

run_stop() {
  local home=$1
  (cd "$home"; FM_HOME="$home" FM_ROOT_OVERRIDE="$home" TEST_ROOT="$ROOT" \
    CODEX_THREAD_ID=S1 CODEX_SESSION_ID=S1 FM_CODEX_STOP_CHECKPOINT=2 \
    FM_POLL=1 FM_SIGNAL_GRACE=1 FM_CHECK_INTERVAL=999999 FM_HEARTBEAT=999999 \
    "$LAB/codex" app-server > "$home/out" 2> "$home/err")
}

home=$(make_home captain-stopped-checkpoints)
printf 'stop\n' > "$home/state/.codex-stop-checkpoint-paused"
FM_HOME="$home" bash -c '. "$1/bin/fm-wake-lib.sh"; fm_wake_append signal worker.status "done: retained for later"' _ "$ROOT"
status=0
run_stop "$home" || status=$?
expect_code 0 "$status" 'an explicit stop for this home must suppress the automatic checkpoint'
[ ! -s "$home/err" ] || fail 'stopped checkpoint produced a continuation'
assert_absent "$home/state/.watch.lock/pid" 'stopped checkpoint started a watcher'
assert_contains "$(cat "$home/state/.wake-queue")" 'retained for later' 'stopping checkpoints lost a pending wake'
pass 'Codex API Stop: an explicit home stop preserves pending wakes without starting a checkpoint'

home=$(make_home invalid-stop)
printf 'invalid\n' > "$home/state/.codex-stop-checkpoint-paused"
status=0
run_stop "$home" || status=$?
expect_code 2 "$status" 'an invalid stop record must not suppress supervision'
assert_contains "$(cat "$home/err")" 'checkpoint:' 'an invalid stop record suppressed the checkpoint'
pass 'Codex API Stop: an invalid stop record does not disable supervision'

home=$(make_home quiet)
status=0
run_stop "$home" || status=$?
expect_code 2 "$status" 'a successful quiet Stop checkpoint must compel the successor even when stop_hook_active=true'
assert_contains "$(cat "$home/err")" 'checkpoint:' 'quiet checkpoint was not delivered through Stop feedback'
assert_contains "$(cat "$home/err")" 'start the next bounded foreground checkpoint' 'quiet continuation omitted its executable successor path'
assert_contains "$(cat "$home/err")" 'FM_CODEX_WATCH_CHECKPOINT:-180' 'quiet continuation omitted the standard 180-second fallback'
assert_absent "$home/state/.watch.lock/pid" 'quiet Stop leaked a watcher'
pass 'Codex API Stop: a quiet checkpoint returns an executable continuation, despite the old loop flag'

prepare_live_away_daemon() {
  local home=$1 identity
  printf 'away\n' > "$home/state/.afk"
  mkdir -p "$home/state/.supervise-daemon.lock"
  printf '%s\n' "$$" > "$home/state/.supervise-daemon.lock/pid"
  identity=$(bash -c '. "$1/bin/fm-wake-lib.sh"; fm_pid_identity "$2"' _ "$ROOT" "$$")
  [ -n "$identity" ] || fail 'could not identify the live fixture daemon owner'
  printf '%s\n' "$identity" > "$home/state/.supervise-daemon.lock/pid-identity"
}

home=$(make_home afk-fresh-beacon)
prepare_live_away_daemon "$home"
touch "$home/state/.last-watcher-beat"
status=0
run_stop "$home" || status=$?
expect_code 0 "$status" 'a live away daemon with a fresh watcher beacon must remain the alternate owner'
[ ! -s "$home/out" ] && [ ! -s "$home/err" ] || fail 'fresh away-daemon ownership produced a continuation'
assert_absent "$home/state/.watch.lock/pid" 'fresh away-daemon ownership started another watcher'
pass 'Codex API Stop: a fresh beacon permits the live away daemon to own supervision'

home=$(make_home afk-stale-beacon)
prepare_live_away_daemon "$home"
touch "$home/state/.last-watcher-beat"
sleep 2
status=0
FM_GUARD_GRACE=1 run_stop "$home" || status=$?
expect_code 2 "$status" 'a live away daemon with a stale watcher beacon must fall back to the native checkpoint'
assert_contains "$(cat "$home/err")" 'checkpoint:' 'stale away-daemon fallback did not return a checkpoint continuation'
assert_absent "$home/state/.watch.lock/pid" 'stale away-daemon fallback started a second watcher'
pass 'Codex API Stop: a stale beacon prevents the live away daemon from suppressing the checkpoint'

home=$(make_home cli-argument)
cat > "$home/exec" <<'SH'
. "$TEST_ROOT/bin/fm-session-lock-lib.sh"
if fm_session_lock_codex_api_pid; then exit 1; fi
SH
(cd "$home"; TEST_ROOT="$ROOT" "$LAB/codex" exec 'codex app-server') \
  || fail 'CLI prompt text was mistaken for an actual app-server command'
pass 'Codex API identity: CLI prompt text cannot select the native API owner'

home=$(make_home existing-watcher)
fm_test_track_watcher_state "$home/state"
FM_HOME="$home" FM_POLL=1 FM_CHECK_INTERVAL=999999 FM_HEARTBEAT=999999 \
  bash "$ROOT/bin/fm-watch.sh" >"$home/watcher.out" 2>"$home/watcher.err" &
watcher=$!
for _ in {1..50}; do
  [ ! -f "$home/state/.last-watcher-beat" ] || break
  sleep 0.1
done
assert_present "$home/state/.last-watcher-beat" 'fixture watcher never became healthy'
status=0
run_stop "$home" || status=$?
expect_code 2 "$status" 'a healthy existing watcher still needs a real successor delivery'
assert_contains "$(cat "$home/err")" 'existing watcher retained' 'Stop did not follow the existing watcher'
[ "$(cat "$home/state/.watch.lock/pid")" = "$watcher" ] || fail 'Stop replaced the existing watcher'
kill -TERM "$watcher"
wait "$watcher" || true
pass 'Codex API Stop: an existing healthy watcher is retained once and quiet completion still reaches the handler'

home=$(make_home late)
(
  sleep 1
  printf 'done: ready for already authorized validation\n' > "$home/state/worker.status"
) &
producer=$!
status=0
run_stop "$home" || status=$?
wait "$producer"
expect_code 2 "$status" 'a worker close after a short reply must reach the native Stop continuation'
assert_contains "$(cat "$home/err")" 'Drain bin/fm-wake-drain.sh' 'late worker close reached no handler continuation'
drain=$(FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_GUARD_SKIP=1 bash "$ROOT/bin/fm-wake-drain.sh" 2>&1)
assert_contains "$drain" 'ready for already authorized validation' 'late worker close did not survive the Stop boundary'
# The resumed handler takes an actual permitted action using the existing
# durable steering primitive, then acknowledges the generation it handled.
bash -c '. "$1/bin/fm-task-inbox-lib.sh"; fm_task_inbox_write_idempotent "$2/state" worker "Proceed with the already authorized validation"' _ "$ROOT" "$home" >/dev/null
ack=$(printf '%s\n' "$drain" | sed -n 's/^WAKE_ACK_REQUIRED: after handling completes run //p')
[ -n "$ack" ] || fail 'drain omitted its acknowledgement'
FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_GUARD_SKIP=1 bash -c "$ack" >/dev/null
assert_contains "$(cat "$home/state/worker.inbox/001.msg")" 'authorized validation' 'handler did not steer the worker'
drain=$(FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_GUARD_SKIP=1 bash "$ROOT/bin/fm-wake-drain.sh" 2>&1)
assert_not_contains "$drain" 'ready for already authorized validation' 'acknowledged worker close replayed'
pass 'Codex API Stop: a late worker completion survives into a real idempotent steering action'

home=$(make_home foreign)
status=0
TEST_LOCK_SESSION=S2 TEST_STOP_ACTIVE=false run_stop "$home" || status=$?
expect_code 0 "$status" 'a different thread in the same app-server must not claim the primary lock'
assert_contains "$(cat "$home/out")" 'OWNED BY ANOTHER LIVE SESSION' 'foreign-thread refusal is missing'
assert_contains "$(cat "$home/state/.lock-session")" 'S2' 'the native Stop stole the other thread sidecar'
assert_absent "$home/state/.watch.lock/pid" 'foreign-thread Stop started a watcher'
pass 'Codex API Stop: shared daemon PID does not grant another thread ownership'

home=$(make_home lock-writer)
status=0
TEST_LOCK_ONLY=1 TEST_LOCK_SESSION=S2 run_stop "$home" || status=$?
expect_code 1 "$status" 'the lock writer must not overwrite another thread just because it has the same daemon PID'
assert_contains "$(cat "$home/state/.lock-session")" 'S2' 'same-PID lock confirmation stole another API thread'
home=$(make_home unknown-lock-writer)
status=0
TEST_LOCK_ONLY=1 TEST_UNKNOWN_ID=1 run_stop "$home" || status=$?
expect_code 1 "$status" 'a shared API PID without thread identity must not own a recorded thread'
assert_contains "$(cat "$home/state/.lock-session")" 'S1' 'an unidentified caller erased the recorded thread'
home=$(make_home legacy-lock-writer)
status=0
TEST_LOCK_ONLY=1 TEST_NO_SESSION=1 run_stop "$home" || status=$?
expect_code 1 "$status" 'the lock writer must not adopt a live legacy PID-only lock'
assert_contains "$(cat "$home/err")" 'legacy PID-only session lock' 'the legacy adoption refusal named no restart'
assert_absent "$home/state/.lock-session" 'the lock writer recorded a thread beside a live legacy PID-only lock'
pass 'Codex API session-lock writer: refuses another thread and never adopts a live legacy PID-only lock'

home=$(make_home session-start)
stub_session_start "$home"
status=0
TEST_START=1 TEST_NO_SESSION=1 run_stop "$home" || status=$?
expect_code 0 "$status" 'a refused native SessionStart must never block session initialization'
assert_contains "$(cat "$home/err")" 'legacy PID-only session lock' 'native session start adopted a live legacy PID-only lock'
assert_absent "$home/state/.lock-session" 'native session start recorded a thread beside a live legacy PID-only lock'
status=0
TEST_START=1 TEST_KEEP_LOCK=1 TEST_NO_SESSION=1 run_stop "$home" || status=$?
expect_code 0 "$status" 'native SessionStart must route the original payload identity to the lock writer'
assert_contains "$(cat "$home/out")" 'lock acquired: harness pid' 'native session start did not claim the stale legacy lock'
assert_contains "$(cat "$home/state/.lock-session")" 'S1' 'native session start did not bind its payload thread'
pass 'Codex API SessionStart: a live legacy lock stays read-only; after a restart the payload identity binds it without vendor environment IDs'

home=$(make_home held-only)
FM_HOME="$home" bash "$ROOT/bin/fm-check-unregister.sh" lab >/dev/null
mkdir -p "$home/data"
printf -- '- [ ] parked - waiting for captain approval\n' > "$home/data/backlog.md"
status=0
run_stop "$home" || status=$?
expect_code 0 "$status" 'held/parked backlog alone must not create supervision work'
[ ! -s "$home/out" ] && [ ! -s "$home/err" ] || fail 'held-only home produced a continuation'
assert_absent "$home/state/.watch.lock/pid" 'empty/held-only home started a watcher'
pass 'Codex API Stop: an empty fleet with held or parked backlog stays legitimately idle'

home=$(make_home captain-held-only)
FM_HOME="$home" bash "$ROOT/bin/fm-check-unregister.sh" lab >/dev/null
printf 'captain-held [key=approval]: tracked by approval-call\n' > "$home/state/approval.status"
printf 'task=approval-call\n' > "$home/state/approval.meta"
status=0
run_stop "$home" || status=$?
expect_code 0 "$status" 'a fleet durably held for a captain decision must not force another primary continuation'
[ ! -s "$home/out" ] && [ ! -s "$home/err" ] || fail 'captain-held-only home produced a continuation'
assert_absent "$home/state/.watch.lock/pid" 'captain-held-only home started a watcher'
pass 'Codex API Stop: a verified captain-held fleet remains a legitimate wait'

home=$(make_home open-decision)
FM_HOME="$home" bash "$ROOT/bin/fm-check-unregister.sh" lab >/dev/null
printf 'needs-decision [key=approval]: choose restricted or open access\n' > "$home/state/approval.status"
printf 'task=approval-call\n' > "$home/state/approval.meta"
status=0
run_stop "$home" || status=$?
expect_code 2 "$status" 'an untransferred captain decision must keep the primary continuation available'
pass 'Codex API Stop: an open decision is not mistaken for a completed captain wait'

home=$(make_home captain-held-with-check)
printf 'captain-held [key=approval]: tracked by approval-call\n' > "$home/state/approval.status"
printf 'task=approval-call\n' > "$home/state/approval.meta"
status=0
run_stop "$home" || status=$?
expect_code 2 "$status" 'an independent registered check must remain supervised beside captain-held work'
pass 'Codex API Stop: a registered independent check is not hidden by a captain-held task'

home=$(make_home captain-held-pending)
FM_HOME="$home" bash "$ROOT/bin/fm-check-unregister.sh" lab >/dev/null
printf 'captain-held [key=approval]: tracked by approval-call\n' > "$home/state/approval.status"
printf 'task=approval-call\n' > "$home/state/approval.meta"
FM_HOME="$home" bash -c '. "$1/bin/fm-wake-lib.sh"; fm_wake_append signal approval.status "done: approved work is ready"' _ "$ROOT"
status=0
run_stop "$home" || status=$?
expect_code 2 "$status" 'a pending natural wake must override the captain-held wait shortcut'
assert_contains "$(cat "$home/err")" 'pending durable wake' 'the wake beside a captain-held item did not reach the primary'
pass 'Codex API Stop: a pending wake stays actionable beside a captain-held task'

home=$(make_home failure)
mkdir "$home/fakebin"
cat > "$home/fakebin/perl" <<'SH'
#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in */fm-watch.sh) exit 9 ;; esac
done
SH
printf 'exec %q "$@"\n' "$(command -v perl)" >> "$home/fakebin/perl"
chmod +x "$home/fakebin/perl"
for attempt in 1 2 3; do
  status=0
  PATH="$home/fakebin:$PATH" run_stop "$home" || status=$?
  expect_code 2 "$status" "failed checkpoint attempt $attempt must fail closed for the recorded primary with pending work"
  assert_contains "$(cat "$home/err")" 'checkpoint failed' 'checkpoint failure did not reach the handler'
done
assert_absent "$home/state/.watch.lock/pid" 'failed checkpoint leaked a watcher'
pass 'Codex API Stop: repeated checkpoint failure keeps returning a repair continuation instead of allowing Stop'

home=$(make_home pending)
FM_HOME="$home" bash -c '. "$1/bin/fm-wake-lib.sh"; fm_wake_append signal worker.status "done: pending across boundary"' _ "$ROOT"
status=0
run_stop "$home" || status=$?
expect_code 2 "$status" 'pending wake must survive and force a real handler turn'
assert_contains "$(cat "$home/err")" 'pending durable wake' 'pending wake was not delivered'
assert_absent "$home/state/.watch.lock/pid" 'pending delivery started an unnecessary watcher'
for attempt in 2 3; do
  status=0
  run_stop "$home" || status=$?
  expect_code 2 "$status" "unhandled identical wake attempt $attempt must fail closed"
  assert_contains "$(cat "$home/err")" 'pending durable wake' 'unhandled duplicate wake lost its continuation'
done
assert_contains "$(cat "$home/state/.wake-queue")" 'worker.status' 'repeated delivery erased unhandled work'
pass 'Codex API Stop: an unhandled pending wake stays durable and keeps blocking Stop'

home=$(make_home contention)
bash -c '. "$1/bin/fm-wake-lib.sh"; fm_lock_try_acquire "$2" || exit 1; exec sleep 30' \
  _ "$ROOT" "$home/state/.codex-stop.lock" &
holder=$!
for _ in {1..50}; do
  [ ! -e "$home/state/.codex-stop.lock" ] || break
  sleep 0.1
done
assert_present "$home/state/.codex-stop.lock" 'fixture never held the checkpoint lock'
status=0
run_stop "$home" || status=$?
kill "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true
expect_code 2 "$status" 'checkpoint-lock contention must fail closed for the recorded primary with pending work'
assert_contains "$(cat "$home/err")" 'checkpoint lock' 'contention continuation did not name the held lock'
assert_absent "$home/state/.watch.lock/pid" 'contended Stop started a second watcher'
pass 'Codex API Stop: a held checkpoint lock returns a continuation instead of a silent Stop'

home=$(make_home legacy-stop)
stub_session_start "$home"
for thread in S2 S1; do
  status=0
  TEST_NO_SESSION=1 TEST_STOP_SESSION=$thread run_stop "$home" || status=$?
  expect_code 0 "$status" "the legacy guard must allow thread $thread once stop_hook_active bounds it"
  status=0
  TEST_NO_SESSION=1 TEST_STOP_SESSION=$thread TEST_STOP_ACTIVE=false run_stop "$home" || status=$?
  expect_code 2 "$status" "an unsupervised legacy PID-only lock must block thread $thread once"
  assert_contains "$(cat "$home/err")" 'restarting this app-server first if it holds a legacy PID-only lock' "the legacy block for thread $thread omitted the bind migration"
  assert_contains "$(cat "$home/err")" 'Only the native SessionStart hook binds the firstmate primary thread' "the legacy block for thread $thread omitted the host-side bind"
  assert_not_contains "$(cat "$home/err")" 'fm-lock.sh' "the legacy block for thread $thread told a sandboxed tool to claim"
  assert_absent "$home/state/.lock-session" "Stop of thread $thread adopted a legacy PID-only lock"
  assert_absent "$home/state/.watch.lock/pid" 'an unclaimed legacy lock started a watcher'
done
status=0
TEST_START=1 TEST_START_SOURCE=resume TEST_KEEP_LOCK=1 TEST_NO_SESSION=1 run_stop "$home" || status=$?
expect_code 0 "$status" 'the native SessionStart resume must bind the legacy lock after an app-server restart'
assert_contains "$(cat "$home/state/.lock-session")" 'S1' 'the native resume did not bind the stale legacy lock'
status=0
TEST_NO_SESSION=1 run_stop "$home" || status=$?
expect_code 2 "$status" 'the primary bound by native SessionStart must be supervised at Stop'
assert_contains "$(cat "$home/err")" 'checkpoint:' 'the bound primary did not get its checkpoint return'
status=0
TEST_NO_SESSION=1 TEST_STOP_SESSION=S2 TEST_STOP_ACTIVE=false run_stop "$home" || status=$?
expect_code 0 "$status" 'another thread of the same app-server must not be blocked'
assert_contains "$(cat "$home/out")" 'OWNED BY ANOTHER LIVE SESSION' 'the other thread got no read-only notice'
assert_contains "$(cat "$home/state/.lock-session")" 'S1' 'another thread replaced the claimed primary'
pass 'Codex API Stop: a legacy PID-only lock keeps a bounded guard and binds only through native SessionStart after a restart'

home=$(make_home unrecorded-locks)
for lock in free stale pid1; do
  rm -f "$home/state/.lock"
  case "$lock" in
    stale) bash -c 'printf "%s\n" "$$"' > "$home/state/.lock" ;;
    pid1) printf '1\n' > "$home/state/.lock" ;;
  esac
  before=$(cat "$home/state/.lock" 2>/dev/null || true)
  status=0
  TEST_KEEP_LOCK=1 TEST_NO_SESSION=1 run_stop "$home" || status=$?
  expect_code 0 "$status" "the $lock-lock guard must allow Stop once stop_hook_active bounds it"
  status=0
  TEST_KEEP_LOCK=1 TEST_NO_SESSION=1 TEST_STOP_ACTIVE=false run_stop "$home" || status=$?
  expect_code 2 "$status" "an unrecorded thread under a $lock lock with pending work must be blocked once"
  assert_contains "$(cat "$home/err")" 'does not record this native Codex thread' "the $lock-lock block omitted the bind instruction"
  assert_not_contains "$(cat "$home/err")" 'fm-lock.sh' "the $lock-lock block told a sandboxed tool to claim"
  [ "$(cat "$home/state/.lock" 2>/dev/null || true)" = "$before" ] || fail "Stop claimed a $lock lock"
  assert_absent "$home/state/.lock-session" "Stop recorded a thread beside a $lock lock"
  assert_absent "$home/state/.watch.lock/pid" "an unrecorded $lock lock started a watcher"
done
FM_HOME="$home" bash "$ROOT/bin/fm-check-unregister.sh" lab >/dev/null
status=0
TEST_KEEP_LOCK=1 TEST_NO_SESSION=1 TEST_STOP_ACTIVE=false run_stop "$home" || status=$?
expect_code 0 "$status" 'an unrecorded thread with an empty fleet must end its turn'
[ ! -s "$home/out" ] && [ ! -s "$home/err" ] || fail 'an unrecorded thread with an empty fleet got a notice or continuation'
pass 'Codex API Stop: free, stale and PID-1 locks keep a bounded non-claiming guard, silent for an empty fleet'

home=$(make_home legacy-resume)
stub_session_start "$home"
status=0
TEST_START=1 TEST_START_SOURCE=resume TEST_NO_SESSION=1 run_stop "$home" || status=$?
expect_code 0 "$status" 'a refused native resume must never block session initialization'
assert_contains "$(cat "$home/err")" 'legacy PID-only session lock' 'a thread resumed under a live legacy PID-only lock adopted it'
assert_absent "$home/state/.lock-session" 'a thread resumed under a live legacy PID-only lock recorded itself'
status=0
TEST_START=1 TEST_START_SOURCE=resume TEST_KEEP_LOCK=1 TEST_NO_SESSION=1 run_stop "$home" || status=$?
expect_code 0 "$status" 'a native resume must never block session initialization'
assert_contains "$(cat "$home/out")" 'lock acquired: harness pid' 'a thread resumed after an app-server restart was not bound in the hook'
assert_not_contains "$(cat "$home/out")" 'fm-session-start.sh' 'the resumed native thread was told to claim from its sandboxed tools'
assert_contains "$(cat "$home/state/.lock-session")" 'S1' 'the native resume did not record its thread'
status=0
TEST_START=1 TEST_START_SOURCE=resume run_stop "$home" || status=$?
expect_code 0 "$status" 'a native resume must never block session initialization'
[ ! -s "$home/out" ] || fail 'the bound primary thread was started again on resume'
status=0
TEST_START=1 TEST_START_SOURCE=resume TEST_LOCK_SESSION=S2 run_stop "$home" || status=$?
expect_code 0 "$status" 'a refused native resume must never block session initialization'
assert_contains "$(cat "$home/err")" 'another live firstmate session holds the lock' 'a resumed thread was not refused by the recorded thread of its live app-server'
assert_contains "$(cat "$home/state/.lock-session")" 'S2' 'a resumed thread replaced the recorded thread of its live app-server'
pass 'Codex API SessionStart: resume refuses a live legacy lock, binds after an app-server restart and leaves another recorded thread read-only'

home=$(make_home duplicate)
TEST_HOLD=1 run_stop "$home" &
holder_job=$!
for _ in {1..50}; do
  [ ! -s "$home/state/.lock-session" ] || break
  sleep 0.1
done
assert_present "$home/state/.lock-session" 'fixture app-server never recorded its thread'
holder=$(cat "$home/state/.lock")
for attempt in 1 2; do
  status=0
  TEST_KEEP_LOCK=1 TEST_NO_SESSION=1 run_stop "$home" || status=$?
  expect_code 0 "$status" "duplicate attachment Stop attempt $attempt must stay read-only while the owning app-server lives"
  assert_contains "$(cat "$home/out")" "live process $holder owns the session lock" 'the duplicate attachment got no read-only notice'
  [ ! -s "$home/err" ] || fail 'the duplicate attachment received an impossible repair continuation'
done
[ "$(cat "$home/state/.lock")" = "$holder" ] || fail 'the duplicate attachment took over a live owner'
assert_absent "$home/state/.watch.lock/pid" 'the duplicate attachment started a watcher'
: > "$home/release"
wait "$holder_job"
status=0
TEST_KEEP_LOCK=1 TEST_NO_SESSION=1 run_stop "$home" || status=$?
expect_code 2 "$status" 'the recorded thread must be supervised once the previous app-server is gone'
[ "$(cat "$home/state/.lock")" != "$holder" ] || fail 'the recorded thread did not reclaim the stale app-server lock'
pass 'Codex API Stop: the Stop of the same thread in another app-server is read-only while the owner lives and reclaims after it exits'

# Native Linux model tools run under codex-linux-sandbox as pid 1 of their own
# PID namespace, where the host app-server that holds the lock is invisible.
sandboxed_lock() {  # <home> <thread>
  local status=0
  # shellcheck disable=SC2016 # Expanded by the namespace's own shells.
  (cd "$1"; FM_HOME="$1" FM_ROOT_OVERRIDE="$1" CODEX_THREAD_ID=$2 CODEX_SESSION_ID=$2 \
    unshare -rpf --mount-proc bash -c 'exec -a codex-linux-sandbox "$0" -c "bash \"\$0/bin/fm-lock.sh\"; exit \$?" "$1"' \
    "$LAB/codex" "$ROOT") > "$1/out" 2> "$1/err" || status=$?
  return "$status"
}

if ! command -v unshare >/dev/null 2>&1 || ! unshare -rpf --mount-proc true >/dev/null 2>&1; then
  printf '# skip: unprivileged PID namespaces are unavailable here, so the sandboxed lock writer is unverified\n'
else
  home=$(make_home sandbox)
  stub_session_start "$home"
  TEST_HOLD=1 TEST_NO_SESSION=1 run_stop "$home" &
  holder_job=$!
  for _ in {1..50}; do
    [ ! -s "$home/state/.lock" ] || break
    sleep 0.1
  done
  holder=$(cat "$home/state/.lock")
  status=0
  sandboxed_lock "$home" S1 || status=$?
  expect_code 1 "$status" 'a sandboxed tool must not claim a PID-only lock of a live host app-server'
  assert_contains "$(cat "$home/err")" 'sandboxed Codex tool cannot verify the host owner' 'the sandboxed refusal named no host-side path'
  [ "$(cat "$home/state/.lock")" = "$holder" ] || fail 'a sandboxed tool replaced a live legacy host PID'
  assert_absent "$home/state/.lock-session" 'a sandboxed tool bound a legacy lock'
  status=0
  TEST_START=1 TEST_KEEP_LOCK=1 TEST_NO_SESSION=1 run_stop "$home" || status=$?
  expect_code 0 "$status" 'a refused native start must never block session initialization'
  [ "$(cat "$home/state/.lock")" = "$holder" ] || fail 'another app-server took over while the host owner lived'
  assert_absent "$home/state/.lock-session" 'another app-server bound the live legacy lock'
  printf 'S1\n' > "$home/state/.lock-session"
  cp "$home/state/.lock" "$home/lock.before"
  status=0
  sandboxed_lock "$home" S1 || status=$?
  expect_code 0 "$status" 'a sandboxed tool carrying the recorded thread id must confirm its host-bound lock'
  assert_contains "$(cat "$home/out")" "lock acquired: harness pid $holder" 'the sandboxed confirmation did not keep the host anchor'
  cmp -s "$home/lock.before" "$home/state/.lock" || fail 'the sandboxed confirmation rewrote the host anchor'
  [ "$(cat "$home/state/.lock-session")" = S1 ] || fail 'the sandboxed confirmation rewrote the recorded thread'
  status=0
  sandboxed_lock "$home" S2 || status=$?
  expect_code 1 "$status" 'another sandboxed thread must not claim the recorded thread'
  cmp -s "$home/lock.before" "$home/state/.lock" || fail 'another sandboxed thread rewrote the host anchor'
  : > "$home/release"
  wait "$holder_job" || true
  status=0
  sandboxed_lock "$home" S2 || status=$?
  expect_code 1 "$status" 'a sandboxed tool must not reclaim a stale host lock of another thread'
  rm "$home/state/.lock-session"
  status=0
  sandboxed_lock "$home" S1 || status=$?
  expect_code 1 "$status" 'a sandboxed tool must not reclaim a stale PID-only host lock'
  cmp -s "$home/lock.before" "$home/state/.lock" || fail 'a sandboxed tool replaced a stale host PID'
  assert_absent "$home/state/.lock-session" 'a sandboxed tool bound a stale PID-only lock'
  for sidecar in none S1; do
    printf '1\n' > "$home/state/.lock"
    [ "$sidecar" = none ] || printf '%s\n' "$sidecar" > "$home/state/.lock-session"
    status=0
    sandboxed_lock "$home" S1 || status=$?
    expect_code 1 "$status" "a sandboxed tool must not confirm a PID-1 lock with sidecar $sidecar"
    [ "$(cat "$home/state/.lock")" = 1 ] || fail 'a sandboxed tool rewrote a PID-1 lock'
  done
  rm "$home/state/.lock" "$home/state/.lock-session"
  status=0
  sandboxed_lock "$home" S1 || status=$?
  expect_code 1 "$status" 'a sandboxed tool must not claim a free lock'
  assert_absent "$home/state/.lock" 'a sandboxed tool published PID 1'
  assert_absent "$home/state/.lock-session" 'a sandboxed tool recorded a thread without a host anchor'
  pass 'Codex sandboxed lock writer: confirms the recorded thread by its id alone, keeps the host anchor, and never publishes PID 1 or replaces a PID-only, stale or PID-1 lock'
fi
