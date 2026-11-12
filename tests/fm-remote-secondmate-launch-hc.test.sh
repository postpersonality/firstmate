#!/usr/bin/env bash
# tests/fm-remote-secondmate-launch-hc.test.sh - the remote LAUNCH side of the
# herdr-core route, over the deterministic SSH boundary.
#
# A remote second mate is launched by this home's fm-spawn, which hands the
# launch to the remote host and then validates exactly what the host reports.
# The fake SSH here answers only that launch call, so the assertions cover the
# spawn-side parsing/validation branch a seeded route cannot: what a valid hc
# reply records, and what a foreign or moved reply must refuse while keeping the
# route for reconciliation. No SSH target, no Core, no new infrastructure.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=bin/fm-backend.sh
. "$ROOT/bin/fm-backend.sh"

TMP_ROOT=$(fm_test_tmproot fm-remote-launch-hc)
ID=ios
PARENT="$TMP_ROOT/parent"
FAKEBIN=$(fm_fakebin "$TMP_ROOT/fake")
SSH_LOG="$TMP_ROOT/ssh.log"
mkdir -p "$PARENT/state" "$PARENT/data" "$PARENT/config" "$PARENT/projects"
printf 'pi\n' > "$PARENT/config/secondmate-harness"
printf 'tmux\n' > "$PARENT/config/backend"
printf '## In flight\n\n## Queued\n\n## Done\n' > "$PARENT/data/backlog.md"
printf -- '- %s - Remote mate (host: remote-mac; root: /srv/fm; home: /srv/fm-home; scope: remote work; projects: alpha; added 2026-01-01)\n' \
  "$ID" > "$PARENT/data/secondmates.md"

# The fake SSH answers the launch handshake the way a healthy Core host does.
# fm-on passes the remote argv base64-encoded, so the fake decodes it exactly as
# the existing remote fixtures do instead of matching the wire text.
cat > "$FAKEBIN/fake-ssh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FM_FAKE_SSH_LOG:?}"
decoded=
for arg in "$@"; do
  text=$(perl -MMIME::Base64=decode_base64 -e 'print decode_base64($ARGV[0])' "$arg" 2>/dev/null | tr '\0' ' ')
  case "$text" in
    *fm-remote-*) decoded=$text ;;
  esac
  [ -z "$decoded" ] || break
done
printf '%s\n' "$decoded" >> "${FM_FAKE_SSH_LOG}.decoded"
case "$decoded" in
  # The inheritance handshake is answered as a healthy, already-current receiver,
  # so this test reaches the launch call it is about.
  *fm-remote-inherit.sh*generation*) printf '0\n'; exit 0 ;;
  *fm-remote-inherit.sh*) exit 0 ;;
  *fm-remote-secondmate-control.sh*send-stdin*)
    cat > "${FM_FAKE_SSH_LOG}.send-body"
    exit 0
    ;;
  *fm-remote-secondmate-control.sh*launch*)
    case "${FM_FAKE_HC_REPLY:-ok}" in
      foreign)
        printf 'backend=hc\ntarget=fm-remote-0123456789abcdef:t7\nhc_session=fm-remote-0123456789abcdef\nharness=pi\nmodel=default\neffort=default\n'
        ;;
      moved)
        printf 'backend=hc\ntarget=fm-remote:t9\nhc_session=fm-remote\nharness=pi\nmodel=default\neffort=default\n'
        ;;
      *)
        printf 'backend=hc\ntarget=fm-remote:t7\nhc_session=fm-remote\nharness=pi\nmodel=default\neffort=default\n'
        ;;
    esac
    exit 0
    ;;
  *) exit 0 ;;
esac
SH
chmod +x "$FAKEBIN/fake-ssh"
command -v perl >/dev/null 2>&1 || { echo 'ok - remote hc launch: skipped (perl not found)' 3; exit 0; }

spawn() {  # <env assignments...>
  FM_HOME="$PARENT" FM_SSH_BIN="$FAKEBIN/fake-ssh" FM_FAKE_SSH_LOG="$SSH_LOG" \
    FM_REMOTE_JOB_PLATFORM_OVERRIDE=Linux FM_REMOTE_JOB_STATE_ROOT="$TMP_ROOT/jobs" \
    FM_FAKE_REMOTE_ENTRYPOINT=/srv/fm/bin/fm-remote-entrypoint.sh \
    "$@" "$ROOT/bin/fm-spawn.sh" "$ID" --secondmate --backend hc </dev/null 2>&1
}

