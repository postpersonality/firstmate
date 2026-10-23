"""Shared synthetic terminal and isolated worker setup for offline/native coverage."""
import json
from pathlib import Path
import subprocess


def _git(root, *args):
    result = subprocess.run(
        ["git", "-C", str(root), *args], check=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    return result.stdout.strip()


def ensure_lab_primary(home):
    """Give the private supervision home its own main-branch lab root."""
    home = Path(home).resolve()
    home.mkdir(parents=True, exist_ok=True)
    if not (home / ".git").exists():
        subprocess.run(
            ["git", "init", "-q", "--initial-branch=main", str(home)],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
    branch = _git(home, "symbolic-ref", "--quiet", "--short", "HEAD")
    if branch != "main":
        subprocess.run(
            ["git", "-C", str(home), "branch", "--move", "main"],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
    head = subprocess.run(
        ["git", "-C", str(home), "rev-parse", "--verify", "HEAD"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    if head.returncode:
        subprocess.run(
            ["git", "-C", str(home), "-c", "user.name=Firstmate test",
             "-c", "user.email=firstmate-test@example.invalid",
             "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty",
             "-m", "fixture lab primary"],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
    if _git(home, "branch", "--show-current") != "main":
        raise RuntimeError("fixture lab primary is not on main")
    return home


def _task_worktree(home):
    """Create and verify a task worktree linked to a separate fixture project."""
    home = Path(home).resolve()
    primary = home.parent / f"{home.name}-project-primary"
    worktree = home.parent / f"{home.name}-task-worktree"
    if primary.exists() or worktree.exists():
        raise RuntimeError("fixture project paths must be fresh and test-owned")
    primary.mkdir()
    subprocess.run(
        ["git", "init", "-q", "--initial-branch=main", str(primary)],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    (primary / "fixture.txt").write_text("synthetic worker project\n")
    _git(primary, "add", "fixture.txt")
    subprocess.run(
        ["git", "-C", str(primary), "-c", "user.name=Firstmate test",
         "-c", "user.email=firstmate-test@example.invalid",
         "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture project"],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    subprocess.run(
        ["git", "-C", str(primary), "worktree", "add", "--detach", str(worktree), "HEAD"],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )

    primary = primary.resolve()
    worktree = worktree.resolve()
    primary_root = Path(_git(primary, "rev-parse", "--show-toplevel")).resolve()
    task_root = Path(_git(worktree, "rev-parse", "--show-toplevel")).resolve()
    primary_git = Path(_git(primary, "rev-parse", "--absolute-git-dir")).resolve()
    task_git = Path(_git(worktree, "rev-parse", "--absolute-git-dir")).resolve()
    task_common = Path(_git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()
    task_branch = subprocess.run(
        ["git", "-C", str(worktree), "symbolic-ref", "--quiet", "--short", "HEAD"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    listed = _git(primary, "worktree", "list", "--porcelain")
    paths = {line.removeprefix("worktree ") for line in listed.splitlines()
             if line.startswith("worktree ")}
    if (primary == home or worktree in (home, primary) or primary_root != primary
            or task_root != worktree or primary_git == task_git
            or task_common != primary_git or task_git.parent != primary_git / "worktrees"
            or task_branch.returncode == 0 or _git(primary, "branch", "--show-current") != "main"
            or str(worktree) not in paths or not (worktree / "fixture.txt").is_file()
            or not (worktree / ".git").is_file()):
        raise RuntimeError("fixture metadata target is not a distinct linked task worktree")
    return worktree


def preflight_environment(base):
    """Match the native Stop owner's short event-coalescing wait."""
    env = dict(base)
    env["FM_SIGNAL_GRACE"] = "1"
    return env


def install_fixture(home, worker=True, active=True):
    """Install the synthetic Orca boundary used by both test paths.

    The primary under test is Codex. The separate synthetic worker is marked
    Grok only so its fake terminal can exercise Grok's existing verified
    rendered-footer activity contract; this is not Codex worker-liveness proof.
    """
    home = ensure_lab_primary(home)
    fakebin = home / "fakebin"
    fakebin.mkdir(parents=True, exist_ok=True)
    orca = fakebin / "orca"
    orca.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
if args[:2] == ["terminal", "read"] and "native-lab-worker" in args:
    active = Path(os.environ["FM_HOME"], "state/.native-terminal-active").is_file()
    text = "live task output\\nCtrl+c:cancel" if active else "╭────╮\\n│    │\\n╰────╯"
    print(json.dumps({"ok": True, "result": {"text": text}}))
elif args[:2] == ["terminal", "send"] and "native-lab-worker" in args:
    with Path(os.environ["FM_HOME"], "terminal-calls.jsonl").open("a") as stream:
        stream.write(json.dumps(args) + "\\n")
    print('{"ok":true}')
else:
    raise SystemExit("unreviewed synthetic terminal operation: " + repr(args))
''')
    orca.chmod(0o700)
    if worker:
        state = home / "state"
        state.mkdir(parents=True, exist_ok=True)
        task_worktree = _task_worktree(home)
        if active:
            (state / ".native-terminal-active").touch()
        else:
            (state / ".native-terminal-active").unlink(missing_ok=True)
        (state / "worker.meta").write_text(
            f"worktree={task_worktree}\n"
            "backend=orca\nterminal=native-lab-worker\nwindow=fm-worker\n"
            "kind=ship\nharness=grok\n"
        )
        (state / "worker.status").write_text(
            "working: owned validation fixture is in flight\n"
        )
    return str(fakebin)
