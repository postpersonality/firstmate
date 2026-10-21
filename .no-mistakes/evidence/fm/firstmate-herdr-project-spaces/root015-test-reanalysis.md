# Test reanalysis of Root015 host-transport evidence (run 01M5DT0T26N5HWGKHN66HD74J6)

Native Test owner, evidence-only. No lab, suite, code or sandbox change was made in this pass.

## Why host transport
The native Bash sandbox mounts ~/.config read-only over the writable ~/.config/herdr bind, so
`fm-herdr-lab.sh provision` fails with EROFS (see `herdr-lab-sandbox-blocker.md`, preserved).
The user selected the existing Codex task worker as host execution transport for this same Test owner.

## Independent checks by the Test owner
- Worktree HEAD is `a5dcdb5ff08d8070a4a475faa05d925c563201b2`, equal to the recorded HEAD.
- `root015-source-hashes.json` has 708 entries (704 files, 4 symlinks). They equal `git ls-files` at this
  worktree one for one, and every file sha256 matches the current bytes. 0 mismatches, 0 missing.
- The absolute helper `/home/nikolayseliverstov/Projects/firstmate/bin/fm-herdr-lab.sh` hashes to
  `e862f079...f317`, identical to this worktree's `bin/fm-herdr-lab.sh`.
- The sha256 of every suite stdout, stderr and trace equals the value recorded in `root015-host-results.json`.
  Every `.exit` file reads `0`.
- The traces show `fm-spawn.sh` invoked from this worktree path, and real Herdr JSON replies
  (`cli:workspace:create`, pane and tab ids) obtained through `tests/herdr-project-fixture.sh`.
  Its fakebin `herdr` drops a matching `--session` and execs `fm-herdr-lab.sh run <lab session>`.
  A mismatched session exits 90.
- Cleanup: `tests/herdr-project-fixture.sh` sets `status=1` if guarded teardown fails, and teardown fails
  if the default-session tripwire record changed. Each cleanup trace ends in `exit 0`, and the suites exit 0.
- After the runs `/tmp/fm-herdr-lab-1000/` has no tripwire records, and `~/.config/herdr/sessions/` has no
  `fm-lab-*` directories.

## Scenario -> suite result (all exit 0, no skips, 1 attempt each)
| Scenario | Suite | ok line(s) |
|---|---|---|
| Worker spawned from an unrelated launcher/focused Space lands in the existing project Space; existing panes survive | 2 | pane-bound worker reuses project Space despite unrelated launcher and focus; existing panes survive |
| Detached caller gets a separate worker tab in the same project Space | 2 | detached caller uses the same project Space and a separate worker tab |
| Absent project Space created once across concurrent homes, then reused | 2 | absent project Space is created once across concurrent homes, then reused by public spawn |
| Firstmate exception: home, projects/firstmate copy and source share one project Space, separate tabs, management Space and source checkout preserved | 2 | repeat home, projects/firstmate copy and source spawns share one project Space with separate tabs; management and source checkout are preserved |
| Adversarial: live endpoint recorded in another Space refuses before any tab or .meta change | 2 | live endpoint recorded in another Space refuses fresh spawn before any tab or record change |
| Adversarial: duplicate path-identified / unknown same-name Spaces refuse, not focus-chosen, preserved | 2 | multiple path-identified project Spaces refuse without choosing the focused one; ambiguous same-name Spaces are preserved and reported |
| Own-husk recovery only; other home's same-name endpoint kept; teardown closes only its endpoint | 2 | public spawn replaces only its own exactly recorded shell husk; shared project Space preserves another home same-name task endpoint; teardown closes only its recorded fixture endpoint; other workers and orchestration survive |
| Legacy transition: own projection and mixed old container passed over; legacy recovery/cleanup keep parent, focus, project worker | 4 | exact owned legacy projection reclaims only its saved husk and preserves parent and focus; same-project transition excludes exact own projection and mixed old container, creates/reuses project Space without moving old workers; legacy exact-pane cleanup preserves project worker and orchestration parent |
| Persistent secondmate keeps its home Space; workers share the project Space; per-home recovery and teardown | 3 | four ok lines in root015-suite-3.stdout |
| Retired `config/herdr-presentation-spaces` is no longer pushed to secondmates | native, earlier in this run | `config-push-retired-setting.log`: target unchanged (exit 0); base pushed it |

Offline matrix (suite 1, `tests/fm-backend-herdr.test.sh`): exit 0, 209 ok lines. It is supporting evidence only and does not count as live.

Excerpts: `root015-host-transport/excerpt-cross-space-live-endpoint-refusal.trace` and
`root015-host-transport/excerpt-firstmate-exception.trace`. Full raw files are in `root015-host-transport/`.
