#!/usr/bin/env python3
"""Task-scoped external Herdr bindings; fm-attach.sh owns the command contract."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import uuid

from fm_agent_process import process_sample, pane_sample

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = 'fm-external-session.v1'
DOD = 'External DoD: '


class IdentityMismatch(ValueError):
    pass


def stamp():
    return datetime.now(timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def read_json(path, limit=1024 * 1024):
    path = Path(path)
    if path.is_symlink() or path.stat().st_size > limit:
        raise ValueError(f'недопустимый файл: {path}')
    return json.loads(path.read_text())


def evidence(path, token=None):
    path = Path(path).resolve(strict=True)
    if not path.is_file() or path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError('источник подтверждения не прочитан в пределах 16 MiB')
    raw = path.read_bytes()
    if not raw.strip() or (token is not None and token.encode() not in raw):
        raise ValueError('нет точного подтверждения в указанном источнике')
    return {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest(), 'at': stamp()}


def atomic(path, value):
    path = Path(path)
    if path.is_symlink():
        raise ValueError(f'отказ записи через symlink: {path}')
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out, ensure_ascii=False, indent=2)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def run(args, **kw):
    return subprocess.run([str(a) for a in args], check=True, capture_output=True,
                          text=True, timeout=30, **kw).stdout


def herdr(session, *args):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+', session):
        raise ValueError('недопустимая Herdr session')
    # Experiments use the mandatory lab helper, including all read operations.
    if session.startswith('fm-lab-'):
        helper = os.environ.get('FM_HERDR_LAB_HELPER', str(ROOT / 'bin/fm-herdr-lab.sh'))
        cmd = [helper, 'run', session, *args]
    else:
        cmd = [os.environ.get('FM_BACKEND_HERDR_BIN', 'herdr'), '--session', session, *args]
    return json.loads(run(cmd))


def classified(samples):
    if not samples:
        return []
    rows = run(['bash', ROOT / 'bin/fm-agent-process-probe.sh'], input=json.dumps(samples))
    return [json.loads(line) for line in rows.splitlines()]


def host_identity():
    return {'host': Path('/etc/machine-id').read_text().strip(),
            'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}


def pane_observation(session, pane, require_agent=True):
    info = herdr(session, 'pane', 'process-info', '--pane', pane)
    data = pane_sample(info, pane)
    if not data['complete']:
        raise ValueError(data['error'])
    try:
        agent = herdr(session, 'agent', 'get', pane)['result']['agent']
    except (KeyError, subprocess.CalledProcessError):
        if require_agent:
            raise
        agent = {}
    if agent and agent.get('pane_id') != pane:

        raise ValueError('ответ Herdr относится к другой панели')
    return agent, classified(data['procs'])


def unmanaged(pid):
    # Ownership metadata only; no environment values or prompts leave this check.
    raw = Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
    return not any(row.startswith(b'FM_TASK_ID=') and row != b'FM_TASK_ID=' for row in raw)


def inspect(session, pane, pid, parent_record=None, native_session=None):
    before = process_sample(pid)
    if before is None:
        raise ValueError('точный процесс отсутствует или его идентичность не прочитана')
    agent, samples = pane_observation(session, pane)
    match = [p for p in samples if p['pid'] == pid and p['kind'] == 'agent']
    if len(match) != 1:
        raise IdentityMismatch('native-процесс не доказан в выбранной панели')
    sample = match[0]
    if agent.get('agent') != sample['family'] and not (sample['family'] == 'pi' and agent.get('agent') == 'pi-signed'):
        raise IdentityMismatch('семейство процесса противоречит регистрации Herdr')
    fields = ('pid', 'ticks', 'identity_paths', 'identity_files', 'cwd', 'argv0', 'name', 'cmdline_sha256')
    after = process_sample(pid)
    if after is None or any(before[k] != after[k] or before[k] != sample[k] for k in fields):
        raise IdentityMismatch('процесс изменился во время проверки')
    pane_info = herdr(session, 'pane', 'get', pane)['result']['pane']
    if pane_info.get('pane_id') != pane or pane_info.get('tab_id') != agent.get('tab_id'):
        raise IdentityMismatch('pane и agent registration противоречат друг другу')
    if not pane_info.get('workspace_id'):
        raise ValueError('Herdr не сообщил Space панели')
    native = agent.get('agent_session') or {}
    if parent_record:
        if sample['family'] != 'agy':
            raise ValueError('launcher parent-record поддержан только для AGY')
        if not native_session:
            raise ValueError('нужен явно известный parent conversation id, не поиск child=false')
        env = Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
        runs = [os.fsdecode(v.split(b'=', 1)[1]) for v in env if v.startswith(b'AR_RUN_DIR=')]
        if len(runs) != 1 or Path(parent_record).resolve().parent != Path(runs[0]).resolve():
            raise IdentityMismatch('launcher-record не принадлежит AR_RUN_DIR точного процесса')
        parent = read_json(parent_record)
        if parent.get('id') != native_session or parent.get('child') is not False or parent.get('cwd') != sample['cwd'] or not parent.get('id'):
            raise IdentityMismatch('launcher-record не доказывает родительскую сессию AGY')
        native = {'kind': 'agy-parent', 'value': parent['id'],
                  'record': str(Path(parent_record).resolve())}
    elif native.get('kind') not in ('path', 'id') or not native.get('value'):
        raise ValueError('native session не доказана; требуется структурный источник')
    elif native['kind'] == 'path' and not Path(native['value']).is_absolute():
        raise ValueError('native session path должен быть абсолютным')
    elif native['kind'] == 'id' and re.search(r'[/\s]', native['value']):
        raise ValueError('native session id не доказан')
    for key in ('tab_id', 'terminal_id'):
        if not agent.get(key):
            raise ValueError(f'Herdr не сообщил {key}')
    if agent.get('cwd') != sample['cwd']:
        raise IdentityMismatch('cwd процесса противоречит регистрации Herdr')
    identity = {key: sample[key] for key in fields}
    identity.update(host_identity(), family=sample['family'], session=session, pane_id=pane,
                    tab_id=agent['tab_id'], terminal_id=agent['terminal_id'], workspace_id=pane_info['workspace_id'], native=native)
    return identity, agent


class Home:
    def __init__(self):
        if not os.environ.get('FM_HOME'):
            raise ValueError('FM_HOME должен быть задан явно')
        self.home = Path(os.environ['FM_HOME']).resolve(strict=True)
        self.state = Path(os.environ.get('FM_STATE_OVERRIDE', self.home / 'state'))
        self.data = Path(os.environ.get('FM_DATA_OVERRIDE', self.home / 'data'))

    def controller_pid(self):
        pid = run(['bash', '-c', '. "$1/bin/fm-session-lock-lib.sh"; fm_session_lock_inspect "$2"; if [ "$FM_LOCK_INSPECT_STATE" = held ]; then printf "%s" "$FM_LOCK_INSPECT_PID"; fi',
                   'external-controller', ROOT, self.state]).strip()
        return int(pid) if pid.isdigit() else None

    def path(self, task):
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,95}', task):
            raise ValueError('недопустимый точный task id')
        return self.state / f'{task}.external.json'

    @contextmanager
    def lock(self):
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        path = self.state / '.external-session.lock'
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def load(self, task):
        binding = read_json(self.path(task))
        if binding.get('schema') != SCHEMA or binding.get('task') != task or binding.get('home') != str(self.home):
            raise ValueError('привязка не принадлежит этой задаче и FM_HOME')
        if (self.state / f'{task}.meta').exists():
            raise ValueError('конфликт внешней привязки с fm-spawn metadata')
        return binding

    def tasks(self, *args):
        env = dict(os.environ, FM_HOME=str(self.home))
        return json.loads(run(['bash', ROOT / 'bin/fm-tasks-axi.sh', *args, '--json'], env=env))

    def task(self, task):
        # tasks-axi 0.2.6 emits TOON for reads (JSON only for mutations).
        shown = run(['bash', ROOT / 'bin/fm-tasks-axi.sh', 'show', task, '--full'])
        fields = {}
        for key, value in re.findall(r'^  (id|kind|state|body): (.*)$', shown, re.M):
            fields[key] = json.loads(value) if value.startswith('"') else value
        if fields.get('id') != task or not all(k in fields for k in ('kind', 'state', 'body')):
            raise ValueError('полный task read не доказан')
        return fields

    def maybe_task(self, task):
        try:
            return self.task(task)
        except subprocess.CalledProcessError as exc:
            if 'NOT_FOUND' not in (exc.stderr + exc.stdout):
                raise
            return None

    def body_update(self, task, body):
        # Body-file is owned by the existing backlog owner, never hand-edit Markdown.
        fd, path = tempfile.mkstemp(dir=self.state, prefix='.external-body-')
        try:
            with os.fdopen(fd, 'w') as out:
                out.write(body)
            self.tasks('update', task, '--body-file', path, '--archive-body')
        finally:
            os.unlink(path)

    def dod(self, binding):
        task = self.task(binding['task'])
        if f"Дело: {binding['case']}" not in task['body'].splitlines():
            raise ValueError('задача больше не принадлежит сохранённому делу')
        rows = [json.loads(line[len(DOD):]) for line in task['body'].splitlines() if line.startswith(DOD)]
        if len(rows) != 1 or not isinstance(rows[0].get('human_required'), bool):
            raise ValueError('версия DoD в задаче не доказана')
        expected = digest({'criteria': rows[0].get('criteria'), 'human_required': rows[0]['human_required']})
        if rows[0].get('version') != expected:
            raise ValueError('критерии изменены без новой версии DoD')
        return rows[0]

    def verify(self, binding):
        expected = binding['identity']
        loss = self.state / f"{binding['task']}.external-session-loss.json"
        if binding.get('phase') != 'bound':
            return {'identity': 'unknown', 'presence': 'unknown', 'detail': 'регистрация ещё не завершена'}
        if host_identity() != {k: expected[k] for k in ('host', 'boot')}:
            return {'identity': 'lost', 'presence': 'unknown', 'detail': 'host/boot изменился; нужно новое поручение'}
        current = process_sample(expected['pid'])
        if current is None:
            # An unreadable live process is not evidence of death.
            stat = Path(f"/proc/{expected['pid']}/stat")
            gone = not stat.exists()
            if not gone:
                try:
                    gone = stat.read_text().rsplit(')', 1)[1].split()[0] in ('Z', 'X')
                except OSError:
                    pass
            return {'identity': 'lost' if gone else 'unknown', 'presence': 'stopped' if gone else 'unknown',
                    'detail': 'исходный процесс остановлен; дело сохранено' if gone else 'процесс не прочитан'}
        if loss.exists() and read_json(loss).get('revision') == binding['revision']:
            return {'identity': 'lost', 'presence': 'unknown', 'detail': 'наблюдалась смена native session; нужно новое поручение'}
        try:
            actual, agent = inspect(expected['session'], expected['pane_id'], expected['pid'],
                                    expected['native'].get('record'), expected['native']['value'])
        except IdentityMismatch as exc:
            return {'identity': 'lost', 'presence': 'unknown', 'detail': str(exc)[:300] + '; нужно новое поручение'}
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
            return {'identity': 'unknown', 'presence': 'unknown', 'detail': str(exc)[:300]}
        if actual != expected:
            if actual.get('native') != expected.get('native') and expected['native']['kind'] != 'agy-parent':
                atomic(loss, {'revision': binding['revision'], 'at': stamp(), 'native': actual['native']})
            return {'identity': 'lost', 'presence': 'unknown', 'detail': 'идентичность изменилась; нужно новое поручение'}
        raw = agent.get('agent_status', 'unknown')
        activity = raw if raw in ('working', 'idle', 'done', 'waiting') else 'unknown'
        if expected['native']['kind'] == 'agy-parent' and agent.get('agent_session', {}).get('value') != expected['native']['value']:
            activity = 'unknown'  # Child status does not describe the parent research.
        return {'identity': 'verified', 'presence': 'alive', 'activity': activity,
                'native_status': raw, 'reported_session': agent.get('agent_session'),
                'detail': 'тот же внешний процесс; выполнение DoD проверяется отдельно'}

    def observation(self, binding):
        result = self.verify(binding)
        try:
            dod = self.dod(binding)
            gate = bool(dod.get('confirmation') and dod.get('achievement') and
                        (not dod.get('human_required') or dod.get('human_acceptance')))
            result['completion'] = {'version': dod['version'], 'confirmed': bool(dod.get('confirmation')),
                                    'achieved': gate, 'human_required': dod.get('human_required', False)}
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
            result['completion'] = {'achieved': False, 'error': str(exc)[:300]}
        receipt = binding.get('receipt')
        result['receipt'] = bool(receipt and receipt.get('revision') == binding['revision'])
        state = 'working' if result.get('activity') == 'working' else 'unknown'
        if result['presence'] == 'stopped':
            state = 'done' if result['completion']['achieved'] else 'stopped'
        result['state'] = state
        return result

    def attach(self, args):
        selected = read_json(args.selection)
        expected = selected.get('identity', selected)
        identity, _ = inspect(expected['session'], expected['pane_id'], int(expected['pid']), expected['native'].get('record'), expected['native']['value'])
        if identity != expected:
            raise ValueError('выбранный процесс изменился; подключение отменено')
        if identity['pid'] == self.controller_pid() or not unmanaged(identity['pid']):
            raise ValueError('процесс уже имеет Firstmate task owner')
        source = evidence(args.source_file)
        evidence(args.dod_file)
        proposed = Path(args.dod_file).read_text().strip()
        if not proposed:
            raise ValueError('предложенный DoD пуст')
        task = args.task
        case = args.case or f'external-{task}'
        self.path(task)
        self.path(case)
        watched = sorted({str(Path(p).resolve()) for p in args.observe_file} |
                         ({identity['native']['value']} if identity['native']['kind'] == 'path' else set()))
        if args.existing_check:
            self.path(args.existing_check)
            run(['bash', '-c', '. "$1/bin/fm-pr-lib.sh" && . "$1/bin/fm-check-lib.sh" && '
                 'fm_custom_check_registered "$2" "$3"',
                 'external-check', ROOT, self.state, args.existing_check])
        operation = digest({'identity': identity, 'source': {k: source[k] for k in ('path', 'sha256')},
                            'case': case, 'watched': watched, 'existing_check': args.existing_check})
        with self.lock():
            if (self.state / f'{task}.meta').exists():
                raise ValueError('задача уже принадлежит fm-spawn')
            old = self.load(task) if self.path(task).exists() else None
            if old and old['operation'] != operation:
                raise ValueError('существующую привязку нельзя заменить; новое поручение требует нового task id')
            for path in self.state.glob('*.external.json'):
                other = read_json(path)
                if other['task'] == task:
                    continue
                same_endpoint = all(other['identity'][key] == identity[key] for key in ('session', 'pane_id'))
                same_source = all(other['source'][key] == source[key] for key in ('path', 'sha256'))
                if same_endpoint and same_source:
                    raise ValueError('новая привязка требует нового источника явного поручения, не прежнего grant')
                if other['identity'] == identity and self.verify(other)['identity'] == 'verified':
                    raise ValueError('процесс уже связан с другой задачей этого home')
            binding = old or {'schema': SCHEMA, 'origin': 'existing-external-process', 'task': task,
                              'case': case, 'home': str(self.home), 'identity': identity, 'source': source,
                              'revision': str(uuid.uuid4()), 'operation': operation, 'phase': 'prepared', 'at': stamp(),
                              'watched': watched, 'existing_check': args.existing_check}
            atomic(self.path(task), binding)  # Recovery intent precedes any backlog mutation.
            c = self.maybe_task(case)
            if c and (c.get('kind') != 'program' or c.get('state') == 'done'):
                raise ValueError('указанное дело не открыто')
            if not c:
                self.tasks('add', case, args.title, '--kind', 'program', '--repo', identity['cwd'],
                           '--body', f'## Зачем\n{args.title}\n## Критерий готовности\nСм. задачу {task}.\n## Контекст\nСуществующая внешняя сессия.\n## Ограничения\nПапка и терминал принадлежат пользователю.')
                self.tasks('start', case)
            t = self.maybe_task(task)
            if t and (t.get('state') == 'done' or f'Дело: {case}' not in t.get('body', '').splitlines()):
                raise ValueError('указанная задача закрыта или связана с другим делом')
            if not t:
                self.tasks('add', task, args.title, '--kind', 'external', '--repo', identity['cwd'],
                           '--body', f'Дело: {case}\n{args.context or args.title}')
            t = self.task(task)
            if not any(line.startswith(DOD) for line in t['body'].splitlines()):
                dod = {'version': digest({'criteria': proposed, 'human_required': args.human_required}),
                       'criteria': proposed, 'human_required': args.human_required,
                       'confirmation': None, 'achievement': None, 'human_acceptance': None}
                self.body_update(task, t['body'] + '\n' + DOD + json.dumps(dod, ensure_ascii=False))
            elif self.dod(binding)['criteria'] != proposed:
                raise ValueError('повтор подключения с другим DoD: измените его явной командой propose')
            if t.get('state') != 'in_flight':
                self.tasks('start', task)
            binding['phase'] = 'bound'
            if self.verify(binding)['identity'] != 'verified':
                raise ValueError('идентичность изменилась при регистрации; дело сохранено, управление не разрешено')
            atomic(self.path(task), binding)
            if not args.existing_check:
                self.install_check(task)
        return {'binding': str(self.path(task)), 'revision': binding['revision'], 'case': case,
                'receipt': bool(binding.get('receipt')), 'dod_confirmed': bool(self.dod(binding).get('confirmation'))}

    def install_check(self, task):
        path = self.state / f'external-{task}.check.sh'
        body = '#!/usr/bin/env bash\nexec env FM_HOME=' + shlex.quote(str(self.home)) + ' python3 ' + shlex.quote(str(ROOT / 'bin/fm-external-session.py')) + ' observe ' + shlex.quote(task) + '\n'
        if path.exists() and path.read_text() != body:
            raise ValueError('check с таким именем уже существует с другим содержимым')
        if path.is_symlink():
            raise ValueError('check не может быть symlink')
        path.write_text(body)
        path.chmod(0o700)
        run(['bash', ROOT / 'bin/fm-check-register.sh', f'external-{task}'])

    def snapshot(self):
        result = []
        for path in sorted(self.state.glob('*.external.json')):
            task = path.name[:-len('.external.json')]
            b = self.load(task)
            ob = self.observation(b)
            i = b['identity']
            result.append({'id': task, 'kind': 'external', 'origin': b['origin'], 'harness': i['family'],
                           'project': i['cwd'], 'backend': 'herdr', 'external': {'binding': str(path), 'revision': b['revision'],
                           'case': b['case'], 'identity': i, 'observation': ob},
                           'paths': {'status_log': {'path': str(self.state / f'{task}.status')}},
                           'endpoint': {'target': i['session'] + ':' + i['pane_id'],
                                        'exists': None, 'agent_alive': ob['presence']},
                           'current_state': {'state': ob['state'], 'source': 'external-session',
                                             'detail': ob['detail'], 'observed_at': stamp()}, 'actions': []})
        return result


def discover(home, session):
    # No scrollback, native transcripts or receipt files are read here.
    owned = set()
    for path in home.state.glob('*.meta'):
        if not path.is_symlink():
            text = path.read_text()
            sessions = re.findall(r'^herdr_session=(.+)$', text, re.M)
            if sessions == [session]:
                owned.update(re.findall(r'^herdr_pane_id=(.+)$', text, re.M))
    for path in home.state.glob('*.external.json'):
        b = read_json(path)
        if b['identity']['session'] == session and home.verify(b)['identity'] == 'verified':
            owned.add(b['identity']['pane_id'])
    ancestors = {home.controller_pid()}
    pid = os.getpid()
    while pid > 1:
        ancestors.add(pid)
        p = process_sample(pid)
        if not p:
            break
        pid = p['ppid']
    result = []
    spaces = herdr(session, 'workspace', 'list')['result']['workspaces']
    for space in spaces:
        panes = herdr(session, 'pane', 'list', '--workspace', space['workspace_id'])['result']['panes']
        for pane in panes:
            if pane['pane_id'] in owned:
                continue
            try:
                agent, rows = pane_observation(session, pane['pane_id'], require_agent=False)
                for proc in rows:
                    if proc['kind'] != 'agent' or proc['pid'] in ancestors or not unmanaged(proc['pid']):
                        continue
                    result.append({'family': proc['family'], 'cwd': proc['cwd'], 'pid': proc['pid'], 'ticks': proc['ticks'],
                                   'session': session, 'space': space['workspace_id'], 'space_label': space.get('label'),
                                   'tab': pane['tab_id'], 'pane': pane['pane_id'], 'terminal': agent.get('terminal_id'),
                                   'activity': 'unknown' if proc['family'] == 'agy' else agent.get('agent_status', 'unknown'),
                                   'task': None})
            except (OSError, ValueError, KeyError, subprocess.SubprocessError):
                print(f"Discovery: панель {session}:{pane['pane_id']} не проверена; наличие агента неизвестно", file=sys.stderr)
    return result


def main():
    parser = argparse.ArgumentParser(description='Точная привязка существующего агента Herdr; справка: fm-attach.sh --help')
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('discover'); p.add_argument('--session', required=True)
    p = sub.add_parser('inspect'); p.add_argument('--session', required=True); p.add_argument('--pane', required=True)
    p.add_argument('--pid', type=int, required=True); p.add_argument('--parent-record'); p.add_argument('--native-session')
    p = sub.add_parser('attach'); p.add_argument('task'); p.add_argument('--selection', required=True)
    p.add_argument('--source-file', required=True); p.add_argument('--dod-file', required=True)
    p.add_argument('--title', required=True); p.add_argument('--context'); p.add_argument('--case'); p.add_argument('--human-required', action='store_true')
    p.add_argument('--observe-file', action='append', default=[]); p.add_argument('--existing-check')
    for cmd in ('verify', 'state', 'receipt', 'dod', 'exit-gate', 'observe'):
        p = sub.add_parser(cmd); p.add_argument('task')
        if cmd == 'receipt':
            p.add_argument('--file', required=True); p.add_argument('--token', required=True)
            p.add_argument('--format', choices=('pi', 'ack-file'), required=True); p.add_argument('--ack')
        if cmd == 'dod':
            p.add_argument('action', choices=('propose', 'confirm', 'achieve', 'accept'))
            p.add_argument('--version'); p.add_argument('--file', required=True); p.add_argument('--human-required', action='store_true')
    sub.add_parser('snapshot')
    args = parser.parse_args()
    home = Home()
    if args.command == 'discover':
        result = discover(home, args.session)
    elif args.command == 'inspect':
        identity, _ = inspect(args.session, args.pane, args.pid, args.parent_record, args.native_session)
        result = {'identity': identity, 'observed_at': stamp()}
    elif args.command == 'attach':
        result = home.attach(args)
    elif args.command == 'snapshot':
        result = home.snapshot()
    else:
        b = home.load(args.task)
        if args.command in ('state', 'verify'):
            result = home.observation(b)
            if args.command == 'verify' and result['identity'] != 'verified':
                raise ValueError(result['detail'])
        elif args.command == 'exit-gate':
            result = home.observation(b)
            if not result['completion']['achieved']:
                raise ValueError('exit запрещён: DoD не подтверждён, не достигнут или ожидает человеческой приёмки')
        elif args.command in ('receipt', 'dod'):
            with home.lock():
                b = home.load(args.task)
                if args.command == 'receipt':
                    if home.verify(b)['identity'] != 'verified':
                        raise ValueError('receipt не относится к доказанному текущему процессу')
                    receipt = evidence(args.file, args.token)
                    if args.format == 'pi':
                        native = b['identity']['native']
                        if b['identity']['family'] != 'pi' or native['kind'] != 'path' or Path(args.file).resolve() != Path(native['value']).resolve():
                            raise ValueError('Pi receipt должен происходить из привязанного native session path')
                        found = False
                        for line in Path(args.file).read_text().splitlines():
                            row = json.loads(line)
                            message = row.get('message') or {}
                            if message.get('role') == 'assistant':
                                content = message.get('content', [])
                                texts = [content] if isinstance(content, str) else [c.get('text', '') for c in content if isinstance(c, dict)]
                                found |= any(args.token in text for text in texts)
                        if not found:
                            raise ValueError('token в пользовательском prompt не подтверждает receipt агента')
                    elif not args.ack or args.ack == args.token or args.ack not in Path(args.file).read_text():
                        raise ValueError('нужна отдельно проверенная точная фраза ответа --ack, отличная от token')
                    if home.verify(b)['identity'] != 'verified':
                        raise ValueError('процесс изменился во время чтения receipt')
                    b['receipt'] = dict(receipt, token=args.token, revision=b['revision'])
                    atomic(home.path(args.task), b)
                    result = b['receipt']
                else:
                    task = home.task(args.task)
                    dod = home.dod(b)
                    proof = evidence(args.file)
                    if args.action == 'propose':
                        criteria = Path(args.file).read_text().strip()
                        dod = {'version': digest({'criteria': criteria, 'human_required': args.human_required}),
                               'criteria': criteria, 'human_required': args.human_required,
                               'confirmation': None, 'achievement': None, 'human_acceptance': None}
                    else:
                        if args.version != dod['version']:
                            raise ValueError('подтверждение относится к другой версии DoD')
                        key = {'confirm': 'confirmation', 'achieve': 'achievement', 'accept': 'human_acceptance'}[args.action]
                        if key != 'confirmation' and not dod.get('confirmation'):
                            raise ValueError('сначала требуется подтверждение этой версии DoD')
                        dod[key] = dict(proof, text=Path(args.file).read_text())
                    body = '\n'.join(DOD + json.dumps(dod, ensure_ascii=False) if line.startswith(DOD) else line for line in task['body'].splitlines())
                    home.body_update(args.task, body)
                    result = dod
        else:
            # Existing watcher owns scheduling and delivery of this check's output.
            with home.lock():
                result = home.observation(b)
                watched = []
                for path in sorted((home.state / f'{args.task}.inbox/handled').glob('*.msg')):
                    watched.append({'name': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
                result['handled'] = watched
                files = []
                for filename in b.get('watched', []):
                    try:
                        item = evidence(filename)
                        item.pop('at')
                        files.append(item)
                    except (OSError, ValueError) as exc:
                        files.append({'path': filename, 'error': str(exc)[:200]})
                result['outputs'] = files
                if home.verify(b)['identity'] != result['identity']:
                    raise ValueError('процесс изменился во время наблюдения; результат не принят')
                result['revision'] = b['revision']
                signature = digest(result)
                dest = home.data / args.task / 'external-observation.json'
                previous = read_json(dest) if dest.exists() else {}
                atomic(dest, dict(result, fingerprint=signature, observed_at=stamp()))
                if previous.get('fingerprint') != signature:
                    print(f'Внешняя сессия {args.task}: {result["state"]}; результат: {dest}')
            return 0
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f'fm-attach: {error}', file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr[:1000], file=sys.stderr)
        sys.exit(1)
