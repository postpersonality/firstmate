// Main screen from the Firstmate snapshots: sections follow fm-bearings.v1, row fields come from fm-fleet-snapshot.v1.
export type Row = {
  id: string; title: string; kind?: string; repo?: string; pinned: boolean; open: boolean; task: boolean; personal: boolean;
  reason?: string; current?: string; noWorker?: boolean; blockedBy?: string; prUrl?: string; reportPath?: string; owner?: string;
};
export type Group = { repo: string; rows: Row[] };
export type Overview = { generated: string; focus: Row[]; waiting: Group[]; working: Group[]; next: Group[]; done: Group[]; kinds: string[]; repos: string[] };

export const focusLimit = 3;
export const noRepo = 'Без проекта';
const value = (v: unknown) => typeof v === 'string' && v && v !== '-' ? v : undefined;
export const pinned = (record: any) => String(record?.priority) === '0' && record?.state !== 'done';

export function groupByRepo(rows: Row[]): Group[] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) groups.set(row.repo || noRepo, [...groups.get(row.repo || noRepo) ?? [], row]);
  return [...groups].map(([repo, rows]) => ({ repo, rows })).sort((a, b) => Number(a.repo === noRepo) - Number(b.repo === noRepo) || a.repo.localeCompare(b.repo));
}

export function overview(bearings: any, fleet: any): Overview {
  const records = new Map<string, any>((fleet.backlog?.records ?? []).map((r: any) => [r.id, r]));
  const workers = new Map<string, any>((fleet.tasks ?? []).map((t: any) => [t.id, t]));
  const row = (id: string, title: string | undefined, extra: Partial<Row> = {}): Row => {
    const r = records.get(id);
    return {
      ...extra, id, title: value(r?.title) ?? value(title) ?? id, kind: value(r?.kind) ?? extra.kind, repo: value(r?.repo) ?? extra.repo,
      pinned: pinned(r), open: !!r && r.state !== 'done', task: !!r, personal: (r?.body_lines ?? []).some((l: unknown) => typeof l === 'string' && l.trim() === 'Личное'), prUrl: value(r?.pr_url), reportPath: value(r?.report_path),
    };
  };
  const current = (id: string, fallback?: string) => {
    const state = workers.get(id)?.current_state;
    return [value(state?.state), value(state?.detail)].filter(Boolean).join(': ') || value(fallback);
  };
  const waiting = (bearings.decisions_open ?? []).map((d: any) => row(d.id, d.summary, { reason: value(records.get(d.id)?.hold_reason) ?? value(d.summary), owner: d.owner }));
  const working = [
    ...(bearings.in_flight ?? []).map((t: any) => row(t.id, t.name, { kind: value(t.kind), repo: value(t.repo), current: current(t.id, t.doing ?? t.state) })),
    ...(fleet.main_inventory?.orphan_in_flight ?? []).map((id: string) => row(id, undefined, { noWorker: true })),
  ];
  const next = (bearings.gates ?? []).map((g: any) => row(g.id, g.title, { reason: value(g.reason), blockedBy: value(g.blocked_by), owner: g.owner }));
  const done = (bearings.landed ?? []).map((l: any) => row(l.id, l.what, { owner: l.owner }));
  const all = [...waiting, ...working, ...next, ...done];
  const focus = [...records.values()].filter(pinned).map(r => row(r.id, r.title));
  return {
    generated: bearings.generated, focus,
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
