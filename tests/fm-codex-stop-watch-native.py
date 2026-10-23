"""Native Stop/return proof; invoked only by the reviewed opt-in shell guard."""
import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import time

ROOT, LAB = map(Path, sys.argv[1:])
if os.environ.get("FM_CODEX_STOP_LIVE_HOOKS_REVIEWED") != "1":
    raise RuntimeError("review the isolated native hook scope before enabling its invocation-local bypass")
BINARY = Path(os.environ.get("FM_CODEX_STOP_LIVE_BIN", shutil.which("codex")))
VERSION = subprocess.check_output([BINARY, "--version"], text=True).strip()
if VERSION != "codex-cli 0.164.0":
    raise RuntimeError(f"refresh native Stop evidence before using {VERSION}")
MODEL = "gpt-6.1-sol"
CASE = os.environ.get("FM_CODEX_STOP_NATIVE_CASE", "all")
if CASE not in ("all", "standalone"):
    raise RuntimeError(f"unsupported native Stop case: {CASE}")
if sys.platform != "linux":
    raise RuntimeError(f"native Stop guard evidence is pinned to Linux, not {sys.platform}")
AUTH = Path.home() / ".codex/auth.json"
if not AUTH.is_file():
    raise RuntimeError("the existing file-backed Codex login is unavailable; no login was attempted")
if shutil.disk_usage(LAB).free < 15 * 1024**3:
    raise RuntimeError("native lab requires 15 GiB free disk")
if sys.platform == "linux":
    mem = {line.split(":")[0]: int(line.split()[1])
           for line in Path("/proc/meminfo").read_text().splitlines()}
    if mem["MemAvailable"] < 8 * 1024**2 or mem["SwapTotal"]:
        raise RuntimeError("native lab requires 8 GiB MemAvailable and no swap")


def one_cpu():
    if hasattr(os, "sched_setaffinity"):
        os.sched_setaffinity(0, {min(os.sched_getaffinity(0))})


