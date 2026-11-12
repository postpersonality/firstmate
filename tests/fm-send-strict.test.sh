#!/usr/bin/env bash
# fm-send strict target resolution and key delivery reporting.
#
# A send that cannot be tied to a recorded task/lane or to an explicit
# well-formed backend target must fail loudly. These tests pin the historical
# silent-fallback failures: missing FM_HOME, unresolved selectors, prefixless
# herdr pane ids, dead explicit endpoints, and the healthy exact/fm-id paths.
# They also verify that a key send reports whether delivery actually succeeded.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SEND="$ROOT/bin/fm-send.sh"
TMP_ROOT=$(fm_test_tmproot fm-send-strict)

make_stubs() {  # <dir> -> echoes fakebin dir
  local dir=$1 fb="$1/fakebin"
  mkdir -p "$fb"
  cat > "$fb/tmux" <<'SH'
#!/usr/bin/env bash
set -u
case "${1:-}" in
  send-keys)
    shift
    literal=0
    target=
    while [ $# -gt 0 ]; do
      case "$1" in
        -t) target=$2; shift 2 ;;
        -l) literal=1; shift ;;
        *) break ;;
      esac
    done
    printf 'send-keys target=%s literal=%s arg=%s\n' "$target" "$literal" "${1:-}" >> "$FM_TMUX_LOG"
    # FM_FAKE_TMUX_SEND_KEY_FAIL names one key whose delivery fails, so the
    # --key exit contract can be driven both ways from the same stub.
    if [ "$literal" = 0 ] && [ -n "${FM_FAKE_TMUX_SEND_KEY_FAIL:-}" ] \
      && [ "${1:-}" = "$FM_FAKE_TMUX_SEND_KEY_FAIL" ]; then
      exit 1
    fi
    exit 0 ;;
  display-message)
    target=
    cursor=0
    while [ $# -gt 0 ]; do
      case "$1" in
        -t) target=$2; shift 2 ;;
        *cursor_y*) cursor=1; shift ;;
        *) shift ;;
      esac
    done
    if [ -n "${FM_FAKE_TMUX_DEAD_TARGET:-}" ] && [ "$target" = "$FM_FAKE_TMUX_DEAD_TARGET" ]; then
      exit 1
    fi
    [ "$cursor" = 1 ] && { printf '1\n'; exit 0; }
    printf '%%1\n'
    exit 0 ;;
  capture-pane)
    printf '╭────╮\n│    │\n╰────╯\n'
    exit 0 ;;
  list-windows)
    printf 'foreign:%s\nfm-mpf-lane-m8\nfm-lane-key\nfm-lane-ok\n' \
      "${FM_FAKE_TMUX_WINDOW:-fm-lost}"
    # FM_FAKE_TMUX_EXTRA_WINDOW adds one exact non-numeric window name, so a
    # tmux inventory can hold the same string a herdr-core terminal uses.
    [ -z "${FM_FAKE_TMUX_EXTRA_WINDOW:-}" ] || printf '%s\n' "$FM_FAKE_TMUX_EXTRA_WINDOW"
    exit 0 ;;
esac
exit 0
SH
  chmod +x "$fb/tmux"
  cat > "$fb/herdr" <<'SH'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "$FM_HERDR_LOG"
case "${1:-} ${2:-}" in
  "status --json") printf '{"client":{"version":"0.7.5","protocol":16},"server":{"running":true}}\n' ;;
  "pane get") printf '{"result":{"pane":{"pane_id":"%s"}}}\n' "${3:-}" ;;
  "pane send-keys") : ;;
esac
SH
  chmod +x "$fb/herdr"
  cat > "$fb/sleep" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  chmod +x "$fb/sleep"
  printf '%s\n' "$fb"
}

setup_home() {  # <name> -> echoes home dir
  local home="$TMP_ROOT/$1-$RANDOM"
  mkdir -p "$home/state"
  printf '%s\n' "$home"
}

