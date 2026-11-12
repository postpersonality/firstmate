#!/usr/bin/env bash
# Public lab CLI regressions. Oracle: roots must exclude untrusted writers,
# sessions must never be adopted, and incomplete inventories cannot verify.
# Command stubs inject filesystem failures, not expected inventory contents.
set -eu
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=tests/lib.sh
. "$ROOT/tests/lib.sh"
TMP_ROOT=$(fm_test_tmproot fm-hc-lab-tests)
LAB=${1:-$ROOT/bin/fm-hc-lab.sh}
export FM_HC_LAB_DIR="$TMP_ROOT/lab" FM_HC_LAB_SOCK_DIR="$TMP_ROOT/sockets"
export XDG_STATE_HOME="$TMP_ROOT/state" XDG_RUNTIME_DIR="$TMP_ROOT/runtime"
mkdir -p "$TMP_ROOT/fakebin" "$XDG_STATE_HOME/herdr-core"
printf 'real state\n' > "$XDG_STATE_HOME/herdr-core/state"
export REAL_FIND REAL_CAT
REAL_FIND=$(command -v find)
REAL_CAT=$(command -v cat)
cat > "$TMP_ROOT/fakebin/hc" <<'SH'
#!/usr/bin/env bash
printf '{"pid":123}\n'
SH
cat > "$TMP_ROOT/fakebin/find" <<'SH'
#!/usr/bin/env bash
[ "${FAIL_READ:-}" != find ] || exit 1
if [ "${FAIL_READ:-}" = metadata ]; then
  # Simulate a file disappearing between inventory and metadata collection.
  printf '%s/missing-file\n' "$1"
  exit 0
fi
exec "$REAL_FIND" "$@"
SH
cat > "$TMP_ROOT/fakebin/cat" <<'SH'
#!/usr/bin/env bash
case "${FAIL_READ:-}:$*" in
  roots:*/fleet-roots.txt|baseline:*/fleet-state.txt) exit 1 ;;
esac
exec "$REAL_CAT" "$@"
SH
# No real Core processes exist in these tests.
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP_ROOT/fakebin/ps"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP_ROOT/fakebin/sleep"
chmod +x "$TMP_ROOT/fakebin/"*
export FM_HC_BIN="$TMP_ROOT/fakebin/hc" PATH="$TMP_ROOT/fakebin:$PATH"

refuse() {
  local diagnostic=$1
  shift
  if "$@" > "$TMP_ROOT/out" 2> "$TMP_ROOT/err"; then
    fail "unexpected success: $*"
  fi
  grep -q "$diagnostic" "$TMP_ROOT/err" || fail "missing diagnostic: $diagnostic"
}

for root in "$FM_HC_LAB_DIR" "$FM_HC_LAB_SOCK_DIR"; do
  mkdir -m 777 "$root"
  chmod 777 "$root"
  for command in provision run stop teardown; do
    refuse 'unsafe root' bash "$LAB" "$command" fm-hclab-unsafe ls
  done
  [ ! -e "$FM_HC_LAB_DIR/fm-hclab-unsafe" ] || fail 'unsafe root accepted'
  rm -rf "$root"
  mkdir -m 700 "$TMP_ROOT/redirect"
  ln -s "$TMP_ROOT/redirect" "$root"
  refuse 'unsafe root' bash "$LAB" provision fm-hclab-redirected
  [ ! -e "$TMP_ROOT/redirect/fm-hclab-redirected" ] || fail 'symlink root accepted'
  rm "$root"
  rmdir "$TMP_ROOT/redirect"
done

bash "$LAB" provision fm-hclab-good
# The filesystem's permission bits are the owned output contract here.
python3 - "$FM_HC_LAB_DIR" "$FM_HC_LAB_SOCK_DIR" <<'PY'
import os, stat, sys
for path in sys.argv[1:]:
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o700, path
PY
printf 'do not overwrite\n' > "$FM_HC_LAB_DIR/fm-hclab-good/sentinel"
refuse 'refusing to adopt or overwrite' bash "$LAB" provision fm-hclab-good
[ "$(cat "$FM_HC_LAB_DIR/fm-hclab-good/sentinel")" = 'do not overwrite' ] || fail 'existing session overwritten'

for failure in find metadata roots baseline; do
  refuse 'refusing unverified teardown' env FAIL_READ=$failure bash "$LAB" teardown fm-hclab-good
  [ -d "$FM_HC_LAB_DIR/fm-hclab-good" ] || fail 'failed verification removed evidence'
done
refuse 'could not record the fleet-state tripwire' env FAIL_READ=find bash "$LAB" provision fm-hclab-incomplete
[ ! -e "$FM_HC_LAB_DIR/fm-hclab-incomplete" ] || fail 'incomplete provision retained'
bash "$LAB" teardown fm-hclab-good
[ ! -e "$FM_HC_LAB_DIR/fm-hclab-good" ] || fail 'successful teardown retained session'
printf 'ok - private roots, exclusive sessions, and fail-closed tripwire\n'

