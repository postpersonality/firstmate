# Migrating Herdr support to Herdr Core and Herdr App

Firstmate drove two different products under the name "Herdr":

- the `herdr` multiplexer ([`herdr-backend.md`](herdr-backend.md)), whose panes, agent registry, presentation journal, and project groups this repository built support for over many releases, and
- Herdr Core, the terminal core under Herdr App ([`hc-backend.md`](hc-backend.md)), reached only through the `hc` CLI.

They share no socket, no id space, and no command: an `hc` terminal such as `default:t12` is not addressable by the old `herdr` CLI at all, which is why a live Core session and an old-Herdr session list look like two unrelated worlds.
This page owns the migration map between them: what already moved, what stays behind on purpose, and the exact steps for pointing one home at Core.

`hc-backend.md` remains the owner of Core operator setup and supported limits.
[`herdr-backend.md`](herdr-backend.md) remains the owner of the multiplexer path, which is now the legacy one: it keeps working, and it is limited to reading and finishing records that were created on it.

## Capability map

Every row names where the capability lived, where it lives now, and what proves it.
`migrated` means the Core path exists and is exercised by a test named in the last column.
The lab's teardown proof compares the real core's state by content, and for its terminal inventory it normalises only that inventory's own activity fields (turn/news/status timestamp, a working/idle/done word, and a leading spinner in a title); terminal identity, membership, processes, labels, real names and every unknown field still have to match, so a rename, a replaced process or a new terminal refuses.
`boundary` means the capability has no Core transfer and the row states why, or what decision it needs.
Nothing is listed as "not found" without a reason: a capability missing from one search is not a boundary.

| Capability | Old Herdr owner | Core/App owner now | State | Verification |
| --- | --- | --- | --- | --- |
| Runtime selection and auto-detection | `fm_backend_detect`'s `HERDR_ENV`/`HERDR_PANE_ID` arm | `fm_backend_detect`'s `app-terminal` arm: the process's own `HC_TERMINAL_ID` terminal carries a `herdr.space` label in its core's record | migrated | `tests/fm-backend-hc.test.sh`, `tests/fm-backend-hc-appdetect-smoke.test.sh` |
| Toolchain gate | `fm_backend_herdr_version_check` + client selection | `fm_backend_hc_version_check` (`hc x.y.z` floor, generation-1 `hello`) | migrated | `tests/fm-backend-hc.test.sh` |
| Task container creation | `fm_backend_herdr_create_task` (pane in a workspace) | `fm_backend_hc_create_task` (`hc run --bg --no-parent --outlive-parent --no-notify` with `firstmate.task`/`firstmate.home` labels) | migrated | `tests/fm-backend-hc.test.sh`, `tests/fm-backend-hc-smoke.test.sh` |
| Task placement shown in the app | workspace + tab projection journal (`fm_backend_herdr_projection_*`, `fm-herdr-groups.sh`) | `herdr.space`/`herdr.tab` labels project the terminal into the app; the adapter's App section then names the home's space, names the task's tab, keeps a home's task tabs contiguous, and restores focus after closing the active tab | migrated | `tests/fm-backend-hc.test.sh` (App presentation cases), `docs/verification/runtime-backends.md` |
| Naming the app's spaces and tabs, ordering, focus | `herdr` workspace label, tab title, workspace/tab move, `--no-focus` creation | `herdr-app do space.rename|tab.rename|tab.move|tab.select`, driven by `bin/backends/hc.sh`'s App section | migrated, restricted to what this home owns | `tests/fm-backend-hc.test.sh` |
| Default-tab prune and the projection journal | `fm_backend_herdr_*_projection_*`, `fm-herdr-session-cleanup.sh` | not applicable: Core has no shared default tab to prune and no window layout that a close can disturb | boundary: the hazard these surfaces repaired only exists in a shared multiplexer window | `tests/fm-herdr-*` cover the multiplexer path only |
| Spawn (capability check, isolation, model/effort/account, instructions, readiness) | `fm-spawn.sh` through the `herdr` adapter | the same `fm-spawn.sh` through the `hc` adapter; worktrees still come from Treehouse | migrated | `tests/fm-spawn-herdr-*` and `tests/fm-backend-hc-appdetect-smoke.test.sh` |
| Steer delivery and durable inbox | `fm-send.sh` target resolution, Herdr composer proof | `fm-send.sh` with verification-based provider resolution (below) and `hc send --wait` submit proof | migrated | `tests/fm-send-strict.test.sh`, `tests/fm-send-inbox.test.sh` |
| Interrupt, exit, relaunch | `fm-control.sh` over the `herdr` adapter | `fm-control.sh` over the `hc` adapter: recovery-grade agent state, a live-socket absence proof, generic replacement launch | migrated | `tests/fm-backend-hc.test.sh`, `tests/fm-control-herdr-smoke.test.sh` (multiplexer), `tests/fm-control.test.sh` |
| Binding an existing user agent (discover/inspect/attach/verify/observe) | `fm-external-session.py` over Herdr's pane and agent APIs | the same owner with a herdr-core inspector (`--backend hc`) | migrated, with one boundary: Core publishes no native session registration | `tests/fm-external-session.test.py` |
| Observation and notification | `fm_backend_herdr_agent_status_raw`, native idle state, event stream | `hc get`'s `status.state` plus the shared process classifier; supervision keeps its own polling cycle | migrated for state; boundary: `hc` has no event stream this repository consumes, so supervision stays a poll (`docs/hc-backend.md` "Limits") | `tests/fm-backend-hc-liveness-live-e2e.test.sh`, `tests/fm-backend-hc.test.sh` |
| Away-mode supervision injection | `fm-supervise-daemon.sh` over the `herdr` adapter | the same daemon over the `hc` adapter; `hc` is in `FM_SUPERVISOR_SUPPORTED_BACKENDS` and injection/submit go through the generic dispatch | migrated | `tests/fm-daemon.test.sh`, `tests/fm-backend-hc.test.sh` |
| Lab isolation for experiments | `bin/fm-herdr-lab.sh` (named non-default old-Herdr session) | `bin/fm-hc-lab.sh` (named private `fm-hclab-*` core session, content-digest tripwire, guarded teardown) | migrated | `tests/fm-hc-lab.test.sh` |
| Install and update | `bin/fm-install-herdr.sh` | `bin/fm-install-hc.sh` plus the adapter's version floor | migrated | `tests/fm-install-herdr.test.sh` (multiplexer), `tests/fm-backend-hc.test.sh` |
| CI cleanup of leaked sessions | `bin/fm-herdr-ci-cleanup.sh` | `bin/fm-hc-ci-cleanup.sh` | migrated | `.github/workflows` |
| Local secondmates | multiplexer home container, `2ndmate-<id>` workspace, generic secondmate launch path | the same generic path on Core: the secondmate's own home labels and its own space, no backend-specific refusal | migrated | `tests/fm-backend-hc.test.sh` (secondmate spawn case) |
| Remote secondmates | `fm-remote-herdr-guard.sh`, `fm-remote-herdr-identity-lib.sh`, `fm-remote-herdr-owner-lib.sh`, `fm-remote-secondmate-control.sh`, `fm-remote-doctor.sh --backend herdr\|rex` | the same SSH/`fm-on` route with `remote_backend=hc`: the spawn validates the launch against the code-root namespace and records `remote_hc_session`/`remote_hc_terminal`, the host-local control plane pins `HC_SESSION` and refuses another root's session, and the doctor gains `--backend hc` with a connect-only liveness check | migrated over the existing route; the live half needs a remote host, so the verification here is the deterministic transport fixture below | `tests/fm-remote-secondmate-hc.test.sh` (route, wrong owner, moved endpoint, absent and stale socket with no core start), `tests/fm-remote-secondmate-relaunch.test.sh`, `tests/fm-remote-secondmate-parent-binding.test.sh` |
| Focus and ordering surfaces | `herdr-focus`, `herdr-workspace-move.py`, `fm-herdr-lab-viewer.py` | `herdr-app do tab.move`/`space.move` for ordering and `tab.select` for the focus backstop; `hc attach <t>` for a person who wants the terminal itself | migrated for tab order and the close backstop; space ordering stays app-side because Firstmate names one space per home and never reorders the person's other spaces | `tests/fm-backend-hc.test.sh`; `herdr-app commands` |

