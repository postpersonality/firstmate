#!/usr/bin/env bash
# Privacy-reviewed historical copy: paths and runtime identifiers are normalized; this is not a new test run. Recorded checksums refer to originals. See PRIVACY-NOTICE.md.
# Live lab driver for the completion follow-through change. Runs the real
# firstmate scripts from the gate worktree against a disposable marked lab home
# (plain FM_HOME, no FM_*_OVERRIDE, private tmux server). Only external tools
# are stubbed: treehouse (pool), no-mistakes, gh, gh-axi; plus a tmux shim that
# answers #{pane_current_path} because the sandbox PID namespace hides
# /proc/<pane-pid>/cwd from tmux. Everything else is real.
set -u
ROOT=<validation-worktree>
W="$TMPDIR/fmtest"
cd "$ROOT" || exit 1

LAB=$(mktemp -d "${TMPDIR:-/tmp}/fm-lab.XXXXXX")
"$ROOT/bin/fm-lab-home.sh" create "$LAB" >/dev/null || exit 1
mkdir -p "$LAB/tmux" "$LAB/pane-cwd"
printf '%s\n' "$LAB" > "$TMPDIR/fm-lab-path"
cp "$ROOT/.tasks.toml" "$LAB/.tasks.toml"
printf '# Backlog\n\n## In flight\n\n## Queued\n\n## Done\n' > "$LAB/data/backlog.md"
P="$LAB/projects/sample"
mkdir -p "$P"; git -C "$P" init -q -b main; echo '# sample' > "$P/README.md"
git -C "$P" add README.md; git -C "$P" -c user.name=Lab -c user.email=lab@example.invalid commit -qm initial
git clone -q --bare "$P" "$LAB/projects/sample.origin.git"
git -C "$P" remote add origin "file://$LAB/projects/sample.origin.git"; git -C "$P" fetch -q origin
for s in 1 2 3 4; do git -C "$P" worktree add -q --detach "$LAB/projects/sample-wt$s" origin/main; done
mkdir -p "$W/stubs"
for t in no-mistakes gh gh-axi; do
  printf '#!/usr/bin/env bash\nprintf "%%s %%s\\n" "%s" "$*" >> "%s/stub-calls.log"\nexit 0\n' "$t" "$LAB" > "$W/stubs/$t"
  chmod +x "$W/stubs/$t"
done
cat > "$W/stubs/treehouse" <<EOF
#!/usr/bin/env bash
printf 'treehouse %s\n' "\$*" >> "$LAB/stub-calls.log"
if [ "\${1:-}" = get ]; then
  n=\$(cat "$LAB/next-wt" 2>/dev/null || echo 1); echo \$((n + 1)) > "$LAB/next-wt"
  cd "$LAB/projects/sample-wt\$n" && pwd -P > "$LAB/pane-cwd/\$TMUX_PANE" && exec bash --norc --noprofile -i
fi
exit 0
EOF
chmod +x "$W/stubs/treehouse"

# shellcheck disable=SC1091
. "$W/lab-env.sh"
cd "$LAB" || exit 1
start_lab_tmux

