#!/usr/bin/env python3
"""Small offline fixture: presence split, done proof, authority, decision owner, escaping, and collection errors."""
import importlib.util
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import time

spec = importlib.util.spec_from_file_location('workers_status', Path(__file__).resolve().parents[1] / 'bin/fm-workers-status.py')
m = importlib.util.module_from_spec(spec)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bin'))
spec.loader.exec_module(m)
ARTIFACT = Path(tempfile.gettempdir())
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'


def task(state, exists=True, **extra):
    return dict(id=state, current_state={'state': state}, endpoint={'exists': exists}, **extra)


rows = [task(s) for s in ('working', 'parked', 'paused', 'blocked', 'done', 'ready', 'failed', 'stopped')]
rows += [task('unknown', None, paths={'status_log': {'last_event': {'state': 'working', 'age_seconds': 999999}}}),
         task('gone', False), task('checking', current='unused')]
rows[-1]['current_state'] = {'state': 'working', 'source': 'run-step', 'detail': 'validating (running)'}
rows[1]['current_state']['source'] = 'run-step'
rows[1]['current_state']['detail'] = 'parked at review · ask-user: authority decision · run: R1'
rows[1]['hints'] = {'pending_decision': True}
rows[3]['backlog'] = {'unresolved_blocker_ids': ['upstream']}
rows[0]['backlog'] = {'repo': 'Demo', 'title': 'Demo: Title | <tag> [link](x) `code`\nnext'}
snapshot = {'schema': 'fm-fleet-snapshot.v1', 'generated': 'fixture', 'tasks': rows}
presence = {'working': ('agent', None), 'parked': ('agent', None), 'unknown': ('no-agent', None),
            'gone': ('no-pane', None), 'checking': ('agent', None)}
decisions = {'parked': True}
report = m.render(snapshot, presence, decisions=decisions)
launched, retained = report.split('## Сохранённые записи без подтверждённого агента')
assert report.startswith('Запущено агентов: 3. Незавершённых записей без подтверждённого агента: 8 '
                         '(агента нет: 1; панели нет: 1; присутствие не подтверждено: 6). Сделано: 0. '
                         'Заявлено готовым без доказательства доставки: 0.')
assert 'Всего записей: 11; открытых панелей по срезу: 9.' in report
assert launched.count('| Проект | Работник и задача | Статус |') == retained.count('| Проект | Работник и задача | Статус |') == 1
# Markdown: escaping, three columns, every record in exactly one table.
assert '| Demo | Title &#124; &lt;tag&gt; \\[link\\](x) \\`code\\` next | Работает |' in launched
assert all(len(line.split(' | ')) == 3 for line in report.splitlines() if line.startswith('| '))
body = [line for line in report.splitlines() if line.startswith('| ') and not line.startswith(('| Проект', '| ---'))]
assert len(body) == len(rows) and 'gone' not in launched
# Idle/waiting agent with a proved process stays launched; its owner semantics stay.
assert '| parked | Ожидает решения — требуется решение координатора |' in launched
# Stale status: a working event is history, never a launch or a current phase.
assert ('| unknown | Активность не подтверждена; последнее событие: Работает (999999 с назад); '
        'агента нет: панель без работающего агента |') in retained
assert '| gone | Активность не подтверждена; агента нет: панель закрыта или её сервер остановлен |' in retained
# Unknown presence is explicit and never reported as an absent agent.
assert '| done | Готово; присутствие агента не подтверждено: проверка не выполнялась |' in retained
assert not [line for line in retained.splitlines() if 'не подтверждено' in line and 'агента нет' in line]
assert m.status(rows[-1]) == 'Проверки'
# Decision owner: the coordinator only while the owner holds an open decision
# bound to this gate's run; a resolved decision followed by a declared wait is not
# an unanswered coordinator question, and an unproved owner is said to be so.
assert m.status(rows[1], gate=True) == 'Ожидает решения — требуется решение координатора'
answered = dict(rows[1], hints={'pending_decision': False, 'open_decisions': []})
assert m.status(answered, gate=False) == ('Проверки приостановлены — открытый вопрос координатору по этой проверке '
                                          'не записан; ответственный не подтверждён')
