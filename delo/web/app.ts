import type { Goal } from '../src/model.ts';
import type { Overview, Row, CaseRow } from '../src/overview.ts';
type ViewGoal = Goal & { inbox?: { requests: { requestId: string; at: string; state: string; acknowledged: boolean; reply: unknown }[]; ready?: any }; worker?: { harness: string } };
type CaseTask = { id: string; title: string; phase: keyof typeof phaseLabels; links: string[]; report: boolean };
type ViewCase = Goal & { archived: boolean; sources: string[]; tasks: CaseTask[]; earlier: CaseTask[] };
const phaseLabels = { working: 'в работе', waiting: 'ждёт меня', next: 'дальше', done: 'сделано' };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const date = (s: string) => s ? new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const badge = (title: string) => `<span class="badge">${esc(title)}</span>`;
// Only a task's own `data/<id>/report.md` link opens as «Отчёт»; other refs stay as they are.
const ownReport = (taskId: string) => `data/${taskId}/report.md`;
const reportAnchor = (taskId: string) => `<a class="report-link" href="#report:${encodeURIComponent(taskId)}">Отчёт</a>`;
const closed = (g: Goal) => g.state === 'done' || g.state === 'dropped';
const field = (name: string, label: string, value = '', multiline = false, required = false) => `<label>${esc(label)}${multiline ? `<textarea name="${name}" ${required ? 'required' : ''}>${esc(value)}</textarea>` : `<input name="${name}" value="${esc(value)}" ${required ? 'required' : ''} maxlength="500">`}</label>`;
let csrf = ''; let view: Overview | undefined;
let kind = ''; let current: ViewGoal | undefined;
let submitDialog: (form: FormData) => Promise<void> = async () => {};

