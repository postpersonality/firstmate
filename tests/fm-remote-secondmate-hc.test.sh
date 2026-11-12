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

# shellcheck source=tests/fixtures.sh
. "$(dirname "${BASH_SOURCE[0]}")/fixtures.sh"

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

test_spawn_binds_prelaunch_send_and_abort_cleanup_to_secondmate_home() {
  local parent="$TMP_ROOT/spawn-parent" secondmate="$TMP_ROOT/spawn-secondmate"
  local id=hc-home-owner fakebin hcdir out rc send_calls kill_calls rm_calls
  fm_test_spawn_home "$parent" pi
  mkdir -p "$parent/user-home" "$secondmate/bin" "$secondmate/data" \
    "$secondmate/config" "$secondmate/state/parent-route" \
    "$secondmate/data/.parent-route" "$secondmate/projects"
  printf '# Firstmate\n' > "$secondmate/AGENTS.md"
  printf '%s\n' "$id" > "$secondmate/.fm-secondmate-home"
  printf 'charter for %s\n' "$id" > "$secondmate/data/charter.md"
  printf '%s\n' 'projects/' 'state/' 'data/' 'config/' '.no-mistakes/' > "$secondmate/.gitignore"
  git -C "$secondmate" init -q -b main || fail 'could not initialize the secondmate home fixture'
  fakebin=$(fm_test_make_spawn_fakebin "$TMP_ROOT/spawn-tools")
  hcdir="$TMP_ROOT/spawn-hc"
  mkdir -p "$hcdir"
  cat > "$fakebin/pi" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  --version) printf 'Pi 0.84.0\n' ;;
  --help) printf 'Options: --tui-mode <mode> --approve\n' ;;
  *) exit 0 ;;
esac
SH
  cat > "$fakebin/herdr-core" <<'SH'
#!/usr/bin/env bash
set -u
D=${FM_FAKE_HC_DIR:?}
{
  printf 'FM_HOME=%s HC_SESSION=%s' "${FM_HOME:-}" "${HC_SESSION:-}"
  for a in "$@"; do printf '\x1f%s' "$a"; done
  printf '\n'
} >> "$D/log"
cmd=${1:-}
last=
for a in "$@"; do last=$a; done
case "$cmd" in
  --version) printf 'hc 0.1.20\n' ;;
  server) printf '{"running":true}\n' ;;
  connect) printf '{"jsonrpc":"2.0","id":1,"result":{"generation":1}}\n' ;;
  ls) printf '{"terminals":[]}\n' ;;
  run)
    task= home= cwd=
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --cwd) cwd=$2; shift 2 ;;
        --label)
          case "$2" in
            firstmate.task=*) task=${2#*=} ;;
            firstmate.home=*) home=${2#*=} ;;
          esac
          shift 2
          ;;
        *) shift ;;
      esac
    done
    [ -n "$task" ] && [ -n "$home" ] || exit 4
    jq -cn --arg task "$task" --arg home "$home" --arg cwd "$cwd" \
      '{address:"t1",state:"live",labels:{"firstmate.task":$task,"firstmate.home":$home},cwd:$cwd,foreground:{name:"sh",argv:["/bin/sh"],cwd:$cwd,pid:99999}}' \
      > "$D/t1.json"
    printf '{"address":"t1"}\n'
    ;;
  get)
    [ -f "$D/$last.json" ] || { printf '{"error":{"kind":"not_found"}}\n' >&2; exit 3; }
    printf '%s\n' "$(<"$D/$last.json")"
    ;;
  send) printf 'injected prelaunch send failure\n' >&2; exit 1 ;;
  kill) printf '{}\n' ;;
  rm) rm -f "$D/$last.json"; printf '{}\n' ;;
  *) exit 2 ;;
esac
SH
  chmod +x "$fakebin/pi" "$fakebin/herdr-core"

  out=$(FM_ROOT_OVERRIDE="$ROOT" FM_HOME="$parent" HOME="$parent/user-home" \
    FM_STATE_OVERRIDE="$secondmate/state/parent-route" \
    FM_DATA_OVERRIDE="$secondmate/data/.parent-route" \
    FM_PROJECTS_OVERRIDE="$secondmate/projects" FM_CONFIG_OVERRIDE="$secondmate/config" \
    FM_SPAWN_NO_GUARD=1 FM_SKIP_SECONDMATE_SYNC=1 FM_SKIP_SECONDMATE_INHERIT=1 \
    FM_HC_BIN="$fakebin/herdr-core" FM_FAKE_HC_DIR="$hcdir" HC_SESSION=fm-remote \
    PATH="$fakebin:$PATH" \
    "$ROOT/bin/fm-spawn.sh" "$id" "$secondmate" --secondmate --backend hc --harness pi 2>&1)
  rc=$?
  [ "$rc" -ne 0 ] || fail 'the injected prelaunch send failure should stop the spawn'
  send_calls=$(grep $'\x1fsend\x1f' "$hcdir/log" || true)
  kill_calls=$(grep $'\x1fkill\x1f' "$hcdir/log" || true)
  rm_calls=$(grep $'\x1frm\x1f' "$hcdir/log" || true)
  [ -n "$send_calls" ] || fail "the task-owned terminal rejected input before hc send was reached: $out"
  [ -n "$kill_calls" ] || fail "failed prelaunch delivery did not reach guarded endpoint cleanup: $out"
  [ -n "$rm_calls" ] || fail "guarded cleanup did not remove the failed-spawn endpoint: $out"
  assert_contains "$send_calls" "FM_HOME=$secondmate" 'HC prelaunch send used the primary home identity'
  assert_contains "$kill_calls" "FM_HOME=$secondmate" 'HC abort cleanup used the primary home identity'
  assert_contains "$rm_calls" "FM_HOME=$secondmate" 'HC endpoint removal used the primary home identity'
  [ ! -e "$hcdir/t1.json" ] || fail 'a failed prelaunch left its owned HC endpoint behind'
  assert_not_contains "$out" 'could not close endpoint' 'guarded cleanup refused its own secondmate endpoint'
  pass 'hc secondmate spawn: prelaunch input and failed-spawn cleanup use the secondmate home identity'
}