# An unrelated open decision (another run's key, a stale question) stays visible, unowned.
view = m.status(rows[1], gate=False)
assert view.startswith('Проверки приостановлены — ') and view.endswith('ответственный не подтверждён; открыто решение — ответственный не указан')
for gate, hints in ((None, rows[1]['hints']), (True, {})):  # unchecked, or the snapshot disagrees
    view = m.status(dict(rows[1], hints=hints), gate=gate)
    assert view.startswith('Проверки приостановлены — ответственный не подтверждён') and 'координатор' not in view, view
norun = dict(rows[1], current_state=dict(rows[1]['current_state'], detail='parked at review · ask-user: authority decision'))
assert m.gate_run(norun) == '' and m.status(norun, gate=True) == 'Проверки приостановлены — ответственный не подтверждён'
lookalike = dict(rows[1], current_state=dict(rows[1]['current_state'], detail='parked · ask-user: authority decisions · run: R1'))
assert m.gate_run(lookalike) is None
user_gate = dict(rows[1], backlog={'captain_actionable': True})
assert m.status(user_gate, gate=True) == m.status(user_gate) == 'Ожидает решения — требуется решение пользователя'
assert 'координатора' not in m.status(user_gate)
unknown_gate = dict(rows[1], current_state=dict(rows[1]['current_state'], source='pane'))
assert 'ответственный не указан' in m.status(unknown_gate)
for prefix in ('Дело', 'Зодчий', 'Firstmate'):
    named = task('working', backlog={'repo': 'internal-repo', 'title': prefix + ': Понятная задача'})
    view = m.render(dict(snapshot, tasks=[named]), {'working': ('agent', None)})
    assert f'| {prefix} | Понятная задача | Работает |' in view
    assert 'internal-repo' not in view
assert 'зависит от: upstream' in m.status(rows[3])
assert 'открыто решение' in m.status(task('unknown', hints={'pending_decision': True}))
assert m.status(task('parked')) == 'Ожидает решения — ответственный не указан'
assert m.status(task('unknown', paths={'status_log': {'last_event': {'state': 'done'}}})).endswith('(время неизвестно)')
for state, label in m.LABELS.items():
    assert m.status(task(state)).startswith(label)
# A proved agent with unknown phase says so; the event stays labelled history.
assert m.status(rows[8], launched=True) == 'Агент запущен; этап задачи не подтверждён; последнее событие: Работает (999999 с назад)'
empty = m.render(dict(snapshot, tasks=[]))
assert empty.startswith('Запущено агентов: 0. Незавершённых записей без подтверждённого агента: 0') and empty.count('Нет.') == 3

# One offline family exercises the complete installed launcher/family/process
# seam. Native test binaries are copies of sleep; no model or vendor is invoked.
started = time.time()
me = int(os.readlink('/proc/self'))
native = m.process_sample(me)
assert native and native['start'] <= started
gen = f"s{int(native['start']) - 10}.1.2"
live = dict(task('working'), id='live', backend='herdr', harness='claude', kind='ship', remote=None,
            spawn_gen=gen, endpoint={'exists': True, 'target': 'default:w1:p1'},
            paths={'worktree': {'path': native['cwd']}})
agent = dict(native, kind='agent', harness='claude')


def row(agent_state='alive', procs=(agent,), **extra):
    return dict(dict(id='live', gen=gen, after=gen, target='default:w1:p1', target_after='default:w1:p1',
                     recorded='claude', harness_after='claude', family='claude', tree_complete=True,
                     agent=agent_state, worktree=native['cwd'], worktree_after=native['cwd'], procs=list(procs)), **extra)


assert m.judge(live, row(), started) == ('agent', None)
assert m.judge(live, row('dead', ()), started) == ('no-agent', None)
assert m.judge(live, row('missing', ()), started) == ('no-pane', None)
assert m.judge(live, row('unknown', ()), started)[0] == 'unknown'
assert m.judge(live, row('dead', (), tree_complete=False), started)[0] == 'unknown'
assert m.judge(live, row('dead'), started)[0] == 'unknown'  # contradictory stock owner
assert m.judge(live, row('refused', (), target=''), started)[1] == 'запись панели не прошла проверку привязки'
for extra in ({'after': 's9.9.9'}, {'gen': 's9.9.9'}, {'target_after': 'default:w1:p9'},
              {'target': 'default:w1:p9'}, {'harness_after': 'codex'}, {'family': ''}):
    assert m.judge(live, row(**extra), started)[0] == 'unknown', extra