async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'content-type': 'application/json', 'x-delo-csrf': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error ?? `Ошибка ${response.status}`); return value;
}
function message(text: string, error = false) {
  $('message').textContent = text; $('message').className = `message${error ? ' error' : ''}`; $('message').hidden = false;
  window.setTimeout(() => { $('message').hidden = true; }, 5000);
}
function modal(title: string, body: string, action: (form: FormData) => Promise<void>, submit = 'Сохранить') {
  $('dialog-title').textContent = title; $('dialog-body').innerHTML = body; $('dialog-error').textContent = '';
  $('dialog-submit').textContent = submit;
  submitDialog = action; $('dialog-submit').hidden = !submit;
  ($('dialog') as HTMLDialogElement).showModal();
}
const personalLine = 'Личное';
const personalBox = (on = false) => `<label class="checkbox"><input type="checkbox" name="personal" ${on ? 'checked' : ''}> Личное</label>`;
// The folder is the body's `Папка:` line; suggestions are the folders other backlog tasks name.
const folderLine = 'Папка: ';
const folderField = (folders: string[], value = '') => `<label>Папка (только чтение)<input name="folder" value="${esc(value)}" list="folder-list" maxlength="500" placeholder="абсолютный путь или ~/…"><datalist id="folder-list">${folders.map(f => `<option value="${esc(f)}">`).join('')}</datalist></label>`;
async function newGoal() {
  const folders = await api<string[]>('/api/folders');
  const repos = view?.repos ?? [];
  const cases = view?.cases ?? [];
  modal('Новая задача', `${field('title', 'Название', '', false, true)}${personalBox()}<label>Дело<select name="caseId"><option value="">Без дела</option>${cases.map(c => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('')}</select></label><label>Вид<select name="kind"><option value="ship">ship</option><option value="scout">scout</option></select></label><label>Проект<input name="repo" list="repo-list" maxlength="500"><datalist id="repo-list">${repos.map(r => `<option value="${esc(r)}">`).join('')}</datalist></label>${folderField(folders)}${field('body', 'Описание', '', true)}${field('blockedBy', 'После задачи (id)')}<label>Отложить до<input type="date" name="holdUntil"></label>`, async f => {
    const g = await api<Goal>('/api/goals', { title: f.get('title'), kind: f.get('kind'), repo: f.get('repo'), body: f.get('body'), blockedBy: f.get('blockedBy'), holdUntil: f.get('holdUntil'), personal: f.has('personal'), caseId: f.get('caseId'), folder: f.get('folder') });
    location.hash = g.id; await reload();
  }, 'Завести задачу');
}
function newCase() {
  modal('Новое дело', `${field('title', 'Название', '', false, true)}${field('sources', 'Источники, по одной ссылке в строке', '', true)}${field('why', 'Зачем', '', true)}${field('doneWhen', 'Критерий готовности', '', true)}${field('context', 'Контекст', '', true)}${field('constraints', 'Ограничения, по одному в строке', '', true)}`, async f => {
    const c = await api<Goal>('/api/cases', Object.fromEntries(['title', 'sources', 'why', 'doneWhen', 'context', 'constraints'].map(k => [k, f.get(k)])));
    location.hash = `case:${c.id}`; await reload();
  }, 'Завести дело');
}
// The browser loads app.ts with types stripped, so it keeps a copy of `harnesses` from src/model.ts; edit both together.
const harnesses = ['claude', 'codex', 'opencode', 'pi', 'grok', 'kimi', 'gemini', 'agy'];
const defaultDirection = 'Разбери текущее дело по ориентировке и прикреплённым материалам. Прочитай источники, необходимые для понимания задания. Если задание понятно, приступай к работе. Если сведений недостаточно, задай уточняющий вопрос.';
// The receipt of a note for firstmate, as «Взять в работу» and «Новый агент» show it.
const receipt = (result: any) => {
  const ready = result.ready && result.ready.can_receive !== true ? ` Firstmate сейчас не принимает заметки (can_receive: ${result.ready.can_receive}, posture: ${result.ready.posture?.state ?? '-'}).` : '';
  return `Заметка для firstmate: ${result.note.outcome === 'replay' ? 'повтор уже отправленного запроса (replay)' : 'отправлена'}, ${result.note.id}.${ready}`;
};
async function newAgent(c: ViewCase) {
  const folders = await api<string[]>('/api/folders');
  const repos = view?.repos ?? [];
  modal('Новый агент', `${field('direction', 'Направление', defaultDirection, true, true)}<label>Вид<select name="kind"><option value="scout">scout</option><option value="ship">ship</option></select></label><label id="agent-repo" style="display:none">Проект<input name="repo" list="repo-list" maxlength="500"><datalist id="repo-list">${repos.map(r => `<option value="${esc(r)}">`).join('')}</datalist></label><label>Исполнитель<select name="harness"><option value="">как решит firstmate</option>${harnesses.map(h => `<option value="${h}">${h}</option>`).join('')}</select></label><label class="checkbox"><input type="checkbox" name="interactive"> Работаю в окне сам</label>${folderField(folders, c.folder)}`, async f => {
    const result = await api(`/api/cases/${encodeURIComponent(c.id)}/agent`, { direction: f.get('direction'), kind: f.get('kind'), repo: f.get('repo'), harness: f.get('harness'), interactive: f.has('interactive'), folder: f.get('folder') });
    message(`Новый агент: задача ${result.task.id}. ${receipt(result)}`);
    await reload();
  }, 'Запустить');
  const kindSelect = document.querySelector<HTMLSelectElement>('#dialog-body [name=kind]')!;
  kindSelect.onchange = () => { $('agent-repo').style.display = kindSelect.value === 'ship' ? '' : 'none'; };
  // Interactive work runs on Codex by the captain's standing preference; the choice stays changeable.
  const interactive = document.querySelector<HTMLInputElement>('#dialog-body [name=interactive]')!;
  interactive.onchange = () => { if (interactive.checked) document.querySelector<HTMLSelectElement>('#dialog-body [name=harness]')!.value = 'codex'; };
}
const actionLabels: Record<string, string> = { start: 'Взять в работу', pause: 'Пауза', unhold: 'Снять паузу', close: 'Закрыть', decline: 'Отказ', answer: 'Ответить', release: 'Разрешить работу', later: 'Позже', reopen: 'Вернуть' };
async function taskAction(g: ViewGoal, action: string) {
  const path = `/api/tasks/${encodeURIComponent(g.id)}/${action}`;
  const run = async (body: Record<string, unknown> = {}) => {
    const result = await api(path, body);
    message(result.note ? receipt(result) : `${actionLabels[action]}: готово.`);
    await reload();
  };
  if (action === 'decline') modal('Отказ', field('reason', 'Причина отказа', '', false, true), async f => run({ reason: f.get('reason') }), 'Отказаться');
  else if (action === 'answer') modal('Ответить', field('answer', 'Ответ', '', false, true), async f => run({ answer: f.get('answer') }), 'Ответить');
  else if (action === 'release') modal('Разрешить работу', field('answer', 'Комментарий (необязательно)'), async f => run(f.get('answer') ? { answer: f.get('answer') } : {}), 'Разрешить работу');
  else if (action === 'later') modal('Позже', `${field('reason', 'Почему позже', '', false, true)}<label>Вернуться<input type="date" name="until" required></label>`, async f => run({ reason: f.get('reason'), until: f.get('until') }), 'Отложить');
  else await run();
}

