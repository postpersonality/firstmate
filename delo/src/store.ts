import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { goalInput, goalPatch, actions, actionInput, personalLine } from './model.ts';
import type { Goal, Action } from './model.ts';
import { Firstmate, type FirstmateTask } from './firstmate.ts';
import { overview, pinRefusal } from './overview.ts';

const sections = ['Обложка', 'Зачем', 'Критерий готовности', 'Контекст', 'Ограничения'];

// The Firstmate home next to the projects folder: ~/Projects/firstmate for ~/Projects/<folder>/delo.
export const defaultFirstmateHome = (project = fileURLToPath(new URL('..', import.meta.url))) => resolve(project, '..', '..', 'firstmate');

function section(body: string, heading: string) {
  const headings = [...body.matchAll(/^## (.+)$/gm)].filter(m => sections.includes(m[1].trim()));
  const start = headings.findIndex(m => m[1].trim() === heading);
  if (start < 0) return '';
  return body.slice(headings[start].index + headings[start][0].length, headings[start + 1]?.index).trim();
}

function managedBody(body: string) {
  return /^## Зачем\s*(?:\r?\n|$)/.test(body) && /^## Зачем\s*(?:\r?\n|$)[\s\S]*^## Критерий готовности\s*(?:\r?\n|$)[\s\S]*^## Контекст\s*(?:\r?\n|$)[\s\S]*^## Ограничения\s*(?:\r?\n|$)/m.test(body);
}

function nativeLinks(task: FirstmateTask): string[] {
  const entries = Array.isArray(task.links) ? task.links : typeof task.links === 'string' && task.links !== 'none' ? task.links.split(',') : [];
  return entries.flatMap((entry: any) => {
    const value = typeof entry === 'string' ? entry.replace(/^(?:pr|report|doc):/, '') : entry?.url;
    return typeof value === 'string' && value ? [value] : [];
  });
}

// URLs typed into the title move to `Источник:` lines at the top of the body.
export function titleSources(value: string) {
  const refs = new Set<string>();
  const title = value.replace(/https?:\/\/[^\s<>"'«»]+/gi, candidate => {
    let ref = candidate.replace(/[.,;!?]+$/, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (ref.endsWith(close) && ref.split(close).length > ref.split(open).length) ref = ref.slice(0, -1);
    }
    try { new URL(ref); } catch { return candidate; }
    refs.add(ref); return candidate.slice(ref.length);
  }).replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, ' ').replace(/\s+/g, ' ').trim();
  const cleaned = refs.size ? title.replace(/^[,.;:!?\s]+|[,.;:!?\s]+$/g, '') : value;
  return { title: cleaned || 'Новое дело', sources: [...refs].map(ref => `Источник: ${ref}`) };
}

// The body exactly as typed, with source lines first and the personal marker as its own last line.
export function composeBody(body: string, sources: string[], personal: boolean) {
  const own = body.split('\n').filter(l => l !== personalLine).join('\n');
  return [...sources.filter(l => !own.includes(l)), own, personal ? personalLine : ''].filter(Boolean).join('\n');
}
const isPersonal = (body: string) => body.split('\n').some(l => l.trim() === personalLine);
const field = (v: unknown) => typeof v === 'string' && v && v !== '-' ? v : undefined;
const held = (task: FirstmateTask) => task.held === 'yes' || task.held === true;

// Every card and row comes from the Firstmate backlog; Delo keeps no data of its own.
export class Store {
  firstmate: Firstmate;
  constructor(options: { firstmateHome?: string } = {}) {
    this.firstmate = new Firstmate(options.firstmateHome || process.env.DELO_FIRSTMATE_HOME || defaultFirstmateHome());
  }

  // Creation writes only the Firstmate backlog: no template, never --start.
  create(input: unknown): Goal {
    const data = goalInput.parse(input);
    const { title, sources } = titleSources(data.title);
    const task = this.firstmate.add(undefined, title, composeBody(data.body, sources, data.personal), { kind: data.kind, repo: data.repo, blockedBy: data.blockedBy });
    if (data.holdUntil) this.firstmate.hold(task.id, `Отложено до ${data.holdUntil}`, 'parked', data.holdUntil);
    return this.get(task.id);
  }

  get(goalId: string, task = this.firstmate.show(goalId)): Goal {
    const body = task.body || '';
    const managed = managedBody(body);
    return {
      id: task.id, title: task.title, state: task.state === 'done' ? 'done' : held(task) ? 'paused' : 'active',
      body, kind: field(task.kind), repo: field(task.repo), personal: isPersonal(body), actions: actions(task),
      holdKind: field(task.hold_kind), inFlight: task.state === 'in_flight',
      why: managed ? section(body, 'Зачем') : '', doneWhen: managed ? section(body, 'Критерий готовности') : '', context: managed ? section(body, 'Контекст') : body,
      constraints: managed ? section(body, 'Ограничения').split('\n').filter(s => s.startsWith('- ')).map(s => s.slice(2)) : [],
      links: nativeLinks(task),
    };
  }

  list(): Goal[] {
    const seen = new Set<string>();
    return this.firstmate.list().filter(task => task.id && !seen.has(task.id) && seen.add(task.id))
      .map(task => this.get(task.id, task.body?.includes('\n... (truncated,') ? this.firstmate.show(task.id) : task));
  }

  update(goalId: string, input: unknown): Goal {
    const { title: newTitle, body, personal, state: nextState } = goalPatch.parse(input);
    if (newTitle !== undefined || body !== undefined || personal !== undefined) {
      const g = this.get(goalId);
      if (g.state === 'done') throw new Error('Бриф закрытой цели заморожен');
      const { title, sources } = newTitle === undefined ? { title: g.title, sources: [] } : titleSources(newTitle);
      const next = composeBody(body ?? g.body, sources, personal ?? g.personal);
      this.firstmate.update(goalId, { title, ...(next !== g.body ? { body: next, archiveBody: true } : {}) });
    }
    if (nextState === undefined) return this.get(goalId);
    const g = this.get(goalId);
    if (nextState === g.state || nextState === 'dropped' && g.state === 'done') return g;
    if (g.holdKind === 'captain') throw new Error('Вопрос капитану закрывается только ответом в Firstmate');
    if (g.inFlight) throw new Error('Состояние задачи в работе меняет Firstmate');
    // tasks-axi reports held: no on a Done row that still carries a hold, so ask the reopened row.
    if (nextState === 'active' && g.state === 'done') { if (this.firstmate.reopen(goalId).held) this.firstmate.unhold(goalId); }
    else if (nextState === 'paused') { if (g.state === 'done') this.firstmate.reopen(goalId); this.firstmate.hold(goalId, 'Приостановлено в Деле'); }
    else if (nextState === 'active') this.firstmate.unhold(goalId);
    else this.firstmate.done(goalId);
    return this.get(goalId);
  }

  // A card button. Starting and closing a row in flight are notes for firstmate, which owns dispatch.
  act(taskId: string, action: Action, input: unknown) {
    const data = actionInput.parse(input);
    const task = this.firstmate.show(taskId);
    if (!actions(task).includes(action)) throw new Error('Это действие недоступно для задачи в её состоянии');
    const need = <T>(value: T | undefined, what: string) => { if (!value) throw new Error(`Укажите ${what}`); return value; };
    if (action === 'start' || action === 'close' && task.state === 'in_flight') {
      const kind = action === 'start' ? 'start' : 'close';
      const text = kind === 'start' ? `Дело: возьми в работу задачу ${task.id}` : `Дело: закрой задачу ${task.id}`;
      const note = this.firstmate.note(text, this.requestId(kind, task.id));
      return { note, ready: this.firstmate.ready() };
    }
    if (action === 'answer' || action === 'release') {
      const answer = action === 'answer' ? need(data.answer, 'ответ') : data.answer || 'Разрешаю работу';
      const output = this.firstmate.answer(task.id, answer, action === 'answer' ? 'Ответить' : 'Разрешить работу', action === 'answer' ? 'done' : 'release');
      if (/^skipped:/m.test(output)) throw new Error(output);
      return { output };
    }
    if (action === 'later') return { output: this.firstmate.captainLater(task.id, need(data.reason, 'причину'), need(data.until, 'дату')) };
    if (action === 'pause') return { task: this.firstmate.hold(task.id, data.reason || 'Приостановлено в Деле') };
    if (action === 'unhold') return { task: this.firstmate.unhold(task.id) };
    if (action === 'close') return { task: this.firstmate.done(task.id) };
    if (action === 'decline') return { task: this.firstmate.done(task.id, `Отказ: ${need(data.reason, 'причину отказа')}`) };
    return { task: this.firstmate.reopen(task.id) };
  }

  // A repeated click on a request firstmate has not acknowledged reuses its id, so fm-inbox replays it.
  private requestId(kind: 'start' | 'close', taskId: string) {
    const prefix = `delo-${kind}-${taskId}-`;
    const { pending = [], handled = [] } = this.firstmate.receipts();
    const ours = [...pending, ...handled].filter((r: any) => typeof r.request_id === 'string' && r.request_id.startsWith(prefix) && /^\d+$/.test(r.request_id.slice(prefix.length)));
    const waiting = ours.find((r: any) => pending.includes(r) && !r.acknowledged);
    if (waiting) return waiting.request_id;
    return `${prefix}${Math.max(0, ...ours.map((r: any) => Number(r.request_id.slice(prefix.length)))) + 1}`;
  }

  // Delo's own notes about this row with their receipt state, and whether firstmate can take a note now.
  inbox(taskId: string) {
    const { pending = [], handled = [] } = this.firstmate.receipts();
    const requests = [...pending.map((r: any) => ({ ...r, state: 'pending' })), ...handled.map((r: any) => ({ ...r, state: 'handled' }))]
      .filter(r => [`delo-start-${taskId}-`, `delo-close-${taskId}-`].some(p => r.request_id?.startsWith(p)))
      .map(r => ({ requestId: r.request_id, at: r.at, state: r.state, acknowledged: !!r.acknowledged, reply: r.reply ?? null }));
    return { requests, ready: requests.some(r => r.state === 'pending') ? this.firstmate.ready() : undefined };
  }

  overview() {
    return overview(this.firstmate.snapshot('fm-bearings-snapshot.sh'), this.firstmate.snapshot('fm-fleet-snapshot.sh'));
  }

  // Pinning is the backlog row's priority: 0 puts it in focus, 2 is the backlog default.
  pin(taskId: string, on: boolean) {
    const refusal = on ? pinRefusal(this.firstmate.snapshot('fm-fleet-snapshot.sh'), taskId) : undefined;
    if (refusal) throw new Error(refusal);
    this.firstmate.priority(taskId, on ? 0 : 2);
    return this.overview();
  }
}
