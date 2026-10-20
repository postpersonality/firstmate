import { actions, type Phase, type Goal, type TaskRequest } from './model.ts';
import type { FirstmateTask } from './firstmate.ts';
// Bearings supplies context; backlog and reconciled worker state determine each row's section.
export type Row = {
  id: string; title: string; kind?: string; repo?: string; pinned: boolean; open: boolean; task: boolean; personal: boolean;
  reason?: string; current?: string; noWorker?: boolean; blockedBy?: string; blockers?: { id: string; title: string }[]; prUrl?: string; reportPath?: string; owner?: string;
  requests?: TaskRequest[]; actions: Goal['actions']; state?: Goal['state']; holdKind?: string; inFlight?: boolean;
  phase?: Phase;
};
export type Group = { repo: string; rows: Row[] };
export type CaseRow = Row & { counts: Record<Phase, number> };
export type Overview = { generated: string; cases: CaseRow[]; focus: Row[]; waiting: Group[]; working: Group[]; next: Group[]; done: Group[]; kinds: string[]; repos: string[] };

// Receipt acceptance is independent of the backlog state: handled never means executed.
export function requestsByTask(receipts: { pending?: any[]; handled?: any[] } = {}) {
  const result = new Map<string, TaskRequest[]>();
  for (const [state, entries] of [['pending', receipts.pending ?? []], ['handled', receipts.handled ?? []]] as const) {
    for (const entry of entries) {
      const match = /^delo-(start|stop|close)-(.+)-(\d+)$/.exec(entry.request_id ?? '');
      if (!match) continue;
      const request: TaskRequest = { action: match[1] as TaskRequest['action'], requestId: entry.request_id, state: state === 'handled' || entry.acknowledged ? 'handled' : 'pending' };
      const own = result.get(match[2]) ?? [];
      const previous = own.findIndex(r => r.action === request.action);
      if (previous < 0) own.push(request);
      else if (Number(own[previous].requestId.split('-').at(-1)) <= Number(match[3])) own[previous] = request;
      result.set(match[2], own);
    }
  }
  return result;
}

export const focusLimit = 3;
export const noRepo = 'Без проекта';
const value = (v: unknown) => typeof v === 'string' && v && v !== '-' ? v : undefined;
// A task's own report is its backlog link `report:data/<id>/report.md`; any other report link stays plain text.
export const reportPath = (id: string) => `data/${id}/report.md`;
export const linkEntries = (links: unknown): unknown[] => Array.isArray(links) ? links : typeof links === 'string' && links !== 'none' ? links.split(',') : [];
export const hasReport = (task: { id: string; links?: unknown }) => linkEntries(task.links).includes(`report:${reportPath(task.id)}`);
export const pinned = (record: any) => String(record?.priority) === '0' && record?.state !== 'done';

// Shared by overview rows and task cards; completed dependencies no longer hold the task.
export function taskBlockers(task: any, records: Map<string, any>) {
  const ids: string[] = task.unresolved_blocker_ids ?? task.blocked_by_ids ?? value(task.blocked_by)?.split(',') ?? [];
  return ids.map(id => id.trim()).filter(id => id && id !== 'none' && records.get(id)?.state !== 'done').map(id => ({ id, title: value(records.get(id)?.title) ?? id }));
}

// Uses reconciled current state, never historical status events or unknown-state hints.
export function workerState(worker: any): string {
  if (!worker) return 'Нет исполнителя';
  const state = worker.current_state;
  if (!state || state.state === 'unknown') return 'Состояние неизвестно';
  if (state.state === 'needs-decision' || (['parked', 'paused', 'blocked'].includes(state.state) && (worker.hints?.pending_decision === true || /^needs-decision\b/.test(state.detail ?? '')))) return 'Вопрос исполнителя';
  if (state.state === 'working') return state.source === 'run-step' || /^(validating\b|ci running\b)/.test(state.detail ?? '') ? 'Идёт проверка' : 'Работает';
  return ({ parked: 'Исполнитель на паузе', paused: 'Исполнитель на паузе', blocked: 'Работа заблокирована', done: 'Работа исполнителя завершена', failed: 'Работа завершилась с ошибкой' } as Record<string, string>)[state.state] ?? 'Состояние неизвестно';
}