Two consequences follow from the table and are worth stating plainly:

- A migrated home creates, steers, and finishes **new** work through Core. Its older records keep their recorded backend, so `fm-send`/`fm-control`/`fm-teardown` still reach a multiplexer pane that a previous session created, and that is the only thing the multiplexer path is used for.
- No capability is enabled on Core that the multiplexer path did not already provide. In particular Core adds no new review, gate, or supervision mechanism: the same `fm-spawn.sh`, `fm-send.sh`, `fm-control.sh`, and watcher cycle serve both providers.

## Choosing the right system

Three rules decide which product a command reaches, in this order:

1. **A recorded endpoint wins.** A task or lane record names its own backend (`backend=herdr`, `backend=hc`) and its own session and terminal, and every command uses exactly those.
   The same `<session>:<terminal>` string in two different cores is not interchangeable, and a record from one is never re-pointed at the other.
2. **An explicit provider prefix wins over shape.** `hc:<session>:<address>`, `tmux:<session>:<window>`, and `herdr:<session>:<pane>` state the provider directly.
3. **Otherwise the shape is only a candidate, and verification decides.**
   A single colon is a tmux `session:window` *and* a herdr-core `session:address`.
   `fm-send.sh` therefore probes both: Core only for a well-formed Core address (`<session>:t<n>`) whose session's own core is already answering on its socket, tmux as before.
   Exactly one verified owner wins; two live owners refuse as ambiguous rather than guessing; nothing live refuses with the providers it tried.

The Core probe is read-only by construction: `bin/backends/hc.sh`'s `fm_backend_hc_core_live` connects to the session's own socket first, because any `hc` call against a missing socket *starts* a core (`docs/hc-backend.md` "Runtime auto-detection").
An inherited `HERDR_ENV`/`HERDR_PANE_ID` from the multiplexer never redirects a Core target: it selects the multiplexer only for a process actually running inside it, and an explicit `config/backend`, `FM_BACKEND`, or `--backend hc` always outranks every marker.