FAILS=0; CHECKS=0
section() { printf '\n\n==== %s ====\n' "$1"; }
# check <ok|refuse> <label> [expected-substring] -- <cmd...>
check() {
  local want=$1 label=$2 expect='' out rc good=1
  shift 2
  if [ "$1" != -- ]; then expect=$1; shift; fi
  shift
  printf '\n$ %s\n' "$(printf '%q ' "$@" | sed "s|$ROOT/bin/|bin/|g; s|$LAB|\$LAB|g")"
  out=$("$@" 2>&1); rc=$?
  printf '%s\n' "$out" | sed "s|$LAB|\$LAB|g" | grep -v '^fm-gate-refuse: gate agent lifecycle permitted' | head -n 14
  printf '[exit %s]\n' "$rc"
  case "$want" in ok) [ "$rc" = 0 ] || good=0 ;; refuse) [ "$rc" != 0 ] || good=0 ;; esac
  if [ -n "$expect" ] && ! printf '%s' "$out" | grep -qF -- "$expect"; then good=0; fi
  CHECKS=$((CHECKS + 1))
  if [ "$good" = 1 ]; then printf 'CHECK PASS: %s\n' "$label"; else printf 'CHECK FAIL: %s\n' "$label"; FAILS=$((FAILS + 1)); fi
}
fact() {  # <label> <expected-substring> -- <cmd...>  (read-only observation)
  local label=$1 expect=$2 out
  shift 3
  printf '\n$ %s\n' "$(printf '%q ' "$@" | sed "s|$ROOT/bin/|bin/|g; s|$LAB|\$LAB|g")"
  out=$("$@" 2>&1)
  printf '%s\n' "$out" | sed "s|$LAB|\$LAB|g" | head -n 14
  CHECKS=$((CHECKS + 1))
  if printf '%s' "$out" | grep -qF -- "$expect"; then printf 'CHECK PASS: %s\n' "$label"; else printf 'CHECK FAIL: %s\n' "$label"; FAILS=$((FAILS + 1)); fi
}
absent() {  # <label> <path>
  CHECKS=$((CHECKS + 1))
  if [ ! -e "$2" ]; then printf 'CHECK PASS: %s (%s absent)\n' "$1" "${2/#$LAB/\$LAB}"; else printf 'CHECK FAIL: %s (%s exists)\n' "$1" "${2/#$LAB/\$LAB}"; FAILS=$((FAILS + 1)); fi
}
fields() {  # <task-id>: the backlog facts the gate reads
  "$ROOT/bin/fm-tasks-axi.sh" show "$1" | grep -E '^  (id|state|kind|held|hold_kind|hold_until|blocked|blocked_by):'
}
# Sandbox workaround: lsof in teardown's leaked-process reaper reports host PIDs,
# which kill(2) cannot reach from this command's PID namespace, so the worker
# pane is ended through its tty first (C-c the harness, exit the shell).
end_worker() {
  labtmux send-keys -t "firstmate:fm-$1" C-c 2>/dev/null; sleep 1
  labtmux send-keys -t "firstmate:fm-$1" exit Enter 2>/dev/null; sleep 1
  echo "(lab: ended the $1 worker pane through its tty)"
}
pane_fg() {
  local tty; tty=$(labtmux display-message -p -t "firstmate:fm-$1" '#{pane_tty}' 2>/dev/null) || return 0
  ps -t "${tty#/dev/}" -o pgid=,tpgid=,comm=,args= 2>/dev/null | sed 's/^/  pane: /'
}
TA="$ROOT/bin/fm-tasks-axi.sh"; CH="$ROOT/bin/fm-captain-hold.sh"; TD="$ROOT/bin/fm-teardown.sh"; SP="$ROOT/bin/fm-spawn.sh"
brief() {  # <id> <kind-args...>
  "$ROOT/bin/fm-brief.sh" "$1" sample "${@:2}" >/dev/null
  python3 -I - "$LAB/data/$1/brief.md" <<'PY'
import sys
p = sys.argv[1]; t = open(p).read()
t = t.replace("{TASK}", "Deliver a working evaluator for the labelled sample corpus.")
t = t.replace("{FIRSTMATE_SPEC}", "Lab fixture: the worker pane runs a placeholder command instead of an agent.")
open(p, "w").write(t)
PY
}

section "S0 setup: real spawn of automatic-backlog scouts and a ship in the lab home"
for id in corpus-scout gate-scout promo-scout; do "$TA" add "$id" "Working evaluator milestone ($id)" --kind scout >/dev/null; brief "$id" --scout; done
"$TA" add collect-ship "Bounded collection ship" --kind ship >/dev/null; brief collect-ship --mode local-only
for id in corpus-scout gate-scout promo-scout; do
  check ok "fm-spawn launches scout $id" "spawned $id" -- timeout 170 "$SP" "$id" "$P" --scout --harness "sleep 900"
done
check ok "fm-spawn launches ship collect-ship" "spawned collect-ship" -- timeout 170 "$SP" collect-ship "$P" --mode local-only --yolo off --harness "sleep 900"
for id in corpus-scout collect-ship; do
  fact "spawn recorded completion_required=1 for $id" "completion_required=1" -- grep -E '^(kind|spawn_gen|completion_required)=' "$LAB/state/$id.meta"