assert m.judge(live, None, started)[0] == 'unknown'
for wrong in (dict(agent, kind='shell'), dict(agent, kind='other'), dict(agent, harness='codex'),
              dict(agent, cwd='/wtx'), dict(agent, cwd=None)):
    assert m.judge(live, row(procs=(wrong,)), started)[0] == 'unknown'
future = f's{int(started) + 1000}.1.2'
assert m.judge(dict(live, spawn_gen=future), row(gen=future, after=future), started)[1] == 'процесс не принадлежит текущему запуску'
assert m.judge(live, row(), native['start'] - 5)[1] == 'процесс не принадлежит текущему запуску'
assert m.judge(live, row(procs=(dict(agent, pid=2 ** 31),)), started)[1] == 'время старта процесса не прочитано'
assert m.judge(live, row(procs=(dict(agent, ticks='0'),)), started)[1] == 'PID или идентичность процесса сменились после чтения'
assert m.judge(live, row(procs=(dict(agent, cmdline_sha256='changed'),)), started)[1] == 'PID или идентичность процесса сменились после чтения'
for change, reason in ((dict(remote={'host': 'h'}), 'удалённая панель не проверяется'),
                       (dict(kind='secondmate'), 'второй помощник не проверяется'),
                       (dict(backend='tmux'), 'панель tmux не проверяется'),
                       (dict(spawn_gen=''), 'у записи нет метки запуска'),
                       (dict(endpoint={'exists': None}), 'адрес панели не записан')):
    assert m.unsupported(dict(live, **change)) == reason
    assert m.probe(dict(snapshot, tasks=[dict(live, **change)]), Path('/nonexistent'))[0]['live'] == ('unknown', reason)

