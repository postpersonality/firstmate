# DeepSeek Harness (DSH)

The worker adapter uses the official `@deepseek-ai/dsh` ACP profile through `bin/fm-dsh-worker.mjs`.
It is separate from selecting a DeepSeek model in another harness.
The supported runtime is Linux, DSH 0.1.5-rc.1, and the Herdr backend; portable tmux checks cover the shared process/composer owners.
Primary, secondmate, remote, and other DSH versions are unsupported.
[Maintained verification](../../../../../docs/verification/dsh.md) owns the commands and version evidence.

## Operating facts

| Contract | Behavior |
|---|---|
| Executable | `FM_DSH_BIN` selects an existing official entrypoint; otherwise `dsh` must be on PATH. The spawn owner runs a read-only version preflight before provisioning. |
| Native configuration | The existing `DSH_HOME` or `~/.dsh` settings and credentials are read by native providers under a mutation-denying preload. The ACP runtime home is private to the task generation. No auth value is copied into the launch command or patch. |
| Models | Firstmate passes `provider/model`; the ACP model option must advertise the selection. Omission preserves the native route. Provider/account changes require the ordinary dispatch authority; no official-provider fallback is invented. |
| Effort | The requested value is applied only when the selected model advertises it in `reasoning_effort`; otherwise it is recorded and omitted with a notice. |
| Busy | `dsh-acp` opens on an outstanding prompt and settles to `unknown` on completion/cancellation/failure. The existing generation-bound writer and classifier own the record. Prompt settlement only touches the turn-ended notification; it never declares task done. |
| Steering | The bridge renders the shared `❯` composer and serializes submitted lines. Use ordinary `fm-send`; its durable inbox and acknowledgement move remain authoritative. A real draft defers ringing. |
| Interrupt/exit | The executable control table owns Ctrl+C and `/exit`. ACP cancel is distinct from closing the session; vendor close acknowledgement and child EOF are required for normal exit. |
| Relaunch | The recorded worktree, files, and brief survive; a fresh ACP session and busy generation are created. Native transcript resume is not implemented. |
| Trust and skills | The ACP profile runs with task autonomy, including external task-channel paths. No project hook is installed. Read the skill file explicitly; slash skill commands are not implemented by this terminal bridge. |
| Identity | `bin/fm-dsh-lib.sh` requires the actual Linux Node script argument to be the bridge or the official package entrypoint. A bare `dsh` name, leaked marker, cwd, or later prompt mention cannot prove identity. |

## Limits

DSH 0.2 changes settings persistence and may migrate an existing 0.1 home.
The version preflight refuses it rather than modifying that home.
An existing credential provider can be usable without a model-level quota record; that uncertainty is not an authentication failure.
No default quota-provider mapping is inferred from the DSH name.
Native vendor error details are withheld because they can contain authentication headers; the bridge prints the ACP error code and exits unsuccessfully.
The bridge publishes its own `firstmate:dsh:<generation>` lifecycle source through existing Herdr `report-agent` and releases it on exit; it does not borrow another harness label.
The adapter uses one owned child process and no daemon, SDK control plane, or alternative inbox.
