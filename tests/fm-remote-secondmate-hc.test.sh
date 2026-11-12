#!/usr/bin/env bash
# tests/fm-remote-secondmate-hc.test.sh - deterministic transport-boundary
# coverage for the herdr-core (hc) remote secondmate route.
#
# No SSH and no Core are involved: the host-local control plane is driven
# directly against a seeded home, and the readiness doctor runs against a fake
# hc CLI that records every call. What this proves is the route contract (own
# code-root session, endpoint bound to it) and that a read-only readiness check
# never starts or replaces a core.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TMP_ROOT=$(fm_test_tmproot fm-remote-secondmate-hc)
ID=ios
HOME_DIR="$TMP_ROOT/account"
TARGET_HOME="$HOME_DIR/home"
RUN_DIR="$HOME_DIR/run"
FAKEBIN=$(fm_fakebin "$TMP_ROOT/fake")
mkdir -p "$TARGET_HOME/state/parent-route" "$TARGET_HOME/data/.parent-route" \
  "$TARGET_HOME/bin" "$RUN_DIR/herdr-core" "$HOME_DIR/.firstmate"
printf '%s\n' "$ID" > "$TARGET_HOME/.fm-secondmate-home"
printf '# home\n' > "$TARGET_HOME/AGENTS.md"

# A fake herdr-core/hc CLI that records calls. The adapter's `--version` gate is
# a local binary read, so it is allowed; anything that would touch a core from a
# readiness check is a contract failure.
# The fake answers the adapter's version gate, which is a local binary read.
cat > "$FAKEBIN/herdr-core" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FM_FAKE_HC_LOG:?}"
case "${1:-}" in
  --version) printf 'hc %s\n' "${FM_FAKE_HC_VERSION:-0.1.20}" ;;
  *) exit 1 ;;
esac
SH
chmod +x "$FAKEBIN/herdr-core"
# `hc` is an alias the adapter also accepts; a case below runs WITHOUT it, so
# nothing here may depend on the alias being installed.
cp "$FAKEBIN/herdr-core" "$FAKEBIN/hc"
chmod +x "$FAKEBIN/hc"

# A recorded hc endpoint, as the parent-side spawn publishes it.
write_route() {  # <hc-session> <hc-terminal> [window]
  local session=$1 terminal=$2 window=${3:-$1:$2}
  printf '%s\n' \
    "window=$window" \
    "endpoint_task_id=$ID" \
    "worktree=$TARGET_HOME" \
    "project=$TARGET_HOME" \
    "harness=pi" \
    "kind=secondmate" \
    "mode=secondmate" \
    "yolo=off" \
    "model=default" \
    "effort=default" \
    "home=$TARGET_HOME" \
    "projects=alpha" \
    "remote_host=remote-host" \
    "remote_root=/srv/fm" \
    "backend=hc" \
    "remote_backend=hc" \
    "hc_session=$session" \
    "hc_terminal=$terminal" \
    "remote_hc_session=$session" \
    "remote_hc_terminal=$terminal" \
    "remote_target=$session:$terminal" \
    > "$TARGET_HOME/state/parent-route/$ID.meta"
}

control() {  # <args...>
  HOME="$HOME_DIR" FM_ROOT_OVERRIDE="${FM_TEST_ROOT_OVERRIDE:-$ROOT}" FM_HOME="$TARGET_HOME" \
    FM_FAKE_HC_LOG="$HOME_DIR/hc-calls" XDG_RUNTIME_DIR="$RUN_DIR" \
    PATH="$FAKEBIN:$PATH" "$ROOT/bin/fm-remote-secondmate-control.sh" "$@"
}

doctor() {  # <args...>
  HOME="$HOME_DIR" FM_ROOT_OVERRIDE="$ROOT" FM_HOME="$TARGET_HOME" \
    FM_FAKE_HC_LOG="$HOME_DIR/hc-calls" XDG_RUNTIME_DIR="$RUN_DIR" \
    PATH="$FAKEBIN:$PATH" "$ROOT/bin/fm-remote-doctor.sh" "$@"
}