# make_hc_stub <fakebin> <dir>: a herdr-core CLI stub for the Core target
# cases. It answers only what those paths read - `get --json <address>` from
# <dir>/<address>.json (exit 3 not_found when absent), `read`, `keys`, `send`,
# and `--version` - and logs every call with its HC_SESSION/HC_SOCKET pins.
make_hc_stub() {  # <fakebin> <dir>
  local fb=$1
  cat > "$fb/hc" <<'SH'
#!/usr/bin/env bash
set -u
D="${FAKE_HC_DIR:?}"
{
  printf 'HC_SESSION=%s HC_SOCKET=%s' "${HC_SESSION:-}" "${HC_SOCKET:-}"
  for a in "$@"; do printf '\x1f%s' "$a"; done
  printf '\n'
} >> "$D/hc.log"
cmd=${1:-}
last=""
for a in "$@"; do last=$a; done
case "$cmd" in
  --version) printf 'hc 0.1.20\n' ;;
  get)
    [ -f "$D/$last.json" ] || { printf '{"error":{"kind":"not_found"}}\n' >&2; exit 3; }
    cat "$D/$last.json" ;;
  read) printf '╭───╮\n│ > │\n╰───╯\n' ;;
  keys|send) printf '{"started":true,"wait":{"status":"working"}}\n' ;;
  *) printf '{}\n' ;;
esac
SH
  chmod +x "$fb/hc"
}

# write_hc_terminal <dir> <address> <state>: the Core record `hc get` answers.
write_hc_terminal() {  # <dir> <address> <state>
  jq -n --arg a "$2" --arg s "$3" \
    '{address: $a, state: $s, labels: {},
      cwd: "/start", turn: 0, status: {app: "pi", state: "idle"},
      foreground: {name: "pi", pid: 1, cwd: "/live"}}' > "$1/$2.json"
}

# A single-colon target is a tmux session:window AND a herdr-core
# session:address. These cases pin the resolution contract: a live Core
# terminal resolves without touching tmux, a live pair refuses as ambiguous,
# an absent core is never started, and a prefixed target is refused unless that
# named provider's own endpoint verifies.
test_core_terminal_resolves_without_tmux() {
  local dir fb home err log hclog rc sock
  dir="$TMP_ROOT/core-live"; mkdir -p "$dir/runtime"
  fb=$(make_stubs "$dir"); make_hc_stub "$fb"; home=$(setup_home corelive)
  err="$dir/send.err"; log="$dir/tmux.log"; hclog="$dir/hc.log"; : > "$log"; : > "$hclog"
  sock="$dir/core.sock"; fm_test_unix_socket "$sock" || fail "fixture core socket"
  write_hc_terminal "$dir" t7 live

  PATH="$fb:$PATH" FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_TMUX_LOG="$log" \
    FAKE_HC_DIR="$dir" FM_HC_BIN="$fb/hc" FM_HC_SOCKET="$sock" XDG_RUNTIME_DIR="$dir/runtime" \
    FM_FAKE_TMUX_DEAD_TARGET=default:t7 FM_SEND_SETTLE=0 \
    "$SEND" default:t7 "hello core" >/dev/null 2>"$err"; rc=$?
  expect_code 0 "$rc" "a live Core terminal should resolve and accept the steer"
  assert_grep 'send' "$hclog" "the resolved Core target should be sent through hc"
  assert_grep 'HC_SESSION=default' "$hclog" "the resolved target should pin its own Core session"
  assert_no_grep 'send-keys' "$log" "a Core target must never fall through to tmux input"
  pass "fm-send strict: a live herdr-core terminal resolves by verification, not by shape"
}

test_ambiguous_live_owner_refuses() {
  local dir fb home err log hclog rc sock
  dir="$TMP_ROOT/core-ambiguous"; mkdir -p "$dir/runtime"
  fb=$(make_stubs "$dir"); make_hc_stub "$fb"; home=$(setup_home coreamb)
  err="$dir/send.err"; log="$dir/tmux.log"; hclog="$dir/hc.log"; : > "$log"; : > "$hclog"
  sock="$dir/core.sock"; fm_test_unix_socket "$sock" || fail "fixture core socket"
  write_hc_terminal "$dir" t7 live

  # The tmux stub answers display-message for default:t7, so both providers
  # hold a live endpoint at that exact string.
  PATH="$fb:$PATH" FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_TMUX_LOG="$log" \
    FAKE_HC_DIR="$dir" FM_HC_BIN="$fb/hc" FM_HC_SOCKET="$sock" XDG_RUNTIME_DIR="$dir/runtime" \
    FM_FAKE_TMUX_EXTRA_WINDOW=t7 FM_SEND_SETTLE=0 \
    "$SEND" default:t7 "hello" >/dev/null 2>"$err"; rc=$?
  [ "$rc" -ne 0 ] || fail "a target live in both providers should refuse"
  assert_contains "$(cat "$err")" "ambiguous" "the refusal should name the ambiguity"
  assert_contains "$(cat "$err")" "hc:default:t7" "the refusal should show the hc: prefix"
  assert_contains "$(cat "$err")" "tmux:default:t7" "the refusal should show the tmux: prefix"
  # The stub separates arguments with \x1f, so the pattern matches the `send`
  # COMMAND and never the fixture path (which itself contains "fm-send-strict").
  assert_no_grep $'\x1fsend' "$hclog" "an ambiguous target must not be delivered to Core"
  assert_no_grep 'send-keys' "$log" "an ambiguous target must not be delivered to tmux"
  pass "fm-send strict: a target live in two providers refuses instead of guessing"
}

