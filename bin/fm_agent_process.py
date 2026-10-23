"""Bounded Linux process observations shared by the worker collector and attachment owner.

No conversations or environment are read. Unsupported/unreadable kernels remain unknown.
The shell family/process owners classify the sampled executable/script identities.
"""
import hashlib
import os
from pathlib import Path
import re

def process_sample(pid):
    """Read one named PID twice; retain no prompts, environment or model data."""
    try:
        base = Path('/proc') / str(int(pid))
        before = (base / 'stat').read_text()
        fields = before.rsplit(')', 1)[1].split()
        if fields[0] in ('Z', 'X'):
            return None
        cmdline = (base / 'cmdline').read_bytes()
        argv = cmdline.split(b'\0')
        argv = [os.fsdecode(v) for v in argv if v]
        exe = os.readlink(base / 'exe')
        cwd = os.readlink(base / 'cwd')
        paths = [exe]
        # A script is executable identity only in the interpreter's script slot.
        # -e/-p, imports, flag operands and later prompt arguments prove nothing.
        if re.fullmatch(r'(node|bun|python)([0-9.]*)', Path(exe).name) and len(argv) > 1:
            script = argv[1]
            if script and not script.startswith('-'):
                path = os.path.join(cwd, script)
                if os.path.isfile(path):
                    paths += [path, os.path.realpath(path)]
        identity_files = []
        for index, path in enumerate(dict.fromkeys(paths)):
            st = os.stat(base / 'exe' if index == 0 else path)
            identity_files.append({'path': path, 'device': str(st.st_dev), 'inode': str(st.st_ino),
                                   'mtime_ns': str(st.st_mtime_ns), 'size': str(st.st_size)})
        after = (base / 'stat').read_text().rsplit(')', 1)[1].split()
        if fields[19] != after[19] or int(fields[1]) != int(after[1]) or \
                exe != os.readlink(base / 'exe') or cwd != os.readlink(base / 'cwd'):
            return None
        boot = next(int(line.split()[1]) for line in Path('/proc/stat').read_text().splitlines()
                    if line.startswith('btime '))
        return {'pid': int(pid), 'ppid': int(fields[1]), 'name': (base / 'comm').read_text().strip(),
                'cwd': cwd, 'identity_paths': list(dict.fromkeys(paths)), 'identity_files': identity_files, 'ticks': fields[19],
                'start': boot + int(fields[19]) / os.sysconf('SC_CLK_TCK'),
                'argv0': argv[0] if argv else '',
                'cmdline_sha256': hashlib.sha256(cmdline).hexdigest(),
                'interpreter': bool(re.fullmatch(r'(node|bun|python)([0-9.]*)', Path(exe).name))}
    except (OSError, ValueError, IndexError, StopIteration, TypeError):
        return None


def start_time(pid):
    sample = process_sample(pid)
    return sample['start'] if sample else None


def pane_sample(info, pane):
    """Bounded descent from this exact pane shell, plus its foreground PIDs."""
    data = (info.get('result') or {}).get('process_info') or {}
    if data.get('pane_id') != pane or not isinstance(data.get('shell_pid'), int) or data['shell_pid'] <= 1:
        return {'procs': [], 'complete': False, 'error': 'не прочитана идентичность панели'}
    frontier = [data['shell_pid']] + [p['pid'] for p in data.get('foreground_processes', [])
                                    if isinstance(p.get('pid'), int) and p['pid'] > 1]
    seen, procs, complete = set(), [], True
    for depth in range(9):
        following = []
        for pid in frontier:
            if pid in seen:
                continue
            if len(seen) >= 256:
                complete = False
                break
            seen.add(pid)
            sample = process_sample(pid)
            if sample:
                # The stock presence owner needs args, but they never leave the
                # pipe to its bounded ps seam or appear in saved evidence.
                try:
                    sample['args'] = Path(f'/proc/{pid}/cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace').strip()
                    following += [int(c) for c in Path(f'/proc/{pid}/task/{pid}/children').read_text().split()]
                except (OSError, ValueError):
                    complete = False
                procs.append(sample)
            else:
                complete = False
        frontier = [p for p in following if p not in seen]
        if not frontier:
            break
    if frontier:
        complete = False
    return {'procs': procs, 'complete': complete,
            'error': None if complete else 'не все процессы панели прочитаны или достигнут предел 8/256'}