// Business progress is independent of native runtime; explicit waits and completion win.
export function position(task: any, worker: any, records: Map<string, any>): { phase: Phase; reason?: string; owner?: string } {
  if (task?.state === 'done') return { phase: 'done' };
  const reason = value(task?.hold_reason);
  const blockers = taskBlockers(task ?? {}, records);
  if (blockers.length) return { phase: 'waiting', reason: reason ?? 'Ожидает завершения задач' };
  if (task?.hold_kind === 'captain') return { phase: 'waiting', reason: reason ?? 'Ожидает ответа', owner: 'Капитан' };
  if (task?.held === true || task?.held === 'yes' || task?.held === undefined && reason && task?.hold_kind) {
    return { phase: 'waiting', reason: [reason ?? 'Задача отложена', value(task.hold_until) ? `До ${task.hold_until}` : undefined].filter(Boolean).join(' · ') };
  }
  const current = worker?.current_state?.state === 'unknown' && worker?.declaredWait ? worker.declaredWait : worker?.current_state;
  const state = current?.state;
  const detail = value(current?.detail);
  if (['unknown', 'done'].includes(state) && worker?.delivery?.state === 'pending') return { phase: 'waiting', reason: 'Результат готов, ожидает локальной посадки', owner: 'Firstmate' };
  const decision = state === 'unknown' ? worker?.hints?.open_decisions?.[0] : undefined;
  if (decision) return { phase: 'waiting', reason: value(decision.summary) ?? 'Ожидает разрешения открытого вопроса', owner: decision.verb === 'needs-decision' ? 'Firstmate' : undefined };
  if (state === 'needs-decision' || ['parked', 'paused', 'blocked'].includes(state) && (worker.hints?.pending_decision === true || /^needs-decision\b/.test(detail ?? ''))) {
    return { phase: 'waiting', reason: `Исполнителю нужен ответ Firstmate${detail ? `: ${detail.replace(/^needs-decision:\s*/, '')}` : ''}`, owner: 'Firstmate' };
  }
  if (state === 'done' && !task?.state) return { phase: 'done' };
  if (state === 'done') return { phase: 'waiting', reason: worker.pr?.url ? 'Результат готов, ожидает ревью или слияния' : 'Результат готов, ожидает разбора и завершения задачи', owner: 'Firstmate' };
  if (state === 'failed') return { phase: 'waiting', reason: `Нужен разбор ошибки исполнителя${detail ? `: ${detail}` : ''}`, owner: 'Firstmate' };
  if (['parked', 'paused', 'blocked'].includes(state)) return { phase: 'waiting', reason: `Исполнитель ожидает продолжения${detail ? `: ${detail}` : ''}` };
  return { phase: task?.state === 'in_flight' || state === 'working' ? 'working' : 'next' };
}

export function groupByRepo(rows: Row[]): Group[] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) groups.set(row.repo || noRepo, [...groups.get(row.repo || noRepo) ?? [], row]);
  return [...groups].map(([repo, rows]) => ({ repo, rows })).sort((a, b) => Number(a.repo === noRepo) - Number(b.repo === noRepo) || a.repo.localeCompare(b.repo));
}

// A task belongs to a дело when the first line of its body is `Дело: <id>`.
export const caseOf = (lines: unknown) => { const first = Array.isArray(lines) ? lines[0] : typeof lines === 'string' ? lines.split('\n')[0] : undefined; return typeof first === 'string' ? /^Дело: (\S+)$/.exec(first.trim())?.[1] : undefined; };