test_dead_core_probe_never_starts_one() {
  local dir fb home err hclog rc
  dir="$TMP_ROOT/core-absent"; mkdir -p "$dir/runtime"
  fb=$(make_stubs "$dir"); make_hc_stub "$fb"; home=$(setup_home coreabsent)
  err="$dir/send.err"; hclog="$dir/hc.log"; : > "$hclog"

  # No socket for this session exists in the fixture runtime dir, so the Core
  # candidate is rejected without contacting hc at all (which would start one).
  PATH="$fb:$PATH" FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_TMUX_LOG="$dir/tmux.log" \
    FAKE_HC_DIR="$dir" FM_HC_BIN="$fb/hc" XDG_RUNTIME_DIR="$dir/runtime" FM_SEND_SETTLE=0 \
    "$SEND" default:t7 "hello" >/dev/null 2>"$err"; rc=$?
  [ "$rc" -ne 0 ] || fail "a Core-shaped target with no running core should refuse"
  [ -s "$hclog" ] && fail "the Core-shaped probe contacted hc without a live core:"$'\n'"$(cat "$hclog")"
  [ ! -e "$dir/runtime/herdr-core/default.sock" ] || fail "the probe created core state"
  pass "fm-send strict: a Core-shaped target is probed only when its core is already running"
}

test_explicit_prefix_refuses_dead_core_endpoint() {
  local dir fb home err log hclog rc sock
  dir="$TMP_ROOT/core-prefix-dead"; mkdir -p "$dir/runtime"
  fb=$(make_stubs "$dir"); make_hc_stub "$fb"; home=$(setup_home coreprefixdead)
  err="$dir/send.err"; log="$dir/tmux.log"; hclog="$dir/hc.log"; : > "$log"; : > "$hclog"
  sock="$dir/core.sock"; fm_test_unix_socket "$sock" || fail "fixture core socket"

  PATH="$fb:$PATH" FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_TMUX_LOG="$log" \
    FAKE_HC_DIR="$dir" FM_HC_BIN="$fb/hc" FM_HC_SOCKET="$sock" XDG_RUNTIME_DIR="$dir/runtime" \
    FM_SEND_SETTLE=0 \
    "$SEND" hc:default:t99 "hello" >/dev/null 2>"$err"; rc=$?
  [ "$rc" -ne 0 ] || fail "an hc: prefix naming an absent terminal should refuse"
  assert_contains "$(cat "$err")" "not a live hc endpoint" "the refusal should name the named provider"
  assert_no_grep $'\x1fsend' "$hclog" "a refused Core prefix must not type into anything"
  assert_no_grep 'send-keys' "$log" "a refused Core prefix must not reach tmux"
  pass "fm-send strict: an hc: prefix is refused unless that core verifies the terminal"
}

test_explicit_hc_prefix_routes_to_core() {
  local dir fb home err log hclog rc sock
  dir="$TMP_ROOT/core-prefix"; mkdir -p "$dir/runtime"
  fb=$(make_stubs "$dir"); make_hc_stub "$fb"; home=$(setup_home coreprefix)
  err="$dir/send.err"; log="$dir/tmux.log"; hclog="$dir/hc.log"; : > "$log"; : > "$hclog"
  sock="$dir/core.sock"; fm_test_unix_socket "$sock" || fail "fixture core socket"
  write_hc_terminal "$dir" t12 live

  PATH="$fb:$PATH" FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_TMUX_LOG="$log" \
    FAKE_HC_DIR="$dir" FM_HC_BIN="$fb/hc" FM_HC_SOCKET="$sock" XDG_RUNTIME_DIR="$dir/runtime" \
    FM_SEND_SETTLE=0 \
    "$SEND" hc:default:t12 "hello core" >/dev/null 2>"$err"; rc=$?
  expect_code 0 "$rc" "an hc: prefix naming a live terminal should be delivered"
  assert_grep 'send' "$hclog" "the prefixed target should be sent through hc"
  [ -s "$log" ] && fail "a prefixed Core target still reached tmux:"$'\n'"$(cat "$log")"
  pass "fm-send strict: an hc: prefix delivers to Core and never to tmux"
}

