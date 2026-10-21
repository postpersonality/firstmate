<!-- Privacy-reviewed historical copy: paths and runtime identifiers are normalized; this is not a new test run. Recorded checksums refer to originals. See PRIVACY-NOTICE.md. -->

# Test-phase notes (run <run-1>)

## What was driven

- `lab-transcript.txt` records the final live run of `lab-driver/drive.sh`: 74 checks, 71 passed, and 3 failed, all of them S8.
- The real firstmate scripts from the gate worktree (`bin/fm-spawn.sh`, `fm-captain-hold.sh`, `fm-tasks-axi.sh` over the real tasks-axi, `fm-teardown.sh`, `fm-promote.sh`, `fm-branch-prompt.sh`) ran against a disposable lab home.
  - It was created with `bin/fm-lab-home.sh create` under `$TMPDIR` and carried the `.fm-lab-home` marker.
  - It used plain `FM_HOME`, with no `FM_*_OVERRIDE`.
  - Workers ran on a private tmux server (`-L fm-lab`).
- Stubbed externals: `treehouse` (pool get/return over 4 local git worktrees), `no-mistakes`, `gh`, and `gh-axi`. Their calls are logged at the end of the transcript.
- Worker harness: `sleep 900`. No agent ran.

## Sandbox limitations

Each Bash command runs in its own PID namespace, but `/proc` is the host's.

- A probe showed `$$` = 84 resolving `/proc/84/comm` to the host process `idle_inject/11`.
- A probe child with namespace PID 65 was reported by `lsof` as host PID 1201717.

Consequences:

1. tmux cannot read pane cwd. `lab-driver/tmux-shim.sh` answers `#{pane_current_path}` from a file that the treehouse stub writes. Every other tmux call goes to the real tmux.
2. Teardown's leaked-process reaper gets host PIDs from `lsof` and cannot `kill(2)` them from inside the namespace.
   - In the first run, teardown of `corpus-scout` and `collect-ship` passed the outcome gate and then refused at "leaked worktree processes ... remain after 3 reap attempts".
   - The final run ends each worker pane through its tty first (`end_worker`: C-c, then `exit`). Both teardowns then completed and closed their rows.
3. `ps -t <pane tty>` returns no rows, so the tmux agent-state classifier reads the endpoint as `ambiguous`. `fm-spawn.sh --relaunch` refused before changing anything, which is correct fail-closed behavior.
   - This means the S8 relaunch scenario cannot be driven live here, and its 3 failed checks are this refusal.
   - The `spawn_gen` stayed unchanged and `verify` still passed because no new incarnation was created.
4. `tests/lib.sh` stops at `fm_test_pid_identity "$$"` for the same PID mismatch. `targeted-tests.txt` therefore shows harness bootstrap failures, not product results. The automated tests could not run in this sandbox.

## Driver corrections between runs

- S4: gate-scout teardown originally refused at the earlier scout-report check because no report had been written. The final run writes the report first, and the completion gate then refuses.
- S7: the first grep read the paragraph after the one that holds the outcome-review sentence. The final run greps the sentence itself.
- S8: switched to the promoted `promo-scout`, so the verify after relaunch is not confounded by the gate-after state. It also compares spawn_gen before and after.

## Incident

During a PID-namespace probe I ran `rm -rf "$TMPDIR/probe"`. That path already held a pre-existing directory `fm/` dated 2026-10-14 with 2 subentries; it was not created in this run, and its contents were not inspected before deletion. It was in the session scratch area `/tmp/claude-1000`, not in the worktree or any FM_HOME.