with tempfile.TemporaryDirectory(dir=ARTIFACT) as directory:
    home = Path(directory)
    Path(home, 'live.meta').write_text(f'spawn_gen={gen}\nbackend=herdr\n')
    verdicts, probed = m.probe(dict(snapshot, roots={'state': directory}, tasks=[live]), home)
    assert probed['live']['agent'] == 'refused', probed
    assert verdicts['live'][0] == 'unknown'
    fake = home / 'bin'
    fake.mkdir()
    Path(fake, 'herdr').write_text('#!/usr/bin/env bash\ncase "$1 $2" in\n'
        """'pane get') echo '{"result":{"pane":{"pane_id":"w1:p1"}}}' ;;\n"""
        """'agent get') echo '{"result":{"agent":{"agent":"claude","agent_status":"idle"}}}' ;;\n"""
        """'pane process-info') cat "$FAKE_INFO" ;;\n*) exit 1 ;;\nesac\n""")
    Path(fake, 'herdr').chmod(0o755)
    info = home / 'info.json'
    saved = dict(os.environ)
    os.environ.update(PATH=f"{fake}:{os.environ['PATH']}", FAKE_INFO=str(info))
    processes = []

    def check(label, executable, expected, *, cwd=home, argv=None):
        proc = subprocess.Popen([str(executable), *(argv or ['60'])], cwd=cwd,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        processes.append(proc)
        # Popen may return just before exec. Wait for this exact owned child.
        for _ in range(100):
            sampled = m.process_sample(proc.pid)
            if sampled and sampled['identity_paths'][0] == str(executable):
                break
            time.sleep(.01)
        current_gen = f's{int(time.time()) - 2}.1.2'
        candidate = dict(live, harness=label, spawn_gen=current_gen,
                         paths={'worktree': {'path': str(home)}})
        Path(home, 'live.meta').write_text(
            f'window=default:w1:p1\nendpoint_task_id=live\nworktree={home}\nproject={home}\nharness={label}\n'
            f'spawn_gen={current_gen}\nbackend=herdr\nherdr_session=default\nherdr_workspace_id=w1\n'
            f'herdr_tab_id=w1:t1\nherdr_pane_id=w1:p1\n')
        info.write_text(json.dumps({'result': {'type': 'pane_process_info', 'process_info': {
            'pane_id': 'w1:p1', 'shell_pid': proc.pid, 'foreground_processes': [
                {'pid': proc.pid, 'name': sampled['name'], 'argv': sampled['identity_paths'][:1], 'cwd': str(cwd)}]}}}))
        seen, proof = m.probe(dict(snapshot, roots={'state': directory}, tasks=[candidate]), home)
        assert seen['live'][0] == expected, (label, seen, proof)
        proc.terminate(); proc.wait()
        return proof['live']

    try:
        # All installed verified adapter families, including signed Pi and DSH.
        for family in ('claude', 'codex', 'opencode', 'grok', 'kimi', 'pi', 'omp', 'agy',
                       'devin', 'muse', 'rovo', 'gemini', 'cursor'):
            binary = fake / ('cursor-agent' if family == 'cursor' else family)
            shutil.copyfile(shutil.which('sleep'), binary); binary.chmod(0o755)
            check(family, binary, 'agent')
        check('pi-signed', fake / 'pi', 'agent')
        check('claude', fake / 'codex', 'unknown')
        elsewhere = home / 'elsewhere'; elsewhere.mkdir()
        # Sibling cwd must not be accepted as a prefix of the task cwd.
        wrong = check('claude', fake / 'claude', 'agent', cwd=elsewhere)
        candidate = dict(live, spawn_gen=wrong['gen'], paths={'worktree': {'path': str(home / 'else')}})
        assert m.judge(candidate, wrong, time.time())[0] == 'unknown'
        wrapper = fake / 'bwrap'; shutil.copyfile(shutil.which('sleep'), wrapper); wrapper.chmod(0o755)
        check('codex', wrapper, 'unknown')
        node = fake / 'node'; shutil.copyfile(shutil.which('sleep'), node); node.chmod(0o755)
        check('codex', node, 'unknown')
        check('unverified-wrapper', fake / 'codex', 'unknown')
        # A private alias to a verified native executable is proved from its
        # canonical path and native process, never the alias's name.
        runtime = home / 'data/live/runtime'; runtime.mkdir(parents=True)
        (runtime / 'local-alias').symlink_to(fake / 'agy')
        check('local-alias', fake / 'agy', 'agent')
        # All four approved entrypoint aliases nominate through the family owner
        # and still require native proof. No approved launcher is executed here.
        for family in ('claude', 'codex', 'pi', 'agy'):
            entry = Path.home() / 'bin' / ('autoresearch-' + family)
            assert entry.is_file(), entry
            alias = family + '-autoresearch'
            (runtime / alias).symlink_to(entry)
            proof = check(alias, fake / family, 'agent')
            assert proof['launch']['path'] == str(entry) and proof['family'] == family, proof
            check(alias, wrapper, 'unknown')
        (runtime / 'raw-codex-wrapper').symlink_to(wrapper)
        check('raw-codex-wrapper', fake / 'codex', 'unknown')
        shell = fake / 'bash'; shutil.copyfile(shutil.which('bash'), shell); shell.chmod(0o755)
        proof = check('claude', shell, 'no-agent', argv=['-c', 'while :; do read -r -t 1; done'])
        # A native child behind a shell wrapper must be found without any
        # host-wide ps scan; unrelated children never supply an identity.
        check('codex', shell, 'agent', argv=['-c', '"$1" 60 & wait', 'wrapper', str(fake / 'codex')])
        # Interpreter script slots and package paths, with real token-free Node.
        node_bin = Path(subprocess.check_output(['node', '-p', 'process.execPath'], text=True, env=saved).strip())
        scripts = [('pi', home / 'scripts/pi'), ('pi-signed', home / 'scripts/pi-signed'),
                   ('cursor', home / 'cursor-agent/versions/fixture/cursor-agent'),
                   ('gemini', home / '@google/gemini-cli/bundle/gemini.js'),
                   ('dsh', home / '@deepseek-ai/dsh/lib/bin.js')]
        for label, script in scripts:
            script.parent.mkdir(parents=True, exist_ok=True)
            script.write_text('setInterval(() => {}, 1000);\n')
            check(label, node_bin, 'agent', argv=[str(script)])
        check('gemini', node_bin, 'agent', argv=['--max-old-space-size=64', str(home / '@google/gemini-cli/bundle/gemini.js')])
        titled = home / 'title.js'
        titled.write_text('process.title = "pi"; setInterval(() => {}, 1000);\n')
        check('pi', node_bin, 'agent', argv=[str(titled)])
        check('pi-signed', node_bin, 'agent', argv=[str(titled)])
        stranger = home / 'unrelated.js' ; stranger.write_text('setInterval(() => {}, 1000);\n')
        check('codex', node_bin, 'unknown', argv=[str(stranger), 'codex', 'claude'])
        bun = shutil.which('bun')
        if bun:
            check('pi', Path(bun).resolve(), 'agent', argv=[str(home / 'scripts/pi')])
        else:
            print('offline: Bun interpreter unavailable; Node script-slot cases exercised')
        # Missing installed owner is an explicit failed probe, never a launch.
        real_root = m.FIRSTMATE
        m.FIRSTMATE = home / 'absent-owner'
        assert m.probe(dict(snapshot, roots={'state': directory}, tasks=[live]), home)[0]['live'][0] == 'unknown'
        m.FIRSTMATE = real_root
    finally:
        for proc in processes:
            if proc.poll() is None:
                proc.terminate(); proc.wait()
        os.environ.clear(); os.environ.update(saved)
    evidence = home / 'evidence.json'
    evidence.write_text(json.dumps({'snapshot': snapshot, 'presence': presence, 'decisions': decisions}))
    result = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / 'bin/fm-workers-status.py'),
                             '--snapshot', str(evidence)], capture_output=True, text=True)
    assert result.returncode == 0 and result.stdout == report

