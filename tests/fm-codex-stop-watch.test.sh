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
printf '%s\n' "$$" > "$FM_HOME/state/.lock"
if [ "${TEST_NO_SESSION:-0}" != 1 ]; then printf '%s\n' "${TEST_LOCK_SESSION:-S1}" > "$FM_HOME/state/.lock-session"; fi
if [ "${TEST_UNKNOWN_ID:-0}" = 1 ]; then unset CODEX_THREAD_ID CODEX_SESSION_ID; fi
if [ "${TEST_LOCK_ONLY:-0}" = 1 ]; then bash "$TEST_ROOT/bin/fm-lock.sh"; exit $?; fi
unset CODEX_THREAD_ID CODEX_SESSION_ID
if [ "${TEST_START:-0}" = 1 ]; then
  printf '{"hook_event_name":"SessionStart","session_id":"S1","source":"startup"}\n' | bash "$FM_HOME/bin/fm-sessionstart-run.sh"
  exit $?
fi
printf '{"hook_event_name":"Stop","session_id":"S1","turn_id":"T1","stop_hook_active":true}\n' \
  | bash "$TEST_ROOT/bin/fm-turnend-guard.sh"
SH
  printf '%s\n' "$home"
}

run_stop() {
  local home=$1
  (cd "$home"; FM_HOME="$home" FM_ROOT_OVERRIDE="$home" TEST_ROOT="$ROOT" \
    CODEX_THREAD_ID=S1 CODEX_SESSION_ID=S1 FM_CODEX_STOP_CHECKPOINT=2 \
    FM_POLL=1 FM_SIGNAL_GRACE=1 FM_CHECK_INTERVAL=999999 FM_HEARTBEAT=999999 \
    "$LAB/codex" app-server > "$home/out" 2> "$home/err")
}

home=$(make_home quiet)
status=0
run_stop "$home" || status=$?
expect_code 2 "$status" 'a successful quiet Stop checkpoint must compel the successor even when stop_hook_active=true'
assert_contains "$(cat "$home/err")" 'checkpoint:' 'quiet checkpoint was not delivered through Stop feedback'
assert_absent "$home/state/.watch.lock/pid" 'quiet Stop leaked a watcher'
pass 'Codex API Stop: a quiet checkpoint returns an executable continuation, despite the old loop flag'

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
assert_contains "$(cat "$home/err")" 'worker.status' 'late worker close was dropped'
drain=$(FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_GUARD_SKIP=1 bash "$ROOT/bin/fm-wake-drain.sh" 2>&1)
assert_contains "$drain" 'worker.status' 'wake did not survive the Stop boundary'
# The resumed handler takes an actual permitted action using the existing
# durable steering primitive, then acknowledges the generation it handled.
bash -c '. "$1/bin/fm-task-inbox-lib.sh"; fm_task_inbox_write_idempotent "$2/state" worker "Proceed with the already authorized validation"' _ "$ROOT" "$home" >/dev/null
ack=$(printf '%s\n' "$drain" | sed -n 's/^WAKE_ACK_REQUIRED: after handling completes run //p')
[ -n "$ack" ] || fail 'drain omitted its acknowledgement'
FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_GUARD_SKIP=1 bash -c "$ack" >/dev/null
assert_contains "$(cat "$home/state/worker.inbox/001.msg")" 'authorized validation' 'handler did not steer the worker'
drain=$(FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_GUARD_SKIP=1 bash "$ROOT/bin/fm-wake-drain.sh" 2>&1)
assert_not_contains "$drain" $'\tsignal\tworker.status\t' 'acknowledged wake replayed'
pass 'Codex API Stop: a late worker completion survives into a real idempotent steering action'

home=$(make_home foreign)
status=0
TEST_LOCK_SESSION=S2 run_stop "$home" || status=$?
expect_code 0 "$status" 'a different thread in the same app-server must not claim the primary lock'
assert_contains "$(cat "$home/out")" 'another session owns' 'foreign-thread refusal is missing'
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
expect_code 0 "$status" 'the existing lock writer must safely bind a legacy PID-only owner'
assert_contains "$(cat "$home/state/.lock-session")" 'S1' 'legacy API owner did not record its native thread'
pass 'Codex API session-lock writer: refuses another thread and binds the legacy native owner'

home=$(make_home session-start)
rm "$home/bin"
cp -R "$ROOT/bin" "$home/bin"
cat > "$home/bin/fm-session-start.sh" <<'SH'
#!/usr/bin/env bash
bash "$FM_HOME/bin/fm-lock.sh"
SH
status=0
TEST_START=1 TEST_NO_SESSION=1 run_stop "$home" || status=$?
expect_code 0 "$status" 'native SessionStart must route the original payload identity to the lock writer'
assert_contains "$(cat "$home/state/.lock-session")" 'S1' 'native session start did not bind its payload thread'
pass 'Codex API SessionStart: payload identity binds a legacy lock without vendor environment IDs'

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
status=0
PATH="$home/fakebin:$PATH" run_stop "$home" || status=$?
expect_code 2 "$status" 'first failed checkpoint needs one actual repair continuation'
assert_contains "$(cat "$home/err")" 'checkpoint failed' 'checkpoint failure did not reach the handler'
status=0
PATH="$home/fakebin:$PATH" run_stop "$home" || status=$?
expect_code 0 "$status" 'repeated failure must not create an unbounded Stop loop'
assert_contains "$(cat "$home/out")" 'SUPERVISION FAILED' 'bounded failure was silently allowed'
assert_absent "$home/state/.watch.lock/pid" 'failed checkpoint leaked a watcher'
pass 'Codex API Stop: failed delivery gets one repair turn, then a visible bounded failure'

home=$(make_home pending)
FM_HOME="$home" bash -c '. "$1/bin/fm-wake-lib.sh"; fm_wake_append signal worker.status "done: pending across boundary"' _ "$ROOT"
status=0
run_stop "$home" || status=$?
expect_code 2 "$status" 'pending wake must survive and force a real handler turn'
assert_contains "$(cat "$home/err")" 'pending durable wake' 'pending wake was not delivered'
assert_absent "$home/state/.watch.lock/pid" 'pending delivery started an unnecessary watcher'
status=0
run_stop "$home" || status=$?
expect_code 2 "$status" 'an unhandled identical wake gets one repair continuation'
status=0
run_stop "$home" || status=$?
expect_code 0 "$status" 'an inert handler must not cause an infinite immediate Stop loop'
assert_contains "$(cat "$home/out")" 'SUPERVISION FAILED' 'unhandled duplicate wake silently allowed Stop'
assert_contains "$(cat "$home/state/.wake-queue")" 'worker.status' 'loop suppression erased unhandled work'
pass 'Codex API Stop: pending wakes are retained; an inert duplicate handler fails visibly without spinning'
