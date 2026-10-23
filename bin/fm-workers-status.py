#!/usr/bin/env python3
"""Render the Firstmate snapshot as launched agents, retained records and done work.

A launch is proved only by the existing presence owner plus a harness process
of the current incarnation in the task's pane and worktree; events, labels,
model names and open panes never prove it. Done is proved only by a delivery
owner (merged-PR marker, landed ship branch or recorded scout report) for a
stopped record whose last event claims completion.
"""
import argparse
import html
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

FIRSTMATE = Path(__file__).resolve().parent.parent
LABELS = {
    'working': 'Работает', 'parked': 'Ожидает решения', 'paused': 'Ожидание',
    'blocked': 'Заблокирован', 'done': 'Готово', 'ready': 'Готово',
    'failed': 'Ошибка', 'stopped': 'Остановлен', 'unknown': 'Активность не подтверждена',
    'needs-decision': 'Ожидает решения',
}
SKEW = 2  # whole-second spawn stamp and /proc btime both truncate
PRESENCE = {'no-agent': 'агента нет: панель без работающего агента',
            'no-pane': 'агента нет: панель закрыта или её сервер остановлен'}
# Read-only, one bash for all tasks: Firstmate's own endpoint validator and
# presence owner, then one `pane process-info` read classified by Firstmate's
# own process and harness-name owners. Generation is read before and after.
PROBE = r'''
root=$1 state=$2 script=$3
shift 3
. "$root/bin/fm-backend.sh" && fm_backend_source herdr || exit 1
# Load the installed family owner without own-harness detection or ancestry walks.
. "$root/bin/fm-harness.sh" validate-native-effort || exit 1
# Ask the stock one-process family owner about exactly these supplied facts.
# No ancestor, interpreter prompt, or host-wide process table can supply a family.
family_for() (
  local ws_comm=$1 ws_args=$3 process_pid=${4:-0} verdict
  ps() {
    case "$*" in
      "-o comm= -p $process_pid") printf '%s\n' "$ws_comm" ;;
      "-o args= -p $process_pid") printf '%s\n' "$ws_args" ;;
      *) return 1 ;;
    esac
  }
  verdict=$(harness_process_verdict "$process_pid")
  case "$verdict" in comm\ *) harness_family "${verdict#comm }" ;; esac
)
# The presence owner's ps seam sees only this pane's bounded descendants.
ws_ps() {
  case "$*" in
    '-axo pid=,ppid=,comm=') jq -r '.procs[] | "\(.pid) \(.ppid) \(.name)"' <<<"$sample" ;;
    -p\ *\ -o\ args=) jq -r --argjson pid "$2" '.procs[] | select(.pid == $pid) | .args' <<<"$sample" ;;
    *) return 1 ;;
  esac
}
export FM_HERDR_PS_BIN=ws_ps
for id; do
  meta=$state/$id.meta target= agent=refused procs=() family= launcher= launch='{}' sample='{"procs":[]}'
  gen=$(fm_backend_meta_exact_value "$meta" spawn_gen) || gen=
  worktree=$(fm_backend_meta_exact_value "$meta" worktree) || worktree=
  recorded=$(fm_backend_meta_exact_value "$meta" harness) || recorded=
  family=$(family_for "$recorded" "$recorded" "$recorded")
  # A canonical adapter is named exactly by its owner. A launch alias instead
  # needs its task-private symlink and the owner's proof of its resolved path.
  if [ "$(harness_family "$recorded")" != "$family" ] || [ -z "$family" ]; then
    family=
    launch=$(python3 "$script" --launcher-sample "$id" "$recorded")
    launcher=$(jq -r '.path // ""' <<<"$launch")
    nominated=$(jq -r '.nominated // ""' <<<"$launch")
    if [ -n "$nominated" ]; then family=$(family_for "$nominated" "$nominated" "$nominated"); fi
  fi
  if fm_backend_validate_task_endpoint "$meta" "$id" 2>/dev/null; then
    target=$FM_BACKEND_VALIDATED_TARGET
    if [ "$FM_BACKEND_VALIDATED_BACKEND" = herdr ] && fm_backend_herdr_parse_target "$target"; then
      info=$(fm_backend_herdr_cli "$FM_BACKEND_HERDR_SESSION" pane process-info \
        --pane "$FM_BACKEND_HERDR_PANE" 2>/dev/null)
      sample=$(printf '%s' "$info" | python3 "$script" --process-sample "$FM_BACKEND_HERDR_PANE")
      while IFS= read -r p; do
        actual=$(jq -r '.family' <<<"$p")
        if [ -z "$family" ] && [ "$actual" = "$recorded" ] && [ -n "$actual" ]; then family=$actual; fi
        if [ -z "$family" ] && [ -n "$launcher" ] && [ -n "$actual" ] && \
          jq -e --arg path "$launcher" '.identity_paths | index($path) != null' <<<"$p" >/dev/null; then
          family=$actual
        fi
        procs+=("$(jq -c '. + {harness:.family}' <<<"$p")")
      done < <(jq '.procs' <<<"$sample" | bash "$root/bin/fm-agent-process-probe.sh")
    fi
    agent=$(fm_backend_agent_state "$FM_BACKEND_VALIDATED_BACKEND" "$target")
  fi
  after=$(fm_backend_meta_exact_value "$meta" spawn_gen) || after=
  target_after=
  if fm_backend_validate_task_endpoint "$meta" "$id" 2>/dev/null; then target_after=$FM_BACKEND_VALIDATED_TARGET; fi
  worktree_after=$(fm_backend_meta_exact_value "$meta" worktree) || worktree_after=
  harness_after=$(fm_backend_meta_exact_value "$meta" harness) || harness_after=
  printf '%s\n' "${procs[@]}" | jq -sc --arg id "$id" --arg gen "$gen" --arg after "$after" \
    --arg worktree "$worktree" --arg worktree_after "$worktree_after" \
    --arg target "$target" --arg target_after "$target_after" --arg recorded "$recorded" \
    --arg harness_after "$harness_after" --arg family "$family" --arg launcher "$launcher" --arg agent "$agent" \
    --argjson sample "$sample" --argjson launch "$launch" \
    '{id:$id,gen:$gen,after:$after,target:$target,target_after:$target_after,recorded:$recorded,
      harness_after:$harness_after,family:$family,launcher:$launcher,agent:$agent,worktree:$worktree,worktree_after:$worktree_after,
      sample_error:$sample.error,tree_complete:$sample.complete,launch:$launch,procs:.}'
done
'''
# Read-only delivery proof, one bash for all candidates. A scout report counts
# only after the captain-hold completion gate's read-only `verify` passes for it
# (fm-captain-hold.sh); report presence alone is unreviewed. A PR is delivered only
# when Firstmate's own merge-outcome marker names exactly that PR (fm-pr-lib.sh);
# a local-only ship only when its recorded branch, carrying commits since its
# creation, and the worktree HEAD are reachable from the default branch that
# fm-merge-local.sh fast-forwards (same default_branch rule). Uncommitted
# worktree paths are counted apart: they are not part of what landed.
LANDED = r'''
. "$1/bin/fm-pr-lib.sh" || exit 1
state=$2
export GIT_OPTIONAL_LOCKS=0
# Unit separator, not tab: whitespace IFS would merge an empty PR field away.
while IFS=$'\x1f' read -r id mode url project branch worktree; do
  proof=unavailable dirty= default=
  project=${project:-/nonexistent} worktree=${worktree:-/nonexistent}  # git -C '' means the cwd
  if [ "$mode" = local-only ]; then
    default=$(git -C "$project" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null) && default=${default#origin/}
    if [ -z "$default" ]; then
      for b in main master; do
        git -C "$project" show-ref --verify --quiet "refs/heads/$b" 2>/dev/null && { default=$b; break; }
      done
    fi
    tip=$(git -C "$project" rev-parse --quiet --verify "refs/heads/$branch^{commit}" 2>/dev/null) || tip=
    born=$(git -C "$project" log -g --format=%H "refs/heads/$branch" 2>/dev/null | tail -1)
    head=$(git -C "$worktree" rev-parse --quiet --verify 'HEAD^{commit}' 2>/dev/null) || head=
    if [ -z "$default" ] || [ -z "$tip" ] || [ -z "$born" ] || [ -z "$head" ]; then
      proof=unavailable
    elif [ "$tip" = "$born" ]; then
      proof=empty
    elif git -C "$project" merge-base --is-ancestor "$tip" "refs/heads/$default" 2>/dev/null \
      && git -C "$project" merge-base --is-ancestor "$head" "refs/heads/$default" 2>/dev/null; then
      proof=landed
    else
      proof=unlanded
    fi
    st=$(git -C "$worktree" status --porcelain 2>/dev/null) && dirty=$(grep -c . <<<"$st")
  elif [ "$mode" = scout ]; then
    if "$1/bin/fm-captain-hold.sh" verify "$id" >/dev/null 2>&1; then proof=landed; else proof=unverified; fi
  elif [ -z "$url" ]; then
    proof=no-pr
  elif fm_pr_url_parse "$url"; then
    if fm_pr_poll_merge_already_notified "$state" "$id" "$FM_PR_PROVIDER" "$FM_PR_HOST" "$FM_PR_PATH" "$FM_PR_NUMBER"; then
      proof=landed
    else
      proof=unmerged
    fi
  fi
  jq -nc --arg id "$id" --arg proof "$proof" --arg dirty "$dirty" --arg default "$default" \
    '{id: $id, proof: $proof, dirty: $dirty, default: $default}'
done
'''
# A human-owed gate is the coordinator's only while the task's own fold holds an
# open needs-decision bound to that gate's run: the same owner pair fm-watch.sh
# uses (wedge_wait_evidence). Read only on the snapshot's log sample: its last
# line must hold before and after the fold, otherwise no answer is given.
GATE = r'''
. "$1/bin/fm-classify-lib.sh" || exit 1
state=$2
while IFS=$'\x1f' read -r id run last; do
  f=$state/$id.status open=false
  [ -f "$f" ] && [ ! -L "$f" ] || continue  # the owner folds these to nothing: no evidence
  [ "$(grep -v '^[[:space:]]*$' "$f" 2>/dev/null | tail -1)" = "$last" ] || continue
  status_has_open_needs_decision "$f" "$run" && open=true
  [ "$(grep -v '^[[:space:]]*$' "$f" 2>/dev/null | tail -1)" = "$last" ] || continue
  jq -nc --arg id "$id" --argjson open "$open" '{id: $id, open: $open}'
done
'''
HUMAN_GATE = 'ask-user: authority decision'  # FM_GATE_HUMAN_DECISION in fm-classify-lib.sh
UNFINISHED = ('working', 'parked', 'paused', 'blocked', 'needs-decision', 'failed')