# Done section: only a stopped record whose last event claims completion AND
# whose delivery is proved; everything else stays retained with its reason.
def claim(id, kind='ship', mode='local-only', state='unknown', event='done', **extra):
    return dict(id=id, kind=kind, mode=mode, branch=f'fm/{id}', current_state={'state': state},
                endpoint={'exists': True}, paths={'status_log': {'last_event': {'state': event}},
                                                  'report': {'present': kind == 'scout'}}, **extra)


url = 'https://github.com/o/r/pull/2'
cases = [claim('landed'), claim('pr2', mode='no-mistakes', state='done', pr={'url': url}),
         claim('parked', event='paused'), claim('live'), claim('working', state='working'),
         claim('gone'), claim('scout', kind='scout', mode=''), claim('noreport', kind='scout', mode='', report=None),
         claim('held', backlog={'captain_actionable': True}), claim('mate', kind='secondmate'),
         claim('merged', mode='direct-PR', pr={'url': url}), claim('unproved'),
         claim('unreviewed', kind='scout', mode='')]
cases[7]['paths']['report']['present'] = False
seen = {t['id'] for t in cases}
verdicts = {i: ('no-agent', None) for i in seen} | {'live': ('agent', None), 'unproved': ('unknown', 'x')}
delivery = {'landed': {'proof': 'landed', 'dirty': '2', 'default': 'main'},
            'pr2': {'proof': 'unmerged'}, 'gone': {'proof': 'unavailable'},
            'held': {'proof': 'landed', 'dirty': '0', 'default': 'main'},
            'merged': {'proof': 'landed'}, 'unproved': {'proof': 'landed', 'dirty': '0', 'default': 'main'},
            'scout': {'proof': 'landed'}, 'unreviewed': {'proof': 'unverified'}}
assert {t['id'] for t in cases if m.claimed(t, verdicts[t['id']][0])} == seen - {'parked', 'live', 'working', 'unproved'}
view = m.render(dict(snapshot, tasks=cases), verdicts, delivery)
launched, rest = view.split('## Сохранённые записи без подтверждённого агента')
retained, done = rest.split('## Сделано')
assert ('Незавершённых записей без подтверждённого агента: 9 (агента нет: 8; панели нет: 0; '
        'присутствие не подтверждено: 1). Сделано: 3. Заявлено готовым без доказательства доставки: 4.') in view