class Native:
    def __init__(self, name, control=False, empty=False, primer=True,
                 stop_checkpoint="2", watch_checkpoint="2"):
        self.home = LAB / name
        self.standalone = not primer
        self.home.mkdir()
        self.user = self.home / "user"
        self.user.mkdir(mode=0o700)
        # Reuse the operator's selected login without reading or printing it.
        (self.user / "auth.json").symlink_to(AUTH)
        shutil.copytree(ROOT / "bin", self.home / "bin")
        if control:
            old = subprocess.check_output(["git", "-C", ROOT, "show",
                                           "343e7a31:bin/fm-turnend-guard.sh"])
            (self.home / "bin/fm-turnend-guard.sh").write_bytes(old)
        for path in ("state", "data", "config"):
            (self.home / path).mkdir()
        (self.home / "AGENTS.md").write_text("")
        (self.home / "fixture.sh").write_text("#!/usr/bin/env bash\nprintf 'validated\\n'\n")
        (self.home / "tool-proof.sh").write_text('''#!/usr/bin/env bash
set -u
python3 - <<'PY'
import json, os
from pathlib import Path
a, b = os.environ.get("CODEX_THREAD_ID"), os.environ.get("CODEX_SESSION_ID")
Path(os.environ["FM_HOME"], "tool-env.json").write_text(json.dumps({
    "CODEX_THREAD_ID_present": bool(a), "CODEX_SESSION_ID_present": bool(b),
    "vendor_ids_equal": bool(a and a == b),
    "FM_CODEX_HOOK_SESSION_ID_present": bool(os.environ.get("FM_CODEX_HOOK_SESSION_ID")),
    "pid1_comm": Path("/proc/1/comm").read_text().strip(),
    "pid1_argv0": Path("/proc/1/cmdline").read_bytes().split(bytes([0]))[0].decode(),
}))
PY
. "$FM_HOME/bin/fm-session-lock-lib.sh"
fm_session_lock_codex_api_pid > "$FM_HOME/tool-api-pid" || true
fm_session_lock_owned_by_self "$FM_HOME/state"
owned=$?
cp "$FM_HOME/state/.lock" "$FM_HOME/tool-lock-before"
bash "$FM_HOME/bin/fm-lock.sh" > "$FM_HOME/tool-lock.out" 2> "$FM_HOME/tool-lock.err"
rc=$?
cp "$FM_HOME/state/.lock" "$FM_HOME/tool-lock-after"
bash "$FM_HOME/bin/fm-watch-checkpoint.sh" --seconds 1 > "$FM_HOME/tool-checkpoint.out" 2> "$FM_HOME/tool-checkpoint.err"
printf '%s\\n' "$?" > "$FM_HOME/tool-checkpoint-status"
printf '%s %s\\n' "$owned" "$rc" > "$FM_HOME/tool-lock-status"
mkdir -p "$FM_HOME/legacy-state" "$FM_HOME/free-state"
cp "$FM_HOME/state/.lock" "$FM_HOME/legacy-state/.lock"
FM_STATE_OVERRIDE="$FM_HOME/legacy-state" bash "$FM_HOME/bin/fm-lock.sh" > "$FM_HOME/tool-legacy.out" 2>&1
legacy=$?
FM_STATE_OVERRIDE="$FM_HOME/free-state" bash "$FM_HOME/bin/fm-lock.sh" > "$FM_HOME/tool-free.out" 2>&1
printf '%s %s\\n' "$legacy" "$?" > "$FM_HOME/tool-unowned-status"
exit "$rc"
''')
        # The digest body stays out of this lab; the real session-open router
        # still classifies the native event and runs the lock writer in the hook.
        (self.home / "bin/fm-session-start.sh").write_text(
            '#!/usr/bin/env bash\nexec bash "$FM_HOME/bin/fm-lock.sh"\n')
        (self.home / "native-start.sh").write_text(
            '#!/usr/bin/env bash\npayload=$(cat)\n'
            'output=$(printf "%s" "$payload" | bash "$FM_HOME/bin/fm-sessionstart-run.sh" 2>&1)\n'
            'jq -cn --argjson payload "$payload" --arg output "$output" '
            "'{payload:$payload,output:$output}' >> \"$FM_HOME/native-starts.jsonl\"\n"
            'printf "%s\\n" "$output"\n')
        subprocess.run(["git", "init", "-q", self.home], check=True)
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("FM_", "CODEX_", "CLAUDE_"))
                    and key not in ("CLAUDECODE", "NO_MISTAKES_GATE")}
        self.env.update(CODEX_HOME=str(self.user), FM_HOME=str(self.home),
                        FM_ROOT_OVERRIDE=str(self.home), FM_CODEX_STOP_CHECKPOINT=stop_checkpoint,
                        FM_CODEX_WATCH_CHECKPOINT=watch_checkpoint,
                        FM_POLL="1", FM_CHECK_INTERVAL="999999", FM_HEARTBEAT="999999")
        # Only this synthetic terminal's read/send boundary is mocked. The
        # real fm-send command, guards, identity, queue and inbox run natively.
        fakebin = self.home / "fakebin"
        fakebin.mkdir()
        orca = fakebin / "orca"
        orca.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
if args[:2] == ["terminal", "read"] and "native-lab-worker" in args:
    print(json.dumps({"ok": True, "result": {"text": "╭────╮\\n│    │\\n╰────╯"}}))
elif args[:2] == ["terminal", "send"] and "native-lab-worker" in args:
    with Path(os.environ["FM_HOME"], "terminal-calls.jsonl").open("a") as stream:
        stream.write(json.dumps(args) + "\\n")
    print('{"ok":true}')
else:
    raise SystemExit("unreviewed synthetic terminal operation: " + repr(args))