def cell(value):
    value = ' '.join(str(value).split())
    value = html.escape(value, quote=False)
    return re.sub(r'([\\`*_[\]{}])', r'\\\1', value).replace('|', '&#124;')


def gate_run(task):
    """Run of a parked gate fm-crew-state marks human-owed ('' without a usable run), else None.

    Whole components are compared, as crew_gate_awaits_human_decision does.
    """
    current = task.get('current_state') or {}
    parts = (current.get('detail') or '').split(' · ')
    if current.get('state') != 'parked' or current.get('source') != 'run-step' or HUMAN_GATE not in parts:
        return None
    runs = [p[len('run: '):] for p in parts if p.startswith('run: ')]
    return runs[-1] if runs and runs[-1] and not re.search(r'\s', runs[-1]) else ''


def status(task, launched=False, gate=None):
    """gate: the owner's answer for this gate's run-bound open decision; None when not proved."""
    current = task.get('current_state') or {}
    state = current.get('state', 'unknown')
    result = LABELS.get(state, LABELS['unknown'])
    hints = task.get('hints') or {}
    run = gate_run(task)
    captain = (task.get('backlog') or {}).get('captain_actionable') is True
    if launched and (state == 'unknown' or state not in LABELS):
        result = 'Агент запущен; этап задачи не подтверждён'
    if state == 'working' and current.get('source') == 'run-step':
        result = 'Проверки'  # run-step working is validating/CI in fm-crew-state.
    if state in ('parked', 'blocked', 'paused', 'needs-decision'):
        if captain:
            result += ' — требуется решение пользователя'
        elif run and gate is True and hints.get('pending_decision'):
            result += ' — требуется решение координатора'
        elif run and gate is False:  # a marked gate not proved an open question is not shown as one
            result = 'Проверки приостановлены — открытый вопрос координатору по этой проверке не записан; ответственный не подтверждён'
        elif run is not None:
            result = 'Проверки приостановлены — ответственный не подтверждён'
        elif state in ('parked', 'needs-decision'):
            result += ' — ответственный не указан'
    if state == 'unknown' or state not in LABELS:
        event = (((task.get('paths') or {}).get('status_log') or {}).get('last_event') or {})
        if event.get('state'):
            stage = LABELS.get(event['state'], event['state'])
            age = event.get('age_seconds')
            timing = f'{age} с назад' if age is not None else 'время неизвестно'
            result += f'; последнее событие: {stage} ({timing})'
    # A marked gate not proved the coordinator's must not hide another open decision.
    if hints.get('pending_decision') and (state not in ('parked', 'needs-decision')
                                          or (run is not None and gate is not True and not captain)):
        result += '; открыто решение — ответственный не указан'
    blockers = (task.get('backlog') or {}).get('unresolved_blocker_ids') or []
    if blockers:
        result += '; зависит от: ' + ', '.join(blockers)
    return result