test_exact_lane_id_send_still_works() {
  local dir fb home err log rc got
  dir="$TMP_ROOT/exact"; mkdir -p "$dir"
  fb=$(make_stubs "$dir"); home=$(setup_home exact); err="$dir/send.err"; log="$dir/tmux.log"; : > "$log"
  fm_write_meta "$home/state/mpf-lane-m8.meta" "window=sess:fm-mpf-lane-m8" "kind=ship"

  PATH="$fb:$PATH" FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_TMUX_LOG="$log" FM_SEND_SETTLE=0 \
    "$SEND" mpf-lane-m8 "lost dispatch" >/dev/null 2>"$err"; rc=$?
  expect_code 0 "$rc" "exact task id send should succeed when metadata exists"
  got=$(cat "$log")
  assert_contains "$got" "target=sess:fm-mpf-lane-m8 literal=1 arg=: Firstmate instruction waiting" \
    "exact id should ring the doorbell at the meta target"
  assert_contains "$got" "target=sess:fm-mpf-lane-m8 literal=0 arg=Enter" "exact id should submit the doorbell with Enter"
  grep -qF 'lost dispatch' "$home/state/mpf-lane-m8.inbox/001.msg" \
    || fail "exact id should record the steer in the task inbox"
  pass "fm-send strict: exact task/lane ids resolve through home metadata"
}

test_help_prints_usage() {
  local home="$TMP_ROOT/help" out err rc
  mkdir -p "$home/state"
  out="$TMP_ROOT/help.out"; err="$TMP_ROOT/help.err"
  env -u FM_HOME "$SEND" --help >"$out" 2>"$err"; rc=$?
  expect_code 0 "$rc" "fm-send --help without FM_HOME should print usage and exit 0"
  assert_contains "$(cat "$out")" "Usage: fm-send.sh <target>" "--help should print the header usage line"
  assert_contains "$(cat "$out")" "--resolve-key" "--help should print the header contract"
  [ ! -s "$err" ] || fail "fm-send --help wrote to stderr: $(cat "$err")"
  FM_HOME="$home" "$SEND" --help >"$out" 2>"$err"; rc=$?
  expect_code 0 "$rc" "fm-send --help with FM_HOME should not treat the flag as a target"
  assert_contains "$(cat "$out")" "Usage: fm-send.sh <target>" "--help with FM_HOME should print usage"
  pass "fm-send --help prints the header usage before FM_HOME and target resolution"
}

test_unset_fm_home_fails() {
  local dir fb err log rc
  dir="$TMP_ROOT/nohome"; mkdir -p "$dir"
  fb=$(make_stubs "$dir"); err="$dir/send.err"; log="$dir/tmux.log"; : > "$log"

  env -u FM_HOME PATH="$fb:$PATH" FM_ROOT_OVERRIDE="$dir" FM_TMUX_LOG="$log" FM_SEND_SETTLE=0 \
    "$SEND" sess:win "hello" >/dev/null 2>"$err"; rc=$?
  [ "$rc" -ne 0 ] || fail "unset FM_HOME should fail"
  assert_contains "$(cat "$err")" "FM_HOME is not set" "unset FM_HOME diagnostic should be explicit"
  [ ! -s "$log" ] || fail "unset FM_HOME still attempted a send"$'\n'"$(cat "$log")"
  pass "fm-send strict: unset FM_HOME fails before target resolution"
}

