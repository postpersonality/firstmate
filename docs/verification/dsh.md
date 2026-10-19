# DeepSeek Harness worker verification

Verified on 2026-10-19 with the official `@deepseek-ai/dsh` package version `0.2.1-rc.2`, Node `24.18.0`, Linux, and Herdr.
This adapter runs DeepSeek Harness itself through ACP; a model supplied by a different provider can still be used inside that harness.
The [adapter reference](../../.agents/skills/harness-adapters/references/harness/dsh.md) owns operating facts and supported limits, and [configuration](../configuration.md#deepseek-harness-workers) owns setup.
The upstream [repository](https://github.com/deepseek-ai/deepseek-harness) and [ACP implementation](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.2/packages/acp/acp) are the primary protocol references; the installed 0.1.5 package was also inspected directly to preserve compatibility with its different settings behavior.

## Verification entry points

```sh
bin/fm-test-run.sh --jobs 1 \
  tests/fm-dsh-worker.test.sh tests/fm-dsh-process.test.sh \
  tests/fm-dsh-harness.test.sh tests/fm-dsh-tmux-terminal.test.sh \
  tests/fm-dsh-herdr-terminal.test.sh tests/fm-dsh-spawn-lifecycle.test.sh
```

The deterministic ACP peer exercises transport and terminal behavior without a model or user credentials.
It does not substitute for the opt-in vendor guard:

```sh
FM_DSH_LIVE_E2E=1 \
FM_DSH_BIN=/absolute/path/to/installed/dsh \
FM_DSH_LIVE_MODEL=provider/model \
bin/fm-test-run.sh --jobs 1 tests/fm-dsh-live-e2e.test.sh
```

Use a route already present in the native DSH catalogue and existing authentication.
The test uses a marked temporary Firstmate home and a helper-owned Herdr lab, with an isolated repository fixture instead of the shared worktree pool.
Every Herdr operation, including reports from the bridge, passes through `fm-herdr-lab.sh`; teardown checks its default-session tripwire.
The test does not install a package, provision an account, or change user configuration.

## Recorded results

The six adapter regressions completed on 2026-10-19 without a gate skip:

```text
FM_TEST_SUMMARY total=6 failed=0 skipped_gate=0 duration_ms=36974
```

The native guard used the existing corporate `litellm/gpt-6-luna` route inside DSH 0.2.1-rc.2, with the installed official entrypoint selected by `FM_DSH_BIN`:

```text
ok - real DSH canonical supervised launch, cwd, model tool and Herdr liveness/composer
ok - real DSH fm-send durable inbox delivery and acknowledgement
ok - real DSH draft deferral, steering during busy, control cancellation and owned tool termination
ok - real DSH session close and EOF leave the pane shell alive
ok - real DSH fresh-generation relaunch repeats model tools, preserves dirty work and leaves native store metadata unchanged
FM_TEST_SUMMARY total=1 failed=0 skipped_gate=0 duration_ms=69954
```

These results establish the compatibility boundary below; they do not verify another DSH version, provider route, primary role, or backend.

## Guarantees exercised

| Surface | Evidence |
|---|---|
| ACP launch and discovery | Native 0.2 initialize/new, correct cwd, advertised corporate model selection, refreshed reasoning options, real bash result `80235`. |
| Native configuration | Legacy settings migrate only inside the private runtime home after native profile overrides are staged. A delayed-import regression requires the bridge to wait before initialize; the credential provider refuses source-store writes. The real guard compares source file metadata before launch and after relaunch. |
| External task paths | Native model read/wrote task files and read/actioned a steering inbox outside the worktree, acknowledging by moving the message to `handled/`. |
| Supervised delivery | Canonical `fm-spawn` establishes generation-bound readiness and process liveness; ordinary `fm-send` uses the existing durable inbox, including draft deferral and a steer delivered during a running tool. |
| Busy | The fixture opens an actual pending ACP request and checks `busy dsh-acp`; completion/cancellation yields `unknown dsh-acp`, never task completion. Retired-generation writes and submissions are refused. |
| Composer | Real Herdr and tmux PTYs prove empty and draft states; a typed draft survives asynchronous output and Escape cancellation. |
| Lifecycle | The fixture runs actual `fm-control` interrupt, exit, relaunch and crash recovery against real Herdr, checking a fresh generation and preserved dirty files. The native guard repeats actual model tools after relaunch and preserves its dirty sentinel. Native `fm-control` cancellation and direct ACP cancellation also terminated an executing sleeping bash process and accepted the next prompt. |
| Process identity | Real Node processes with spaces in their script paths identify correctly; a later cwd/prompt mention, `node -e`, a foreign script, and distributed shell `dsh` do not identify. |
| Error boundaries | Child death and vendor RPC errors fail the worker; vendor error messages are not copied to diagnostics. Session close/EOF is bounded, with TERM/KILL restricted to the owned child group on failure. |

The interrupt key is Ctrl+C: readline holds a lone Escape while looking for a Meta sequence, and an immediate `/exit` can otherwise arrive as `exit`.
The real Herdr terminal regression reproduces that failure and requires the Ctrl+C counterfactual to preserve the slash.
Manual Escape remains available for cancellation, but lifecycle automation uses the executable control table.
Herdr receives a custom `firstmate:dsh:<generation>` authority and the actual `dsh` label, and that authority is released after the ACP child closes.
No native Herdr detection manifest, backend, global hook, or user setting is installed.

## Compatibility boundary

Canonical dispatch is limited to local Linux Herdr crewmates/scouts and official DSH `0.2.1-rc.2` or `0.1.5-rc.1`.
The current native result above is 0.2; the 2026-10-19 native 0.1.5 result remains `FM_TEST_SUMMARY total=1 failed=0 skipped_gate=0 duration_ms=43588`, and the portable protocol regression retains both versions.
The tmux tests cover the shared PTY/process owners; canonical tmux DSH dispatch is refused.
Primary, secondmate, remote, and native transcript resume are unsupported.
Relaunch preserves the recorded worktree and instructions and starts a fresh ACP session.
DSH `0.2.1-rc.2` changes settings persistence and can rename a legacy settings file.
The bridge stages only settings and profile overrides at 0600 in its private home, waits for that native import to complete, and never copies the credential document or starts the runtime in the source home.
Custom profile dependencies outside the installed official composition and relative external configuration includes are unverified.
Re-verify the readonly providers, import ordering, protocol fixtures, native model/auth path, and both terminal/control guards before widening this version boundary.
Native ACP keeps a configured current model in its options even if provider enumeration is unavailable; an advertised option is a native selection surface, not proof of authentication or quota.
Unadvertised explicit selections are refused, and an unsupported effort is recorded and omitted without changing the provider or inventing a quota mapping.

Native bash `run_in_background` jobs have a separate job-cancellation contract; the foreground cancellation guard explicitly sets `run_in_background=false` and `timeoutMs=60000`.
An unread durable steer can be read again after interruption until its acknowledgement move; cancellation never fabricates that acknowledgement.
The live guard therefore acknowledges a short draft-steer before starting its separate cancellable foreground-tool probe.
