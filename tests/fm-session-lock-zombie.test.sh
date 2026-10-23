#!/usr/bin/env bash
# A real unreaped harness-named zombie must never own a session lock.
set -eu
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ -d /proc/self ] || { echo 'skip: Linux zombie regression requires /proc'; exit 0; }
python3 - "$ROOT" <<'PY'
import ctypes
import os
from pathlib import Path
import subprocess
import sys

def probe(pid):
    return subprocess.run(['bash', '-c', '. "$1/bin/fm-session-lock-lib.sh"; fm_harness_pid_alive "$2"',
                           'test', sys.argv[1], str(pid)], capture_output=True).returncode

pid = os.fork()
if pid == 0:
    ctypes.CDLL(None).prctl(15, b'codex', 0, 0, 0)
    os._exit(0)
try:
    os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)
    assert Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[0] == 'Z'
    assert probe(pid) != 0
    assert probe(2147483647) != 0
    # A separate live process with the same kernel identity remains accepted.
    live = os.fork()
    if live == 0:
        ctypes.CDLL(None).prctl(15, b'codex', 0, 0, 0)
        os.kill(os.getpid(), 19)
        os._exit(0)
    try:
        os.waitpid(live, os.WUNTRACED)
        assert probe(live) == 0
    finally:
        os.kill(live, 18)
        os.waitpid(live, 0)
    print('ok: real zombie rejected; live harness and absent PID classified correctly')
finally:
    os.waitpid(pid, 0)
PY