test_unresolvable_target_does_not_tmux_fallback() {
  local dir fb home err log rc
  dir="$TMP_ROOT/unresolved"; mkdir -p "$dir"
  fb=$(make_stubs "$dir"); home=$(setup_home unresolved); err="$dir/send.err"; log="$dir/tmux.log"; : > "$log"

  PATH="$fb:$PATH" FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_TMUX_LOG="$log" FM_FAKE_TMUX_WINDOW=lost-target FM_SEND_SETTLE=0 \
    "$SEND" lost-target "hello" >/dev/null 2>"$err"; rc=$?
  [ "$rc" -ne 0 ] || fail "unresolvable target should fail"
  assert_contains "$(cat "$err")" "not resolvable" "unresolvable diagnostic should be loud"
  assert_contains "$(cat "$err")" "metadata window/terminal lookup" "unresolvable diagnostic should name the attempted lookup"
  assert_contains "$(cat "$err")" "backend=none" "unresolvable diagnostic should name that no backend was assumed"
  [ ! -s "$log" ] || fail "unresolvable target fell through to tmux send"$'\n'"$(cat "$log")"
  pass "fm-send strict: unresolvable selectors do not fall back to tmux"
}

test_prefixless_herdr_pane_id_fails() {
  local dir fb home err log rc
  dir="$TMP_ROOT/herdr-pane"; mkdir -p "$dir"
  fb=$(make_stubs "$dir"); home=$(setup_home herdr); err="$dir/send.err"; log="$dir/tmux.log"; : > "$log"
  fm_write_meta "$home/state/nudge.meta" \
    "window=default:wB:p2" "backend=herdr" "herdr_session=default" "herdr_pane_id=wB:p2" "kind=ship"

  PATH="$fb:$PATH" FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_TMUX_LOG="$log" FM_SEND_SETTLE=0 \
    "$SEND" wB:p2 "nudge" >/dev/null 2>"$err"; rc=$?
  [ "$rc" -ne 0 ] || fail "prefixless herdr pane id should fail"
  assert_contains "$(cat "$err")" "matches herdr_pane_id" "herdr pane diagnostic should name the meta match"
  assert_contains "$(cat "$err")" "expected <herdr-session>:<pane-id>" "herdr pane diagnostic should show expected shape"
  assert_contains "$(cat "$err")" "default:wB:p2" "herdr pane diagnostic should show the canonical target"
  [ ! -s "$log" ] || fail "prefixless herdr pane id fell through to tmux send"$'\n'"$(cat "$log")"
  pass "fm-send strict: prefixless herdr pane ids are rejected before tmux fallback"
}

test_unmatched_single_colon_target_must_exist() {
  local dir fb home err log rc
  dir="$TMP_ROOT/dead-explicit"; mkdir -p "$dir"
  fb=$(make_stubs "$dir"); home=$(setup_home deadexplicit); err="$dir/send.err"; log="$dir/tmux.log"; : > "$log"

  PATH="$fb:$PATH" FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_TMUX_LOG="$log" FM_FAKE_TMUX_DEAD_TARGET=sess:missing FM_SEND_SETTLE=0 \
    "$SEND" sess:missing "hello" >/dev/null 2>"$err"; rc=$?
  [ "$rc" -ne 0 ] || fail "dead explicit tmux-shaped target should fail"
  assert_contains "$(cat "$err")" "not a live tmux endpoint" "dead explicit target diagnostic should name the assumed backend"
  assert_contains "$(cat "$err")" "backend=tmux" "dead explicit target diagnostic should name the tried backend"
  [ ! -s "$log" ] || fail "dead explicit target still attempted a send"$'\n'"$(cat "$log")"
  pass "fm-send strict: unmatched single-colon explicit targets must verify live before sending"
}

test_fm_prefixed_herdr_session_is_an_explicit_target() {
  local dir fb home err log herdr_log rc
  dir="$TMP_ROOT/fm-remote-explicit"; mkdir -p "$dir"
  fb=$(make_stubs "$dir"); home=$(setup_home fmremote); err="$dir/send.err"; log="$dir/tmux.log"; herdr_log="$dir/herdr.log"
  : > "$log"
  : > "$herdr_log"

  PATH="$fb:$PATH" FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_TMUX_LOG="$log" FM_HERDR_LOG="$herdr_log" FM_SEND_SETTLE=0 \
    "$SEND" fm-remote:w1:p2 --key Enter >/dev/null 2>"$err"; rc=$?
  expect_code 0 "$rc" "an fm-prefixed Herdr session target should be accepted as explicit"
  assert_grep 'pane get w1:p2 --session fm-remote' "$herdr_log" "fm-prefixed Herdr target was not verified in its session"
  assert_grep 'pane send-keys w1:p2 enter --session fm-remote' "$herdr_log" "fm-prefixed Herdr target was not sent its key in its session"
  assert_no_grep '--session default' "$herdr_log" "fm-prefixed Herdr target fell back to the default session"
  pass "fm-send strict: fm-prefixed Herdr sessions remain explicit backend targets"
}