const sections = [['waiting', 'Ждёт меня'], ['working', 'В работе'], ['next', 'Дальше'], ['done', 'Сделано']] as const;
function row(r: Row, inFocus = false) {
  const marks = [r.kind ? badge(r.kind) : '', r.personal ? badge('личное') : '', r.pinned && !inFocus ? badge('В фокусе') : '', r.noWorker ? badge('нет исполнителя') : ''].join('');
  const detail = [r.id, r.reason || r.current].filter(Boolean).join(' · ');
  const pin = r.open ? `<button class="quiet" data-action="pin" data-id="${esc(r.id)}" data-on="${r.pinned ? '' : '1'}">${r.pinned ? 'Открепить' : 'Закрепить'}</button>` : '';
  return `<div class="row${r.task ? ' go' : ' warning'}"><div class="row-content"><strong>${r.task ? `<a href="#${encodeURIComponent(r.id)}">${esc(r.title)}</a>` : esc(r.title)}</strong> ${marks}<small>${esc(detail)}${r.reportPath === ownReport(r.id) ? ` · ${reportAnchor(r.id)}` : ''}</small></div>${pin}</div>`;
}
function caseRow(c: CaseRow) {
  return `<div class="row go"><div class="row-content"><strong><a href="#case:${encodeURIComponent(c.id)}">${esc(c.title)}</a></strong><small>${esc(Object.entries(phaseLabels).map(([k, l]) => `${l} ${c.counts[k as keyof typeof phaseLabels]}`).join(' · '))}</small></div></div>`;
}
function renderOverview() {
  current = undefined; document.title = 'Дело — что происходит';
  if (!view) return;
  const v = view; const match = (r: Row) => kind === ':personal' ? r.personal : !kind || r.kind === kind;
  const focus = v.focus.filter(match);
  const part = (key: typeof sections[number][0], title: string) => {
    const groups = v[key].map(g => ({ ...g, rows: g.rows.filter(match) })).filter(g => g.rows.length);
    return `<section class="area"><div class="area-heading"><h2>${title} <span class="count">${groups.reduce((n, g) => n + g.rows.length, 0)}</span></h2></div>${groups.length ? groups.map(g => `<p class="eyebrow">${esc(g.repo)}</p><div class="rows">${g.rows.map(r => row(r)).join('')}</div>`).join('') : '<p class="muted">Здесь пусто.</p>'}</section>`;
  };
  $('main').innerHTML = `<div class="page-heading"><div><p class="eyebrow">Firstmate · ${date(v.generated)}</p><h1>Что сейчас происходит</h1></div><div class="actions"><label class="sr-only" for="kind">Вид задачи</label><select id="kind"><option value="">Все виды</option>${v.kinds.map(k => `<option value="${esc(k)}" ${kind === k ? 'selected' : ''}>${esc(k)}</option>`).join('')}<option value=":personal" ${kind === ':personal' ? 'selected' : ''}>Личное</option></select><button data-action="refresh" class="quiet">Обновить</button></div></div><section class="area"><div class="area-heading"><h2>Дела <span class="count">${v.cases.length}</span></h2><a href="#:closed">Закрытые дела</a></div>${v.cases.length ? `<div class="rows">${v.cases.map(caseRow).join('')}</div>` : '<p class="muted">Открытых дел нет.</p>'}</section><section class="area"><div class="area-heading"><h2>В фокусе <span class="count">${focus.length}</span></h2></div>${focus.length ? `<div class="rows">${focus.map(r => row(r, true)).join('')}</div>` : '<p class="muted">Закрепите до трёх задач, чтобы держать их перед глазами.</p>'}</section>${sections.map(([key, title]) => part(key, title)).join('')}`;
  $('kind').onchange = () => { kind = ($('kind') as HTMLSelectElement).value; renderOverview(); };
}