# A core rewrites its own state file atomically, so the same bytes reappear under
# a new inode and a later mtime. Content, not metadata, decides: that rewrite must
# not fail verification, while a real change to the same file must.
bash "$LAB" provision fm-hclab-atomic
cp "$XDG_STATE_HOME/herdr-core/state" "$TMP_ROOT/state.before"
printf 'real state\n' > "$TMP_ROOT/state.same"
mv "$TMP_ROOT/state.same" "$XDG_STATE_HOME/herdr-core/state"
[ "$(stat -c '%i' "$TMP_ROOT/state.before")" != "$(stat -c '%i' "$XDG_STATE_HOME/herdr-core/state")" ] \
  || fail 'the fixture did not replace the state file atomically'
bash "$LAB" teardown fm-hclab-atomic || fail 'an identical-byte atomic rewrite was treated as damage'
[ ! -e "$FM_HC_LAB_DIR/fm-hclab-atomic" ] || fail 'teardown after an identical rewrite retained the session'
printf 'ok - an atomic rewrite of identical bytes is not damage\n'

bash "$LAB" provision fm-hclab-content
printf 'changed state\n' >> "$XDG_STATE_HOME/herdr-core/state"
refuse 'FLEET-STATE TRIPWIRE FAILED' bash "$LAB" teardown fm-hclab-content
[ -d "$FM_HC_LAB_DIR/fm-hclab-content" ] || fail 'a real content change removed evidence'
printf 'ok - a real content change still fails verification\n'

# The real core's terminal inventory is rewritten while agents work. ONLY its own
# activity fields may differ between the baseline and the check; everything that
# identifies a terminal, or that a person would notice (names, labels, lifecycle,
# membership, processes), still refuses.
TERMINALS="$XDG_STATE_HOME/herdr-core/terminals.json"
write_terminals() {  # <file> [python-dict-patch]
  python3 - "$1" "${2:-}" <<'PY'
import json, sys
base = {"terminals": [
    {"address": "t1", "state": "live", "turn": 9, "news": 7, "status_ms": 1000,
     "labels": {"herdr.space": "sp-a", "herdr.tab": "tb-a"},
     "title": "⠦ fix login", "pid": 4242, "start_ms": 900,
     "cwd": "/work/app", "argv": ["claude"], "exit_code": None,
     "status": {"app": "claude", "state": "working"}},
    {"address": "t2", "state": "live", "turn": 0, "news": 0, "status_ms": 5,
     "labels": {}, "title": "⠧ shell", "pid": 4343, "start_ms": 910,
     "cwd": "/work/other", "argv": ["nu"], "exit_code": None},
]}
if sys.argv[2]:
    exec(sys.argv[2], {"data": base})
with open(sys.argv[1], "w") as handle:
    json.dump(base, handle)
PY
}

# 1. Normal activity and a spinner animation are not damage.
write_terminals "$TERMINALS"
bash "$LAB" provision fm-hclab-activity
write_terminals "$TERMINALS" '
data["terminals"][0]["turn"] = 10
data["terminals"][0]["news"] = 9
data["terminals"][0]["status_ms"] = 2000
data["terminals"][0]["status"]["state"] = "done"
data["terminals"][0]["title"] = "⠧ fix login"
data["terminals"][1]["title"] = "⠋ shell"
'
bash "$LAB" teardown fm-hclab-activity || fail 'normal activity and a spinner were treated as damage'
[ ! -e "$FM_HC_LAB_DIR/fm-hclab-activity" ] || fail 'activity-only teardown retained the session'
printf 'ok - core activity and spinner animation are not damage\n'

for patch in \
  'data["terminals"][0]["title"] = "refactor login"' \
  'data["terminals"][0]["labels"]["herdr.tab"] = "tb-renamed"' \
  'data["terminals"][0]["pid"] = 9999' \
  'data["terminals"].append({"address": "t3", "state": "live"})' \
  'data["terminals"][0]["state"] = "finished"' \
  'data["terminals"][0]["exit_code"] = 1' \
  'data["terminals"][0]["unmodelled"] = 1' \
  'data["terminals"][0]["status"]["unmodelled_nested"] = 1' \
  'data["terminals"][0]["extra"] = {"state": "working", "turn": 1}' \
  'data["terminals"][0]["status"]["state"] = "blocked"'; do
  write_terminals "$TERMINALS"
  bash "$LAB" provision "fm-hclab-diff-$(printf '%s' "$patch" | cksum | cut -d' ' -f1)"
  session="fm-hclab-diff-$(printf '%s' "$patch" | cksum | cut -d' ' -f1)"
  write_terminals "$TERMINALS" "$patch"
  refuse 'FLEET-STATE TRIPWIRE FAILED' bash "$LAB" teardown "$session"
  [ -d "$FM_HC_LAB_DIR/$session" ] || fail "a real change removed evidence: $patch"
  rm -rf "$FM_HC_LAB_DIR/$session"
done
printf 'ok - a rename, label, process, membership, lifecycle or unknown-field change still refuses\n'

write_terminals "$TERMINALS"
bash "$LAB" provision fm-hclab-corrupt
printf '{"terminals": [' > "$TERMINALS"
refuse 'refusing unverified teardown' bash "$LAB" teardown fm-hclab-corrupt
[ -d "$FM_HC_LAB_DIR/fm-hclab-corrupt" ] || fail 'corrupted inventory removed evidence'
rm -rf "$FM_HC_LAB_DIR/fm-hclab-corrupt"
write_terminals "$TERMINALS"
printf 'ok - a corrupted core inventory never verifies\n'