test_healthy_fm_id_send_still_works() {
  local dir fb home err log rc got
  dir="$TMP_ROOT/healthy"; mkdir -p "$dir"
  fb=$(make_stubs "$dir"); home=$(setup_home healthy); err="$dir/send.err"; log="$dir/tmux.log"; : > "$log"
  fm_write_meta "$home/state/lane-ok.meta" "window=sess:fm-lane-ok" "kind=ship" "harness=codex"

  PATH="$fb:$PATH" FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_TMUX_LOG="$log" FM_SEND_SETTLE=0 \
    "$SEND" fm-lane-ok "hello captain" >/dev/null 2>"$err"; rc=$?
  expect_code 0 "$rc" "healthy fm-id send should succeed"
  got=$(cat "$log")
  assert_contains "$got" "target=sess:fm-lane-ok literal=1 arg=: Firstmate instruction waiting" \
    "healthy send should ring the doorbell at the meta target"
  assert_contains "$got" "target=sess:fm-lane-ok literal=0 arg=Enter" "healthy send should submit the doorbell with Enter"
  grep -qF 'hello captain' "$home/state/lane-ok.inbox/001.msg" \
    || fail "healthy send should record the steer in the task inbox"
  assert_contains "$(cat "$err")" "requested message WILL still be sent" "fm-send guard banner should keep send-specific continuation wording"
  pass "fm-send strict: healthy fm-<id> sends record the steer and ring once"
}

# A --key send is how firstmate interrupts a worker, so its exit status is the
# only signal that the interrupt actually landed.
# Reporting success for a key that was never delivered would leave supervision
# believing a runaway worker had been stopped, so the failing case must exit
# nonzero and name the key.
# Both directions are asserted from one stub so the failing case cannot go
# quietly vacuous if the key ever stops being delivered at all.
test_key_send_exit_status_follows_delivery() {
  local dir fb home err log rc
  dir="$TMP_ROOT/key-exit"; mkdir -p "$dir"
  fb=$(make_stubs "$dir"); home=$(setup_home keyexit); err="$dir/send.err"; log="$dir/tmux.log"; : > "$log"
  fm_write_meta "$home/state/lane-key.meta" "window=sess:fm-lane-key" "kind=ship"

  PATH="$fb:$PATH" FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_TMUX_LOG="$log" FM_SEND_SETTLE=0 \
    "$SEND" lane-key --key Escape >/dev/null 2>"$err"; rc=$?
  expect_code 0 "$rc" "a delivered --key interrupt should report success"
  assert_contains "$(cat "$log")" "target=sess:fm-lane-key literal=0 arg=Escape" "the delivered case should send the named key"

  : > "$log"
  PATH="$fb:$PATH" FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_TMUX_LOG="$log" FM_SEND_SETTLE=0 \
    FM_FAKE_TMUX_SEND_KEY_FAIL=Escape \
    "$SEND" lane-key --key Escape >/dev/null 2>"$err"; rc=$?
  [ "$rc" -ne 0 ] || fail "an undelivered --key interrupt reported success"
  assert_contains "$(cat "$err")" "key 'Escape' not sent" "the undelivered case should name the key that failed"
  assert_contains "$(cat "$log")" "target=sess:fm-lane-key literal=0 arg=Escape" "the undelivered case should still have attempted the send"
  pass "fm-send --key: exit status follows delivery, and an undelivered key never reports success"
}

test_exact_lane_id_send_still_works
test_help_prints_usage
test_key_send_exit_status_follows_delivery
test_unset_fm_home_fails
test_unresolvable_target_does_not_tmux_fallback
test_prefixless_herdr_pane_id_fails
test_unmatched_single_colon_target_must_exist
test_core_terminal_resolves_without_tmux
test_ambiguous_live_owner_refuses
test_dead_core_probe_never_starts_one
test_explicit_prefix_refuses_dead_core_endpoint
test_explicit_hc_prefix_routes_to_core
test_fm_prefixed_herdr_session_is_an_explicit_target
test_healthy_fm_id_send_still_works