export function overview(bearings: any, fleet: any, archive: any[] = [], tasks: FirstmateTask[] = [], receipts = {}): Overview {
  const requests = requestsByTask(receipts);
  const records = new Map<string, any>((fleet.backlog?.records ?? []).map((r: any) => [r.id, r]));
  // Fleet snapshots omit the computed held bit; tasks-axi owns expiry and action availability.
  for (const task of tasks) records.set(task.id, { ...records.get(task.id), ...task, body_lines: records.get(task.id)?.body_lines ?? task.body?.split('\n') });
  const workers = new Map<string, any>((fleet.tasks ?? []).map((t: any) => [t.id, t]));
  for (const t of bearings.in_flight ?? []) if (!workers.has(t.id) && !records.has(t.id)) workers.set(t.id, { current_state: { state: t.state } });
  const row = (id: string, title: string | undefined, extra: Partial<Row> = {}): Row => {
    const r = records.get(id);
    const task = r;
    const worker = workers.get(id);
    const place = position(task, worker, records);
    return {
      ...extra, id, title: value(r?.title) ?? value(title) ?? id, kind: value(r?.kind) ?? extra.kind, repo: value(r?.repo) ?? extra.repo,
      pinned: pinned(r), open: !!r && r.state !== 'done', task: !!r, personal: (r?.body_lines ?? []).some((l: unknown) => typeof l === 'string' && l.trim() === 'Личное'), prUrl: value(worker?.pr?.url) ?? value(r?.pr_url), reportPath: value(r?.report_path),
      requests: (requests.get(id) ?? []).filter(request => task && actions(task).includes(request.action) && (request.action !== 'close' || task.state === 'in_flight')),
      actions: r ? actions(task) : [], state: !r ? undefined : task.state === 'done' ? 'done' : task.held === true || task.held === 'yes' ? 'paused' : 'active',
      reason: place.reason ?? extra.reason, owner: place.owner, phase: place.phase,
      blockers: taskBlockers({ ...r, blocked_by: extra.blockedBy ?? r?.blocked_by }, records),
      current: worker || task?.state === 'in_flight' ? `${task?.state === 'done' && worker ? 'Сохранённый исполнитель · ' : ''}${workerState(worker)}` : extra.current,
      holdKind: value(task?.hold_kind), inFlight: task?.state === 'in_flight',
      noWorker: task?.state === 'in_flight' && !worker || extra.noWorker,
    };
  };
  const decisions = new Set<string>((bearings.decisions_open ?? []).map((d: any) => d.id));
  const candidates = [
    ...(bearings.decisions_open ?? []).map((d: any) => row(d.id, d.summary, { reason: value(d.summary) })),
    ...(bearings.in_flight ?? []).map((t: any) => row(t.id, t.name, { kind: value(t.kind), repo: value(t.repo) })),
    ...(fleet.main_inventory?.orphan_in_flight ?? []).map((id: string) => row(id, undefined, { noWorker: true })),
    ...(bearings.gates ?? []).map((g: any) => {
      const warning = !records.has(g.id) && g.id.startsWith('(');
      return row(g.id, warning ? 'Требуется внимание Firstmate' : g.title, {
        reason: warning ? 'Нужно проверить состояние задач' : records.has(g.id) ? undefined : value(g.reason),
        blockedBy: value(g.blocked_by),
      });
    }),
    ...(bearings.landed ?? []).map((l: any) => row(l.id, l.what)),
    ...[...records.values()].filter(r => r.id && r.kind !== 'program').map(r => row(r.id, r.title)),
  ];
  const sections: Record<Phase, Row[]> = { waiting: [], working: [], next: [], done: [] };
  const landed = new Set((bearings.landed ?? []).map((l: any) => l.id));
  for (const r of new Map<string, Row>(candidates.map(r => [r.id, r])).values()) {
    if (records.get(r.id)?.kind === 'program') continue;
    const task = records.get(r.id) ?? archive.find(t => t.id === r.id);
    const place = position(task ?? (r.blockedBy ? { blocked_by: r.blockedBy } : undefined), workers.get(r.id), records);
    if (!task && decisions.has(r.id)) { place.phase = 'waiting'; place.owner = 'Капитан'; }
    else if (!task && landed.has(r.id)) place.phase = 'done';
    sections[place.phase].push({ ...r, phase: place.phase, reason: place.phase === 'done' ? undefined : place.reason ?? r.reason, owner: place.owner });
  }
  const { waiting, working, next, done } = sections;
  const all = [...waiting, ...working, ...next, ...done];
  const focus = [...records.values()].filter(pinned).map(r => row(r.id, r.title));
  // Open program rows sit in no Bearings section, so «Дела» reads them from the fleet records and counts their tasks there and in the archive.
  const members = [...[...records.values()].map(r => [caseOf(r.body_lines), position(r, workers.get(r.id), records).phase]), ...archive.filter(t => !records.has(t.id)).map(t => [caseOf(t.body), 'done'])];
  const cases = [...records.values()].filter(r => r.kind === 'program' && r.state !== 'done').map(r => ({
    ...row(r.id, r.title), counts: Object.fromEntries((['working', 'waiting', 'next', 'done'] as const).map(p => [p, members.filter(([c, m]) => c === r.id && m === p).length])) as Record<Phase, number>,
  }));
  return {
    generated: bearings.generated, cases, focus,
    waiting: groupByRepo(waiting), working: groupByRepo(working), next: groupByRepo(next), done: groupByRepo(done),
    kinds: [...new Set(all.map(r => r.kind).filter((k): k is string => !!k))].sort(),
    repos: [...new Set([...records.values()].map(r => value(r.repo)).filter((k): k is string => !!k))].sort(),
  };
}

// Returns why the pin is refused, or undefined when the row may be pinned.
export function pinRefusal(fleet: any, id: string) {
  const records: any[] = fleet.backlog?.records ?? [];
  const record = records.find(r => r.id === id);
  if (!record) return 'Задачи нет в бэклоге Firstmate';
  if (record.state === 'done') return 'Закрытую задачу нельзя закрепить';
  if (pinned(record)) return undefined;
  if (records.filter(pinned).length >= focusLimit) return `В фокусе уже ${focusLimit} задачи; открепите одну, чтобы закрепить эту`;
}
