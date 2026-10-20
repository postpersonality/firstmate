#!/usr/bin/env bash
# Owned real-Herdr lab, scratch Git clones, fixture shell and public spawn helpers.
# No native model agents, project pool, global config, or default endpoints.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=tests/herdr-test-safety.sh
. "$ROOT/tests/herdr-test-safety.sh"
herdr_forget_inherited_pane
for tool in herdr jq git; do
  command -v "$tool" >/dev/null || { echo "skip: $tool unavailable"; exit 0; }
done
HERDR_LAB_HELPER=${HERDR_LAB_HELPER:-$ROOT/bin/fm-herdr-lab.sh}
HERDR_LAB_SESSION=$("$HERDR_LAB_HELPER" name firstmate-herdr-project-spaces)
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-herdr-project.XXXXXX")
cleanup() {
  local status=$?
  trap - EXIT
  env PATH="$REAL_PATH" "$HERDR_LAB_HELPER" teardown "$HERDR_LAB_SESSION" || status=1
  find "$TMP_ROOT" -type d -exec chmod u+rwx {} +
  rm -rf "$TMP_ROOT"
  exit "$status"
}
trap cleanup EXIT
fail() { echo "not ok - $*" >&2; exit 1; }
pass() { echo "ok - $*"; }
REAL_PATH=$PATH
mkdir -p "$TMP_ROOT/fakebin" "$TMP_ROOT/home/state" "$TMP_ROOT/home/config" "$TMP_ROOT/slots"
export REAL_PATH HERDR_LAB_HELPER HERDR_LAB_SESSION TMP_ROOT
# Every production call (including the client-only status read) crosses the
# helper. A mismatched explicit session or lifecycle call fails closed there.
cat > "$TMP_ROOT/fakebin/herdr" <<'SH'
#!/usr/bin/env bash
set -eu
args=()
while [ "$#" -gt 0 ]; do
  if [ "$1" = --session ]; then
    [ "$2" = "$HERDR_LAB_SESSION" ] || exit 90
    shift 2
  else
    args+=("$1"); shift
  fi
done
exec env PATH="$REAL_PATH" "$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" "${args[@]}"
SH
cat > "$TMP_ROOT/fakebin/treehouse" <<'SH'
#!/usr/bin/env bash
# Dependency/return fixture only; allocation is the shell function below.
[ "${1:-}" = return ] || [ "${1:-}" = --version ]
SH
cat > "$TMP_ROOT/rc" <<'SH'
export PATH="$TMP_ROOT/fakebin:$REAL_PATH"
unset PROMPT_COMMAND
PS1='lab$ '
treehouse() {
  [ "$1" = get ] || return 1
  local slot
  slot=$(mktemp -d "$TMP_ROOT/slots/slot.XXXXXX") || return 1
  git clone --quiet "$PWD" "$slot" || return 1
  git -C "$slot" remote set-url origin "$(git remote get-url origin)" || return 1
  builtin cd "$slot"
}
SH
cat > "$TMP_ROOT/shell" <<'SH'
#!/usr/bin/env bash
touch "$TMP_ROOT/shell-launched"
exec bash --noprofile --rcfile "$TMP_ROOT/rc" -i
SH
chmod +x "$TMP_ROOT/fakebin/"* "$TMP_ROOT/shell"
# A named session is the socket boundary. Its own config also prevents host
# shell defaults and rename plugins from entering the fixture world.
export HERDR_CONFIG_PATH="$TMP_ROOT/herdr-config.toml"
# This optional installed plugin documents a per-process config override. Keep
# its label mutations out of legacy exact-binding fixtures, without changing
# the shared plugin settings or the default session.
export HERDR_AUTOMATIC_RENAME_CONFIG="$TMP_ROOT/rename-config.sh"
printf 'NAME_TABS=0\nAUTO_INDEX=0\n' > "$HERDR_AUTOMATIC_RENAME_CONFIG"
printf '[terminal]\ndefault_shell = "%s"\n' "$TMP_ROOT/shell" > "$HERDR_CONFIG_PATH"
"$HERDR_LAB_HELPER" provision "$HERDR_LAB_SESSION"
export HERDR_SESSION=$HERDR_LAB_SESSION FM_HOME="$TMP_ROOT/home" FM_ROOT_OVERRIDE="$ROOT" FM_SPAWN_NO_GUARD=1
export PATH="$TMP_ROOT/fakebin:$REAL_PATH"
lab() { env PATH="$REAL_PATH" "$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" "$@"; }
# Prove the real pane uses our shell BEFORE sending any allocation command.
lab workspace create --cwd "$TMP_ROOT" --label fixture-shell --no-focus >/dev/null
for ((i=0; i<100; i++)); do
  [ ! -f "$TMP_ROOT/shell-launched" ] || break
  sleep 0.1