done
fact "spawned rows are In flight" "state: in_flight" -- fields corpus-scout
labtmux list-windows -t firstmate -F '#{window_name}' | sed 's/^/window: /'

section "S1 milestone-only acceptance is refused (saved corpus + plan is not the working evaluator)"
printf '# Saved labelled corpus and calibration plan\n\nImplementation is a possible next step.\n' > "$LAB/data/corpus-scout/report.md"
echo "done [at=$(date +%s)]: corpus saved, calibration plan written" >> "$LAB/state/corpus-scout.status"
check refuse "captain-call-only complete is refused" "review the requested outcome" -- "$CH" complete corpus-scout --none
check refuse "unforced teardown refuses the unreviewed milestone" "outcome and captain-call completion gate" -- "$TD" corpus-scout
check refuse "done refuses before review" "must pass its outcome review" -- "$TA" done corpus-scout
check refuse "done with value flags before the id refuses" "must pass its outcome review" -- "$TA" done --keep 0 --note "flags first" corpus-scout
check refuse "task-noun done refuses" "must pass its outcome review" -- "$TA" task done --note "noun first" corpus-scout
check refuse "close with --report before the id refuses" "must pass its outcome review" -- "$TA" close --report data/corpus-scout/report.md corpus-scout
fact "refusals left the origin In flight" "state: in_flight" -- fields corpus-scout
CHECKS=$((CHECKS + 1)); if [ -f "$LAB/state/corpus-scout.meta" ] && [ -d "$LAB/projects/sample-wt1" ]; then echo "CHECK PASS: refusals kept task record and worktree"; else echo "CHECK FAIL: refusals lost source state"; FAILS=$((FAILS + 1)); fi

section "S2 remaining executable work is filed as an ordinary task and survives cleanup"
"$TA" add corpus-implement "Implement and assess the authorized evaluator on the labelled corpus" --kind ship >/dev/null
check refuse "a missing remaining task is refused" "absent or unreadable" -- "$CH" complete corpus-scout --none --remaining corpus-missing
check refuse "the origin cannot vouch for itself" "cannot be its own remaining work" -- "$CH" complete corpus-scout --none --remaining corpus-scout
check ok "complete --remaining corpus-implement is accepted" -- "$CH" complete corpus-scout --none --remaining corpus-implement
fact "the reference and seal are recorded on the origin" "completion_work=worker:corpus-implement" -- grep -E '^completion_(work|reviewed)=' "$LAB/state/corpus-scout.meta"
check ok "verify passes" -- "$CH" verify corpus-scout
end_worker corpus-scout
check ok "unforced teardown now proceeds" -- "$TD" corpus-scout
fact "origin closed Done" "state: done" -- fields corpus-scout
fact "remaining work is still queued and visible to ready" "corpus-implement" -- "$TA" ready
fact "remaining work stays queued" "state: queued" -- fields corpus-implement
absent "teardown removed the origin task record" "$LAB/state/corpus-scout.meta"