assert ('| Неизвестен | landed | Сделано: ветка fm/landed влита в main; рабочая копия задачи сохраняет '
        'незакоммиченных путей: 2, они не входят в доставленное |') in done
assert f'| Неизвестен | merged | Сделано: PR {url} слит |' in done
assert '| Неизвестен | scout | Сделано: отчёт принят проверкой завершения |' in done
assert f'| pr2 | Готово; ожидает слияния: PR {url} не слит; агента нет' in retained
assert '| parked | Активность не подтверждена; последнее событие: Ожидание' in retained
assert '| live | Агент запущен; этап задачи не подтверждён; последнее событие: Готово' in launched
assert '| working | Работает; агента нет' in retained
assert 'gone | Активность не подтверждена; последнее событие: Готово (время неизвестно); доказательство доставки недоступно: ветка' in retained
assert 'noreport | Активность не подтверждена; последнее событие: Готово (время неизвестно); доказательство доставки недоступно: отчёт не найден' in retained
assert 'held | Активность не подтверждена; последнее событие: Готово (время неизвестно); доставлено, но запись ждёт решения пользователя' in retained
assert 'mate | Активность не подтверждена; последнее событие: Готово (время неизвестно); доказательство доставки недоступно: запись другого дома' in retained
# Unproved absence never counts as stopped, even with a landed branch; an
# unreviewed report is not done.
assert '| unproved | Активность не подтверждена; последнее событие: Готово (время неизвестно); присутствие агента не подтверждено: x |' in retained
assert 'unreviewed | Активность не подтверждена; последнее событие: Готово (время неизвестно); доказательство доставки недоступно: проверка завершения отчёта не пройдена' in retained
body = [line for line in view.splitlines() if line.startswith('| ') and not line.startswith(('| Проект', '| ---'))]
assert len(body) == len(cases) and done.count('| Неизвестен |') == 3

# The real delivery bash over a scratch repository and PR marker: landed,
# not yet landed, no task commits, uncommitted paths, merged and unmerged PR.
with tempfile.TemporaryDirectory(dir=ARTIFACT) as directory:
    git = lambda *a, cwd=directory: subprocess.run(['git', '-C', cwd, *a], check=True, capture_output=True, text=True)
    repo, wt, state = f'{directory}/repo', f'{directory}/wt', f'{directory}/state'
    os.makedirs(repo)
    os.makedirs(state)
    git('init', '-q', '-b', 'main', cwd=repo)
    env = ['-c', 'user.name=t', '-c', 'user.email=t@t']
    git(*env, 'commit', '-q', '--allow-empty', '-m', 'base', cwd=repo)
    git('clone', '-q', repo, wt, cwd=directory)
    git('checkout', '-q', '-b', 'fm/a', cwd=wt)
    git('branch', 'fm/a', cwd=repo)
    git('branch', 'fm/empty', cwd=repo)
    git(*env, 'commit', '-q', '--allow-empty', '-m', 'task', cwd=wt)
    git('fetch', '-q', wt, 'fm/a:fm/a', cwd=repo)
    Path(wt, 'note').write_text('x')
    ship = lambda id, branch: dict(claim(id), project=repo, branch=branch, paths={'worktree': {'path': wt},
                                   'status_log': {'last_event': {'state': 'done'}}})
    pr = lambda id: dict(claim(id, mode='no-mistakes'), pr={'url': url})
    snap = dict(snapshot, roots={'state': state}, tasks=[ship('a', 'fm/a'), ship('e', 'fm/empty'), pr('p'), pr('q')])
    plain = {t['id']: ('no-agent', None) for t in snap['tasks']}
    rows = m.landed(snap, Path(directory), plain)
    assert (rows['a']['proof'], rows['a']['dirty']) == ('unlanded', '1'), rows
    assert rows['e']['proof'] == 'empty' and rows['p']['proof'] == 'unmerged', rows
    git('fetch', '-q', wt, 'fm/a:fm/a', cwd=repo)
    git('merge', '-q', '--ff-only', 'fm/a', cwd=repo)
    Path(state, 'p.pr-poll-merge-notified').write_text('fm-pr-poll-merge-notified-v1\ngithub\ngithub.com\no/r\n2\n')
    Path(state, 'p.pr-poll-merge-notified').chmod(0o600)
    rows = m.landed(snap, Path(directory), plain)
    assert rows['a'] == {'id': 'a', 'proof': 'landed', 'dirty': '1', 'default': 'main'}, rows
    assert rows['p']['proof'] == 'landed' and rows['q']['proof'] == 'unmerged', rows
    assert m.landed(snap, Path(directory), dict(plain, a=('agent', None))).keys() == {'e', 'p', 'q'}
    # An unrecorded project or worktree never falls back to the current directory.
    blank = dict(ship('b', 'fm/a'), project='', paths={'worktree': {'path': ''}, 'status_log': {'last_event': {'state': 'done'}}})
    assert m.landed(dict(snap, tasks=[blank]), Path(directory), {'b': ('no-agent', None)})['b']['proof'] == 'unavailable'
    # A scout with no recorded completion inventory fails the owner's read-only verify.
    scout = claim('s', kind='scout', mode='')
    assert m.landed(dict(snap, tasks=[scout]), Path(directory), {'s': ('no-agent', None)})['s']['proof'] == 'unverified'