test_valid_hc_launch_records_the_route() {
  local out
  rm -f "$PARENT/state/$ID.meta"
  : > "$SSH_LOG"
  out=$(spawn env) || fail "a valid hc remote launch should succeed: $out"
  assert_grep "remote_backend=hc" "$PARENT/state/$ID.meta" \
    "the launch did not record the hc backend"
  assert_grep "remote_hc_session=fm-remote" "$PARENT/state/$ID.meta" \
    "the launch did not record the Core session"
  assert_grep "remote_hc_terminal=t7" "$PARENT/state/$ID.meta" \
    "the launch did not record the Core terminal"
  assert_grep "remote_target=fm-remote:t7" "$PARENT/state/$ID.meta" \
    "the launch did not record the endpoint"
  # The published parent record is a ROUTE, and every later consumer reads these
  # four fields: recovery compares remote_backend, and send/control dispatch to
  # the host where the recorded session and endpoint are addressed.
  local session terminal target
  session=$(sed -n 's/^remote_hc_session=//p' "$PARENT/state/$ID.meta" | tail -1)
  terminal=$(sed -n 's/^remote_hc_terminal=//p' "$PARENT/state/$ID.meta" | tail -1)
  target=$(sed -n 's/^remote_target=//p' "$PARENT/state/$ID.meta" | tail -1)
  [ -n "$session" ] && [ -n "$terminal" ] && [ -n "$target" ] \
    || fail "the recorded route is missing a field later consumers read"
  [ "$target" = "$session:$terminal" ] \
    || fail "the recorded endpoint '$target' does not name its own session and terminal"
  assert_grep "window=remote:$ID" "$PARENT/state/$ID.meta" \
    "the remote route must keep its remote window identity"
  # Consume the freshly published route with an ordinary parent-to-mate send.
  # The fake boundary records the exact remote control verb/body; it does not
  # touch a real host or pretend to validate host-local inbox persistence.
  : > "$SSH_LOG"
  FM_HOME="$PARENT" FM_SSH_BIN="$FAKEBIN/fake-ssh" FM_FAKE_SSH_LOG="$SSH_LOG" \
    FM_REMOTE_JOB_PLATFORM_OVERRIDE=Linux FM_REMOTE_JOB_STATE_ROOT="$TMP_ROOT/jobs" \
    FM_FAKE_REMOTE_ENTRYPOINT=/srv/fm/bin/fm-remote-entrypoint.sh \
    "$ROOT/bin/fm-send.sh" "fm-$ID" "launch-follow-up" >/dev/null 2>&1 \
    || fail "ordinary send could not consume the newly published hc route"
  grep -q 'fm-remote-secondmate-control.sh.*send-stdin' "$SSH_LOG.decoded" \
    || fail "ordinary send did not dispatch through the remote control path"
  grep -q 'launch-follow-up$' "$SSH_LOG.send-body" \
    || fail "ordinary send did not carry its body through the remote boundary"
  pass "remote hc launch: a valid host reply records backend, session, terminal, and an ordinary send consumes the published route"
}

test_foreign_or_moved_reply_is_refused_and_preserved() {
  local out
  rm -f "$PARENT/state/$ID.meta"
  out=$(spawn env) || fail "the baseline hc launch for preservation setup failed: $out"
  cp "$PARENT/state/$ID.meta" "$TMP_ROOT/route-before-refusal.meta"

  # A changed session belongs to another code root. Refuse it without replacing
  # the already-published valid route; callers can still use that route to
  # reconcile the host rather than losing their only endpoint record.
  out=$(spawn env FM_FAKE_HC_REPLY=foreign) && fail "a foreign session reply was accepted: $out"
  assert_contains "$out" "malformed herdr-core route metadata" \
    "the foreign-session refusal did not name the route"
  cmp -s "$TMP_ROOT/route-before-refusal.meta" "$PARENT/state/$ID.meta" \
    || fail "a refused changed-session reply overwrote the existing route"

  # A fresh launch may legitimately land on a different terminal inside its own
  # session. The published endpoint must then describe that endpoint coherently;
  # a moved endpoint under an already-owned route is covered by the relaunch
  # wrapper regression in fm-remote-secondmate-relaunch.test.sh.
  rm -f "$PARENT/state/$ID.meta"
  out=$(spawn env FM_FAKE_HC_REPLY=moved) || fail "a fresh launch on another terminal of its own session was refused: $out"
  assert_grep "remote_target=fm-remote:t9" "$PARENT/state/$ID.meta" \
    "the fresh launch did not record the endpoint the host reported"
  assert_grep "remote_hc_session=fm-remote" "$PARENT/state/$ID.meta" \
    "the fresh launch lost the session identity"
  pass "remote hc launch: a changed unowned session is refused without changing the existing route, and a fresh own-session endpoint records coherently"
}

test_valid_hc_launch_records_the_route
test_foreign_or_moved_reply_is_refused_and_preserved
