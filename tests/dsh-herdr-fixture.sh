#!/usr/bin/env bash
# Shared real Herdr worker-test setup; no global auth/config or shared pool.
# Caller sources tests/lib.sh and selects its own live/model gate first.
# shellcheck source=tests/herdr-test-safety.sh
. "$ROOT/tests/herdr-test-safety.sh"
herdr_forget_inherited_pane
ORIGINAL_PATH=$PATH
LAB_HELPER=${HERDR_LAB_HELPER:-$ROOT/bin/fm-herdr-lab.sh}
SESSION=$("$LAB_HELPER" name dsh-worker)
LAB=$(fm_test_tmproot fm-dsh-live)
ID=dsh-live-$$
export FM_HOME="$LAB/home"
"$ROOT/bin/fm-lab-home.sh" create "$FM_HOME" >/dev/null
mkdir -p "$LAB/fakebin" "$FM_HOME/data/$ID" "$FM_HOME/state/$ID.inbox/handled"
cleanup() {
  local rc=$?
  trap - EXIT
  [ "$rc" = 0 ] || printf 'not ok - DSH test phase: %s\n' "${DSH_TEST_PHASE:-setup/lifecycle}" >&2
  if [ -n "${FM_DSH_LIVE_EVIDENCE:-}" ]; then
    mkdir -p "$FM_DSH_LIVE_EVIDENCE"
    cp "$LAB/shim.log" "$LAB/spawn.out" "$LAB/spawn.err" "$LAB/exit.out" "$LAB/exit.err" "$LAB/interrupt.out" "$LAB/interrupt.err" "$FM_DSH_LIVE_EVIDENCE/" 2>/dev/null || true
    if [ -f "$LAB/pane" ]; then
      env PATH="$ORIGINAL_PATH" "$LAB_HELPER" run "$SESSION" pane read "$(cat "$LAB/pane")" --source recent --lines 80 > "$FM_DSH_LIVE_EVIDENCE/viewport.txt" 2>&1 || true
    fi
  fi
  env PATH="$ORIGINAL_PATH" "$LAB_HELPER" teardown "$SESSION" || rc=1
  "$ROOT/bin/fm-lab-home.sh" teardown "$FM_HOME" || rc=1
  for temp_path in "/tmp/fm-$ID" "/tmp/fm-$ID+"*; do
    [ ! -d "$temp_path" ] || fm_test_remove_tree "$temp_path"
  done
  fm_test_cleanup
  exit "$rc"
}
trap cleanup EXIT
export DSH_LAB_HELPER="$LAB_HELPER" DSH_LAB_SESSION="$SESSION" DSH_LAB_PATH="$ORIGINAL_PATH" DSH_LAB_ROOT="$LAB"
# Substitute only the test provider handoff, never call the shared pool.
cat > "$LAB/fakebin/treehouse" <<'SH'
#!/usr/bin/env bash
set -eu
[ "${1:-}" = get ] || exit 0
cd "${BASH_SOURCE[0]%/*}/../worktree"
exec bash --noprofile --norc
SH
{
  printf '#!/usr/bin/env bash\nset -eu\n'
  printf 'DSH_LAB_HELPER=%q\nDSH_LAB_SESSION=%q\nDSH_LAB_PATH=%q\nDSH_LAB_ROOT=%q\n' "$LAB_HELPER" "$SESSION" "$ORIGINAL_PATH" "$LAB"
  cat <<'SH'
printf '%q ' "$0" "$@" >> "$DSH_LAB_ROOT/shim.log"
printf '\n' >> "$DSH_LAB_ROOT/shim.log"
if [ "${1:-} ${2:-}" = 'pane run' ]; then printf '%s\n' "$3" > "$DSH_LAB_ROOT/pane"; fi
args=("$@")
n=${#args[@]}
if [ "$n" -ge 2 ] && [ "${args[n-2]}" = --session ]; then
  [ "${args[n-1]}" = "$DSH_LAB_SESSION" ] || exit 97
  args=("${args[@]:0:n-2}")
fi
for ((i=0;i<${#args[@]};i++)); do
  case "${args[i]}" in --session|--session=*) exit 98 ;; esac
  if [ "${args[i]}" = 'treehouse get' ]; then
    args[i]="/usr/bin/env '$DSH_LAB_ROOT/fakebin/treehouse' get"
  fi
done
exec env PATH="$DSH_LAB_PATH" "$DSH_LAB_HELPER" run "$DSH_LAB_SESSION" "${args[@]}"
SH
} > "$LAB/fakebin/herdr"
chmod +x "$LAB/fakebin/"*
git init -q -b main "$LAB/project"
printf '# DSH runtime fixture\n' > "$LAB/project/README.md"
git -C "$LAB/project" add README.md
git -C "$LAB/project" -c user.name=Tests -c user.email=tests@example.invalid commit -qm initial
git clone -q "$LAB/project" "$LAB/worktree"
printf 'off\n' > "$FM_HOME/config/herdr-presentation-spaces"
printf 'manual\n' > "$FM_HOME/config/backlog-backend"