test_hc_relaunch_uses_secondmate_home_for_control() {
  local old_id=$ID old_home=$TARGET_HOME id=hc-relaunch-home home="$TMP_ROOT/relaunch-home"
  local fake_root="$TMP_ROOT/relaunch-code" identity_home="$TMP_ROOT/relaunch-identity"
  local session=fm-remote-046fafda74bf37ae control_log out source name
  mkdir -p "$home/bin" "$home/data" "$home/config" "$home/state/parent-route" \
    "$home/data/.parent-route" "$home/projects" "$fake_root/bin" "$identity_home/.firstmate"
  printf '%s\n' "$id" > "$home/.fm-secondmate-home"
  printf '# Firstmate\n' > "$home/AGENTS.md"
  printf '/srv/firstmate-primary\n' > "$identity_home/.firstmate/remote-herdr-owner"
  ID=$id TARGET_HOME=$home
  write_route "$session" t7

  for source in "$ROOT"/bin/*.sh; do
    name=${source##*/}
    [ "$name" = fm-control.sh ] && continue
    ln -s "$source" "$fake_root/bin/$name" || fail "could not link $name into the remote-control fixture"
  done
  ln -s "$ROOT/bin/backends" "$fake_root/bin/backends" || fail 'could not link backend fixtures'
  cat > "$fake_root/bin/fm-control.sh" <<'SH'
#!/usr/bin/env bash
{
  printf 'FM_HOME=%s\n' "${FM_HOME:-}"
  printf 'HC_LABEL_HOME=%s\n' "${HC_LABEL_HOME:-}"
  printf 'FM_ROOT_OVERRIDE=%s\n' "${FM_ROOT_OVERRIDE:-}"
  printf 'FM_STATE_OVERRIDE=%s\n' "${FM_STATE_OVERRIDE:-}"
  printf 'FM_DATA_OVERRIDE=%s\n' "${FM_DATA_OVERRIDE:-}"
  printf 'FM_CONFIG_OVERRIDE=%s\n' "${FM_CONFIG_OVERRIDE:-}"
  printf 'args=%s\n' "$*"
} > "${FM_FAKE_CONTROL_LOG:?}"
SH
  chmod +x "$fake_root/bin/fm-control.sh"
  control_log="$TMP_ROOT/relaunch-control-env"
  out=$(HOME="$identity_home" FM_HOME="$home" FM_ROOT_OVERRIDE=/srv/firstmate-extra \
    FM_STATE_OVERRIDE="$home/state/parent-route" FM_DATA_OVERRIDE="$home/data/.parent-route" \
    FM_CONFIG_OVERRIDE="$home/config" FM_FAKE_CONTROL_LOG="$control_log" \
    "$fake_root/bin/fm-remote-secondmate-control.sh" relaunch "$id" pi openai-codex/gpt-6-luna xhigh 2>&1)
  assert_contains "$out" 'target=fm-remote-046fafda74bf37ae:t7' 'the host-local relaunch should retain its recorded Core target'
  assert_contains "$(cat "$control_log")" 'FM_HOME=/srv/firstmate-extra' 'HC relaunch must retain the code root as the active home'
  assert_contains "$(cat "$control_log")" "HC_LABEL_HOME=$home" 'HC control must validate labels as the secondmate home'
  assert_contains "$(cat "$control_log")" 'FM_ROOT_OVERRIDE=/srv/firstmate-extra' 'HC control must retain the remote code-root identity'
  assert_contains "$(cat "$control_log")" "FM_STATE_OVERRIDE=$home/state/parent-route" 'HC control must retain the parent-route state owner'
  ID=$old_id TARGET_HOME=$old_home
  pass 'hc remote relaunch: lifecycle control uses the secondmate home while retaining the remote code root and route state'
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
test_hc_relaunch_uses_secondmate_home_for_control
test_readiness_never_starts_a_core
test_spawn_binds_prelaunch_send_and_abort_cleanup_to_secondmate_home
