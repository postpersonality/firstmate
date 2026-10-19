# DeepSeek Harness (DSH)

The worker adapter uses the official `@deepseek-ai/dsh` ACP profile through `bin/fm-dsh-worker.mjs`.
It is separate from selecting a DeepSeek model in another harness.
The supported runtime is Linux with Herdr and official DSH 0.2.1-rc.2 or 0.1.5-rc.1; portable tmux checks cover the shared process/composer owners.
Primary, secondmate, remote, and other DSH versions are unsupported.
[Maintained verification](../../../../../docs/verification/dsh.md) owns the commands and version evidence.

## Operating facts

| Contract | Behavior |
|---|---|
| Executable | `FM_DSH_BIN` selects an existing official entrypoint; otherwise `dsh` must be on PATH. The spawn owner runs a read-only version preflight before provisioning. |
| Native configuration | The source is the existing `DSH_HOME` or `~/.dsh`. For 0.2, legacy settings and native ACP/home profile overrides are staged at 0600 in the private generation home; the native importer finishes there before ACP initialization. The credential document stays at its native source under a mutation-denying preload and is never copied. Launch arguments and the bridge overlay contain only paths and route ids. |
| Models | Firstmate passes `provider/model`; the ACP model option must advertise the selection. Omission preserves the native route. Provider/account changes require the ordinary dispatch authority; no official-provider fallback is invented. |
| Effort | The requested value is applied only when the selected model advertises it in `reasoning_effort`; otherwise it is recorded and omitted with a notice. |
| Busy | `dsh-acp` opens on an outstanding prompt and settles to `unknown` on completion/cancellation/failure. The existing generation-bound writer and classifier own the record. Prompt settlement only touches the turn-ended notification; it never declares task done. |
| Steering | The bridge renders the shared `❯` composer and serializes submitted lines. Use ordinary `fm-send`; its durable inbox and acknowledgement move remain authoritative. A real draft defers ringing. |
| Interrupt/exit | The executable control table owns Ctrl+C and `/exit`. ACP cancel is distinct from closing the session; vendor close acknowledgement and child EOF are required for normal exit. |
| Relaunch | The recorded worktree, files, and brief survive; a fresh ACP session and busy generation are created. Native transcript resume is not implemented. |
| Trust and skills | The ACP profile runs with task autonomy, including external task-channel paths. No project hook is installed. Read the skill file explicitly; slash skill commands are not implemented by this terminal bridge. |
| Identity | `bin/fm-dsh-lib.sh` requires the actual Linux Node script argument to be the bridge or the official package entrypoint. A bare `dsh` name, leaked marker, cwd, or later prompt mention cannot prove identity. |

## Limits

DSH 0.2 changes settings persistence; only the staged legacy copy may be migrated, and the native source home is never opened as its runtime home.
Versions other than 0.2.1-rc.2 and 0.1.5-rc.1 are refused.
Custom profile dependencies outside the installed official composition and relative external configuration includes have not been verified.
An existing credential provider can be usable without a model-level quota record; that uncertainty is not an authentication failure.
No default quota-provider mapping is inferred from the DSH name.
Native vendor error details are withheld because they can contain authentication headers; the bridge prints the ACP error code and exits unsuccessfully.
The bridge publishes its own `firstmate:dsh:<generation>` lifecycle source through existing Herdr `report-agent` and releases it on exit; it does not borrow another harness label.
The adapter uses one owned child process and no daemon, SDK control plane, or alternative inbox.