function link(ref: string, report?: string) {
  const http = /^https?:\/\//.test(ref);
  return `<div class="row"><div class="row-content"><strong>${report && ref === ownReport(report) ? reportAnchor(report) : http ? `<a href="${esc(ref)}" target="_blank" rel="noopener noreferrer">${esc(ref)}</a>` : esc(ref)}</strong></div></div>`;
}
function requests(g: ViewGoal) {
  const items = g.inbox?.requests ?? []; const ready = g.inbox?.ready;
  if (!items.length) return '';
  return `<p class="muted">Запросы firstmate: ${items.map(r => esc(`${r.requestId} · ${r.state === 'pending' ? (r.acknowledged ? 'принят' : 'ждёт') : 'обработан'}${r.reply ? ` · ${typeof r.reply === 'string' ? r.reply : JSON.stringify(r.reply)}` : ''}`)).join('; ')}${ready && ready.can_receive !== true ? esc(` · Firstmate сейчас не принимает заметки (can_receive: ${ready.can_receive}, posture: ${ready.posture?.state ?? '-'})`) : ''}</p>`;
}
// The chosen executor from the `Исполнитель:` line next to the one the fleet snapshot shows running the task.
function executor(g: ViewGoal) {
  if (!g.harness && !g.worker?.harness) return '';
  return `<p class="muted" id="executor">Исполнитель: ${esc(g.harness || 'как решит firstmate')}${g.worker?.harness ? ` · работает: ${esc(g.worker.harness)}` : ''}</p>`;
}
function renderGoal(g: ViewGoal) {
  current = g; document.title = `${g.title} — Дело`;
  $('main').innerHTML = `<a class="back" href="#">← Что происходит</a><div class="page-heading"><div><p class="eyebrow">Задача Firstmate · ${esc(g.id)}${g.personal ? ' · личное' : ''}</p><h1>${esc(g.title)}</h1><p class="muted">${esc(g.why || 'Зачем нужна цель, пока не записано')}</p>${executor(g)}${requests(g)}</div><div class="actions"><button data-action="edit" ${closed(g) ? 'disabled' : ''}>Править</button>${g.actions.map(a => `<button data-task-action="${a}">${actionLabels[a]}</button>`).join('')}</div></div><section class="section"><div class="section-heading"><h2>Ссылки</h2></div>${g.links.length ? `<div class="rows">${g.links.map(ref => link(ref, g.report ? g.id : undefined)).join('')}</div>` : '<p class="muted">У задачи нет ссылок в Firstmate.</p>'}</section><section class="section"><div class="section-heading"><h2>Бриф</h2></div><details class="brief-box"><summary>Зачем, критерий готовности и контекст</summary><dl><dt>Зачем</dt><dd class="prose">${esc(g.why)}</dd><dt>Готово, когда</dt><dd class="prose">${esc(g.doneWhen)}</dd><dt>Контекст</dt><dd class="prose">${esc(g.context)}</dd><dt>Ограничения</dt><dd class="prose">${esc(g.constraints.join('\n'))}</dd></dl>${closed(g) ? '<p class="disabled-note">Бриф заморожен после закрытия цели.</p>' : ''}</details></section>`;
}