section "S3 a prepared firstmate-owned action must be handled, not parked for firstmate's own next move"
"$TA" add collect-run "Run the verified bounded collection command" >/dev/null
check refuse "a ready firstmate action blocks acceptance" "firstmate action collect-run is actionable now" -- "$CH" complete collect-ship --none --firstmate-action collect-run
fact "the refused handoff kept its owner on the row" "kind: firstmate" -- fields collect-run
fact "the refused handoff kept its reference on the origin" "completion_work=firstmate:collect-run" -- grep -E '^completion_work=' "$LAB/state/collect-ship.meta"
check refuse "--fulfilled cannot erase the outstanding action" "still owes remaining task collect-run" -- "$CH" complete collect-ship --none --fulfilled
check refuse "ship teardown refuses while the action is owed" "outcome and captain-call completion gate" -- "$TD" collect-ship
before=$(md5sum < "$LAB/data/backlog.md")
check refuse "undated future wait cannot hide the action" "firstmate action collect-run needs a real captain, external, date or dependency gate" -- "$TA" hold collect-run --kind future --reason "my own next step later"
check refuse "flags-first parked wait cannot hide the action" "firstmate action collect-run" -- "$TA" hold --kind parked --reason "my own next step later" collect-run
check refuse "task-noun load wait cannot hide the action" "firstmate action collect-run" -- "$TA" task hold --reason "my own next step later" --kind load collect-run
check refuse "an untyped hold cannot hide the action" "firstmate action collect-run" -- "$TA" hold collect-run --reason "later"
CHECKS=$((CHECKS + 1)); if [ "$before" = "$(md5sum < "$LAB/data/backlog.md")" ]; then echo "CHECK PASS: refused holds left the backlog byte-identical"; else echo "CHECK FAIL: a refused hold changed the backlog"; FAILS=$((FAILS + 1)); fi
brief collect-run --mode local-only
windows_before=$(labtmux list-windows -t firstmate -F '#{window_name}' | sort | tr '\n' ' ')
check refuse "a firstmate row is never dispatched to a worker" "backlog item collect-run is a firstmate row, which is never handed to a worker" -- timeout 170 "$SP" collect-run "$P" --mode local-only --yolo off --harness "sleep 900"
absent "dispatch refusal published no task record" "$LAB/state/collect-run.meta"
CHECKS=$((CHECKS + 1)); if [ "$windows_before" = "$(labtmux list-windows -t firstmate -F '#{window_name}' | sort | tr '\n' ' ')" ]; then echo "CHECK PASS: dispatch refusal created no endpoint ($windows_before)"; else echo "CHECK FAIL: dispatch refusal created an endpoint"; FAILS=$((FAILS + 1)); fi
"$TA" start collect-run >/dev/null
check refuse "marking the action In flight is not handling it" "firstmate action collect-run is actionable now" -- "$CH" complete collect-ship --none --firstmate-action collect-run
printf 'collected 3 bounded samples\n' > "$LAB/data/collect-ship/collection.txt"
check ok "firstmate performs the action and closes its row" -- "$TA" done collect-run
check ok "handled action clears the gate" -- "$CH" complete collect-ship --none --firstmate-action collect-run
meta_before=$(cat "$LAB/state/collect-ship.meta")
check ok "replaying complete converges" -- "$CH" complete collect-ship --none --firstmate-action collect-run
CHECKS=$((CHECKS + 1)); if [ "$meta_before" = "$(cat "$LAB/state/collect-ship.meta")" ]; then echo "CHECK PASS: replay did not rewrite metadata"; else echo "CHECK FAIL: replay rewrote metadata"; FAILS=$((FAILS + 1)); fi
check ok "verify passes after the action is Done" -- "$CH" verify collect-ship
end_worker collect-ship
check ok "unforced ship teardown proceeds past the outcome gate" -- "$TD" collect-ship
fact "ship origin closed Done" "state: done" -- fields collect-ship

section "S4 genuine gates stay valid; an origin-only blocker and a cleared gate do not"
for k in captain external dated running dependency other after; do "$TA" add "gate-$k" "Continuation $k" >/dev/null; done
check ok "captain hold for an explicit stop" -- "$CH" hold gate-captain --reason "Explicit user stop: do not collect until told"
check ok "external hold for an executing job" -- "$TA" hold gate-external --kind external --reason "Executing job completion receipt"
check ok "dated hold" -- "$TA" hold gate-dated --kind future --until 2099-01-01 --reason "External release window"
"$TA" start gate-running >/dev/null
"$TA" block gate-dependency --by gate-running >/dev/null
check ok "real captain/external/date/dependency gates and running worker work are accepted" -- "$CH" complete gate-scout --none --firstmate-action gate-captain --firstmate-action gate-external --firstmate-action gate-dated --firstmate-action gate-dependency --remaining gate-running
check ok "verify passes with real gates" -- "$CH" verify gate-scout
"$TA" unhold gate-external >/dev/null
check refuse "a cleared external condition makes the action owed again" "firstmate action gate-external is actionable now" -- "$CH" verify gate-scout
check refuse "the cleared action cannot be parked behind an undated wait" "firstmate action gate-external" -- "$TA" hold gate-external --kind future --reason "later"
check ok "the action can be re-held behind a real external condition" -- "$TA" hold gate-external --kind external --reason "Second job completion receipt"
check ok "verify passes again" -- "$CH" verify gate-scout
"$TA" block gate-after --by gate-scout >/dev/null
fact "gate-after is blocked only by its origin" "blocked_by: gate-scout" -- fields gate-after
check refuse "an origin-only blocker is not a dependency gate" "firstmate action gate-after is actionable now" -- "$CH" complete gate-scout --none --firstmate-action gate-after
"$TA" block gate-after --by gate-other >/dev/null
check ok "an independent active blocker is a real dependency gate" -- "$CH" complete gate-scout --none --firstmate-action gate-after
"$TA" done gate-other >/dev/null
check refuse "once the independent blocker is Done the origin cannot vouch" "firstmate action gate-after is actionable now" -- "$CH" verify gate-scout
printf '# Gate scout report\n' > "$LAB/data/gate-scout/report.md"
check refuse "teardown refuses the origin that would unblock its own owed action" "outcome and captain-call completion gate" -- "$TD" gate-scout
check refuse "conflicting owners for one task are refused" "conflicting owners" -- "$CH" complete gate-scout --none --remaining gate-after