# The owner's run-bound fold over scratch status logs (real fm-classify-lib.sh).
with tempfile.TemporaryDirectory(dir=ARTIFACT) as directory:
    asked = 'needs-decision [at=1] [key=nm-R1-ci]: ask-user findings=ci-1'
    logs = {'answered': [asked, 'resolved [key=nm-R1-ci] [at=2]: answered', 'paused [at=3]: waiting for a dependency'],
            'open': [asked, 'paused [at=2]: waiting for a dependency'],
            'other': ['needs-decision [at=1] [key=nm-R0-ci]: older run', 'needs-decision [at=2] [key=plan]: unrelated'],
            'resolved-other': ['needs-decision [at=1] [key=nm-R0-ci]: old', 'resolved [key=nm-R0-ci] [at=2]: ok', asked]}
    logs['newer'] = logs['answered'] + ['needs-decision [at=4] [key=nm-R1-ci-2]: ask-user findings=ci-2']
    logs['moved'] = logs['open']
    for id, lines in logs.items():
        Path(directory, id + '.status').write_text('\n'.join(lines) + '\n\n')
    os.symlink(Path(directory, 'open.status'), Path(directory, 'linked.status'))
    gate_task = lambda id, last=None: dict(snapshot['tasks'][1], id=id, paths={'status_log': {'last_event': {
        'raw': logs.get(id, logs['open'])[-1] if last is None else last}}})
    tasks = [gate_task(i) for i in logs if i != 'moved'] + [gate_task('moved', 'an older last line'), gate_task('linked'),
                                                             gate_task('missing'), dict(gate_task('open'), id='plain', current_state={'state': 'parked'})]
    snap = dict(snapshot, roots={'state': directory}, tasks=tasks)
    assert m.gates(snap, Path(directory)) == {'answered': False, 'open': True, 'other': False,
                                              'resolved-other': True, 'newer': True}
    real_root = m.FIRSTMATE
    m.FIRSTMATE = Path(directory) / 'absent-owner'
    assert m.gates(snap, Path(directory)) == {}
    m.FIRSTMATE = real_root

try:
    m.render(dict(snapshot, schema='future'))
    raise AssertionError('unsupported schema accepted')
except ValueError:
    pass
with tempfile.TemporaryDirectory(dir=ARTIFACT) as directory:
    bad = Path(directory) / 'bad.json'
    bad.write_text('{')
    result = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / 'bin/fm-workers-status.py'),
                             '--snapshot', str(bad)], capture_output=True, text=True)
    assert result.returncode == 1 and not result.stdout and 'workers-status:' in result.stderr
print('self-check: installed adapter and four autoresearch alias seam, native/wrapper/shell/node, PID/generation, unavailable owner, '
      'run-bound decision owner (answered wait, open, unrelated, newer gate, moved log), retained/Done/held/Markdown passed')