''')
        orca.chmod(0o700)
        self.env["PATH"] = str(fakebin) + os.pathsep + self.env["PATH"]
        if not empty:
            (self.home / "state/worker.meta").write_text(
                "backend=orca\nterminal=native-lab-worker\nwindow=fm-worker\nkind=ship\nharness=codex\n")
            (self.home / "state/worker.status").write_text("working: owned validation fixture is in flight\n")
        # One other synchronous hook compels the first continuation. This is
        # the disconfirming path the old unconditional loop flag suppresses.
        (self.home / "primer.sh").write_text(
            '#!/usr/bin/env bash\ncat >/dev/null\n'
            '[ ! -e "$FM_HOME/primed" ] || exit 0\n'
            ': > "$FM_HOME/primed"\n'
            'echo "Native test continuation: follow the original handler instructions." >&2\nexit 2\n')
        if empty:
            (self.home / "primed").touch()
        (self.home / "native-hook.sh").write_text(
            '#!/usr/bin/env bash\npayload=$(cat)\n'
            'printf "%s\\n" "$payload" >> "$FM_HOME/native-stops.jsonl"\n'
            'printf "%s %s\\n" "${CODEX_THREAD_ID:-ABSENT}" "${CODEX_SESSION_ID:-ABSENT}" >> "$FM_HOME/native-env"\n'
            'output=$(mktemp "$FM_HOME/stop-output.XXXXXX")\n'
            'printf "%s" "$payload" | bash "$FM_HOME/bin/fm-turnend-guard.sh" 2>"$output"\nstatus=$?\n'
            'jq -cn --argjson payload "$payload" --argjson status "$status" --rawfile feedback "$output" '
            "'{payload:$payload,status:$status,feedback:$feedback}' >> \"$FM_HOME/native-results.jsonl\"\n"
            'cat "$output" >&2\nrm -f "$output"\nexit "$status"\n')
        stop_hooks = []
        if primer:
            stop_hooks.append({"type": "command", "command": 'bash "$FM_HOME/primer.sh"', "timeout": 30})
        stop_hooks.append({"type": "command", "command": 'bash "$FM_HOME/native-hook.sh"', "timeout": 30})
        hooks = {"hooks": {"SessionStart": [{"hooks": [
            {"type": "command", "command": 'bash "$FM_HOME/native-start.sh"', "timeout": 30},
        ]}], "Stop": [{"hooks": stop_hooks}]}}
        (self.user / "hooks.json").write_text(json.dumps(hooks))
        self.thread = None
        self.spawn()
        try:
            self.start()
        except BaseException:
            self.close()
            raise

    def spawn(self):
        self.err = (self.home / "server.stderr").open("a")
        self.proc = subprocess.Popen([BINARY, "app-server", "--stdio"], cwd=self.home,
                                     env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=self.err, start_new_session=True, preexec_fn=one_cpu)
        self.buf = b""
        self.records = []
        self.seq = 0
        self.turn = None
        try:
            self.request("initialize", {"clientInfo": {"name": "firstmate_native_stop_guard", "version": "1"},
                                        "capabilities": {"experimentalApi": True}})
            self.send({"method": "initialized"})
        except BaseException:
            self.close()
            raise

    def restart(self, host):
        self.close()
        deadline = time.monotonic() + 5
        while Path(f"/proc/{host}").exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        assert not Path(f"/proc/{host}").exists(), "the owned host app-server outlived its restart"
        self.spawn()
        result = self.request("thread/resume", {
            "threadId": self.thread, "cwd": str(self.home), "model": MODEL, "approvalPolicy": "never",
            "sandbox": "workspace-write", "config": {"bypass_hook_trust": True, "project_doc_max_bytes": 0},
        })
        assert result["thread"]["id"] == self.thread, "thread/resume did not reopen the persisted primary thread"

    def start(self):
        result = self.request("thread/start", {
            "cwd": str(self.home), "model": MODEL, "approvalPolicy": "never",
            "sandbox": "workspace-write", "ephemeral": False,
            # Invocation-local consent for these reviewed fixture hooks.
            # No trust store or global Codex settings are modified.
            "config": {"bypass_hook_trust": True, "project_doc_max_bytes": 0},
        })
        self.thread = result["thread"]["id"]
        if self.standalone:
            # Resolve only an initial status wake or quiet checkpoint through public owners before the first reply.
            assert not (self.home / "state/lab.check.sh").exists(), \
                "the deliberate check must not preempt initial status handling"
            checkpoint = subprocess.run(
                ["bash", self.home / "bin/fm-watch-checkpoint.sh", "--seconds", "20"],
                cwd=self.home, env=self.env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            drain = subprocess.run(["bash", self.home / "bin/fm-wake-drain.sh"],
                                   cwd=self.home, env=self.env, text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            ack_lines = [line for line in drain.stderr.splitlines()
                         if line.startswith("WAKE_ACK_REQUIRED:")]
            ack_line = ack_lines[0] if len(ack_lines) == 1 else ""
            ack_command = ack_line.split(" run ", 1)[1] if " run " in ack_line else ""
            ack_parts = ack_command.split()
            checkpoint_lines = [line for line in checkpoint.stdout.splitlines() if line]
            drain_lines = [line for line in drain.stdout.splitlines() if line]
            rows = [line for line in drain_lines if len(line.split("\t")) == 5]
            signal_outcome = (
                checkpoint.returncode == 0 and not checkpoint.stderr and len(checkpoint_lines) == 1
                and checkpoint_lines[0].startswith("signal:") and drain.returncode == 0
                and len(drain_lines) == 1 and len(rows) == 1 and "worker.status" in rows[0]
            )
            quiet_outcome = (
                checkpoint.returncode == 124 and not checkpoint.stderr
                and checkpoint_lines == ["checkpoint: no actionable wake within 20s"]
                and drain.returncode == 0 and not drain_lines and not rows
            )
            ack_shape = (
                len(ack_parts) == 5 and ack_parts[0] == "bin/fm-wake-drain.sh"
                and ack_parts[1] == "--ack-through" and ack_parts[3] == "--recovery-generation"
                and bool(ack_parts[4])
            )
            if signal_outcome and ack_shape and ack_parts[2] == rows[0].split("\t")[1]:
                preflight_outcome = "signal"
            elif quiet_outcome and ack_shape and ack_parts[2] == "0":
                preflight_outcome = "quiet"
            else:
                preflight_outcome = "invalid"
            ack = None
            if preflight_outcome != "invalid":
                ack = subprocess.run(ack_parts, cwd=self.home, env=self.env, text=True,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            (self.home / "native-initial-wake.json").write_text(json.dumps({
                "outcome": preflight_outcome,
                "checkpoint": {"status": checkpoint.returncode, "stdout": checkpoint.stdout,
                               "stderr": checkpoint.stderr},
                "drain": {"status": drain.returncode, "stdout": drain.stdout,
                          "stderr": drain.stderr},
                "ack_command": ack_command,
                "ack": None if ack is None else {"status": ack.returncode, "stdout": ack.stdout,
                                                  "stderr": ack.stderr},
            }, indent=2) + "\n")
            assert preflight_outcome != "invalid", \
                "the initial checkpoint/drain produced an unrelated event or no valid generation-bound ACK"
            assert ack and ack.returncode == 0, "the printed initial ACK command did not succeed"
            queue = self.home / "state/.wake-queue"
            assert not queue.exists() or not queue.read_text(), "the initial preflight acknowledgement left wakes queued"
        if (self.home / "state/worker.status").exists():
            check = self.home / "state/lab.check.sh"
            check.write_text("#!/usr/bin/env bash\nexit 1\n")
            check.chmod(0o700)
            subprocess.run(["bash", self.home / "bin/fm-check-register.sh", "lab"],
                           env=self.env, check=True, stdout=subprocess.DEVNULL)
        no_event = (
            "If there is no event, run bash bin/fm-watch-checkpoint.sh --seconds \"${FM_CODEX_WATCH_CHECKPOINT:-180}\". "
            "When that bounded checkpoint is quiet, drain again and start another normal checkpoint; "
            if self.standalone else
            "If there is no event, only acknowledge the drain. "
        )
        prompt = (
            f"This is an isolated native Firstmate supervision test in {self.home}. "
            "Only work inside that directory; never use tmux, Herdr, network, other tasks or delegation. "
            "First reply exactly 'All five received.' "
            "On any hook continuation or firstmate watcher wake, first run bash tool-proof.sh once "
            "after that hook; it records only environment-presence "
            "booleans and checks actual session ownership and fm-lock, including its refusal of lab-local legacy and free locks. "
            "Never forge identity or bypass a refusal. "
            "Then use the shell tool to drain bin/fm-wake-drain.sh with stdout and stderr captured. If it presents worker.status "
            "saying ready for already authorized validation, enqueue exactly one durable instruction "
            "through the public command: FM_SEND_IDEMPOTENT=1 bash bin/fm-send.sh worker "
            '"Proceed with the already authorized validation". '
            "This validation is explicitly authorized; no human decision is required. "
            "Then execute the exact WAKE_ACK_REQUIRED command printed by that drain. "
            f"{no_event}Leave the lab check registered. "
            "Reply 'Handled.' after performing the action; do not manually arm a watcher or create work. "
            "Native interruption is authoritative. Do not claim a tool or delivery happened without doing it."
        )
        result = self.request("turn/start", {"threadId": self.thread, "effort": "xhigh",
                                             "input": [{"type": "text", "text": prompt}]})
        self.turn = result["turn"]["id"]

    def send(self, value):
        self.proc.stdin.write((json.dumps(value) + "\n").encode())
        self.proc.stdin.flush()

    def poll(self, seconds=0.1):
        if select.select([self.proc.stdout], [], [], seconds)[0]:
            data = os.read(self.proc.stdout.fileno(), 1024 * 1024)
            if not data:
                raise RuntimeError("native API exited: " + (self.home / "server.stderr").read_text()[-1500:])
            self.buf += data
        while b"\n" in self.buf:
            line, self.buf = self.buf.split(b"\n", 1)
            value = json.loads(line)
            self.records.append(value)
            with (self.home / "api.jsonl").open("a") as stream:
                stream.write(json.dumps(value) + "\n")
            if "method" in value and "id" in value:
                # The test never grants an unexpected approval or dynamic tool.
                self.send({"id": value["id"], "error": {"code": -32601, "message": "not authorized in this lab"}})

    def request(self, method, params):
        self.seq += 1
        key = self.seq
        self.send({"id": key, "method": method, "params": params})
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            self.poll()
            for value in self.records:
                if value.get("id") == key:
                    if "error" in value:
                        raise RuntimeError(f"{method}: {value['error']}")
                    return value["result"]
        raise TimeoutError(method)

    def rows(self, name):
        path = self.home / name
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def until(self, predicate, seconds=180):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.poll()
            if predicate():
                return
        raise AssertionError(f"{self.home.name}: native condition not reached; inspect {self.home}")

    def completed(self, status="completed"):
        return any(value.get("method") == "turn/completed"
                   and value["params"]["turn"]["status"] == status for value in self.records)

    def sent_then_acked(self):
        sent = False
        for value in self.records:
            if value.get("method") != "item/completed":
                continue
            item = value["params"]["item"]
            if item.get("type") != "commandExecution" or item.get("exitCode") != 0:
                continue
            command = item.get("command", "")
            if "fm-send.sh worker" in command:
                sent = True
            if sent and "fm-wake-drain.sh --ack-through" in command:
                return True
        return False

    def command_completed(self, fragment, exit_code):
        return any(value.get("method") == "item/completed"
                   and value["params"]["item"].get("type") == "commandExecution"
                   and value["params"]["item"].get("exitCode") == exit_code
                   and fragment in value["params"]["item"].get("command", "")
                   for value in self.records)

    def bound(self, source=None):
        start = [row for row in self.rows("native-starts.jsonl")
                 if row["payload"].get("session_id") == self.thread]
        assert start and source in (None, start[-1]["payload"].get("source")) \
            and "lock acquired: harness pid" in start[-1]["output"], \
            "native SessionStart did not bind the primary thread outside the tool sandbox"
        lock = (self.home / "state/.lock").read_text().strip()
        assert lock != "1" and os.getpgid(int(lock)) == self.proc.pid \
            and b"app-server" in Path(f"/proc/{lock}/cmdline").read_bytes(), \
            "native SessionStart did not record this lab's live host app-server"
        assert (self.home / "state/.lock-session").read_text().strip() == self.thread
        return lock

    def close(self):
        if self.thread and self.turn and self.proc.poll() is None \
                and not self.completed() and not self.completed("interrupted"):
            try:
                self.request("turn/interrupt", {"threadId": self.thread, "turnId": self.turn})
            except (RuntimeError, TimeoutError, BrokenPipeError):
                pass
        if self.proc.poll() is None:
            os.killpg(self.proc.pid, signal.SIGTERM)
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(self.proc.pid, signal.SIGKILL)
            self.proc.wait()
        self.err.close()


def tools_confirmed(native, host):
    native.until(lambda: (native.home / "tool-unowned-status").exists())
    assert (native.home / "tool-lock-status").read_text().strip() == "0 0", "native model tool cannot confirm its SessionStart-bound lock"
    assert (native.home / "tool-lock-before").read_bytes() == (native.home / "tool-lock-after").read_bytes(), "model tool replaced the SessionStart-bound host PID"
    assert (native.home / "tool-unowned-status").read_text().strip() == "1 1", "sandboxed model tool claimed a legacy or free lock"
    assert (native.home / "legacy-state/.lock").read_text().strip() == host, "sandboxed model tool replaced a live legacy host PID"
    assert not (native.home / "legacy-state/.lock-session").exists(), "sandboxed model tool bound a legacy lock"
    assert not (native.home / "free-state/.lock").exists(), "sandboxed model tool published PID 1"
    assert (native.home / "tool-checkpoint-status").read_text().strip() in ("0", "124"), "model tool checkpoint failed"


def stays_interrupted(native):
    native.request("turn/interrupt", {"threadId": native.thread, "turnId": native.turn})
    native.until(lambda: native.completed("interrupted"), seconds=15)
    count = len(native.rows("native-stops.jsonl"))
    end = time.monotonic() + 3
    while time.monotonic() < end:
        native.poll()
    assert len(native.rows("native-stops.jsonl")) == count, "native interruption restarted supervision"
    assert not (native.home / "state/.watch.lock/pid").exists(), "native interruption leaked its watcher"


for control in ((False,) if CASE == "standalone" else (True, False)):
    native = Native("before" if control else "after", control=control,
                    primer=control, stop_checkpoint="2" if control else "20",
                    watch_checkpoint="2" if control else "180")
    try:
        native.until(lambda: any(row.get("session_id") == native.thread
                                 for row in native.rows("native-stops.jsonl")))
        stop_started = time.monotonic()
        host = native.bound()
        if control:
            native.until(native.completed)
        else:
            native.until(lambda: any(row["status"] == 2 and "checkpoint:" in row["feedback"]
                                     for row in native.rows("native-results.jsonl")))
            assert time.monotonic() - stop_started >= 18, "the standalone project Stop did not exhaust its native 20-second bound"
            stop_hooks = json.loads((native.user / "hooks.json").read_text())["hooks"]["Stop"][0]["hooks"]
            assert len(stop_hooks) == 1 and "native-hook.sh" in stop_hooks[0]["command"], \
                "the standalone case unexpectedly retained a primer/global Stop hook"
        inbox = native.home / "state/worker.inbox/001.msg"
        if control:
            # This negative control receives its late event after the old guard
            # allowed Stop, with no second user turn to revive it.
            (native.home / "state/worker.status").write_text("done: ready for already authorized validation\n")
            end = time.monotonic() + 6
            while time.monotonic() < end:
                native.poll()
            assert not inbox.exists(), "negative control unexpectedly continued"
            print(f"ok - {VERSION}: old API Stop stayed idle after the late worker completion", flush=True)
        else:
            # The only registered Firstmate Stop callback returns after its full 20-second budget.
            # The primary then takes one normal, quiet 180-second foreground checkpoint;
            # the controlled lab event arrives only after that quiet timeout, so
            # the next checkpoint must surface and handle it with no new input.
            tools_confirmed(native, host)
            checkpoint_started = time.monotonic()
            native.until(lambda: native.command_completed("fm-watch-checkpoint.sh", 124),
                         seconds=240)
            assert time.monotonic() - checkpoint_started >= 170, \
                "the standalone successor did not include the quiet 180-second primary checkpoint"
            (native.home / "state/worker.status").write_text("done: ready for already authorized validation\n")
            native.until(inbox.exists)
            native.until(native.sent_then_acked)
            assert "already authorized validation" in inbox.read_text()
            assert not (inbox.parent / "002.msg").exists(), "worker was steered twice"
            # The owned synthetic worker consumes the actual steering record
            # and performs its authorized validation, rather than logging a wake.
            (inbox.parent / "handled").mkdir(exist_ok=True)
            inbox.rename(inbox.parent / "handled/001.msg")
            subprocess.run(["bash", "-n", native.home / "fixture.sh"], check=True)
            (native.home / "validation.ok").write_text("worker validation passed\n")
            results = native.rows("native-results.jsonl")
            assert any(row["status"] == 2 and "checkpoint:" in row["feedback"] for row in results), "quiet boundary had no native continuation"
            assert any(row["payload"].get("stop_hook_active") and row["status"] == 2 for row in results), "the Firstmate Stop callback did not retain its same-primary return after the first exit-2"
            stays_interrupted(native)
            if CASE == "standalone":
                print(f"ok - {VERSION}: the only registered Stop hook survived a quiet 20-second boundary, the same thread handled a post-boundary event after a quiet successor checkpoint, and interruption stayed stopped", flush=True)
                continue
            owner = (native.home / "state/.lock-session").read_text()
            foreign = native.request("thread/start", {
                "cwd": str(native.home), "model": MODEL, "approvalPolicy": "never",
                "sandbox": "workspace-write", "config": {"bypass_hook_trust": True, "project_doc_max_bytes": 0},
            })["thread"]["id"]
            assert foreign != native.thread
            foreign_turn = native.request("turn/start", {"threadId": foreign, "effort": "xhigh", "input": [{
                "type": "text", "text": f"Inside this isolated lab {native.home}, this thread is not the Firstmate primary. Stay read-only as its session start reported: run no command, create or change no file, and reply exactly Read-only.",
            }]})["turn"]["id"]
            native.until(lambda: any(value.get("method") == "turn/completed"
                                     and value["params"]["turn"]["id"] == foreign_turn
                                     for value in native.records))
            assert (native.home / "state/.lock-session").read_text() == owner, "another native thread replaced the primary identity"
            assert (native.home / "state/.lock").read_text().strip() == host, "another native thread replaced the primary host PID"
            assert any(row["payload"].get("session_id") == foreign
                       and "another live firstmate session holds the lock" in row["output"]
                       for row in native.rows("native-starts.jsonl")), "another thread's native SessionStart was not refused"
            print(f"ok - {VERSION}: the standalone project Stop and a quiet successor checkpoint handled one late worker event; interruption stayed stopped", flush=True)
            print(f"ok - {VERSION}: SessionStart bound the host lock; sandboxed tools only confirmed it, refused legacy and free locks, ran drain/ack/send/checkpoint; another actual thread's native SessionStart refused", flush=True)
            with (native.home / "state/worker.status").open("a") as stream:
                stream.write("done: ready for already authorized validation after the host restart\n")
            prior = len(native.rows("native-results.jsonl"))
            native.restart(host)
            for name in ("tool-lock-status", "tool-unowned-status", "tool-checkpoint-status",
                         "tool-lock-before", "tool-lock-after"):
                (native.home / name).unlink()
            for name in ("legacy-state", "free-state"):
                shutil.rmtree(native.home / name)
            native.turn = native.request("turn/start", {"threadId": native.thread, "effort": "xhigh", "input": [{
                "type": "text", "text": "This lab's host app-server was deliberately restarted and this primary thread resumed. "
                "Reply exactly 'Resumed.' now. On the next hook continuation or firstmate watcher wake, follow your original "
                "handler instructions once more, except that the worker instruction text is now "
                '"Proceed with the already authorized validation after the host restart".',
            }]})["turn"]["id"]
            native.until(lambda: any(row["payload"].get("session_id") == native.thread
                                     and row["payload"].get("source") == "resume"
                                     for row in native.rows("native-starts.jsonl")))
            lock = native.bound("resume")
            assert lock != host, "native resume kept the exited host PID"
            tools_confirmed(native, lock)
            steer = inbox.parent / "002.msg"
            native.until(steer.exists)
            native.until(native.sent_then_acked)
            assert "after the host restart" in steer.read_text()
            assert not (inbox.parent / "003.msg").exists(), "worker was steered twice after resume"
            assert any(row["payload"].get("session_id") == native.thread and row["status"] == 2
                       for row in native.rows("native-results.jsonl")[prior:]), "resumed thread had no native continuation"
            stays_interrupted(native)
            print(f"ok - {VERSION}: owned app-server restart; native resume SessionStart rebound the persisted thread to the new host, sandboxed tools only confirmed it, and one native continuation handled the pending worker completion", flush=True)
    finally:
        native.close()

if CASE == "all":
    native = Native("empty", empty=True)
    try:
        native.until(native.completed)
        native.bound()
        assert all(row["status"] == 0 for row in native.rows("native-results.jsonl")), "empty fleet caused a supervision continuation"
        assert not (native.home / "state/.last-watcher-beat").exists(), "empty fleet started a watcher"
        print(f"ok - {VERSION}: empty API primary completed without supervision work", flush=True)
    finally:
        native.close()
