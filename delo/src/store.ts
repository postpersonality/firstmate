import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { goalInput, goalPatch, actions, actionInput, personalLine, caseInput, closeCaseInput, agentInput, phase, id } from './model.ts';
import type { Goal, Action } from './model.ts';
import { validateReview, reviewProjects, reviewOf, reviewLine, reviewInstructions, readReviewProgress } from './review.ts';
import { Firstmate, type FirstmateTask } from './firstmate.ts';
import { type Overview, overview, workerState, taskBlockers, pinRefusal, caseOf, hasReport, linkEntries, reportPath } from './overview.ts';

const sections = ['Обложка', 'Зачем', 'Критерий готовности', 'Контекст', 'Ограничения'];

// The Firstmate home next to the projects folder: ~/Projects/firstmate for ~/Projects/<folder>/delo.
export const defaultFirstmateHome = (project = fileURLToPath(new URL('..', import.meta.url))) => resolve(project, '..', '..', 'firstmate');

function section(body: string, heading: string) {
  const headings = [...body.matchAll(/^## (.+)$/gm)].filter(m => sections.includes(m[1].trim()));
  const start = headings.findIndex(m => m[1].trim() === heading);
  if (start < 0) return '';
  return body.slice(headings[start].index + headings[start][0].length, headings[start + 1]?.index).trim();
}

// A дело's `Источник:` lines come before its brief.
function managedBody(body: string) {
  body = body.replace(/^(?:Источник: .*\n)+/, '');
  return /^## Зачем\s*(?:\r?\n|$)/.test(body) && /^## Зачем\s*(?:\r?\n|$)[\s\S]*^## Критерий готовности\s*(?:\r?\n|$)[\s\S]*^## Контекст\s*(?:\r?\n|$)[\s\S]*^## Ограничения\s*(?:\r?\n|$)/m.test(body);
}

function nativeLinks(task: FirstmateTask): string[] {
  return linkEntries(task.links).flatMap((entry: any) => {
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

// A duty's read-only folder is one `Папка:` line of the body, which firstmate reads when it starts the task.
const folderLine = 'Папка: ';
export const folderOf = (body: string) => body.split('\n').find(l => l.startsWith(folderLine))?.slice(folderLine.length).trim() ?? '';
export function checkFolder(value: string) {
  const typed = value.trim();
  if (!typed) return '';
  const path = typed === '~' || typed.startsWith('~/') ? join(homedir(), typed.slice(1)) : typed;
  if (!isAbsolute(path)) throw new Error(`Папка: нужен абсолютный путь или ~/…, а не «${typed}»`);
  let directory = false; try { directory = statSync(path).isDirectory(); } catch { /* A missing path is refused below. */ }
  if (!directory) throw new Error(`Папка: нет такой папки ${path}`);
  return resolve(path);
}

// The body exactly as typed, with source lines first and the personal marker as its own last line.
// A changed folder line goes right after the leading reference lines; an unchanged one stays put, so a rename keeps the body byte-for-byte.
export function composeBody(body: string, sources: string[], personal: boolean, folder = folderOf(body)) {
  let lines = body ? body.split('\n').filter(l => l !== personalLine) : [];
  if (folderOf(lines.join('\n')) !== folder) {
    lines = lines.filter(l => !l.startsWith(folderLine));
    const at = lines.findIndex(l => !/^(?:(?:Дело|Источник|Исполнитель): |Интерактивно$)/.test(l));
    if (folder) lines.splice(at < 0 ? lines.length : at, 0, `${folderLine}${folder}`);
  }
  const own = lines.join('\n');
  return [...sources.filter(l => !own.includes(l)), own, personal ? personalLine : ''].filter(Boolean).join('\n');
}
// A task of a дело names it, the chosen executor and interactive work in its first lines; firstmate reads them when it starts the task.
// bin/fm-brief.sh's header owns the `Дело: <id>` line format.
const harnessLine = 'Исполнитель: ';
const interactiveLine = 'Интерактивно';
export const harnessOf = (body: string) => body.split('\n').find(l => l.startsWith(harnessLine))?.slice(harnessLine.length).trim() ?? '';
// The title is the direction's first sentence, cut to the title limit.
export const firstSentence = (text: string) => (/^.*?[.!?…](?=\s|$)/.exec(text.trim().split('\n')[0])?.[0] ?? text.trim().split('\n')[0]).slice(0, 500);
const sourceLine = 'Источник: ';
const caseBody = (c: { why: string; doneWhen: string; context: string; constraints: string[]; sources: string[] }) =>
  [...c.sources.map(s => `${sourceLine}${s}`), '## Зачем', c.why, '## Критерий готовности', c.doneWhen, '## Контекст', c.context, '## Ограничения', ...c.constraints.map(s => `- ${s}`)].join('\n');
const lines = (value: string) => value.split('\n').map(l => l.trim()).filter(Boolean);
const isPersonal = (body: string) => body.split('\n').some(l => l.trim() === personalLine);
const field = (v: unknown) => typeof v === 'string' && v && v !== '-' ? v : undefined;
const held = (task: FirstmateTask) => task.held === 'yes' || task.held === true;
const cut = (value: unknown) => typeof value === 'string' && value.includes('\n... (truncated,');
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every card and row comes from the Firstmate backlog; Delo keeps no data of its own.
export class Store {
  firstmate: Firstmate;
  private overviewRead?: { promise: Promise<Overview>; expires: number };
  private revision = 0;
  private invalidateOverview() { this.overviewRead = undefined; this.revision++; }
  constructor(options: { firstmateHome?: string } = {}) {
    this.firstmate = new Firstmate(options.firstmateHome || process.env.DELO_FIRSTMATE_HOME || defaultFirstmateHome());
  }

  // Creation writes only the Firstmate backlog: no template, never --start.
  create(input: unknown): Goal {
    this.invalidateOverview();
    const data = goalInput.parse(input);
    const { title, sources } = titleSources(data.title);
    if (data.caseId) { const c = this.firstmate.show(data.caseId); if (c.kind !== 'program' || c.state === 'done') throw new Error('Такого открытого дела нет'); }
    const body = [data.caseId ? `Дело: ${data.caseId}` : '', composeBody(data.body, sources, data.personal, checkFolder(data.folder))].filter(Boolean).join('\n');
    const task = this.firstmate.add(undefined, title, body, { kind: data.kind, repo: data.repo, blockedBy: data.blockedBy });
    if (data.holdUntil) this.firstmate.hold(task.id, `Отложено до ${data.holdUntil}`, 'parked', data.holdUntil);
    return this.get(task.id);
  }

  // A дело is a program row put In flight at once: it never gets a worker, so it stays there until closed.
  createCase(input: unknown) {
    this.invalidateOverview();
    const data = caseInput.parse(input);
    const { title, sources } = titleSources(data.title);
    const body = caseBody({ ...data, constraints: lines(data.constraints).map(l => l.replace(/^- /, '')), sources: [...sources.map(l => l.slice(sourceLine.length)), ...lines(data.sources).map(l => l.replace(/^Источник:\s*/, ''))] });
    if (data.review) {
      if (!data.requestId) throw new Error('Для ревью нужен requestId');
      const review = validateReview(data.review, this.firstmate.home);
      const caseId = `review-${data.requestId}`, childId = `${caseId}-agent`;
      const existing = [...this.firstmate.list(), ...this.firstmate.archive()].find(t => t.id === caseId);
      if (existing && JSON.stringify(reviewOf(this.whole(existing).body ?? '')) !== JSON.stringify(review)) throw new Error('Повтор запроса с другими входами ревью');
      if (!existing) this.firstmate.add(caseId, title, `${body}\n${reviewLine(review)}`, { kind: 'program' });
      if (existing?.state !== 'done') {
        if (!existing || existing.state !== 'in_flight') this.firstmate.start(caseId);
        const child = [...this.firstmate.list(), ...this.firstmate.archive()].find(t => t.id === childId);
        if (!child) this.firstmate.add(childId, `${review.kind === 'sa' ? 'Ревью СА' : 'Код-ревью'}: ` + title.slice(0, 480), `Дело: ${caseId}\n${reviewInstructions(review, this.firstmate.home, childId)}`, { kind: 'scout' });
      }
      return this.getCase(caseId);
    }
    const task = this.firstmate.add(undefined, title, body, { kind: 'program' });
    this.firstmate.start(task.id);
    return this.getCase(task.id);
  }

  // «Новый агент»: a task of an open дело through the ordinary create path, then the ordinary start request for firstmate.
  newAgent(caseId: string, input: unknown) {
    this.invalidateOverview();
    const data = agentInput.parse(input);
    const c = this.getCase(caseId);
    if (c.archived || c.state === 'done') throw new Error('Новый агент запускается только в открытом деле');
    const head = [data.harness ? `${harnessLine}${data.harness}` : '', data.interactive ? interactiveLine : ''].filter(Boolean);
    const task = this.create({ title: firstSentence(data.direction), kind: data.kind, repo: data.kind === 'ship' ? data.repo : '', caseId, folder: data.folder, body: [...head, '', data.direction.trim()].join('\n') });
    const started = this.act(task.id, 'start', {});
    return { note: started.note, ready: started.ready, task: this.get(task.id) };
  }

  // A closed дело leaves the backlog for the archive after done_keep closures; its page then reads it from there, read-only.
  getCase(caseId: string) {
    let task: FirstmateTask; let archived = false;
    try { task = this.firstmate.show(caseId); }
    catch (error: any) { if (!/NOT_FOUND/.test(`${error.code} ${error.stdout} ${error.message}`)) throw error; task = this.firstmate.show(caseId, true); archived = true; }
    if (task.kind !== 'program') throw new Error('Это не дело');
    const goal = this.get(caseId, task);
    const entry = (t: FirstmateTask) => {
      const { id, title, state, actions, holdKind, inFlight, links, report, review, reviewProgress } = this.get(t.id, t);
      return { id, title, state, actions, holdKind, inFlight, phase: phase(t), links, report, review, reviewProgress };
    };
    const tasks = this.firstmate.list().filter(t => caseOf(t.body) === caseId).map(t => entry(this.whole(t)));
    const earlier = this.firstmate.archive().filter(t => caseOf(t.body) === caseId).map(t => entry(this.whole(t, true)));
    const sources = goal.body.split('\n').filter(l => l.startsWith(sourceLine)).map(l => l.slice(sourceLine.length).trim());
    return { ...goal, archived, sources, tasks, earlier, links: [...new Set([...sources, ...goal.links, ...[...tasks, ...earlier].flatMap(t => t.links)])] };
  }

  // Q40В: open tasks close only after the warning that lists them is confirmed; each gets the task «Закрыть» note for firstmate.
  closeCase(caseId: string, input: unknown) {
    this.invalidateOverview();
    const { confirmed } = closeCaseInput.parse(input);
    const c = this.getCase(caseId);
    if (c.archived || c.state === 'done') throw new Error('Дело уже закрыто');
    const open = c.tasks.filter(t => t.phase !== 'done');
    const unconfirmed = open.filter(t => !confirmed.includes(t.id));
    if (unconfirmed.length) throw new Error(`Не подтверждено закрытие задач: ${unconfirmed.map(t => t.title).join(', ')}`);
    const notes = open.map(t => this.firstmate.note(`Дело: закрой задачу ${t.id}`, this.requestId('close', t.id)));
    this.firstmate.done(caseId);
    return { notes, case: this.getCase(caseId) };
  }

  reopenCase(caseId: string) {
    this.invalidateOverview();
    const c = this.getCase(caseId);
    if (c.archived || c.state !== 'done') throw new Error('Вернуть можно только закрытое дело из бэклога');
    this.firstmate.reopen(caseId); this.firstmate.start(caseId);
    return this.getCase(caseId);
  }

  // Q42А: an archived дело is not returned; «Продолжить» opens a new дело with its title, brief and sources.
  closedCases() { return this.firstmate.archive().filter(t => t.kind === 'program').map(t => ({ id: t.id, title: t.title, closed: field(t.closed) })); }
  continueCase(caseId: string) {
    this.invalidateOverview();
    const old = this.getCase(caseId);
    if (!old.archived) throw new Error('Продолжить можно только дело из архива');
    const task = this.firstmate.add(undefined, old.title, caseBody(old), { kind: 'program' });
    this.firstmate.start(task.id);
    return this.getCase(task.id);
  }

  // A list row cut by tasks-axi is read again in full; a closed row's title drops the trailing link the backlog line carries.
  private whole(task: FirstmateTask, archive = false): FirstmateTask {
    const full = cut(task.title) || cut(task.body) ? this.firstmate.show(task.id, archive) : task;
    if (full.state !== 'done') return full;
    const trailing = nativeLinks(full).map(link => new RegExp(`\\s+(?:-\\s+)?${escapeRegExp(link)}$`));
    let title = full.title, before;
    do { before = title; for (const link of trailing) title = title.replace(link, ''); } while (title !== before);
    return { ...full, title };
  }

  get(goalId: string, task = this.firstmate.show(goalId)): Goal {
    task = this.whole(task);
    const body = task.body || '';
    const managed = managedBody(body);
    const dependencies = task.blocked_by && task.blocked_by !== 'none' || task.blocked_by_ids?.length || task.unresolved_blocker_ids?.length;
    const records = new Map((dependencies ? this.firstmate.list() : []).map(t => [t.id, t]));
    const review = reviewOf(body);
    const reviewReport = !!review && existsSync(join(this.firstmate.home, reportPath(task.id)));
