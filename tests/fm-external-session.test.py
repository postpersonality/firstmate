"""Behavioral attachment regression through public CLIs; real processes, fake Herdr only."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(sys.argv[1])
sys.path.insert(0, str(ROOT / 'bin'))
from fm_agent_process import process_sample


def call(args, ok=True, **kw):
    p = subprocess.run([str(a) for a in args], text=True, capture_output=True, timeout=90, env=env, **kw)
    if ok:
        assert p.returncode == 0, (args, p.returncode, p.stdout, p.stderr)
    else:
        assert p.returncode != 0, (args, p.stdout, p.stderr)
    return p


def attach(*args, **kw):
    return call([ROOT / 'bin/fm-attach.sh', *args], **kw)


def save(path, data):
    path.write_text(json.dumps(data))


def cfg(**changes):
    data = json.loads(config.read_text())
    data.update(changes)
    save(config, data)
    return data


def state(task='research'):
    return json.loads(attach('state', task).stdout)


def unchanged():
    assert process_sample(agent.pid)['ticks'] == original['ticks']
    assert marker.read_text() == 'uncommitted user material\n'
    assert not (home / 'state/research.meta').exists()


with tempfile.TemporaryDirectory(prefix='fm-external-') as temp:
    temp = Path(temp)
    home = temp / 'home'
    cwd = temp / 'user folder'
    run_dir = temp / 'agy-run'
    fakebin = temp / 'bin'
    for path in (home / 'state', home / 'data', cwd, run_dir, fakebin):
        path.mkdir(parents=True)
    (home / 'data/backlog.md').write_text('## In flight\n\n## Queued\n\n## Done\n')
    marker = cwd / 'private.txt'
    marker.write_text('uncommitted user material\n')
    shutil.copy2('/bin/sleep', fakebin / 'agy')
    env = {k: v for k, v in os.environ.items() if not k.startswith(('FM_', 'HERDR_', 'TASKS_AXI_'))}
    env.update(FM_HOME=str(home), PATH=str(fakebin) + ':' + os.environ['PATH'],
               FM_GATE_REFUSE_BYPASS='1', AR_RUN_DIR=str(run_dir),
               FM_CONTROL_POLL='0.1', FM_CONTROL_EXIT_WAIT='2', FM_CONTROL_SETTLE_WAIT='0',
               FM_SEND_SETTLE='0', FM_SEND_SLEEP='0.1', FM_SEND_RETRIES='1',
               FM_TASK_INBOX_GRACE_SECS='0')
    config = temp / 'herdr.json'
    log = temp / 'calls.jsonl'
    env.update(TEST_HERDR_CONFIG=str(config), TEST_HERDR_LOG=str(log))
    (fakebin / 'herdr').write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args=sys.argv[1:]
assert '--session' in args, args
n=args.index('--session'); session=args[n+1]; del args[n:n+2]
assert session == 'test-external', session
p=Path(os.environ['TEST_HERDR_CONFIG']); c=json.loads(p.read_text())
with open(os.environ['TEST_HERDR_LOG'],'a') as f: f.write(json.dumps(args)+'\\n')
a=dict(agent=c.get('family','agy'), agent_status=c.get('status','idle'), pane_id='w1:p2',tab_id=c.get('tab','w1:t2'),terminal_id=c.get('terminal','term-original'),cwd=c['cwd'],agent_session=c.get('native',dict(kind='id',value=c.get('session','child-1'))))
if args[0]=='status': out={'server':{'running':True,'compatible':True}}
elif args[:2]==['workspace','list']: out={'result':{'workspaces':[{'workspace_id':'w1','label':'Test'}]}}
elif args[:2]==['pane','list']: out={'result':{'panes':[{'pane_id':'w1:p2','tab_id':'w1:t2'}]}}
elif args[:2]==['pane','process-info']:
    assert args[args.index('--pane')+1]=='w1:p2'
    out={'result':{'type':'pane_process_info','process_info':{'pane_id':'w1:p2','shell_pid':c['pid'],'foreground_processes':[{'pid':c['pid'],'name':'agy'}]}}}
elif args[:2]==['agent','get']: out={'result':{'agent':a}}
elif args[:2]==['pane','get']: out={'result':{'pane':{'pane_id':'w1:p2','workspace_id':'w1','tab_id':a['tab_id'],'terminal_id':a['terminal_id'],'cwd':c['cwd'],'is_dead':False}}}
elif args[:2]==['pane','read']: out={'result':{'text':'❯ ','content':'❯ '}}
elif args[:2] in (['pane','send-text'],['pane','send-keys'],['pane','run']):
    if args[1]=='send-text':
        if c.get('protocol_switch'):
            c['terminal']='replacement'; p.write_text(json.dumps(c))
            print('protocol_mismatch',file=sys.stderr); raise SystemExit(1)
        c['typed']=args[-1]
        if c.get('switch_after_text'): c['terminal']='replacement'
    if args[1]=='send-keys' and c.get('typed')=='/quit':
        os.kill(c['pid'],15)
    p.write_text(json.dumps(c)); out={'result':{}}
else: raise SystemExit('unexpected operation: '+repr(args))
print(json.dumps(out))
''')
    (fakebin / 'herdr').chmod(0o755)
    agent = subprocess.Popen([str(fakebin / 'agy'), '300'], cwd=cwd, env=env)
    replacement = None
    try:
        original = process_sample(agent.pid)
        assert original
        parent = run_dir / 'known-parent.json'
        save(parent, {'id': 'parent-1', 'cwd': str(cwd), 'child': False})
        save(run_dir / 'child.json', {'id': 'child-1', 'cwd': str(cwd), 'child': True})
        save(run_dir / 'misleading-child.json', {'id': 'child-1', 'cwd': str(cwd), 'child': False})
        save(config, {'pid': agent.pid, 'cwd': str(cwd)})
        discovery = json.loads(attach('discover', '--session', 'test-external').stdout)
        assert len(discovery) == 1 and discovery[0]['family'] == 'agy' and discovery[0]['task'] is None
        inspect = ['inspect', '--session', 'test-external', '--pane', 'w1:p2', '--pid', str(agent.pid)]
        attach(*inspect, '--parent-record', parent, ok=False)  # no parent inference
        attach(*inspect, '--parent-record', run_dir / 'misleading-child.json', '--native-session', 'parent-1', ok=False)
        selection = temp / 'selection.json'
        selection.write_text(attach(*inspect, '--parent-record', parent, '--native-session', 'parent-1').stdout)
        source = temp / 'authorization.txt'; source.write_text('explicit user instruction for this process')
        output = cwd / 'handoff.md'; output.write_text('initial result')
        proposed = temp / 'criteria.txt'; proposed.write_text('Verified research results with human acceptance')
        observer = home / 'state/existing-research.check.sh'
        observer.write_text('#!/usr/bin/env bash\nexit 0\n'); observer.chmod(0o700)
        call(['bash', ROOT / 'bin/fm-check-register.sh', 'existing-research'])
        observer_files = [observer, home / 'state/existing-research.check-trust']
        observer_before = [(p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns) for p in observer_files]
        args = ['attach', 'research', '--selection', selection, '--source-file', source, '--dod-file', proposed,
                '--title', 'Исследование', '--human-required', '--observe-file', output,
                '--existing-check', 'existing-research']
        first = json.loads(attach(*args).stdout)
        second = json.loads(attach(*args).stdout)
        assert first == second and first['receipt'] is False and first['dod_confirmed'] is False
        b = json.loads((home / 'state/research.external.json').read_text())
        assert b['origin'] == 'existing-external-process' and not {'spawn_gen', 'worktree'} & b.keys()
        assert b['existing_check'] == 'existing-research'
        assert not (home / 'state/external-research.check.sh').exists()
        assert [(p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns) for p in observer_files] == observer_before
        unchanged()
        assert json.loads(attach('discover', '--session', 'test-external').stdout) == []
        assert state()['identity'] == 'verified' and state()['activity'] == 'unknown'  # child status
        cfg(session='another-child', status='done')
        assert state()['identity'] == 'verified' and state()['state'] == 'unknown'
        # Partial registration recovery does not mint another task/case/revision.
        b['phase'] = 'prepared'; save(home / 'state/research.external.json', b)
        assert json.loads(attach(*args).stdout)['revision'] == first['revision']
        tasks = call([ROOT / 'bin/fm-tasks-axi.sh', 'list', '--fields', 'body']).stdout
        assert tasks.startswith('count: 2\n'), tasks
        call([ROOT / 'bin/fm-send.sh', 'research', 'plain instruction through the existing inbox'])
        pending = list((home / 'state/research.inbox').glob('*.msg'))
        assert len(pending) == 1 and 'plain instruction' in pending[0].read_text()
        assert 'FM_TASK_INBOX' not in env  # An attached process never received a Firstmate launch brief/env.
        initial_ring = json.loads(config.read_text())['typed']
        assert str(pending[0].parent) in initial_ring, initial_ring
        assert '$FM_TASK_INBOX' not in initial_ring and 'plain instruction' not in initial_ring
        assert 'numeric order' in initial_ring and 'handled/' in initial_ring
        ring = '. "$1/bin/fm-task-inbox-lib.sh"; fm_task_inbox_ring herdr test-external:w1:p2 "$2"'
        call(['bash', '-c', ring, 'test', ROOT, pending[0]])
        assert json.loads(config.read_text())['typed'] == initial_ring, 'watcher re-ring must carry the same absolute inbox'
        assert pending[0].exists(), 'a re-ring is neither another record nor an acknowledgement'
        # Absolute paths retain the shell no-op guarantee, including quotes and shell syntax.
        hostile = temp / "operator's home; touch marker; #" / 'task.inbox'
        hostile.mkdir(parents=True)
        record = hostile / '001.msg'; record.write_text('pending')
        line = '. "$1/bin/fm-task-inbox-lib.sh"; fm_task_inbox_doorbell_line "$2" "$3"'
        quoted_ring = call(['bash', '-c', line, 'test', ROOT, record, hostile]).stdout
        assert call(['bash', '-c', quoted_ring], cwd=temp).stdout == ''
        assert not (temp / 'marker').exists() and record.read_text() == 'pending'
        call(['bash', '-c', line, 'test', ROOT, pending[0], hostile], ok=False)
        alias = temp / 'alias.inbox'; alias.symlink_to(hostile, target_is_directory=True)
        assert "'alias.inbox' steering inbox" in call(['bash', '-c', line, 'test', ROOT, alias / record.name, '']).stdout
        call(['bash', '-c', line, 'test', ROOT, alias / record.name, hostile])
        handled = pending[0].parent / 'handled'; handled.mkdir(exist_ok=True)
        pending[0].rename(handled / pending[0].name)
        # Receipt is separate from binding and native done; only explicit evidence is recorded.
        ack = temp / 'receipt.txt'; ack.write_text('Agent acknowledgment: RECEIPT_01')
        attach('receipt', 'research', '--file', ack, '--token', 'MISSING', '--format', 'ack-file', '--ack', 'Agent acknowledgment:', ok=False)
        attach('receipt', 'research', '--file', ack, '--token', 'RECEIPT_01', '--format', 'ack-file', '--ack', 'Agent acknowledgment:')
        assert state()['receipt'] is True and state()['completion']['achieved'] is False
        attach('observe', 'research')
        assert attach('observe', 'research').stdout == ''
        output.write_text('new research result without any status transition')
        assert 'external-observation.json' in attach('observe', 'research').stdout
        assert attach('observe', 'research').stdout == ''
        # All identity fields are independent guards; reading errors are not proven restart.
        for field, value in (('terminal', 'other'), ('tab', 'w1:other'), ('cwd', str(temp))):
            saved = cfg(**{field: value})
            assert state()['identity'] != 'verified'
            before = log.read_text()
            call([ROOT / 'bin/fm-send.sh', 'research', '--key', 'Enter'], ok=False)
            call([ROOT / 'bin/fm-control.sh', 'research', 'interrupt'], ok=False)
            extra = log.read_text()[len(before):]
            assert 'send-keys' not in extra and 'send-text' not in extra
            cfg(**{field: 'term-original' if field == 'terminal' else 'w1:t2' if field == 'tab' else str(cwd)})
        cfg(session='parent-1', status='idle')
        expected_binding = json.loads((home / 'state/research.external.json').read_text())
        for key, value in (('ticks', '0'), ('identity_paths', ['/another/executable'])):
            changed = json.loads(json.dumps(expected_binding)); changed['identity'][key] = value
            save(home / 'state/research.external.json', changed)
            assert state()['identity'] != 'verified'
            attach('verify', 'research', ok=False)
        save(home / 'state/research.external.json', expected_binding)
        # A submit retry after a mid-send endpoint replacement must not press Enter.
        cfg(switch_after_text=True)
        before = len(log.read_text().splitlines())
        command = '. "$1/bin/fm-backend.sh"; export FM_EXTERNAL_BINDING="$FM_HOME/state/research.external.json"; fm_backend_source herdr; fm_backend_herdr_send_literal test-external:w1:p2 hello; fm_backend_herdr_send_key test-external:w1:p2 Enter'
        call(['bash', '-c', command, 'test', ROOT], ok=False)
        lines = [json.loads(l) for l in log.read_text().splitlines()[before:]]
        assert sum(l[:2] == ['pane', 'send-text'] for l in lines) == 1
        assert not any(l[:2] == ['pane', 'send-keys'] for l in lines)
        cfg(terminal='term-original', switch_after_text=False, typed='')
        cfg(protocol_switch=True)
        before = len(log.read_text().splitlines())
        command = '. "$1/bin/fm-backend.sh"; export FM_EXTERNAL_BINDING="$FM_HOME/state/research.external.json"; fm_backend_source herdr; fm_backend_herdr_client_select() { FM_BACKEND_HERDR_BIN=herdr-second; FM_BACKEND_HERDR_CLIENT_SESSION=$1; }; fm_backend_herdr_cli test-external pane send-text w1:p2 hello'
        call(['bash', '-c', command, 'test', ROOT], ok=False)
        lines = [json.loads(l) for l in log.read_text().splitlines()[before:]]
        assert sum(l[:2] == ['pane', 'send-text'] for l in lines) == 1
        cfg(terminal='term-original', protocol_switch=False)

        # Public ring interface refuses an old inbox recipient, retaining the record.
        record = home / 'state/research.inbox/001.msg'
        record.parent.mkdir(exist_ok=True); record.write_text('schema=fm-task-inbox.v1\nat=now\n--\nmessage')
        replacement = subprocess.Popen([str(fakebin / 'agy'), '300'], cwd=cwd, env=env)
        cfg(pid=replacement.pid)
        before = len(log.read_text().splitlines())
        ring = '. "$1/bin/fm-task-inbox-lib.sh"; fm_task_inbox_ring herdr test-external:w1:p2 "$2"'
        call(['bash', '-c', ring, 'test', ROOT, record], ok=False)
        assert record.exists()
        assert not any(json.loads(l)[:2] in (['pane', 'send-text'], ['pane', 'send-keys']) for l in log.read_text().splitlines()[before:])
        cfg(pid=agent.pid)
        # Native idle/done and receipt never open exit without confirmed/evidenced DoD.
        call([ROOT / 'bin/fm-control.sh', 'research', 'exit'], ok=False)
        call([ROOT / 'bin/fm-control.sh', 'research', 'relaunch', '--note', 'test'], ok=False)
        call([ROOT / 'bin/fm-teardown.sh', 'research'], ok=False)
        call([ROOT / 'bin/fm-merge-local.sh', 'research'], ok=False)
        unchanged()
        version = state()['completion']['version']
        proof = temp / 'answer.txt'; proof.write_text('User explicitly confirmed this exact criterion.')
        attach('dod', 'research', 'confirm', '--file', proof, '--version', 'wrong', ok=False)
        attach('dod', 'research', 'confirm', '--file', proof, '--version', version)
        attach('exit-gate', 'research', ok=False)
        proof.write_text('Results reviewed with exact evidence.')
        attach('dod', 'research', 'achieve', '--file', proof, '--version', version)
        attach('exit-gate', 'research', ok=False)  # human acceptance still missing
        proof.write_text('User accepted the results.')
        attach('dod', 'research', 'accept', '--file', proof, '--version', version)
        attach('exit-gate', 'research')
        # DoD revisions invalidate every prior confirmation, including human acceptance.
        proposed.write_text('A different, explicitly revised criterion.')
        attach('dod', 'research', 'propose', '--file', proposed)
        attach('exit-gate', 'research', ok=False)
        assert state()['completion']['confirmed'] is False
        # Stop externally (not a controller side effect): records and files survive.
        agent.terminate(); agent.wait(timeout=5)
        assert state()['presence'] == 'stopped' and state()['state'] == 'stopped'
        assert marker.exists() and (home / 'state/research.external.json').exists()
        # Acceptance after external stop must never require relaunching the target.
        version = state()['completion']['version']
        attach('dod', 'research', 'confirm', '--file', proof, '--version', version)
        attach('dod', 'research', 'achieve', '--file', proof, '--version', version)
        call([ROOT / 'bin/fm-control.sh', 'research', 'exit'])
        assert state()['state'] == 'done'
        snapshot = json.loads(attach('snapshot').stdout)
        assert snapshot[0]['kind'] == 'external' and snapshot[0]['external']['observation']['completion']['achieved']
        assert not snapshot[0].get('spawn_gen') and not snapshot[0]['paths'].get('worktree')
        spec = importlib.util.spec_from_file_location('collector', ROOT / 'bin/fm-workers-status.py')
        collector = importlib.util.module_from_spec(spec); spec.loader.exec_module(collector)
        report = collector.render({'schema': 'fm-fleet-snapshot.v1', 'tasks': snapshot, 'attachable': discovery}, {'research': ('no-agent', None)})
        assert 'Сделано: 1' in report and 'Можно подключить' in report and 'задача неизвестна' in report
        # A Pi user prompt is not a receipt; the assistant reply must belong to its bound native session.
        shutil.copy2('/bin/sleep', fakebin / 'pi')
        pi = subprocess.Popen([str(fakebin / 'pi'), '300'], cwd=cwd, env=env)
        try:
            session = temp / 'pi-session.jsonl'
            session.write_text(json.dumps({'type': 'message', 'message': {'role': 'user', 'content': [{'text': 'PI_TOKEN'}]}}) + '\n')
            cfg(pid=pi.pid, family='pi', native={'kind': 'path', 'value': str(session)})
            selection.write_text(attach('inspect', '--session', 'test-external', '--pane', 'w1:p2', '--pid', str(pi.pid)).stdout)
            source.write_text('New explicit Pi authorization for this selected process.')
            pi_args = ['attach', 'pi-research', '--selection', selection, '--source-file', source, '--dod-file', proposed, '--title', 'Pi']
            controller_lock = home / 'state/.lock'
            controller_lock.write_text(str(pi.pid) + '\n')
            assert json.loads(attach('discover', '--session', 'test-external').stdout) == []
            attach(*pi_args, ok=False)
            controller_lock.unlink()
            attach(*pi_args)
            attach('receipt', 'pi-research', '--file', session, '--token', 'PI_TOKEN', '--format', 'pi', ok=False)
            with session.open('a') as out:
                out.write(json.dumps({'type': 'message', 'message': {'role': 'assistant', 'content': [{'text': 'PI_TOKEN received'}]}}) + '\n')
            attach('receipt', 'pi-research', '--file', session, '--token', 'PI_TOKEN', '--format', 'pi')
            cfg(native={'kind': 'path', 'value': str(temp / 'another-session.jsonl')})
            assert state('pi-research')['identity'] == 'lost'
            cfg(native={'kind': 'path', 'value': str(session)})
            # Returning to the old session does not restore a grant lost after a native session change.
            assert state('pi-research')['identity'] == 'lost'
            call([ROOT / 'bin/fm-send.sh', 'pi-research', '--key', 'Enter'], ok=False)
            pi_args[1] = 'pi-research-new-grant'
            attach(*pi_args, ok=False)
            source.write_text('New explicit instruction after the observed native session change.')
            attach(*pi_args)
            assert state('pi-research-new-grant')['identity'] == 'verified'
        finally:
            pi.terminate(); pi.wait(timeout=5)
        print('ok: exact identity, AGY parent ambiguity, idempotent case/task, receipt/state, re-ring/submit guards, DoD and external file preservation')
    finally:
        if agent.poll() is None:
            agent.terminate(); agent.wait(timeout=5)
        if replacement and replacement.poll() is None:
            replacement.terminate(); replacement.wait(timeout=5)