def unsupported(task):
    if task.get('remote'):
        return 'удалённая панель не проверяется'
    if task.get('kind') == 'secondmate':
        return 'второй помощник не проверяется'
    if task.get('backend') != 'herdr':
        return f"панель {task.get('backend') or 'tmux'} не проверяется"
    if not re.match(r's\d+\.', task.get('spawn_gen') or ''):
        return 'у записи нет метки запуска'
    if not (task.get('endpoint') or {}).get('target'):
        return 'адрес панели не записан'
    return None


def launcher_sample(task_id, recorded, home):
    """Only approved entrypoints or an exact task-local executable symlink.

    An approved entrypoint nominates a family; only the installed process and
    family owners can prove it from a separate native process. No hook/model
    claim is made here, and arbitrary wrapper names nominate nothing.
    """
    private = home / 'data' / task_id / 'runtime' / recorded
    if '/' in recorded or recorded in ('', '.', '..'):
        return {}
    candidate = private if private.is_symlink() else Path(shutil.which(recorded) or '/nonexistent')
    try:
        path = candidate.resolve(strict=True)
        if not path.is_file() or not os.access(path, os.X_OK):
            return {}
        approved = {Path.home() / 'bin' / ('autoresearch-' + family)
                    for family in ('claude', 'codex', 'pi', 'agy')}
        nominated = path.name.removeprefix('autoresearch-') if path in approved else ''
        if not nominated and not private.is_symlink():
            return {}
        return {'path': str(path), 'nominated': nominated,
                'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'via': str(candidate)}
    except (OSError, ValueError, RuntimeError):
        return {}


from fm_agent_process import process_sample, pane_sample


def judge(task, row, started):
    if row is None:
        return 'unknown', 'проверка присутствия не выполнилась'
    gen = task['spawn_gen']
    if row['gen'] != gen or row['after'] != gen:
        return 'unknown', 'запуск сменился после среза'
    if row['agent'] == 'refused':
        return 'unknown', 'запись панели не прошла проверку привязки'
    if row.get('recorded') != task.get('harness') or row.get('harness_after') != task.get('harness'):
        return 'unknown', 'среда запуска сменилась после среза'
    if row['target'] != task['endpoint']['target'] or row.get('target_after') != row['target']:
        return 'unknown', 'адрес панели сменился после среза'
    worktree = ((task.get('paths') or {}).get('worktree') or {}).get('path') or ''
    if row.get('worktree') != worktree.rstrip('/') or row.get('worktree_after') != row.get('worktree'):
        return 'unknown', 'рабочая папка записи сменилась после среза'
    launch = row.get('launch') or {}
    if launch:
        try:
            path = Path(launch['via']).resolve(strict=True)
            if str(path) != launch['path'] or hashlib.sha256(path.read_bytes()).hexdigest() != launch['sha256']:
                return 'unknown', 'launch alias сменился после чтения'
        except (OSError, KeyError, ValueError, RuntimeError):
            return 'unknown', 'launch alias не прочитан повторно'
    if not row.get('family'):
        return 'unknown', 'владелец Firstmate не доказал семейство среды или частного launch alias'
    if row['agent'] == 'missing':
        return 'no-pane', None
    if row['agent'] == 'dead':
        if not row.get('tree_complete'):
            return 'unknown', row.get('sample_error') or 'процессы панели не прочитаны'
        if any(p.get('kind') == 'agent' or p.get('owner_kind') == 'agent' for p in row['procs']):
            return 'unknown', 'владелец присутствия ответил dead при распознанном процессе; ограничение штатного владельца'
        return 'no-agent', None
    if row['agent'] != 'alive':
        return 'unknown', 'штатный владелец не подтвердил присутствие: ' + row['agent']
    worktree = ((task.get('paths') or {}).get('worktree') or {}).get('path') or ''
    roots = {worktree.rstrip('/'), os.path.realpath(worktree)} if worktree else set()
    epoch = int(re.match(r's(\d+)\.', gen)[1])
    reason = f"процесс {task['harness']} в папке задачи не найден в панели"
    for proc in row['procs']:
        cwd = proc.get('cwd') or ''
        if proc.get('kind') != 'agent' or proc.get('harness') != row['family'] or \
                not any(cwd == root or cwd.startswith(root + '/') for root in roots):
            continue
        current = process_sample(proc.get('pid'))
        start = proc.get('start')
        if current is None or start is None:
            reason = 'время старта процесса не прочитано'
        elif any(current.get(k) != proc.get(k) for k in ('ticks', 'identity_paths', 'identity_files', 'cwd', 'ppid', 'name', 'argv0', 'interpreter', 'cmdline_sha256')):
            reason = 'PID или идентичность процесса сменились после чтения'
        elif not epoch - SKEW <= start <= started:  # older incarnation or a reused PID
            reason = 'процесс не принадлежит текущему запуску'
        else:
            return 'agent', None
    if any(p.get('owner_kind') == 'agent' and p.get('kind') != 'agent' for p in row['procs']):
        reason += '; процессный владелец видит агента, но штатное доказательство семейства native-процесса недоступно'
    return 'unknown', reason


def claimed(task, verdict):
    """A stopped, locally checkable record whose last event says it finished."""
    event = (((task.get('paths') or {}).get('status_log') or {}).get('last_event') or {})
    state = (task.get('current_state') or {}).get('state', 'unknown')
    # Only a positive owner answer proves the agent stopped; an unproved absence is not stopped.
    return verdict in PRESENCE and event.get('state') == 'done' and state not in UNFINISHED


def completion(task, row):
    """('done', note) with delivery proof; otherwise ('pending' | 'unavailable', reason)."""
    if task.get('remote') or task.get('kind') == 'secondmate':
        return 'unavailable', 'доказательство доставки недоступно: запись другого дома'
    if task.get('kind') == 'scout':
        if not ((task.get('paths') or {}).get('report') or {}).get('present'):
            return 'unavailable', 'доказательство доставки недоступно: отчёт не найден'
        if (row or {}).get('proof') != 'landed':
            return 'unavailable', 'доказательство доставки недоступно: проверка завершения отчёта не пройдена'
        note = 'отчёт принят проверкой завершения'
    else:
        row = row or {}
        proof = row.get('proof')
        branch, default = task.get('branch') or '', row.get('default') or 'ветку по умолчанию'
        url = (task.get('pr') or {}).get('url')
        reasons = {
            'unmerged': f'ожидает слияния: PR {url} не слит',
            'unlanded': f'ожидает влития: ветка {branch} не влита в {default}',
            'no-pr': 'доказательство доставки недоступно: PR не записан',
            'empty': f'доказательство доставки недоступно: в ветке {branch} нет коммитов задачи',
            'unavailable': 'доказательство доставки недоступно: ветка, её журнал или рабочая копия не прочитаны',
        }
        if proof != 'landed':
            reason = reasons.get(proof, 'доказательство доставки недоступно: проверка доставки не выполнилась')
            return ('pending' if proof in ('unmerged', 'unlanded') else 'unavailable'), reason
        if task.get('mode') == 'local-only':
            note = f'ветка {branch} влита в {default}'
            dirty = row.get('dirty')
            if dirty == '':
                note += '; состояние рабочей копии задачи не прочитано'
            elif dirty != '0':
                note += f'; рабочая копия задачи сохраняет незакоммиченных путей: {dirty}, они не входят в доставленное'
        else:
            note = f'PR {url} слит'
    hints = task.get('hints') or {}
    if hints.get('pending_decision') or hints.get('open_decisions'):
        return 'pending', 'доставлено, но открыто решение'
    if (task.get('backlog') or {}).get('captain_actionable') is True:
        return 'pending', 'доставлено, но запись ждёт решения пользователя'
    return 'done', note


def landed(snapshot, fm_home, presence):
    tasks = [t for t in snapshot['tasks'] if t.get('kind') != 'external' and claimed(t, presence.get(t['id'], ('unknown',))[0])
             and t.get('kind') != 'secondmate' and not t.get('remote')]
    rows = {}
    if tasks:
        state = (snapshot.get('roots') or {}).get('state') or str(fm_home / 'state')
        lines = ''.join('\x1f'.join([t['id'], 'scout' if t.get('kind') == 'scout' else t.get('mode') or '', (t.get('pr') or {}).get('url') or '',
                                    t.get('project') or '', t.get('branch') or '',
                                    ((t.get('paths') or {}).get('worktree') or {}).get('path') or '']) + '\n'
                        for t in tasks)
        try:
            result = subprocess.run(['bash', '-c', LANDED, 'workers-status', str(FIRSTMATE), state],
                                    input=lines, env=dict(os.environ, FM_HOME=str(fm_home)),
                                    capture_output=True, text=True, timeout=180)
            rows = {r['id']: r for r in map(json.loads, result.stdout.splitlines())}
        except (OSError, ValueError, subprocess.TimeoutExpired):
            rows = {}
    return rows


def gates(snapshot, fm_home):
    """{id: open} for marked gates the owner answered on the snapshot's own log sample."""
    tasks = [t for t in snapshot['tasks'] if gate_run(t)]
    rows = {}
    if tasks:
        state = (snapshot.get('roots') or {}).get('state') or str(fm_home / 'state')
        lines = ''.join('\x1f'.join([t['id'], gate_run(t), ((((t.get('paths') or {}).get('status_log') or {})
                                                              .get('last_event') or {}).get('raw') or '')]) + '\n'
                        for t in tasks)
        try:
            result = subprocess.run(['bash', '-c', GATE, 'workers-status', str(FIRSTMATE), state],
                                    input=lines, env=dict(os.environ, FM_HOME=str(fm_home)),
                                    capture_output=True, text=True, timeout=60)
            rows = {r['id']: r['open'] for r in map(json.loads, result.stdout.splitlines())}
        except (OSError, ValueError, subprocess.TimeoutExpired):
            rows = {}
    return rows


def probe(snapshot, fm_home):
    started = time.time()
    tasks = snapshot['tasks']
    ids = [t['id'] for t in tasks if t.get('kind') != 'external' and not unsupported(t)]
    rows = {}
    if ids:
        state = (snapshot.get('roots') or {}).get('state') or str(fm_home / 'state')
        try:
            result = subprocess.run(['bash', '-c', PROBE, 'workers-status', str(FIRSTMATE), state, str(Path(__file__).resolve()), *ids],
                                    env=dict(os.environ, FM_HOME=str(fm_home)),
                                    capture_output=True, text=True, timeout=180)
            rows = {r['id']: r for r in map(json.loads, result.stdout.splitlines()) if r.get('id') in ids}
        except (OSError, ValueError, subprocess.TimeoutExpired):
            rows = {}
    presence = {t['id']: ('unknown', unsupported(t)) if unsupported(t) else judge(t, rows.get(t['id']), started)
                for t in tasks}
    for task in tasks:
        if task.get('kind') == 'external':
            try:
                result = subprocess.run([str(FIRSTMATE / 'bin/fm-attach.sh'), 'state', task['id']],
                                        env=dict(os.environ, FM_HOME=str(fm_home)), capture_output=True,
                                        text=True, check=True, timeout=45)
                ob = json.loads(result.stdout)
                rows[task['id']] = ob
                if ob['identity'] == 'verified':
                    presence[task['id']] = ('agent', None)
                elif ob['presence'] == 'stopped':
                    presence[task['id']] = ('no-agent', None)
                else:
                    presence[task['id']] = ('unknown', ob['detail'])
                # DoD and presence must describe the same current observation.
                task['external']['observation'] = ob
            except (OSError, ValueError, KeyError, subprocess.SubprocessError):
                presence[task['id']] = ('unknown', 'внешняя привязка не проверена повторно')
    return presence, rows


def render(snapshot, presence=None, delivery=None, decisions=None):
    if snapshot.get('schema') != 'fm-fleet-snapshot.v1':
        raise ValueError('неподдерживаемая схема snapshot')
    tasks = snapshot['tasks']
    presence = presence or {}
    delivery = delivery or {}
    decisions = decisions or {}
    backlog = {r['id']: r for r in snapshot.get('backlog', {}).get('records', []) if r.get('id')}
    groups = {'agent': [], 'no-agent': [], 'no-pane': [], 'unknown': []}
    retained, done = [], []  # snapshot order across all three retained kinds
    unavailable = 0
    for original in tasks:
        task = dict(original)
        task['backlog'] = task.get('backlog') or backlog.get(task['id'], {})
        record = task['backlog']
        project = record.get('repo') or Path(task.get('project') or '').name or 'Неизвестен'
        title = record.get('title') or task['id']
        prefix = re.match(r'^(Дело|Зодчий|Firstmate)\s*[:—–-]\s*(?=\S)', title, flags=re.I)
        if prefix:
            project = {'дело': 'Дело', 'зодчий': 'Зодчий', 'firstmate': 'Firstmate'}[prefix[1].lower()]
        title = re.sub(r'^' + re.escape(project) + r'\s*[:—–-]\s*', '', title, flags=re.I)
        if len(title) > 110:
            title = title[:107].rsplit(' ', 1)[0] + '…'
        verdict, reason = presence.get(task['id'], ('unknown', 'проверка не выполнялась'))
        external = task.get('kind') == 'external'
        ob = (task.get('external') or {}).get('observation') or {}
        outcome = completion(task, delivery.get(task['id'])) if not external and claimed(task, verdict) else None
        if external and verdict == 'no-agent' and ob.get('completion', {}).get('achieved'):
            outcome = ('done', 'подтверждённый DoD достигнут; исходный процесс остановлен')
        if outcome and outcome[0] == 'done':
            done.append('| ' + ' | '.join(map(cell, (project, title, 'Сделано: ' + outcome[1]))) + ' |')
            continue
        text = status(task, launched=verdict == 'agent', gate=decisions.get(task['id']))
        if external:
            text = 'Внешний процесс; ' + ('работает' if ob.get('activity') == 'working' else 'активность не подтверждена')
            text += '; receipt: ' + ('подтверждён' if ob.get('receipt') else 'не подтверждён')
            text += '; DoD: ' + ('достигнут' if ob.get('completion', {}).get('achieved') else
                                'подтверждён, достижение не доказано' if ob.get('completion', {}).get('confirmed') else 'не подтверждён')
            if ob.get('identity') != 'verified':
                text += '; ' + ob.get('detail', 'привязка не проверена')
        if outcome:
            text += '; ' + outcome[1]
            unavailable += outcome[0] == 'unavailable'
        if verdict != 'agent':
            text += '; ' + ('исходный внешний процесс остановлен; панель сохраняется отдельно' if external and verdict == 'no-agent' else
                           PRESENCE.get(verdict) or f'присутствие агента не подтверждено: {reason}')
        groups[verdict].append('| ' + ' | '.join(map(cell, (project, title, text))) + ' |')
        if verdict != 'agent':
            retained.append(groups[verdict][-1])
    present = sum(t.get('endpoint', {}).get('exists') is True for t in tasks)
    head = ['| Проект | Работник и задача | Статус |', '| --- | --- | --- |']
    lines = [f"Запущено агентов: {len(groups['agent'])}. Незавершённых записей без подтверждённого агента: "
             f"{len(retained)} (агента нет: {len(groups['no-agent'])}; панели нет: {len(groups['no-pane'])}; "
             f"присутствие не подтверждено: {len(groups['unknown'])}). Сделано: {len(done)}. "
             f"Заявлено готовым без доказательства доставки: {unavailable}.",
             f'Всего записей: {len(tasks)}; открытых панелей по срезу: {present}.',
             f"Срез: {cell(snapshot.get('generated', 'время неизвестно'))}.",
             '', '## Запущенные агенты', '', *(head + groups['agent'] if groups['agent'] else ['Нет.']),
             '', '## Сохранённые записи без подтверждённого агента', '', *(head + retained if retained else ['Нет.']),
             '', '## Сделано', '', *(head + done if done else ['Нет.'])]
    candidates = snapshot.get('attachable') or []
    candidate_rows = []
    for c in candidates:
        place = f"{c.get('session')}/{c.get('space')}/{c.get('tab')}/{c.get('pane')}"
        worker = f"{c.get('family', 'unknown')} · {place}; задача неизвестна"
        observed = c.get('activity', 'unknown')
        candidate_rows.append('| ' + ' | '.join(map(cell, (c.get('cwd') or 'Папка неизвестна', worker,
                                                         'Наблюдается: ' + observed))) + ' |')
    lines += ['', '## Можно подключить', '', *(head + candidate_rows if candidate_rows else ['Нет подтверждённых кандидатов в запрошенном срезе.'])]
    if snapshot.get('discovery_notes'):
        lines += ['', cell(snapshot['discovery_notes'])]
    if any(t.get('current_state', {}).get('state', 'unknown') not in LABELS or
           t.get('current_state', {}).get('state', 'unknown') == 'unknown' for t in tasks):
        lines += ['', 'Неподтверждённая активность или этап означают отсутствие достоверного текущего состояния; '
                  'последнее событие — история, а не heartbeat.']
    lines += ['', 'Запущенным считается агент подтверждённого владельцами Firstmate семейства текущего запуска, найденный в панели '
              'и рабочей папке задачи; открытая панель и записи о состоянии этого не доказывают. '
              'Сделанным считается остановленная запись с последним событием «готово» и доказанной доставкой: '
              'слитый PR по записи Firstmate о слиянии, ветка задачи в ветке по умолчанию или отчёт разведки, '
              'прошедший проверку завершения. Для внешней сессии отдельно проверяются точная привязка, receipt и подтверждённый DoD. Срез ограничен этим FM_HOME.']
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description='Запущенные агенты, записи и сделанная работа Firstmate в Markdown')
    parser.add_argument('--fm-home', type=Path, default=Path(os.environ.get('FM_HOME', FIRSTMATE)))
    parser.add_argument('--snapshot', type=Path,
                        help='готовый JSON (срез или файл --evidence) для воспроизведения, без сбора и проверки')
    parser.add_argument('--herdr-session', help='добавить discovery без чтения диалогов в этой session')
    parser.add_argument('--evidence', type=Path, help='сохранить использованный срез и итоги проверки присутствия')
    args = parser.parse_args()
    try:
        if args.snapshot:
            data = json.loads(args.snapshot.read_text())
            snapshot = data.get('snapshot', data)
            presence = {k: tuple(v) for k, v in data.get('presence', {}).items()}
            delivery = data.get('delivery', {})
            decisions = data.get('decisions', {})
        else:
            env = dict(os.environ, FM_HOME=str(args.fm_home), FM_CREW_STATE_NO_FORGE='1')
            result = subprocess.run([str(FIRSTMATE / 'bin/fm-fleet-snapshot.sh'), '--json'],
                                    env=env, check=True, capture_output=True, text=True)
            snapshot = json.loads(result.stdout)
            if args.herdr_session:
                discovery = subprocess.run([str(FIRSTMATE / 'bin/fm-attach.sh'), 'discover', '--session', args.herdr_session],
                                           env=env, check=True, capture_output=True, text=True, timeout=180)
                snapshot['attachable'] = json.loads(discovery.stdout)
                snapshot['discovery_notes'] = discovery.stderr.strip()
            presence, rows = probe(snapshot, args.fm_home)
            delivery = landed(snapshot, args.fm_home, presence)
            decisions = gates(snapshot, args.fm_home)
            if args.evidence:
                args.evidence.write_text(json.dumps({'snapshot': snapshot, 'presence': presence, 'probe': rows,
                                                     'delivery': delivery, 'decisions': decisions},
                                                    ensure_ascii=False, indent=1) + '\n')
        print(render(snapshot, presence, delivery, decisions), end='')
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as exc:
        print(f'workers-status: сбор или чтение snapshot не удались: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--launcher-sample':
        print(json.dumps(launcher_sample(sys.argv[2], sys.argv[3], Path(os.environ.get('FM_HOME', FIRSTMATE)))))
    elif len(sys.argv) == 3 and sys.argv[1] == '--process-sample':
        try:
            print(json.dumps(pane_sample(json.load(sys.stdin), sys.argv[2])))
        except (ValueError, TypeError):
            print(json.dumps({'procs': [], 'complete': False, 'error': 'ответ process-info не прочитан'}))
    else:
        sys.exit(main())