const brief = (g: Goal) => `<div class="brief-box"><dl><dt>Зачем</dt><dd class="prose">${esc(g.why)}</dd><dt>Готово, когда</dt><dd class="prose">${esc(g.doneWhen)}</dd><dt>Контекст</dt><dd class="prose">${esc(g.context)}</dd><dt>Ограничения</dt><dd class="prose">${esc(g.constraints.join('\n'))}</dd></dl></div>`;
const linkList = (refs: string[], report?: string) => refs.map(ref => report && ref === ownReport(report) ? reportAnchor(report) : /^https?:\/\//.test(ref) ? `<a href="${esc(ref)}" target="_blank" rel="noopener noreferrer">${esc(ref)}</a>` : esc(ref)).join(' · ');
const caseTask = (t: CaseTask, live: boolean) => `<div class="row${live ? ' go' : ''}"><div class="row-content"><strong>${live ? `<a href="#${encodeURIComponent(t.id)}">${esc(t.title)}</a>` : esc(t.title)}</strong><small>${esc(t.id)} · ${esc(phaseLabels[t.phase])}${t.links.length ? ' · ' : ''}${linkList(t.links, t.report ? t.id : undefined)}</small></div></div>`;
function renderCase(c: ViewCase) {
  current = c; document.title = `${c.title} — Дело`;
  const open = !c.archived && c.state !== 'done';
  const buttons = open ? '<button data-action="agent-case" class="primary">Новый агент</button><button data-action="edit">Править</button><button data-action="close-case">Закрыть дело</button>' : c.archived ? '<button data-action="continue-case">Продолжить</button>' : '<button data-action="reopen-case">Вернуть</button>';
  const groups = Object.entries(phaseLabels).map(([key, label]) => ({ label, rows: c.tasks.filter(t => t.phase === key) })).filter(g => g.rows.length);
  $('main').innerHTML = `<a class="back" href="#">← Что происходит</a><div class="page-heading"><div><p class="eyebrow">Дело · ${esc(c.id)}${c.archived ? ' · в архиве' : c.state === 'done' ? ' · закрыто' : ''}</p><h1>${esc(c.title)}</h1><p class="muted">${esc(c.why || 'Зачем нужно дело, пока не записано')}</p></div><div class="actions">${buttons}</div></div><section class="section"><div class="section-heading"><h2>Бриф</h2></div>${brief(c)}${open ? '' : '<p class="disabled-note">Бриф заморожен после закрытия дела.</p>'}</section><section class="section"><div class="section-heading"><h2>Задачи</h2></div>${groups.length ? groups.map(g => `<p class="eyebrow">${esc(g.label)}</p><div class="rows">${g.rows.map(t => caseTask(t, true)).join('')}</div>`).join('') : '<p class="muted">В бэклоге нет задач этого дела.</p>'}</section><section class="section"><div class="section-heading"><h2>Закрыты раньше</h2></div>${c.earlier.length ? `<div class="rows">${c.earlier.map(t => caseTask(t, false)).join('')}</div>` : '<p class="muted">В архиве нет задач этого дела.</p>'}</section><section class="section"><div class="section-heading"><h2>Ссылки</h2></div>${c.links.length ? `<div class="rows">${c.links.map(ref => link(ref)).join('')}</div>` : '<p class="muted">У дела и его задач нет ссылок.</p>'}</section>`;
}
function renderClosed(list: { id: string; title: string; closed?: string }[]) {
  current = undefined; document.title = 'Закрытые дела — Дело';
  $('main').innerHTML = `<a class="back" href="#">← Что происходит</a><div class="page-heading"><div><p class="eyebrow">Архив Firstmate</p><h1>Закрытые дела</h1></div></div>${list.length ? `<div class="rows">${list.map(c => `<div class="row go"><div class="row-content"><strong><a href="#case:${encodeURIComponent(c.id)}">${esc(c.title)}</a></strong><small>${esc([c.id, c.closed].filter(Boolean).join(' · '))}</small></div></div>`).join('')}</div>` : '<p class="muted">В архиве нет закрытых дел.</p>'}`;
}

function renderReport(taskId: string, r: { path: string; title: string; text: string }) {
  current = undefined; document.title = `Отчёт: ${r.title} — Дело`;
  $('main').innerHTML = `<a class="back" href="#">← Что происходит</a><div class="page-heading"><div><p class="eyebrow">Отчёт · ${esc(taskId)}</p><h1>${esc(r.title)}</h1></div></div><section class="section"><p class="report-path"><code id="report-path">${esc(r.path)}</code> <button class="quiet" data-action="copy-path">Копировать путь</button> <button class="quiet" data-action="open-report" data-id="${esc(taskId)}">Открыть в приложении</button></p><pre class="report-text">${esc(r.text)}</pre></section>`;
}
// Without the Clipboard API the path is selected, so Ctrl+C copies it.
async function copyPath() {
  const path = $('report-path');
  try { await navigator.clipboard.writeText(path.textContent ?? ''); message('Путь скопирован.'); }
  catch { const range = document.createRange(); range.selectNodeContents(path); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); message('Не удалось скопировать: путь выделен, скопируйте его сами.', true); }
}

async function goalAction(action: string) {
  const g = current; if (!g) return;
  const base = `/api/goals/${encodeURIComponent(g.id)}`;
  if (action !== 'edit') return;
  // A дело's brief has no folder: only its tasks are duties.
  const folder = g.kind === 'program' ? '' : folderField(await api<string[]>('/api/folders'), g.folder);
  modal('Править дело', `${field('title', 'Название', g.title, false, true)}${field('body', 'Описание', g.body.split('\n').filter(l => l !== personalLine && !(folder && l.startsWith(folderLine))).join('\n'), true)}${folder}${personalBox(g.personal)}`, async f => { await api(base, { title: f.get('title'), body: f.get('body'), personal: f.has('personal'), folder: f.get('folder') ?? undefined }, 'PATCH'); await reload(); });
}