test_tool_gate_accepts_the_release_name_alone() {
  local out bin_only
  # A hermetic PATH with ONLY the `herdr-core` release name: no `hc` alias, and
  # no real installed binary that could mask the gap.
  bin_only="$TMP_ROOT/bin-core-only"
  mkdir -p "$bin_only"
  cp "$FAKEBIN/herdr-core" "$bin_only/herdr-core"
  chmod +x "$bin_only/herdr-core"
  for needed in bash env jq git id uname sed grep awk tr cat printf dirname basename mkdir rm mktemp date sort head tail cut sha256sum shasum python3; do
    real=$(command -v "$needed" 2>/dev/null || true)
    [ -z "$real" ] || ln -sf "$real" "$bin_only/$needed" 2>/dev/null || true
  done
  : > "$HOME_DIR/hc-calls"
  out=$(HOME="$HOME_DIR" FM_ROOT_OVERRIDE="$ROOT" FM_HOME="$TARGET_HOME" \
    FM_FAKE_HC_LOG="$HOME_DIR/hc-calls" XDG_RUNTIME_DIR="$RUN_DIR" \
    PATH="$bin_only" "$ROOT/bin/fm-remote-doctor.sh" --backend hc 2>&1) || true
  # This host deliberately lacks the other required tools, so the run reports a
  # gap and stops before the readiness checks; the FACT under test is that the
  # Core tool gate resolved the release name alone.
  printf '%s' "$out" | grep -Fq "required hc=$bin_only/herdr-core" \
    || fail "the tool gate did not accept the herdr-core release name alone: $out"
  printf '%s' "$out" | grep -Fq 'MISSING' \
    && printf '%s' "$out" | grep -q 'required hc=.*MISSING' \
    && fail "the Core tool gate reported the release name missing: $out"
  grep -qx -- '--version' "$HOME_DIR/hc-calls" \
    || fail "the adapter's version gate was not run against herdr-core: $(cat "$HOME_DIR/hc-calls")"
  grep -v -- '--version' "$HOME_DIR/hc-calls" > "$HOME_DIR/hc-touches" || true
  [ -s "$HOME_DIR/hc-touches" ] && fail "the alias-free gate touched a core: $(cat "$HOME_DIR/hc-touches")"
  pass "hc tool gate: the herdr-core release name alone satisfies the required-tool and version gate"
}

test_route_accepts_the_code_root_session() {
  local out
  write_route fm-remote t7
  if ! out=$(control route "$ID" 2>&1); then
    fail "an hc route in this code root's own session was refused: $out"
  fi
  printf '%s' "$out" | grep -Fq 'backend=hc' || fail "route did not report the hc backend: $out"
  printf '%s' "$out" | grep -Fq 'hc_session=fm-remote' || fail "route did not report the session: $out"
  printf '%s' "$out" | grep -Fq 'target=fm-remote:t7' || fail "route did not report the endpoint: $out"
  pass "hc route: a recorded endpoint in this code root's session validates"
}

test_route_refuses_another_code_root_and_a_moved_endpoint() {
  local out
  write_route fm-remote-0123456789abcdef t7
  if out=$(control route "$ID" 2>&1); then
    fail "a route in another code root's session was accepted: $out"
  fi
  printf '%s' "$out" | grep -Fq "recorded in herdr-core session" \
    || fail "the wrong-owner refusal did not name the recorded session: $out"

  write_route fm-remote t7 "fm-remote:t9"
  if out=$(control route "$ID" 2>&1); then
    fail "an endpoint whose window moved away from the record was accepted: $out"
  fi
  printf '%s' "$out" | grep -Fq "endpoint metadata is invalid" \
    || fail "the moved-endpoint refusal did not name the record: $out"
  pass "hc route: another code root's session and a moved endpoint are both refused"
}