## Binding an existing session to Core

`bin/fm-attach.sh --backend hc` binds an agent the user already runs in a Core terminal, for example a live research session in the app.
The evidence model differs from the multiplexer's because Core publishes different records, so the contract is stated once here:

- **Terminal record.** `hc get` must report the terminal `live`, carry a Herdr App space and tab label, and carry no `firstmate.task` label: a terminal that already belongs to a task is never adopted.
- **Process identity.** The terminal's single foreground process must be exactly the requested PID, with the same start ticks, cwd, argv0, and script file identities read twice around the Core read. A changed process is a lost identity, not a repaired one.
- **Family.** Core's `status.app` may contradict the process family only when it names a known harness; otherwise the shared process classifier decides.
- **Native session.** Core publishes no conversation registry, so the binding takes the harness's own evidence instead and refuses when it cannot. For Pi that is the conversation the process itself claims in `PI_SESSION_FILE`/`PI_SESSION_ID`, accepted only when all three checks agree: the named record's header is that same id and this process's working folder, and that record is still the newest one for the folder. A claim inherited from a parent Pi in another folder fails the header check; another Pi in the same folder that took the conversation over fails the newest-record check, and both refuse rather than adopting a file. For any other harness an explicit `--native-session` counts only when the same process's environment or open files name it.
  What this cannot see is a conversation switch that leaves both the claim and the newest-record order unchanged; the recovery from any refusal is a fresh instruction and a new binding, never an in-place repair.
  Receipts work normally on Core: a Pi transcript receipt from the bound file, or an exact reply phrase from any harness.
- **Liveness.** Every later `verify`/`state`/`observe` re-reads the same terminal through `hc get`, refuses to start a core, and reports `unknown` rather than `lost` when it cannot read.

Discovery (`fm-attach.sh discover --backend hc`) lists unmanaged live terminals in one session from Core's own record: it never uses the presence of an app window as evidence about any process, and it never types into anything.

## Remote secondmates on Core

The remote route is the ordinary SSH/`fm-on` route; Core only changes which session-provider owns the endpoint.

- The spawn records `remote_backend=hc` plus `remote_hc_session`/`remote_hc_terminal`, and refuses a launch reply whose session is outside this code root's own namespace (`fm-remote` or `fm-remote-<root-id>`) or whose target is not that session's terminal.
- The host-local control plane validates the same pair before acting, pins `HC_SESSION` for the launch exactly as the multiplexer path pins `HERDR_SESSION`, and prints the session readiness and later control name.
- Readiness never starts a core: `bin/fm-remote-doctor.sh --backend hc` gates the CLI and version through the adapter and proves liveness with a real connect (`fm_backend_hc_core_live`). An absent socket reads as "no core yet — the authorized launch starts it"; a stale one is reported and neither started nor replaced.
- `tests/fm-remote-secondmate-hc.test.sh` is the deterministic transport fixture: route acceptance, another code root's session, a moved endpoint, and both socket states with the fake CLI proving no core call and no state created. A real remote host is the only missing piece there, and it is an environment gap rather than an unimplemented contract.

## Switching a home to Core

The switch is two local configuration changes, and every step is reversible:

1. Install or update Herdr Core to the adapter's verified floor: `bin/fm-install-hc.sh --help` owns the exact usage.
2. Write the provider choice for new work: `config/backend` containing `hc`, or pass `--backend hc` per spawn.
   A home that spawns secondmates sets this explicitly anyway, so a secondmate never depends on a terminal heuristic for its provider.
3. Optionally pin the core session with `HC_SESSION` in the home's launch environment; otherwise Core's `default` session is used.
   The Herdr app shows the session it bound at launch.
4. Verify: `hc server status`, then one `fm-spawn.sh` task with `--backend hc`, then `fm-send` to that task and `fm-control.sh <id> interrupt`.

Rollback is equally local: set `config/backend` back to the previous value (or remove it and rely on detection), and stop starting new Core work.
Records already created on Core keep their `backend=hc` and stay addressable, exactly as multiplexer records stay addressable after the switch; no record is rewritten, no address is converted by string substitution, and no terminal, worktree, or unlanded change is touched by either direction.

## Known limits

- Remote secondmates over Core's `hc machine` transport are not implemented; the guarded remote contract is multiplexer-only until that is decided.
- The app's sidebar, project groups, and layout presets remain app-owned; only the space name, tab name, tab order, and the post-close focus backstop are driven.
- Core exposes no event stream to this repository, so supervision polls, exactly as it does on tmux.
- Core reports one foreground process per terminal, so a launcher's harness is found through the process group on the same machine only.
- A single-colon explicit target that is live as both a tmux window and a Core terminal refuses as ambiguous and needs the `hc:` or `tmux:` prefix; that refusal is the intended outcome, not a resolution failure.
- The prefixes are literal: a tmux session that is itself named `hc`, `tmux`, or `herdr` must be written with the provider first, such as `tmux:hc:<window>`.
