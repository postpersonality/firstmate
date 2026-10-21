"""Read-only re-verification of the Root035 host-assisted native run at 3a6c5afa.
Starts no process except git; reads only the retained lab, the review bundle and this worktree."""
import hashlib, json, os, subprocess, sys
from pathlib import Path

W = Path(sys.argv[1])
B = Path('/home/nikolayseliverstov/Projects/firstmate/data/firstmate-supervision-continuity/native-review-3a6c5afa')
L = Path((B / 'last-lab-path').read_text().strip())
ok = True
def check(cond, label):
    global ok
    ok &= bool(cond)
    print(('PASS ' if cond else 'FAIL ') + label)
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
rows = lambda p: [json.loads(x) for x in Path(p).read_text().splitlines()] if Path(p).exists() else []

print('== provenance')
head = subprocess.check_output(['git', '-C', W, 'rev-parse', 'HEAD'], text=True).strip()
check(head == '3a6c5afa3681035eab84b37188d4d2356fbec483', f'worktree HEAD {head}')
check(subprocess.check_output(['git', '-C', W, 'status', '--porcelain', '--untracked-files=no'], text=True) == '', 'tracked tree clean')
p = json.loads((B / 'pins.json').read_text())
bad = [n for n, d in p['files'].items() if sha(W / n) != d]
check(len(p['files']) == 226 and not bad, f'{len(p["files"])} source pins match current tree (mismatch {bad})')
check(all(sha(B / n) == d for n, d in p['private_scripts'].items()), 'private script pins (run.sh) match')
check(sha(p['binary']['path']) == p['binary']['sha256'] == '399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215', 'codex-cli 0.163.0 binary pin matches')
for n, d in [('run.sh', '04d1ca3cf770c770bef267f029dfe4973c0da0a4988c7b5e0462e69dbd961d22'),
             ('pins.json', 'a40730dc2811126fc9b557da59f5faacd0f7878682e0a9175b52997badaffcd4'),
             ('host-assist.sh', 'ba079063d4ec79c08bc6a05e2b9273fbba8ac524f210454d5b8d20582ad67827'),
             ('host-assist-pins.json', '670c88b9cc27601c2d347b8694907026eab7c2de07981b33d780072d72117155')]:
    check(sha(B / n) == d, f'{n} hash equals the Root034/035 reviewed value')
claim = json.loads((B / 'execution.claimed').read_text())
check(claim['head'] == head, f'execution.claimed head {claim["head"][:8]} at {claim["at"]} (single claim file)')
pre = json.loads((B / 'root035-host-preflight.json').read_text())
check(pre['pid_mapping_consistent'] and pre['pipeline_head'] == head and pre['claims_absent'], 'host preflight: coherent pid/proc, same head, no prior claim')
check((B / 'host-assist.rc').read_text().strip() == '0' and (L / 'driver.rc').read_text().strip() == '0'
      and (L / 'driver.err').read_bytes() == b'', 'host-assist.rc 0, driver.rc 0, driver.err empty')
out = (L / 'driver.out').read_text().splitlines()
check(len(out) == 5 and all(x.startswith('ok - codex-cli 0.163.0:') for x in out), 'driver.out: five ok lines')
m = json.loads((B / 'root035-native-evidence-manifest.json').read_text())
mm = [k for k, v in m['files'].items() if sha(k) != v['sha256'] or os.path.getsize(k) != v['bytes']]
check(len(m['files']) == 40 and not mm, f'manifest {len(m["files"])} files match by sha256 and size (mismatch {mm})')
base_guard = subprocess.check_output(['git', '-C', W, 'show', '343e7a31:bin/fm-turnend-guard.sh'])
for home in ('before', 'after', 'empty'):
    diff = []
    for f in sorted((W / 'bin').rglob('*')):
        if f.is_file():
            rel = f.relative_to(W)
            want = base_guard if (home == 'before' and str(rel) == 'bin/fm-turnend-guard.sh') else f.read_bytes()
            if (L / home / rel).read_bytes() != want: diff.append(str(rel))
    check(diff == ['bin/fm-session-start.sh'], f'{home}/bin equals HEAD bin (control guard = base 343e7a31) except the driver shim {diff}')

def api(home):
    recs = rows(L / home / 'api.jsonl')
    ev = []
    for r in recs:
        mth = r.get('method'); prm = r.get('params', {})
        if mth in ('turn/started', 'turn/completed'):
            ev.append((mth, prm.get('threadId'), prm['turn']['id'], prm['turn'].get('status')))
        elif mth == 'item/completed':
            it = prm['item']
            if it.get('type') == 'commandExecution':
                ev.append(('cmd', prm.get('threadId'), it.get('exitCode'), it.get('command'), it.get('aggregatedOutput') or ''))
            elif it.get('type') == 'agentMessage':
                ev.append(('msg', prm.get('threadId'), it.get('text')))
            elif it.get('type') == 'hookPrompt':
                ev.append(('hook', prm.get('threadId'), [f['text'] for f in it['fragments']]))
    return ev