async function caseAction(c: ViewCase, action: string) {
  const base = `/api/cases/${encodeURIComponent(c.id)}`;
  if (action === 'reopen-case') { await api(`${base}/reopen`, {}); return reload(); }
  if (action === 'agent-case') return newAgent(c);
  if (action === 'continue-case') { const next = await api<Goal>(`${base}/continue`, {}); location.hash = `case:${next.id}`; return reload(); }
  // Q40В: nothing is sent until the warning that lists every open task is confirmed.
  const open = c.tasks.filter(t => t.phase !== 'done');
  const close = async () => { const result = await api(`${base}/close`, { confirmed: open.map(t => t.id) }); message(`Дело закрыто${result.notes.length ? `, firstmate получил запросов закрыть задачу: ${result.notes.length}` : ''}.`); await reload(); };
  if (!open.length) return close();
  modal('Закрыть дело', `<p>У дела есть незакрытые задачи. Firstmate получит запрос закрыть каждую из них:</p><ul id="close-case-tasks">${open.map(t => `<li>${esc(t.title)} · ${esc(phaseLabels[t.phase])}</li>`).join('')}</ul><p class="muted">Пока вы не подтвердите, ничего не отправится и дело останется открытым.</p>`, close, 'Подтвердить и закрыть');
}

async function navigate() {
  const goalId = decodeURIComponent(location.hash.slice(1));
  if (!goalId) return renderOverview();
  try {
    if (goalId === ':closed') return renderClosed(await api('/api/cases'));
    const reportId = /^report:(.+)$/.exec(goalId)?.[1];
    if (reportId) return renderReport(reportId, await api(`/api/reports/${encodeURIComponent(reportId)}`));
    const caseId = /^case:(.+)$/.exec(goalId)?.[1];
    const goal = caseId ? undefined : await api<ViewGoal>(`/api/goals/${encodeURIComponent(goalId)}`);
    if (goal && goal.kind !== 'program') return renderGoal(goal);
    renderCase(await api<ViewCase>(`/api/cases/${encodeURIComponent(caseId ?? goalId)}`));
  }
  catch (e: any) { message(e.message, true); renderOverview(); }
}
async function reload() {
  view = await api('/api/overview'); await navigate();
}
$('new-goal').onclick = () => { newGoal().catch(e => message(e.message, true)); };
$('new-case').onclick = newCase;
$('dialog-close').onclick = () => ($('dialog') as HTMLDialogElement).close();
$('dialog-form').onsubmit = async event => { event.preventDefault(); $('dialog-submit').setAttribute('disabled', ''); try { await submitDialog(new FormData($('dialog-form') as HTMLFormElement)); ($('dialog') as HTMLDialogElement).close(); } catch (e: any) { $('dialog-error').textContent = e.message; } finally { $('dialog-submit').removeAttribute('disabled'); } };
$('main').onclick = async event => {
  const taskButton = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-task-action]');
  if (taskButton && current) { taskButton.disabled = true; try { await taskAction(current, taskButton.dataset.taskAction!); } catch (e: any) { message(e.message, true); } finally { taskButton.disabled = false; } return; }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
  if (!button) { const go = (event.target as HTMLElement).closest('.row.go'); if (go && !(event.target as HTMLElement).closest('a, input, select, textarea, label')) go.querySelector('a')?.click(); return; }
  try { if (button.dataset.action === 'new') return await newGoal(); if (button.dataset.action === 'copy-path') return await copyPath(); if (button.dataset.action === 'open-report') { button.disabled = true; await api(`/api/reports/${encodeURIComponent(button.dataset.id!)}/open`, {}); return; } if (button.dataset.action === 'refresh') { button.disabled = true; await reload(); return; }
    if (button.dataset.action === 'pin') { button.disabled = true; view = await api(`/api/tasks/${encodeURIComponent(button.dataset.id!)}/pin`, { pinned: !!button.dataset.on }); renderOverview(); return; } if (button.dataset.action!.endsWith('-case') && current) return await caseAction(current as ViewCase, button.dataset.action!); await goalAction(button.dataset.action!); }
  catch (e: any) { message(e.message, true); } finally { button.disabled = false; }
};
window.onhashchange = () => { navigate().catch(e => message(e.message, true)); };
async function start() { const meta = await api('/api/meta'); csrf = meta.csrf; await reload(); }
start().catch(e => { $('main').innerHTML = `<div class="empty"><h2>Не удалось прочитать задачи Firstmate</h2><p>${esc(e.message)}</p><button data-action="refresh">Повторить</button></div>`; });
// The overview runs two Firstmate snapshots, so it refreshes only while the tab is visible.
window.setInterval(async () => { if (document.visibilityState !== 'visible' || ($('dialog') as HTMLDialogElement).open) return; try { await reload(); } catch { /* The next refresh retries after the local server returns. */ } }, 30000);
