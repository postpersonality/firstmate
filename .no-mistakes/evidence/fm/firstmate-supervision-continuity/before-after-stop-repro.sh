#!/usr/bin/env bash
# Before/after reproduction: an owned Codex app-server primary ends a short reply
# while a worker is in flight; the Stop arrives with stop_hook_active=true (set by
# another hook). Runs the real guard scripts of base and head in disposable homes.
set -u
ROOT=$1 BASE=$2
LAB=$(mktemp -d "${TMPDIR:-/tmp}/fm-repro-lab.XXXXXX")
trap 'pkill -P $$ 2>/dev/null; rm -rf "$LAB"' EXIT
ln -s "$(command -v bash)" "$LAB/codex"
mkdir -p "$LAB/base-src" && git -C "$ROOT" archive "$BASE" bin | tar -x -C "$LAB/base-src"
make_home() {  # <name> <bin-dir>
  local home="$LAB/$1"
  mkdir -p "$home/state" "$home/config"; git init -q "$home"; : > "$home/AGENTS.md"
  cp -R "$2" "$home/bin"
  printf 'backend=orca\nterminal=lab-worker\nwindow=fm-worker\nkind=ship\nharness=codex\n' > "$home/state/worker.meta"
  printf 'working: owned validation fixture is in flight\n' > "$home/state/worker.status"
  printf '#!/usr/bin/env bash\nexit 1\n' > "$home/state/lab.check.sh"; chmod 700 "$home/state/lab.check.sh"
  FM_HOME="$home" bash "$home/bin/fm-check-register.sh" lab >/dev/null
  # The app-server process shape: nearest harness argv is "codex app-server".
  cat > "$home/app-server" <<'SH'
printf '%s\n' "$$" > "$FM_HOME/state/.lock"; printf 'S1\n' > "$FM_HOME/state/.lock-session"
unset CODEX_THREAD_ID CODEX_SESSION_ID
printf '{"hook_event_name":"Stop","session_id":"S1","turn_id":"T%s","stop_hook_active":true}\n' "${TURN:-1}" \
  | bash "$FM_HOME/bin/fm-turnend-guard.sh"
SH
  printf '%s\n' "$home"
}
stop() {  # <home> <turn>
  (cd "$1"; FM_HOME="$1" FM_ROOT_OVERRIDE="$1" TURN=$2 FM_CODEX_STOP_CHECKPOINT=2 FM_POLL=1 FM_SIGNAL_GRACE=1 \
    FM_CHECK_INTERVAL=999999 FM_HEARTBEAT=999999 "$LAB/codex" app-server >"$1/out" 2>"$1/err")
}
for side in base head; do
  if [ $side = base ]; then src="$LAB/base-src/bin"; label="base $BASE"; else src="$ROOT/bin"; label="head $(git -C "$ROOT" rev-parse --short HEAD)"; fi
  home=$(make_home $side "$src")
  echo "=== $label: short reply ends while worker is in flight (Stop with stop_hook_active=true) ==="
  stop "$home" 1; rc=$?
  echo "Stop exit=$rc"; sed 's/^/  stderr| /' "$home/err" | head -6; sed 's/^/  stdout| /' "$home/out" | head -3
  [ $rc -eq 2 ] && echo "RESULT: turn continues (native exit-2 feedback)" || echo "RESULT: turn ENDS; primary idles with a worker in flight"
  echo "=== $label: worker completes 1s into the next Stop's checkpoint ==="
  ( sleep 1; printf 'done: ready for already authorized validation\n' > "$home/state/worker.status" ) &
  stop "$home" 2; rc=$?; wait
  echo "Stop exit=$rc"; sed 's/^/  stderr| /' "$home/err" | head -6
  if [ $rc -eq 2 ]; then
    drain=$(FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_GUARD_SKIP=1 bash "$home/bin/fm-wake-drain.sh" 2>&1)
    echo "--- handler drains bin/fm-wake-drain.sh:"; printf '%s\n' "$drain" | sed 's/^/  drain| /' | head -12
    bash -c '. "$1/bin/fm-task-inbox-lib.sh"; fm_task_inbox_write_idempotent "$2/state" worker "Proceed with the already authorized validation"' _ "$home" "$home" >/dev/null
    bash -c '. "$1/bin/fm-task-inbox-lib.sh"; fm_task_inbox_write_idempotent "$2/state" worker "Proceed with the already authorized validation"' _ "$home" "$home" >/dev/null
    ack=$(printf '%s\n' "$drain" | sed -n 's/^WAKE_ACK_REQUIRED: after handling completes run //p')
    echo "--- handler steers worker (idempotent, issued twice) and runs: $ack"
    FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_GUARD_SKIP=1 bash -c "$ack" 2>&1 | sed 's/^/  ack| /'
    echo "  worker inbox: $(ls "$home/state/worker.inbox" | tr '\n' ' ')-> $(grep -c . "$home/state/worker.inbox/001.msg") lines, body: $(grep -o "Proceed with the already authorized validation" "$home/state/worker.inbox/001.msg")"
    again=$(FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_GUARD_SKIP=1 bash "$home/bin/fm-wake-drain.sh" 2>&1)
    printf '%s' "$again" | grep -q 'ready for already authorized validation' && echo "  replay after ACK: YES (bad)" || echo "  replay after ACK: none"
  else
    echo "RESULT: turn ENDS; the late worker completion reaches no handler"
  fi
  echo
done