print('== S2 negative control: base guard in native app-server (before home)')
st = rows(L / 'before/native-starts.jsonl'); rs = rows(L / 'before/native-results.jsonl'); ev = api('before')
t = st[0]['payload']['session_id']
check(len(st) == 1 and 'lock acquired: harness pid' in st[0]['output'], f'SessionStart bound primary thread {t}: {st[0]["output"]}')
check([(r['payload']['stop_hook_active'], r['status']) for r in rs] == [(False, 2), (True, 0)], 'base guard: Stop#1 exit 2, Stop#2 (stop_hook_active=true) exit 0')
check([e[3] for e in ev if e[0] == 'turn/completed'] == ['completed'] and sum(e[0] == 'turn/started' for e in ev) == 1, 'turn completed; no further turn started after the late worker completion')
check((L / 'before/state/worker.status').read_text().startswith('done:') and not (L / 'before/state/worker.inbox').exists()
      and not (L / 'before/terminal-calls.jsonl').exists(), 'worker.status=done yet no worker.inbox and no terminal send: primary stayed idle')

print('== after home: owned primary S1, foreign S2, restart/resume')
st = rows(L / 'after/native-starts.jsonl'); rs = rows(L / 'after/native-results.jsonl'); ev = api('after')
s1, s2 = st[0]['payload']['session_id'], st[1]['payload']['session_id']
print(f'   S1={s1} S2={s2}')
check([(r['payload']['session_id'], r['payload']['source']) for r in st] == [(s1, 'startup'), (s2, 'startup'), (s1, 'resume')], 'SessionStart rows: S1 startup, S2 startup, S1 resume')
h1 = st[0]['output'].split()[-1]; h2 = st[2]['output'].split()[-1]
check(st[0]['output'].startswith('lock acquired: harness pid') and st[2]['output'].startswith('lock acquired: harness pid') and h1 != h2 and '1' not in (h1, h2),
      f'S1 bound host {h1} at startup and new host {h2} at resume (no PID 1)')
check(st[1]['output'] == f'error: another live firstmate session holds the lock (pid {h1}, session {s1}); operate read-only until resolved', f'S2 native SessionStart refused: {st[1]["output"]}')
check([(r['payload']['session_id'], r['payload']['stop_hook_active'], r['status']) for r in rs] == [(s1, False, 2), (s1, True, 2), (s2, False, 0), (s1, False, 2)],
      'Stop rows: S1 quiet exit 2, S1 stop_hook_active=true exit 2, S2 exit 0, resumed S1 exit 2')
check('checkpoint: no actionable wake within 2s' in rs[0]['feedback'] and 'WAKE_ACK_REQUIRED' in rs[0]['feedback'], 'S1 Stop#1: quiet checkpoint continuation names drain + exact ACK')
check('signal:' in rs[1]['feedback'] and 'worker.status' in rs[1]['feedback'], 'S1 Stop#2 under stop_hook_active=true: guard alone (primer already spent) delivered the late worker.status wake')
hooks = [e for e in ev if e[0] == 'hook']
check(any('checkpoint: no actionable wake' in x for x in hooks[0][2]) and any('worker.status' in x for x in hooks[1][2]), 'runtime injected both guard feedbacks into the model as hookPrompt items')
cmds = [(e[1], e[2], e[3]) for e in ev if e[0] == 'cmd']
print('   S1 commands:'); [print('     ', c[1], c[2]) for c in cmds if c[0] == s1]
drain2 = [e for e in ev if e[0] == 'cmd' and e[3] == "/usr/bin/bash -lc 'bash bin/fm-wake-drain.sh 2>&1'"][1][4]
check('\t2\tsignal\tworker.status\t' in drain2 and 'WAKE_ACK_REQUIRED: after handling completes run bin/fm-wake-drain.sh --ack-through 2' in drain2
      and 'worker done: ready for already authorized validation' in drain2, 'late-completion drain presented seq 2 worker event and its WAKE_ACK_REQUIRED')
order = [c[2] for c in cmds if c[0] == s1 and c[1] == 0]
i_send = order.index('/usr/bin/bash -lc \'FM_SEND_IDEMPOTENT=1 bash bin/fm-send.sh worker "Proceed with the already authorized validation"\'')
check(order[i_send + 1].startswith("/usr/bin/bash -lc 'bin/fm-wake-drain.sh --ack-through 2 --recovery-generation 1034868.") and order[i_send + 1].split()[-1].rstrip("'") in drain2,
      'model ran public fm-send (exit 0) then the exact printed ACK through 2 (exit 0)')