test_secondary_remote_root_uses_its_owner_and_refuses_foreign_route() {
  local out secondary_session owner_file route_file owner_backup route_backup
  local owner_was_present=0 route_was_present=0
  owner_file="$HOME_DIR/.firstmate/remote-herdr-owner"
  route_file="$TARGET_HOME/state/parent-route/$ID.meta"
  owner_backup="$TMP_ROOT/remote-herdr-owner.before-secondary-test"
  route_backup="$TMP_ROOT/route.before-secondary-test"
  if [ -f "$owner_file" ]; then cp "$owner_file" "$owner_backup"; owner_was_present=1; fi
  if [ -f "$route_file" ]; then cp "$route_file" "$route_backup"; route_was_present=1; fi
  # The shared account's primary service belongs to /srv/firstmate-primary.
  # A remote code root /srv/firstmate-extra must use its root-derived session,
  # not the primary's fm-remote and not the caller's local code-root identity.
  printf '%s\n' /srv/firstmate-primary > "$HOME_DIR/.firstmate/remote-herdr-owner"
  secondary_session=fm-remote-046fafda74bf37ae
  write_route "$secondary_session" t7
  if ! out=$(FM_TEST_ROOT_OVERRIDE=/srv/firstmate-extra control route "$ID" 2>&1); then
    fail "the secondary remote code root's own hc route was refused: $out"
  fi
  printf '%s' "$out" | grep -Fq "hc_session=$secondary_session" \
    || fail "the secondary remote route did not report its owner-derived session: $out"

  write_route fm-remote t7
  if out=$(FM_TEST_ROOT_OVERRIDE=/srv/firstmate-extra control route "$ID" 2>&1); then
    fail "the secondary remote root accepted the primary owner's hc route: $out"
  fi
  printf '%s' "$out" | grep -Fq "expected '$secondary_session'" \
    || fail "the foreign-route refusal did not name the remote owner's expected session: $out"

  # Restore every shared fixture input so readiness and other route checks can
  # run after this test without inheriting the secondary owner's context.
  if [ "$owner_was_present" -eq 1 ]; then cp "$owner_backup" "$owner_file"; else rm -f "$owner_file"; fi
  if [ "$route_was_present" -eq 1 ]; then cp "$route_backup" "$route_file"; else rm -f "$route_file"; fi
  pass "hc owner: /srv/firstmate-extra accepts its session under /srv/firstmate-primary ownership and refuses the primary's foreign route"
}

test_readiness_never_starts_a_core() {
  local out
  : > "$HOME_DIR/hc-calls"
  rm -f "$RUN_DIR/herdr-core/fm-remote.sock"
  out=$(doctor --backend hc 2>&1) || true
  printf '%s' "$out" | grep -Fq 'hc-core=ok: no core is running for session fm-remote yet' \
    || fail "an absent core socket was not reported as 'no core yet': $out"
  grep -v -- '--version' "$HOME_DIR/hc-calls" > "$HOME_DIR/hc-touches" || true
  [ -s "$HOME_DIR/hc-touches" ] && fail "the readiness check touched a core: $(cat "$HOME_DIR/hc-touches")"
  [ ! -e "$RUN_DIR/herdr-core/fm-remote.sock" ] || fail "the readiness check created core state"

  # A stale socket file inside the session's own root: reported, never started
  # or replaced, and still no hc call.
  printf '' > "$RUN_DIR/herdr-core/fm-remote.sock"
  : > "$HOME_DIR/hc-calls"
  out=$(doctor --backend hc 2>&1) || true
  printf '%s' "$out" | grep -Fq 'refuses connections, and this check never starts or replaces a core' \
    || fail "a stale core socket was not reported as such: $out"
  grep -v -- '--version' "$HOME_DIR/hc-calls" > "$HOME_DIR/hc-touches" || true
  [ -s "$HOME_DIR/hc-touches" ] && fail "a stale socket led to a core call: $(cat "$HOME_DIR/hc-touches")"
  [ -f "$RUN_DIR/herdr-core/fm-remote.sock" ] || fail "the readiness check removed or replaced the stale socket"
  pass "hc readiness: an absent or stale socket is reported and no core is started, replaced, or created"
}

test_route_accepts_the_code_root_session
test_route_refuses_another_code_root_and_a_moved_endpoint
test_readiness_never_starts_a_core
test_tool_gate_accepts_the_release_name_alone
test_secondary_remote_root_uses_its_owner_and_refuses_foreign_route
test_readiness_never_starts_a_core