section "S5 scout promotion invalidates the outcome attestation"
check ok "explicit archive-only deliverable can be declared fulfilled" -- "$CH" complete promo-scout --none --fulfilled
check ok "verify passes for the scout" -- "$CH" verify promo-scout
check ok "promote the scout to a ship" -- "$ROOT/bin/fm-promote.sh" promo-scout --mode local-only --yolo off
check refuse "the promoted ship needs a fresh outcome review" "no outcome review for this worker incarnation" -- "$CH" verify promo-scout
check ok "fresh review for the promoted ship" -- "$CH" complete promo-scout --none --fulfilled
check ok "verify passes after re-review" -- "$CH" verify promo-scout

section "S6 an older in-flight ship record keeps compatibility"
"$TA" add legacy-ship "Pre-change in-flight ship" --kind ship >/dev/null
"$TA" start legacy-ship >/dev/null
grep -vE '^(completion_|decision|decisions_)' "$LAB/state/promo-scout.meta" | sed 's/^kind=.*/kind=ship/' > "$LAB/state/legacy-ship.meta"
echo "(emulated pre-change record: a copy of a spawned meta without completion_required)"
check ok "captain-call-only complete still works without completion_required" -- "$CH" complete legacy-ship --none
check ok "done is not blocked for a record without completion_required" -- "$TA" done legacy-ship

section "S7 branch supervision prompt routes landed cleanup through the outcome review"
"$ROOT/bin/fm-branch-prompt.sh" > "$LAB/branch-prompt.txt"
fact "branch prompt names the outcome review before teardown" "record it with \`bin/fm-captain-hold.sh complete <task>\`, and then run \`bin/fm-teardown.sh <task>\` with no flags" -- grep -F 'perform the outcome review' "$LAB/branch-prompt.txt"
fact "branch prompt keeps role limits on owed work" "owed work it finds beyond them is reported with verdict captain" -- grep -F 'Your role limits and posture still bound that review' "$LAB/branch-prompt.txt"

section "S8 relaunch invalidates the outcome attestation (best effort in this sandbox)"
gen_before=$(grep -E '^spawn_gen=' "$LAB/state/promo-scout.meta")
echo "before: $gen_before"; pane_fg promo-scout
labtmux send-keys -t firstmate:fm-promo-scout C-c 2>/dev/null; sleep 2
echo "after C-c:"; pane_fg promo-scout
check ok "fm-spawn --relaunch replaces the promoted worker" -- timeout 170 "$SP" promo-scout --relaunch --harness "sleep 900"
gen_after=$(grep -E '^spawn_gen=' "$LAB/state/promo-scout.meta")
echo "after: $gen_after"
CHECKS=$((CHECKS + 1)); if [ "$gen_before" != "$gen_after" ]; then echo "CHECK PASS: relaunch recorded a new spawn_gen"; else echo "CHECK FAIL: spawn_gen unchanged"; FAILS=$((FAILS + 1)); fi
check refuse "verify after relaunch requires a fresh review" "no outcome review for this worker incarnation" -- "$CH" verify promo-scout

section "external-tool stub calls"
sed "s|$LAB|\$LAB|g" "$LAB/stub-calls.log" 2>/dev/null

section "summary"
printf 'checks=%s failed=%s\n' "$CHECKS" "$FAILS"
labtmux kill-server 2>/dev/null
