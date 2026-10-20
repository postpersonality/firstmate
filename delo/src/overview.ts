import { actions, phase, type Phase, type Goal } from './model.ts';
import type { FirstmateTask } from './firstmate.ts';
// Main screen from the Firstmate snapshots: sections follow fm-bearings.v1, row fields come from fm-fleet-snapshot.v1.
export type Row = {
  id: string; title: string; kind?: string; repo?: string; pinned: boolean; open: boolean; task: boolean; personal: boolean;
  reason?: string; current?: string; noWorker?: boolean; blockedBy?: string; blockers?: { id: string; title: string }[]; prUrl?: string; reportPath?: string; owner?: string;
  actions: Goal['actions']; state?: Goal['state']; holdKind?: string; inFlight?: boolean;
};
export type Group = { repo: string; rows: Row[] };
export type CaseRow = Row & { counts: Record<Phase, number> };
export type Overview = { generated: string; cases: CaseRow[]; focus: Row[]; waiting: Group[]; working: Group[]; next: Group[]; done: Group[]; kinds: string[]; repos: string[] };

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

export function groupByRepo(rows: Row[]): Group[] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) groups.set(row.repo || noRepo, [...groups.get(row.repo || noRepo) ?? [], row]);
  return [...groups].map(([repo, rows]) => ({ repo, rows })).sort((a, b) => Number(a.repo === noRepo) - Number(b.repo === noRepo) || a.repo.localeCompare(b.repo));
}

// A task belongs to a дело when the first line of its body is `Дело: <id>`.
export const caseOf = (lines: unknown) => { const first = Array.isArray(lines) ? lines[0] : typeof lines === 'string' ? lines.split('\n')[0] : undefined; return typeof first === 'string' ? /^Дело: (\S+)$/.exec(first.trim())?.[1] : undefined; };

export function overview(bearings: any, fleet: any, archive: any[] = [], tasks: FirstmateTask[] = []): Overview {
  const records = new Map<string, any>((fleet.backlog?.records ?? []).map((r: any) => [r.id, r]));
  // Fleet snapshots omit the computed held bit; tasks-axi owns expiry and action availability.
  const native = new Map(tasks.map(t => [t.id, t]));
  const workers = new Map<string, any>((fleet.tasks ?? []).map((t: any) => [t.id, t]));
  const row = (id: string, title: string | undefined, extra: Partial<Row> = {}): Row => {
    const r = records.get(id);
    const task = native.get(id) ?? r;
    const worker = workers.get(id);
    return {
      ...extra, id, title: value(r?.title) ?? value(title) ?? id, kind: value(r?.kind) ?? extra.kind, repo: value(r?.repo) ?? extra.repo,
      pinned: pinned(r), open: !!r && r.state !== 'done', task: !!r, personal: (r?.body_lines ?? []).some((l: unknown) => typeof l === 'string' && l.trim() === 'Личное'), prUrl: value(worker?.pr?.url) ?? value(r?.pr_url), reportPath: value(r?.report_path),
      actions: r ? actions(task) : [], state: !r ? undefined : task.state === 'done' ? 'done' : task.held === true || task.held === 'yes' ? 'paused' : 'active',
      reason: value(r?.hold_reason) ?? extra.reason,
      blockers: taskBlockers({ ...r, blocked_by: extra.blockedBy ?? r?.blocked_by }, records),
      current: worker || task?.state === 'in_flight' ? workerState(worker) : extra.current,
      holdKind: value(task?.hold_kind), inFlight: task?.state === 'in_flight',
    };
  };
  const waiting = (bearings.decisions_open ?? []).map((d: any) => row(d.id, d.summary, { reason: value(records.get(d.id)?.hold_reason) ?? value(d.summary), owner: d.owner }));
  const working = [
    ...(bearings.in_flight ?? []).map((t: any) => row(t.id, t.name, { kind: value(t.kind), repo: value(t.repo) })),
    ...(fleet.main_inventory?.orphan_in_flight ?? []).map((id: string) => row(id, undefined, { noWorker: true })),
  ];
  const next = (bearings.gates ?? []).map((g: any) => {
    const warning = !records.has(g.id) && g.id.startsWith('(');
    return row(g.id, warning ? 'Требуется внимание Firstmate' : g.title, {
      reason: warning ? 'Нужно проверить состояние задач' : records.has(g.id) ? undefined : value(g.reason),
      blockedBy: value(g.blocked_by), owner: g.owner,
    });
  });
  const done = (bearings.landed ?? []).map((l: any) => row(l.id, l.what, { owner: l.owner }));
  const all = [...waiting, ...working, ...next, ...done];
  const focus = [...records.values()].filter(pinned).map(r => row(r.id, r.title));
  // Open program rows sit in no Bearings section, so «Дела» reads them from the fleet records and counts their tasks there and in the archive.
  const members = [...[...records.values()].map(r => [caseOf(r.body_lines), phase(r)]), ...archive.map(t => [caseOf(t.body), 'done'])];
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