tc = rows(L / 'after/terminal-calls.jsonl')
check(len(tc) == 4 and all(r[:4] == ['terminal', 'send', '--terminal', 'native-lab-worker'] for r in tc), 'fm-send reached the synthetic worker terminal twice (nudge + Enter each)')
check((L / 'after/state/worker.inbox/handled/001.msg').read_text().rstrip('\n').endswith('\n--\nProceed with the already authorized validation')
      and (L / 'after/validation.ok').read_text() == 'worker validation passed\n', 'first instruction consumed into handled/001.msg; validation.ok written (driver acts as synthetic worker)')
tc_turns = [e for e in ev if e[0] == 'turn/completed']
check([(e[1], e[3]) for e in tc_turns] == [(s1, 'interrupted'), (s2, 'completed'), (s1, 'interrupted')], 'turn ends: S1 interrupted, S2 completed, resumed S1 interrupted')
s2cmds = [c for c in cmds if c[0] == s2]
check(not s2cmds and [e[2] for e in ev if e[0] == 'msg' and e[1] == s2] == ['Read-only.'], 'foreign S2 ran zero commands and only replied "Read-only."')
drain4 = [e for e in ev if e[0] == 'cmd' and e[3] == "/usr/bin/bash -lc 'bash bin/fm-wake-drain.sh 2>&1'"][2][4]
check('\t4\tsignal\tworker.status\t' in drain4 and '\t2\t' not in drain4, 'post-resume drain listed only seq 4; ACKed seq 2 did not replay')
check(order[-2] == '/usr/bin/bash -lc \'FM_SEND_IDEMPOTENT=1 bash bin/fm-send.sh worker "Proceed with the already authorized validation after the host restart"\''
      and order[-1].startswith("/usr/bin/bash -lc 'bin/fm-wake-drain.sh --ack-through 4 --recovery-generation 1052165.") and order[-1].split()[-1].rstrip("'") in drain4,
      'after resume: fm-send of the resumed instruction then exact ACK through 4')
inbox = sorted(str(x.relative_to(L / 'after/state/worker.inbox')) for x in (L / 'after/state/worker.inbox').rglob('*.msg'))
check(inbox == ['002.msg', 'handled/001.msg'] and 'after the host restart' in (L / 'after/state/worker.inbox/002.msg').read_text(), f'inbox {inbox}: exactly one steer per handled event, no 003.msg')
check((L / 'after/state/.wake-queue').read_bytes() == b'' and (L / 'after/state/.lock').read_text().strip() == h2
      and (L / 'after/state/.lock-session').read_text().strip() == s1, 'wake queue empty after ACK; lock = resumed host, sidecar = S1')
print('   .watcher-down =', (L / 'after/state/.watcher-down').read_text().strip())
te = json.loads((L / 'after/tool-env.json').read_text())
check(te['pid1_argv0'] == 'codex-linux-sandbox' and te['CODEX_THREAD_ID_present'], 'model tools ran inside codex-linux-sandbox with CODEX_THREAD_ID')
check((L / 'after/tool-lock-status').read_text().strip() == '0 0' and (L / 'after/tool-lock-before').read_bytes() == (L / 'after/tool-lock-after').read_bytes() == (h2 + '\n').encode(),
      'sandboxed fm-lock confirmed its own SessionStart anchor byte-identically (post-resume proof)')
check((L / 'after/tool-unowned-status').read_text().strip() == '1 1' and (L / 'after/legacy-state/.lock').read_text().strip() == h2
      and not (L / 'after/legacy-state/.lock-session').exists() and not (L / 'after/free-state/.lock').exists(),
      'sandboxed fm-lock refused legacy and free locks: legacy PID unchanged, no sidecar, no PID 1 published')
print('   refusal text:', (L / 'after/tool-legacy.out').read_text().strip())
for home in ('before', 'after', 'empty'):
    s = L / home / 'state'
    check(not (s / '.watch.lock').exists() and not any('checkpoint' in x.name and 'lock' in x.name for x in s.iterdir()), f'{home}: no watcher or checkpoint lock left')

print('== S8 empty fleet')
st = rows(L / 'empty/native-starts.jsonl'); rs = rows(L / 'empty/native-results.jsonl'); ev = api('empty')
check(len(st) == 1 and st[0]['output'].startswith('lock acquired') and [r['status'] for r in rs] == [0], 'empty: bound, single Stop exit 0')
check(not [e for e in ev if e[0] == 'cmd'] and [e[3] for e in ev if e[0] == 'turn/completed'] == ['completed']
      and sorted(x.name for x in (L / 'empty/state').iterdir()) == ['.lock', '.lock-session'], 'empty: zero commands, turn completed, no watcher beat or queue')

print('== cleanup')
for pid in (1018247, 1027103, 1048126, 1062658):
    alive = Path(f'/proc/{pid}').exists()
    note = Path(f'/proc/{pid}/cmdline').read_bytes()[:60] if alive else b''
    check(not alive or b'app-server' not in note, f'fixture host {pid} absent{"" if not alive else " (pid reused: " + repr(note) + ")"}')
print('RESULT', 'ALL PASS' if ok else 'FAILURES PRESENT')
sys.exit(0 if ok else 1)