done
[ -f "$TMP_ROOT/shell-launched" ] || fail 'Herdr did not select the isolated fixture shell; refusing any spawn'
make_project() {
  mkdir -p "$1"
  git -C "$1" init -q -b main
  echo fixture > "$1/README.md"
  git -C "$1" add README.md
  git -C "$1" -c user.name=Tests -c user.email=tests@example.invalid commit -qm initial
  git clone -q --bare "$1" "$1.origin.git"
  git -C "$1" remote add origin "$1.origin.git"
}
write_brief() { # <id>
  mkdir -p "$FM_HOME/data/$1"
  printf '# Task\n## Captain\x27s intent\nExercise project placement.\n\n## Firstmate spec\nRun the fixture command in an isolated copy.\n' > "$FM_HOME/data/$1/brief.md"
}
spawn() { # <id> <project>
  write_brief "$1"
  if ! "$ROOT/bin/fm-spawn.sh" "$1" "$2" "sh -c 'echo placement-fixture-ran'" --mode no-mistakes --yolo off --backend herdr > "$TMP_ROOT/$1.out" 2> "$TMP_ROOT/$1.err"; then
    cat "$TMP_ROOT/$1.err" >&2
    return 1
  fi
  case "$(field "$1" worktree)" in
    "$TMP_ROOT/slots/"*) ;;
    *) fail 'public spawn escaped the scratch-clone allocator' ;;
  esac
}
field() { sed -n "s/^$2=//p" "$FM_HOME/state/$1.meta"; }
container() { bash -c '. "$1/bin/backends/herdr.sh"; fm_backend_herdr_project_container_ensure "$2"' _ "$ROOT" "$1"; }

# Execute public spawn inside a genuine lab pane so Herdr, rather than a
# composed test environment, supplies every parent identity marker.
spawn_in_pane() { # <pane> <id> <project>
  local command i
  write_brief "$2"
  cat > "$TMP_ROOT/spawn-in-pane.sh" <<'SH'
#!/usr/bin/env bash
set -u
FM_HOME="$2" FM_ROOT_OVERRIDE="$1" FM_SPAWN_NO_GUARD=1 \
  "$1/bin/fm-spawn.sh" "$3" "$4" "sh -c 'echo placement-fixture-ran'" --mode no-mistakes --yolo off --backend herdr > "$5/$3.out" 2> "$5/$3.err"
rc=$?
printf '%s\n' "$rc" > "$5/$3.rc"
SH
  printf -v command '%q ' bash "$TMP_ROOT/spawn-in-pane.sh" "$ROOT" "$FM_HOME" "$2" "$3" "$TMP_ROOT"
  lab pane run "$1" "$command" >/dev/null || return 1
  for ((i=0; i<300; i++)); do
    [ ! -f "$TMP_ROOT/$2.rc" ] || break
    sleep 0.1
  done
  [ -f "$TMP_ROOT/$2.rc" ] || fail 'in-pane spawn did not finish'
  if [ "$(cat "$TMP_ROOT/$2.rc")" != 0 ]; then cat "$TMP_ROOT/$2.err" >&2; return 1; fi
  case "$(field "$2" worktree)" in
    "$TMP_ROOT/slots/"*) ;;
    *) fail 'in-pane spawn escaped scratch-clone allocator' ;;
  esac
}
