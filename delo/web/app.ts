import type { Goal } from '../src/model.ts';
import type { Overview, Row } from '../src/overview.ts';
type ViewGoal = Goal & { inbox?: { requests: { requestId: string; at: string; state: string; acknowledged: boolean; reply: unknown }[]; ready?: any } };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const date = (s: string) => s ? new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const badge = (title: string) => `<span class="badge">${esc(title)}</span>`;
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
function newGoal() {
  const repos = view?.repos ?? [];
  modal('Завести дело', `${field('title', 'Название', '', false, true)}${personalBox()}<label>Вид<select name="kind"><option value="ship">ship</option><option value="scout">scout</option></select></label><label>Проект<input name="repo" list="repo-list" maxlength="500"><datalist id="repo-list">${repos.map(r => `<option value="${esc(r)}">`).join('')}</datalist></label>${field('body', 'Описание', '', true)}${field('blockedBy', 'После задачи (id)')}<label>Отложить до<input type="date" name="holdUntil"></label>`, async f => {
    const g = await api<Goal>('/api/goals', { title: f.get('title'), kind: f.get('kind'), repo: f.get('repo'), body: f.get('body'), blockedBy: f.get('blockedBy'), holdUntil: f.get('holdUntil'), personal: f.has('personal') });
    location.hash = g.id; await reload();
  }, 'Завести дело');
}
const actionLabels: Record<string, string> = { start: 'Взять в работу', pause: 'Пауза', unhold: 'Снять паузу', close: 'Закрыть', decline: 'Отказ', answer: 'Ответить', release: 'Разрешить работу', later: 'Позже', reopen: 'Вернуть' };
async function taskAction(g: ViewGoal, action: string) {
  const path = `/api/tasks/${encodeURIComponent(g.id)}/${action}`;
  const run = async (body: Record<string, unknown> = {}) => {
    const result = await api(path, body);
    const ready = result.ready && result.ready.can_receive !== true ? ` Firstmate сейчас не принимает заметки (can_receive: ${result.ready.can_receive}, posture: ${result.ready.posture?.state ?? '-'}).` : '';
    message(result.note ? `Заметка для firstmate: ${result.note.outcome === 'replay' ? 'повтор уже отправленного запроса (replay)' : 'отправлена'}, ${result.note.id}.${ready}` : `${actionLabels[action]}: готово.`);
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
  return `<div class="row${r.task ? ' go' : ' warning'}"><div class="row-content"><strong>${r.task ? `<a href="#${encodeURIComponent(r.id)}">${esc(r.title)}</a>` : esc(r.title)}</strong> ${marks}<small>${esc(detail)}</small></div>${pin}</div>`;
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
  $('main').innerHTML = `<div class="page-heading"><div><p class="eyebrow">Firstmate · ${date(v.generated)}</p><h1>Что сейчас происходит</h1></div><div class="actions"><label class="sr-only" for="kind">Вид задачи</label><select id="kind"><option value="">Все виды</option>${v.kinds.map(k => `<option value="${esc(k)}" ${kind === k ? 'selected' : ''}>${esc(k)}</option>`).join('')}<option value=":personal" ${kind === ':personal' ? 'selected' : ''}>Личное</option></select><button data-action="refresh" class="quiet">Обновить</button></div></div><section class="area"><div class="area-heading"><h2>В фокусе <span class="count">${focus.length}</span></h2></div>${focus.length ? `<div class="rows">${focus.map(r => row(r, true)).join('')}</div>` : '<p class="muted">Закрепите до трёх задач, чтобы держать их перед глазами.</p>'}</section>${sections.map(([key, title]) => part(key, title)).join('')}`;
  $('kind').onchange = () => { kind = ($('kind') as HTMLSelectElement).value; renderOverview(); };
}

function link(ref: string) {
  const http = /^https?:\/\//.test(ref);
  return `<div class="row"><div class="row-content"><strong>${http ? `<a href="${esc(ref)}" target="_blank" rel="noopener noreferrer">${esc(ref)}</a>` : esc(ref)}</strong></div></div>`;
}
function requests(g: ViewGoal) {
  const items = g.inbox?.requests ?? []; const ready = g.inbox?.ready;
  if (!items.length) return '';
  return `<p class="muted">Запросы firstmate: ${items.map(r => esc(`${r.requestId} · ${r.state === 'pending' ? (r.acknowledged ? 'принят' : 'ждёт') : 'обработан'}${r.reply ? ` · ${typeof r.reply === 'string' ? r.reply : JSON.stringify(r.reply)}` : ''}`)).join('; ')}${ready && ready.can_receive !== true ? esc(` · Firstmate сейчас не принимает заметки (can_receive: ${ready.can_receive}, posture: ${ready.posture?.state ?? '-'})`) : ''}</p>`;
}
function renderGoal(g: ViewGoal) {
  current = g; document.title = `${g.title} — Дело`;
  $('main').innerHTML = `<a class="back" href="#">← Что происходит</a><div class="page-heading"><div><p class="eyebrow">Задача Firstmate · ${esc(g.id)}${g.personal ? ' · личное' : ''}</p><h1>${esc(g.title)}</h1><p class="muted">${esc(g.why || 'Зачем нужна цель, пока не записано')}</p>${requests(g)}</div><div class="actions"><button data-action="edit" ${closed(g) ? 'disabled' : ''}>Править</button>${g.actions.map(a => `<button data-task-action="${a}">${actionLabels[a]}</button>`).join('')}</div></div><section class="section"><div class="section-heading"><h2>Ссылки</h2></div>${g.links.length ? `<div class="rows">${g.links.map(link).join('')}</div>` : '<p class="muted">У задачи нет ссылок в Firstmate.</p>'}</section><section class="section"><div class="section-heading"><h2>Бриф</h2></div><details class="brief-box"><summary>Зачем, критерий готовности и контекст</summary><dl><dt>Зачем</dt><dd class="prose">${esc(g.why)}</dd><dt>Готово, когда</dt><dd class="prose">${esc(g.doneWhen)}</dd><dt>Контекст</dt><dd class="prose">${esc(g.context)}</dd><dt>Ограничения</dt><dd class="prose">${esc(g.constraints.join('\n'))}</dd></dl>${closed(g) ? '<p class="disabled-note">Бриф заморожен после закрытия цели.</p>' : ''}</details></section>`;
}

async function goalAction(action: string) {
  const g = current; if (!g) return;
  const base = `/api/goals/${encodeURIComponent(g.id)}`;
  if (action === 'edit') modal('Править дело', `${field('title', 'Название', g.title, false, true)}${field('body', 'Описание', g.body.split('\n').filter(l => l !== personalLine).join('\n'), true)}${personalBox(g.personal)}`, async f => { await api(base, { title: f.get('title'), body: f.get('body'), personal: f.has('personal') }, 'PATCH'); await reload(); });
}

async function navigate() {
  const goalId = decodeURIComponent(location.hash.slice(1));
  if (!goalId) return renderOverview();
  try { const goal = await api<ViewGoal>(`/api/goals/${encodeURIComponent(goalId)}`); renderGoal(goal); }
  catch (e: any) { message(e.message, true); renderOverview(); }
}
async function reload() {
  view = await api('/api/overview'); await navigate();
}
$('new-goal').onclick = newGoal;
$('dialog-close').onclick = () => ($('dialog') as HTMLDialogElement).close();
$('dialog-form').onsubmit = async event => { event.preventDefault(); $('dialog-submit').setAttribute('disabled', ''); try { await submitDialog(new FormData($('dialog-form') as HTMLFormElement)); ($('dialog') as HTMLDialogElement).close(); } catch (e: any) { $('dialog-error').textContent = e.message; } finally { $('dialog-submit').removeAttribute('disabled'); } };
$('main').onclick = async event => {
  const taskButton = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-task-action]');
  if (taskButton && current) { taskButton.disabled = true; try { await taskAction(current, taskButton.dataset.taskAction!); } catch (e: any) { message(e.message, true); } finally { taskButton.disabled = false; } return; }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
  if (!button) { const go = (event.target as HTMLElement).closest('.row.go'); if (go && !(event.target as HTMLElement).closest('a, input, select, textarea, label')) go.querySelector('a')?.click(); return; }
  try { if (button.dataset.action === 'new') return newGoal(); if (button.dataset.action === 'refresh') { button.disabled = true; await reload(); return; }
    if (button.dataset.action === 'pin') { button.disabled = true; view = await api(`/api/tasks/${encodeURIComponent(button.dataset.id!)}/pin`, { pinned: !!button.dataset.on }); renderOverview(); return; } await goalAction(button.dataset.action!); }
  catch (e: any) { message(e.message, true); } finally { button.disabled = false; }
};
window.onhashchange = () => { navigate().catch(e => message(e.message, true)); };
async function start() { const meta = await api('/api/meta'); csrf = meta.csrf; await reload(); }
start().catch(e => { $('main').innerHTML = `<div class="empty"><h2>Не удалось прочитать задачи Firstmate</h2><p>${esc(e.message)}</p><button data-action="refresh">Повторить</button></div>`; });
// The overview runs two Firstmate snapshots, so it refreshes only while the tab is visible.
window.setInterval(async () => { if (document.visibilityState !== 'visible' || ($('dialog') as HTMLDialogElement).open) return; try { await reload(); } catch { /* The next refresh retries after the local server returns. */ } }, 30000);
