import type { Goal, TaskRequest } from '../src/model.ts';
import type { Overview, Row, CaseRow, Position } from '../src/overview.ts';
import type { Diagnostics } from '../src/diagnostics.ts';
import type { TerminalNavigation } from '../src/terminal.ts';
type ViewGoal = Goal & { terminal?: TerminalNavigation; inbox?: { requests: { action?: TaskRequest['action']; requestId: string; at: string; state: string; acknowledged: boolean; reply: unknown }[]; ready?: any }; worker?: Position & { harness: string; current?: string; prUrl?: string; diagnostics?: Diagnostics; details?: string } };
type CaseTask = Pick<Goal, 'id' | 'title' | 'state' | 'actions' | 'holdKind' | 'reason' | 'inFlight' | 'links' | 'report' | 'requests' | 'review' | 'reviewProgress'> & Position & { terminal?: TerminalNavigation; current?: string };
type ViewCase = Goal & { archived: boolean; sources: string[]; tasks: CaseTask[]; earlier: CaseTask[] };
const phaseLabels = { working: 'в работе', waiting: 'ждёт', next: 'дальше', done: 'сделано' };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const badge = (title: string) => `<span class="badge">${esc(title)}</span>`;
// Only a task's own `data/<id>/report.md` link opens as «Отчёт»; other refs stay as they are.
const ownReport = (taskId: string) => `data/${taskId}/report.md`;
const reportAnchor = (taskId: string) => `<a class="report-link" href="#report:${encodeURIComponent(taskId)}">Отчёт</a>`;
const bodyText = (g: Goal) => g.body.replace(/^Delo description: .*\n?/m, '');
const closed = (g: Goal) => g.state === 'done' || g.state === 'dropped';
const field = (name: string, label: string, value = '', multiline = false, required = false) => `<label>${esc(label)}${multiline ? `<textarea name="${name}" ${required ? 'required' : ''}>${esc(value)}</textarea>` : `<input name="${name}" value="${esc(value)}" ${required ? 'required' : ''} maxlength="500">`}</label>`;
let csrf = ''; let draftScope = ''; let view: Overview | undefined;
let kind = ''; let current: ViewGoal | undefined;
let dialogOpener: HTMLElement | null = null; let dialogGeneration = 0;
let submitDialog: (form: FormData) => Promise<void> = async () => {};
const pendingTasks = new Set<string>();
let markup = ''; let navigation = 0; let refreshRequest = 0;
const iconPaths: Record<string, string> = {
  close: 'M6 6l12 12M18 6L6 18', add: 'M12 5v14M5 12h14', start: 'M8 5l11 7-11 7z', pause: 'M8 5v14M16 5v14',
  check: 'M5 12l4 4L19 6', edit: 'M4 20l4-1L20 7l-3-3L5 16z', undo: 'M9 5L4 10l5 5M4 10h9a6 6 0 010 12',
  send: 'M3 3l18 9-18 9 4-9zM7 12h14', clock: 'M12 8v4l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0',
  pin: 'M9 3h6l-1 7 4 4H6l4-4zM12 14v7', refresh: 'M20 7v5h-5M20 12a8 8 0 10-2 6',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5', copy: 'M8 8h12v12H8zM4 16V4h12', open: 'M14 3h7v7M21 3L10 14M10 5H3v16h16v-7',
};
const icon = (name: string) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${iconPaths[name] || iconPaths.check}"/></svg>`;
const actionIcons: Record<string, string> = { start: 'start', unhold: 'start', pause: 'pause', close: 'check', stop: 'pause', decline: 'close', answer: 'send', release: 'check', later: 'clock', reopen: 'undo', edit: 'edit', pin: 'pin', refresh: 'refresh', 'open-terminal': 'terminal', 'copy-path': 'copy', 'open-report': 'open', 'agent-case': 'add', 'close-case': 'check', 'reopen-case': 'undo', 'continue-case': 'start' };
function decorateActions(root: HTMLElement) {
  root.querySelectorAll<HTMLButtonElement>('[data-task-action], [data-action]').forEach(button => {
    const name = actionIcons[button.dataset.taskAction || button.dataset.action || ''];
    if (name) button.insertAdjacentHTML('afterbegin', icon(name));
  });
}
function renderMain(html: string) {
  if (markup === html) return;
  $('main').innerHTML = html; decorateActions($('main')); markup = html;
}

async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const verb = method ?? (body === undefined ? 'GET' : 'POST');
  const request = () => fetch(path, { method: verb, cache: 'no-store', headers: { 'content-type': 'application/json', 'x-delo-csrf': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let response = await request(); let value = await response.json();
  // Only this pre-mutation refusal is safe to replay; network and action failures may already have applied.
  if (!['GET', 'HEAD'].includes(verb) && response.status === 403 && value.code === 'CSRF_MISMATCH') {
    try { const meta = await api('/api/meta'); if (meta.draftScope !== draftScope) throw new Error('Дом Firstmate изменился'); csrf = meta.csrf; }
    catch { throw new Error('Не удалось обновить проверку страницы. Повторите отправку, когда Дело снова будет доступно.'); }
    response = await request(); value = await response.json();
  }
  if (!response.ok) throw new Error(value.error ?? `Ошибка ${response.status}`); return value;
}
let messageTimer: number | undefined;
function message(text: string, error = false, undo?: () => Promise<void>) {
  window.clearTimeout(messageTimer);
  $('message').textContent = text; $('message').className = `message${error ? ' error' : ''}`; $('message').hidden = false;
  if (undo) {
    const button = document.createElement('button'); button.textContent = 'Вернуть';
    button.onclick = async () => { button.disabled = true; try { await undo(); } catch (e: any) { message(e.message, true); } };
    $('message').append(' ', button);
  } else messageTimer = window.setTimeout(() => { $('message').hidden = true; }, 5000);
}
function modal(title: string, body: string, action: (form: FormData) => Promise<void>, submit = 'Сохранить') {
  saveDraft(); draftKey = ''; dialogGeneration++;
  $('dialog-submit').removeAttribute('disabled'); $('dialog-form').removeAttribute('aria-busy');
  dialogOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $('dialog-title').textContent = title; $('dialog-body').innerHTML = body; $('dialog-error').textContent = '';
  $('dialog-submit').innerHTML = submit ? icon('check') + esc(submit) : ''; $('dialog-cancel').hidden = true;
  submitDialog = action; $('dialog-submit').hidden = !submit;
  ($('dialog') as HTMLDialogElement).showModal();
}
const personalLine = 'Личное';
const personalBox = (on = false) => `<label class="checkbox"><input type="checkbox" name="personal" ${on ? 'checked' : ''}> Личное</label>`;
// Project folders and optional read-only materials share one path input with suggestions.
const folderLine = 'Папка: ';
type ProjectChoice = { name: string; path: string };
const pathField = (name: string, label: string, choices: { value: string; label?: string }[], value = '', required = false) => `<label>${esc(label)}<input name="${name}" value="${esc(value)}" list="${name}-list" maxlength="500" ${required ? 'required' : ''} placeholder="абсолютный путь или ~/…"><datalist id="${name}-list">${choices.map(f => `<option value="${esc(f.value)}">${esc(f.label || f.value)}</option>`).join('')}</datalist></label>`;
const projectField = (name: string, projects: ProjectChoice[], value = '', required = false) => pathField(name, 'Проект: папка', projects.map(p => ({ value: p.path, label: p.name })), value, required);
const folderField = (folders: string[], value = '') => pathField('folder', 'Дополнительная папка материалов (только чтение)', folders.map(value => ({ value })), value);
function loadProjectChoices(name: string) {
  const list = document.getElementById(`${name}-list`);
  const folderList = document.getElementById('folder-list');
  if (folderList && !folderList.children.length) api<string[]>('/api/folders').then(folders => { if (folderList.isConnected) folderList.innerHTML = folders.map(p => `<option value="${esc(p)}"></option>`).join(''); }).catch(() => {});
  return Promise.all([api<ProjectChoice[]>('/api/review-projects'), api<string[]>('/api/project-folders')]).then(([projects, recent]) => {
    if (list?.isConnected) list.innerHTML = recent.map(p => `<option value="${esc(p)}">Недавно использовали</option>`).join('') + projects.filter(p => !recent.includes(p.path)).map(p => `<option value="${esc(p.path)}">${esc(p.name)}</option>`).join('');
  }).catch(() => { /* Suggestions never prevent typing any existing folder. */ });
}
let draftKey = '';
const draftMemory = new Map<string, string>();
function draftValues() {
  return Object.fromEntries([...$('dialog-body').querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[name]')].map(e => [e.name, e instanceof HTMLInputElement && e.type === 'checkbox' ? e.checked : e.value]));
}
function saveDraft() {
  if (!draftKey) return;
  const value = JSON.stringify(draftValues()); draftMemory.set(draftKey, value);
  try { localStorage.setItem(draftKey, value); }
  catch { $('dialog-error').textContent = 'Черновик хранится только до перезагрузки страницы: браузер не разрешил сохранение.'; }
}
function restoreDraft(form: string) {
  if (!draftScope) return;
  draftKey = `delo:draft:${draftScope}:${form}`;
  try {
    const value = JSON.parse(draftMemory.get(draftKey) ?? localStorage.getItem(draftKey) ?? '{}');
    for (const e of $('dialog-body').querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[name]')) {
      if (e instanceof HTMLInputElement && e.type === 'checkbox') { if (typeof value[e.name] === 'boolean') e.checked = value[e.name]; }
      else if (typeof value[e.name] === 'string') e.value = value[e.name];
    }
  } catch { /* An unavailable store or corrupt draft leaves the usable form intact. */ }
}
function acceptedDraft(key: string, submitted: string) {
  if (draftMemory.get(key) !== submitted) return;
  draftMemory.delete(key);
  try { if (localStorage.getItem(key) === submitted) localStorage.removeItem(key); } catch { /* The in-page draft is already cleared. */ }
  if (draftKey === key) draftKey = '';
}
$('dialog-body').addEventListener('input', saveDraft);
$('dialog-body').addEventListener('change', saveDraft);
$('dialog').addEventListener('cancel', saveDraft);
$('dialog').addEventListener('close', saveDraft);
window.addEventListener('pagehide', saveDraft);
const extraDetails = (html: string) => `<details class="create-details"><summary>Дополнительные сведения</summary>${html}</details>`;
async function newGoal() {
  const cases = view?.cases ?? [];
  modal('Новая задача', `${field('description', 'Описание', '', true, true)}<label>Вид задачи<select name="kind"><option value="ship">Изменение файлов</option><option value="scout">Исследование</option></select></label>${projectField('repo', [])}${extraDetails(`${personalBox()}<label>Дело<select name="caseId"><option value="">Без дела</option>${cases.map(c => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('')}</select></label><div id="task-source">${folderField([])}</div>${field('blockedBy', 'После задачи (id)')}<label>Отложить до<input type="date" name="holdUntil"></label>`)}`, async f => {
    const key = draftKey, submitted = JSON.stringify(draftValues());
    const g = await api<Goal>('/api/goals', { description: f.get('description'), kind: f.get('kind'), repo: f.get('repo'), blockedBy: f.get('blockedBy'), holdUntil: f.get('holdUntil'), personal: f.has('personal'), caseId: f.get('caseId'), folder: f.get('kind') === 'scout' ? f.get('folder') : '' });
    acceptedDraft(key, submitted); location.hash = g.id; refresh();
  }, 'Завести задачу');
  restoreDraft('goal');
  const select = document.querySelector<HTMLSelectElement>('#dialog-body [name=kind]')!;
  const mode = () => { $('task-source').hidden = select.value !== 'scout'; document.querySelector<HTMLInputElement>('#dialog-body [name=folder]')!.disabled = select.value !== 'scout'; };
  select.onchange = mode; mode(); loadProjectChoices('repo');
}
function newCase() {
  modal('Новое дело', `${field('description', 'Описание', '', true, true)}<label>Вид дела<select name="reviewKind"><option value="">Обычное дело</option><option value="duty">Дежурство</option><option value="sa">Ревью системной аналитики</option><option value="code">Код-ревью</option></select></label>${projectField('reviewRepo', [])}<p id="case-mode-help" class="muted"></p>${extraDetails(`<input type="hidden" name="requestId" value="${crypto.randomUUID()}"><div id="sa-fields"><label>Документ для ревью (если ссылка отсутствует в описании)<input name="document" type="url" pattern="https?://.+" maxlength="2000"></label></div><div id="code-fields"><label>Задача Jira или pull request (если ссылка отсутствует в описании)<input name="url" type="url" maxlength="2000"></label></div><div id="duty-fields">${folderField([])}</div><div id="case-sources">${field('sources', 'Источники, по одной ссылке в строке', '', true)}</div>${field('why', 'Зачем', '', true)}${field('doneWhen', 'Критерий готовности', '', true)}${field('context', 'Дополнительный контекст', '', true)}${field('constraints', 'Ограничения, по одному в строке', '', true)}`)}`, async f => {
    const key = draftKey, submitted = JSON.stringify(draftValues());
    const description = String(f.get('description') ?? '');
    const refs = description.match(/https?:\/\/[^\s<>"'«»]+/gi) ?? [];
    const ref = refs.length === 1 ? refs[0].replace(/[.,;!?]+$/, '') : '';
    const repo = f.get('reviewRepo');
    const review = f.get('reviewKind') === 'sa' ? { kind: 'sa', document: f.get('document') || ref, repo } : f.get('reviewKind') === 'code' ? { kind: 'code', url: f.get('url') || ref, repo } : undefined;
    const c = await api<Goal>('/api/cases', { ...Object.fromEntries(['description', 'sources', 'why', 'doneWhen', 'context', 'constraints'].map(k => [k, f.get(k) ?? ''])), repo, caseType: f.get('reviewKind') === 'duty' ? 'duty' : 'ordinary', folder: f.get('reviewKind') === 'duty' ? f.get('folder') : '', ...(review ? { review, requestId: f.get('requestId'), ...(review.kind === 'code' ? { sources: '' } : {}) } : {}) });
    acceptedDraft(key, submitted); location.hash = `case:${c.id}`; refresh();
  }, 'Завести дело');
  restoreDraft('case');
  const select = document.querySelector<HTMLSelectElement>('[name=reviewKind]')!;
  select.onchange = () => {
    for (const [element, type] of [['sa-fields', 'sa'], ['code-fields', 'code'], ['duty-fields', 'duty']] as const) {
      $(element).hidden = select.value !== type;
      $(element).querySelectorAll<HTMLInputElement>('input').forEach(e => { e.disabled = select.value !== type; });
    }
    $('case-sources').hidden = select.value === 'code';
    document.querySelector<HTMLInputElement>('[name=reviewRepo]')!.required = select.value === 'sa' || select.value === 'duty';
    $('case-mode-help').textContent = select.value === 'duty' ? 'Дежурный читает папку проекта, готовит отчёт и черновики. Другую папку материалов можно указать в дополнительных сведениях.' : select.value === 'sa' ? 'Добавьте ссылку на документ в описание и выберите папку контекста ревью.' : select.value === 'code' ? 'Добавьте ссылку на задачу Jira или конкретный pull request в описание. Папка контекста необязательна.' : 'Можно начать со ссылки. Название появится из описания; агент сможет его уточнить. Папка для личного дела необязательна.';
  };
  select.onchange(new Event('change')); loadProjectChoices('reviewRepo');
}
// The browser loads app.ts with types stripped, so it keeps a copy of `harnesses` from src/model.ts; edit both together.
const harnesses = ['claude', 'codex', 'opencode', 'pi', 'grok', 'kimi', 'gemini', 'agy'];
const defaultDirection = 'Разбери текущее дело по ориентировке и прикреплённым материалам. Прочитай источники, необходимые для понимания задания. Если задание понятно, приступай к работе. Если сведений недостаточно, задай уточняющий вопрос.';
// The receipt of a note for firstmate, as «Взять в работу» and «Новый агент» show it.
const receipt = (result: any) => {
  if (result.note.acknowledged) return 'Firstmate подтвердил приём просьбы. Выполнение ещё не подтверждено.';
  return result.ready?.can_receive === false
    ? 'Просьба сохранена. Firstmate сейчас не готов принять её; принятие и выполнение ещё не подтверждены.'
    : 'Просьба сохранена для Firstmate. Ждём принятия; выполнение ещё не подтверждено.';
};
async function newAgent(c: ViewCase) {
  const [folders, projects] = await Promise.all([api<string[]>('/api/folders'), api<ProjectChoice[]>('/api/review-projects')]);
  const duty = c.caseType === 'duty';
  modal('Новый агент', `${field('direction', 'Направление', defaultDirection, true, true)}<label>Режим работы<select name="kind"><option value="scout">Исследование: отчёт без изменения файлов</option>${duty ? '' : '<option value="ship">Изменение файлов: отдельное рабочее дерево проекта</option>'}</select></label><p id="agent-mode-help" class="muted"></p><div id="agent-repo">${projectField('repo', projects, c.repo || c.review?.repo || '')}</div><label>Исполнитель<select name="harness"><option value="">как решит firstmate</option>${(duty ? ['claude'] : harnesses).map(h => `<option value="${h}">${h}</option>`).join('')}</select></label>${duty ? '<p class="muted">Дежурство использует claude для доступа к материалам только для чтения.</p>' : '<label class="checkbox"><input type="checkbox" name="interactive"> Работаю в окне сам</label>'}<div id="agent-folder">${folderField(folders, c.folder)}</div>`, async f => {
    const key = draftKey, submitted = JSON.stringify(draftValues());
    const result = await api(`/api/cases/${encodeURIComponent(c.id)}/agent`, { direction: f.get('direction'), kind: f.get('kind'), repo: f.get('repo'), harness: f.get('harness'), interactive: f.has('interactive'), folder: f.get('kind') === 'scout' ? f.get('folder') : '' });
    acceptedDraft(key, submitted); message(`Новый агент: задача ${result.task.id}. ${receipt(result)}`);
    refresh();
  }, 'Запустить');
  restoreDraft(`agent:${c.id}:${c.repo || c.review?.repo || ''}`); loadProjectChoices('repo');
  const kindSelect = document.querySelector<HTMLSelectElement>('#dialog-body [name=kind]')!;
  const updateMode = () => {
    const research = kindSelect.value === 'scout';
    $('agent-folder').hidden = !research;
    const folder = document.querySelector<HTMLInputElement>('#dialog-body [name=folder]')!;
    folder.disabled = !research; folder.required = duty;
    $('agent-mode-help').textContent = duty ? 'Дежурство готовит отчёт и черновики по ориентировке и материалам. Для изменения проекта заведите обычное дело.' : research ? 'Агент изучает проект и готовит отчёт. Чтобы поручить правки файлов, выберите режим «Изменение файлов».' : 'Агент меняет файлы в изолированном рабочем дереве проекта. Папка материалов для чтения не становится местом для правок.';
  };
  kindSelect.onchange = updateMode; updateMode();
  const interactive = document.querySelector<HTMLInputElement>('#dialog-body [name=interactive]');
  if (interactive) interactive.onchange = () => { if (interactive.checked) document.querySelector<HTMLSelectElement>('#dialog-body [name=harness]')!.value = 'codex'; };
}
const actionLabels: Record<string, string> = { start: 'Взять в работу', pause: 'Пауза', unhold: 'Снять паузу', close: 'Закрыть', decline: 'Отказ', answer: 'Ответить', release: 'Разрешить работу', later: 'Позже', reopen: 'Вернуть', stop: 'Запросить остановку' };
const actionFeedback: Record<string, string> = {
  unhold: 'Пауза снята в списке задач. Исполнитель этим действием не запущен.',
  pause: 'Задача отложена. Снимите паузу, когда захотите продолжить.',
  answer: 'Ответ сохранён. Продолжение работы зависит от Firstmate.',
  release: 'Разрешение сохранено. Начало работы ещё не подтверждено.',
  reopen: 'Задача возвращена в список. Исполнитель этим действием не запущен.',
};
const parked = (g: { state?: Goal['state']; holdKind?: string }) => g.state === 'paused' && g.holdKind === 'parked';
const taskState = (g: { state?: Goal['state']; holdKind?: string; inFlight?: boolean; phase?: keyof typeof phaseLabels }) => g.state === 'done' ? 'Закрыта' : g.holdKind === 'captain' ? 'Ждёт ответа' : parked(g) ? 'Отложена вами' : g.state === 'paused' ? 'На паузе' : g.phase === 'waiting' ? 'Ждёт' : g.phase === 'working' ? 'В работе' : g.inFlight ? (g.phase === 'next' ? 'Передана Firstmate' : 'В работе') : g.state === 'active' ? 'Готова к запуску' : 'Состояние неизвестно';
const kindLabel = (kind: string) => ({ ship: 'Доработка', scout: 'Исследование', captain: 'Вопрос', program: 'Дело' } as Record<string, string>)[kind] ?? kind;
const waitLabels = { answer: 'Нужен ответ', environment: 'Ожидает условий', parked: 'Отложено вами', attention: 'Нужен разбор ошибки или проблемы', delivery: 'Ожидает проверки результата' };
const waitNote = (g: Pick<Position, 'waitKind' | 'nextStep' | 'until'>) => [g.waitKind ? waitLabels[g.waitKind] : '', g.nextStep, g.until ? `Вернуться: ${g.until}` : ''].filter(Boolean).join(' · ');
const responsible = (g: { state?: Goal['state']; holdKind?: string; owner?: string }) => parked(g) ? '' : g.owner ? `Ответственный: ${g.owner}` : 'Ответственный неизвестен';
const requestLabel = (r: TaskRequest) => r.action === 'start'
  ? r.state === 'pending' ? 'Запуск запрошен: просьба сохранена. Ждём подтверждения приёма Firstmate.' : 'Firstmate подтвердил приём просьбы о запуске. Начало работы ещё не подтверждено.'
  : r.action === 'stop'
    ? r.state === 'pending' ? 'Остановка запрошена. Работа ещё не остановлена.' : 'Просьба об остановке принята. Остановка ещё не подтверждена.'
    : r.state === 'pending' ? 'Закрытие запрошено. Задача ещё не закрыта.' : 'Просьба о закрытии принята. Закрытие ещё не подтверждено.';
const retryLabel = (action: string) => ({ start: 'Повторить просьбу о запуске', stop: 'Повторить просьбу об остановке', close: 'Повторить просьбу о закрытии' } as Record<string, string>)[action];
function taskControls(g: Pick<Goal, 'id' | 'title' | 'actions' | 'holdKind' | 'reason' | 'inFlight' | 'requests'>) {
  const pending = pendingTasks.has(g.id);
  return `<div class="actions task-actions" aria-busy="${pending}">${g.actions.filter(a => !g.requests?.some(r => r.action === a)).map(a => `<button data-task-action="${a}" data-id="${esc(g.id)}" data-title="${esc(g.title)}" data-hold-kind="${esc(g.holdKind)}" data-in-flight="${g.inFlight ? '1' : ''}"${a === 'answer' ? ` data-question="${esc(g.reason)}"` : ''} ${pending ? 'disabled' : ''}>${a === 'close' && g.inFlight ? 'Запросить закрытие' : a === 'close' && g.holdKind === 'captain' ? 'Закрыть как неактуальную' : actionLabels[a]}</button>`).join('')}${(g.requests ?? []).filter(r => g.actions.includes(r.action)).map(r => `<small role="status">${requestLabel(r)}</small>${r.state === 'handled' ? `<button data-task-action="${r.action}" data-task-attempt="${Number(r.requestId.split('-').at(-1)) + 1}" data-id="${esc(g.id)}" data-title="${esc(g.title)}" data-in-flight="${g.inFlight ? '1' : ''}" ${pending ? 'disabled' : ''}>${retryLabel(r.action)}</button>` : ''}`).join('')}<small data-task-pending data-id="${esc(g.id)}" role="status" ${pending ? '' : 'hidden'}>Отправляем…</small></div>`;
}
function taskPending(id: string, on: boolean) {
  if (on) pendingTasks.add(id); else pendingTasks.delete(id);
  document.querySelectorAll<HTMLElement>('.task-actions').forEach(group => { if ([...group.querySelectorAll<HTMLElement>('[data-task-pending]')].some(e => e.dataset.id === id)) group.setAttribute('aria-busy', String(on)); });
  document.querySelectorAll<HTMLButtonElement>('[data-task-action], [data-action="pin"]').forEach(b => { if (b.dataset.id === id) b.disabled = on; });
  document.querySelectorAll<HTMLElement>('[data-task-pending]').forEach(e => { if (e.dataset.id === id) e.hidden = !on; });
}
async function taskAction(g: Pick<Goal, 'id' | 'title' | 'holdKind' | 'inFlight'> & { question?: string }, action: string, attempt?: number) {
  const path = `/api/tasks/${encodeURIComponent(g.id)}/${action}`;
  const run = async (body: Record<string, unknown> = {}) => {
    if (pendingTasks.has(g.id)) return;
    taskPending(g.id, true);
    try {
      const result = await api(path, { ...body, ...(attempt === undefined ? {} : { attempt }) });
      const requested = action === 'stop' || action === 'close' && g.inFlight;
      const feedback = requested
        ? `${receipt(result)} ${action === 'stop' ? 'Остановка ещё не подтверждена. Просьба: сохранить сделанное и оставить задачу открытой.' : 'Закрытие ещё не подтверждено; задача пока остаётся в работе.'}`
        : action === 'close' && result.task ? `Задача «${g.title}» закрыта.`
        : result.note ? receipt(result) : actionFeedback[action] ?? `${actionLabels[action]}: готово.`;
      const undo = action === 'close' && result.task ? () => taskAction(g, 'reopen') : undefined;
      message(feedback, false, undo);
      try { await reload(); } catch { message(`${feedback} Не удалось обновить список. Нажмите «Обновить», чтобы проверить состояние.`, true, undo); }
    } finally { taskPending(g.id, false); }
  };
  if (attempt !== undefined) {
    modal(retryLabel(action), `<p>Задача «${esc(g.title)}»</p><p>Предыдущая просьба принята, но это не подтверждает выполнение. Отправить новую просьбу? Повторное подтверждение отправит её только один раз.</p>`, () => run(), 'Отправить ещё раз');
    $('dialog-cancel').hidden = false;
  }
  else if (action === 'close' || action === 'stop') {
    const consequence = action === 'stop' ? 'Будет сохранена просьба Firstmate остановить работу, сохранить сделанное и оставить задачу открытой. Это не немедленная остановка; ждём обработки просьбы.'
      : g.inFlight ? 'Будет сохранена просьба Firstmate закрыть задачу. Исполнитель не будет остановлен этим нажатием; ждём обработки просьбы.'
      : g.holdKind === 'captain' ? 'Задача будет закрыта как неактуальная, а ваш выбор сохранится в её истории.'
      : `Задача уйдёт в «Сделано». После закрытия её можно вернуть кнопкой «Вернуть».${g.holdKind === 'parked' ? ' Сохранённая пауза останется.' : ''}`;
    const label = action === 'stop' ? actionLabels.stop : g.inFlight ? 'Запросить закрытие' : g.holdKind === 'captain' ? 'Закрыть как неактуальную' : 'Закрыть';
    modal(label, `<p>Задача «${esc(g.title)}»</p><p>${consequence}</p>`, () => run(), label);
    $('dialog-cancel').hidden = false;
  }
  else if (action === 'decline') modal('Отказ', field('reason', 'Причина отказа', '', false, true), async f => run({ reason: f.get('reason') }), 'Отказаться');
  else if (action === 'answer') modal('Ответить', `${g.question ? `<p class="prose" id="answer-question">${esc(g.question)}</p>` : ''}${field('answer', 'Ответ', '', true, true)}`, async f => run({ answer: f.get('answer') }), 'Ответить');
  else if (action === 'release') modal('Разрешить работу', field('answer', 'Комментарий (необязательно)'), async f => run(f.get('answer') ? { answer: f.get('answer') } : {}), 'Разрешить работу');
  else if (action === 'later') modal('Позже', `${field('reason', 'Почему позже', '', false, true)}<label>Вернуться<input type="date" name="until" required></label>`, async f => run({ reason: f.get('reason'), until: f.get('until') }), 'Отложить');
  else await run();
}

const sections = [['waiting', 'Ждёт'], ['working', 'В работе'], ['next', 'Дальше'], ['done', 'Сделано']] as const;
function row(r: Row, inFocus = false) {
  const marks = [r.kind ? badge(kindLabel(r.kind)) : '', r.personal ? badge('личное') : '', r.pinned && !inFocus ? badge('В фокусе') : ''].join('');
  const detail = [taskState(r), r.current, r.reason, waitNote(r), r.reason ? responsible(r) : undefined].filter(Boolean).join(' · ');
  const blockers = r.blockers ?? (r.blockedBy ? r.blockedBy.split(',').map(id => ({ id, title: id })) : []);
  const dependencies = blockers.length ? `<small>Ждёт: ${blockers.map(b => `<a href="#${encodeURIComponent(b.id)}">${esc(b.title)}</a>`).join(', ')}</small>` : '';
  const controls = blockers.length ? { ...r, actions: r.actions.filter(a => a !== 'start') } : r;
  const pr = r.prUrl && /^https?:\/\//.test(r.prUrl) ? ` · <a href="${esc(r.prUrl)}" target="_blank" rel="noopener noreferrer">PR</a>` : '';
  const pin = r.open ? `<button class="quiet" data-action="pin" data-id="${esc(r.id)}" data-on="${r.pinned ? '' : '1'}" ${pendingTasks.has(r.id) ? 'disabled' : ''}>${r.pinned ? 'Открепить' : 'Закрепить'}</button>` : '';
  return `<div class="row${r.task ? ' go' : ' warning'}"><div class="row-content"><strong>${r.task ? `<a href="#${encodeURIComponent(r.id)}">${esc(r.title)}</a>` : esc(r.title)}</strong> ${marks}<small>${esc(detail)}${pr}${r.reportPath === ownReport(r.id) ? ` · ${reportAnchor(r.id)}` : ''}</small>${dependencies}</div><div class="row-actions">${r.task ? taskControls(controls) : ''}${pin}</div></div>`;
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
    const rows = (groups: typeof v.waiting) => groups.map(g => `<p class="eyebrow">${esc(g.repo)}</p><div class="rows">${g.rows.map(r => row(r)).join('')}</div>`).join('');
    const content = key === 'waiting' ? Object.entries(waitLabels).map(([category, label]) => {
      const subset = groups.map(g => ({ ...g, rows: g.rows.filter(r => (r.waitKind ?? 'attention') === category) })).filter(g => g.rows.length);
      const count = subset.reduce((n, g) => n + g.rows.length, 0);
      return count ? `<div class="wait-group" data-wait-kind="${category}"><h3>${label} <span class="count">${count}</span></h3>${rows(subset)}</div>` : '';
    }).join('') : rows(groups);
    return `<section class="area" id="overview-${key}"><div class="area-heading"><h2>${title} <span class="count">${groups.reduce((n, g) => n + g.rows.length, 0)}</span></h2></div>${content || '<p class="muted">Здесь пусто.</p>'}</section>`;
  };
  const kinds = [...new Set(['ship', 'scout', 'captain', ...v.kinds])];
  const filters = `<fieldset class="kind-filters"><legend>Вид задачи</legend>${[['', 'Все виды'], ...kinds.map(k => [k, kindLabel(k)]), [':personal', 'Личное']].map(([value, label]) => `<button type="button" data-kind="${esc(value)}" aria-pressed="${kind === value}">${esc(label)}</button>`).join('')}</fieldset>`;
  renderMain(`<div class="page-heading"><div><p class="eyebrow">Firstmate</p><h1>Что сейчас происходит</h1></div><div class="actions"><button data-action="refresh" class="quiet">Обновить</button></div></div>${filters}${part('waiting', 'Ждёт')}${v.cases.length ? `<section class="area"><div class="area-heading"><h2>Дела <span class="count">${v.cases.length}</span></h2><a href="#:closed">Закрытые дела</a></div><div class="rows">${v.cases.map(caseRow).join('')}</div></section>` : '<p class="muted">Дела: открытых нет. <a href="#:closed">Закрытые дела</a></p>'}${focus.length ? `<section class="area" id="overview-focus"><div class="area-heading"><h2>В фокусе <span class="count">${focus.length}</span></h2></div><div class="rows">${focus.map(r => row(r, true)).join('')}</div></section>` : '<p class="muted">В фокусе: задач нет. <a id="focus-tasks" href="#overview-next">Выберите задачи ниже</a> и нажмите «Закрепить».</p>'}${sections.filter(([key]) => key !== 'waiting').map(([key, title]) => part(key, title)).join('')}`);
  const focusTasks = document.getElementById('focus-tasks');
  if (focusTasks) focusTasks.onclick = e => { e.preventDefault(); $('overview-next').scrollIntoView(); };
  document.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach(button => { button.onclick = () => { kind = button.dataset.kind!; renderOverview(); document.querySelector<HTMLButtonElement>('[data-kind][aria-pressed="true"]')?.focus(); }; });

}

function link(ref: string, report?: string) {
  const http = /^https?:\/\//.test(ref);
  return `<div class="row"><div class="row-content"><strong>${report && ref === ownReport(report) ? reportAnchor(report) : http ? `<a href="${esc(ref)}" target="_blank" rel="noopener noreferrer">${esc(ref)}</a>` : esc(ref)}</strong></div></div>`;
}
function requests(g: ViewGoal) {
  const items = g.inbox?.requests ?? []; const ready = g.inbox?.ready;
  if (!items.length) return '';
  return `<details class="muted"><summary>Технические детали просьб</summary><p>${items.map(r => esc(`${r.requestId} · ${r.state === 'pending' && !r.acknowledged ? 'ожидает принятия' : 'принята'}${r.reply ? ` · ${typeof r.reply === 'string' ? r.reply : JSON.stringify(r.reply)}` : ''}`)).join('; ')}${ready ? esc(` · can_receive: ${ready.can_receive}, posture: ${ready.posture?.state ?? '-'}`) : ''}</p></details>`;
}
// The chosen executor from the `Исполнитель:` line next to the one the fleet snapshot shows running the task.
function executor(g: ViewGoal) {
  if (!g.harness && !g.worker?.harness) return '';
  return `<p class="muted" id="executor">Исполнитель: ${esc(g.harness || 'как решит firstmate')}${g.worker?.harness ? ` · работает: ${esc(g.worker.harness)}` : ''}</p>`;
}
const reviewPhase = (name: string) => ({ unknown: 'Этап неизвестен', links: 'Связанные задачи', audit: 'Аудит', audit_review: 'Проверка аудита', audit_revision: 'Правка аудита', finalize: 'Подготовка итога', comment_draft: 'Подготовка комментариев', comment_rewrite: 'Редактура комментариев', comment_review: 'Проверка комментариев' } as Record<string, string>)[name] ?? name;
const elapsed = (ms: number | null | undefined) => ms == null ? 'время неизвестно' : `${Math.round(ms / 1000)} с`;
const reviewTime = (time: string | undefined) => !time || time === 'unknown' ? 'неизвестно' : time;
function reviewDetails(g: Pick<Goal, 'review' | 'reviewProgress'>) {
  if (!g.review) return '';
  const p = g.reviewProgress;
  const inputs = `<p class="muted">${g.review.kind === 'sa' ? 'Ревью системной аналитики' : 'Код-ревью'} · <a href="${esc(g.review.kind === 'sa' ? g.review.document : g.review.url)}" target="_blank" rel="noopener noreferrer">${g.review.kind === 'sa' ? 'Документ' : 'Задача или PR'}</a><br>Проект контекста: ${esc(g.review.repo || 'будет определён по источнику')}</p>`;
  if (!p) return inputs + '<p class="muted">Ревью ещё не запускалось</p>';
  return inputs + `<div data-review-progress role="status"><p><strong>${esc(({ running: 'Выполняется', done: 'Завершено', failed: 'Ошибка' } as Record<string, string>)[p.status] ?? p.status)}</strong> · ${esc(reviewPhase(p.current))} · Время ревью: ${esc(elapsed(p.elapsedMs))}${p.reportedTotal ? ` · По оркестратору: ${esc(p.reportedTotal)}` : ''}</p><p class="muted">Начало: ${esc(reviewTime(p.startedAt))} · Окончание: ${esc(reviewTime(p.endedAt))}${p.exitCode !== undefined ? ` · exit=${p.exitCode}` : ''}${p.result ? ` · result=${esc(p.result)}` : ''}${p.updatedAt ? ` · Обновлено: ${esc(p.updatedAt)}` : ''}</p><details><summary>Этапы и время</summary><ul>${p.phases.map(phase => `<li>${esc(reviewPhase(phase.name))}: ${esc(reviewTime(phase.startedAt))} → ${esc(reviewTime(phase.endedAt))} · ${esc(elapsed(phase.elapsedMs))} · ${esc(phase.source)}</li>`).join('')}</ul><p class="muted">Время этапов известно по записанным границам. Для неполного этапа время неизвестно.</p>${(p.warnings ?? []).map(w => `<p>${esc(w)}</p>`).join('')}${p.error ? `<p>${esc(p.error)}</p>` : ''}${p.events?.length ? `<pre class="report-text">${esc(p.events.join('\n'))}</pre>` : ''}</details></div>`;
}
function terminalControl(g: { id: string; terminal?: TerminalNavigation }) {
  const terminal = g.terminal;
  if (!terminal) return '';
  if (!terminal.available) return `<small class="muted">${esc(terminal.reason)}</small>`;
  return `<button data-action="open-terminal" data-id="${esc(g.id)}" data-binding="${esc(terminal.binding)}">Открыть терминал</button>`;
}
function renderGoal(g: ViewGoal) {
  current = g; document.title = `${g.title} — Дело`;
  const status = [taskState({ ...g, phase: g.worker?.phase }), g.worker?.current].filter(Boolean).join(' · ');
  const reasons = [...new Set([g.reason, g.worker?.reason].filter(Boolean))];
  const diagnostics = g.worker?.diagnostics;
  const diagnosticSection = `<section class="section" id="task-diagnostics"><h2>Диагностика задачи</h2><p class="muted">${esc(diagnostics?.note || 'Диагностика не подтверждена: нет доступных данных исполнителя.')}</p>${g.worker?.details ? `<details><summary>Сообщение о текущем состоянии</summary><pre class="report-text">${esc(g.worker.details)}</pre></details>` : ''}${diagnostics?.entries.length ? `<details open><summary>Сообщения об ошибках и ожидании (${diagnostics.entries.length})</summary><pre class="report-text">${esc(diagnostics.entries.join('\n'))}</pre></details>` : diagnostics?.available ? '<p class="muted">Сообщений об ошибках в доступной части журнала нет.</p>' : ''}${diagnostics?.truncated ? '<p class="muted">Показан ограниченный фрагмент журнала; часть сообщений опущена.</p>' : ''}</section>`;
  const who = responsible({ ...g, owner: g.worker?.owner });
  const owner = reasons.length && !closed(g) && who ? `<p>${esc(who)}</p>` : '';
  const blockers = g.blockers?.length ? `<p>Ждёт: ${g.blockers.map(b => `<a href="#${encodeURIComponent(b.id)}">${esc(b.title)}</a>`).join(', ')}</p>` : '';
  const pr = g.worker?.prUrl || g.prUrl;
  const refs = [pr && /^https?:\/\//.test(pr) ? `<a href="${esc(pr)}" target="_blank" rel="noopener noreferrer">PR</a>` : '', g.report ? reportAnchor(g.id) : ''].filter(Boolean).join(' · ');
  renderMain(`<a class="back" href="#">← Что происходит</a><div class="page-heading"><div><p class="eyebrow">Задача Firstmate · ${esc(taskState({ ...g, phase: g.worker?.phase }))}${g.personal ? ' · личное' : ''}</p><h1>${esc(g.title)}</h1><p>${esc(status)}</p>${reasons.map(reason => `<p class="prose">${esc(reason)}</p>`).join('')}${g.worker ? `<p class="muted">${esc(waitNote(g.worker))}</p>` : ''}${owner}${blockers}${refs ? `<p>${refs}</p>` : ''}<details class="muted"><summary>Технические сведения</summary><p>ID: <code>${esc(g.id)}</code></p>${executor(g)}</details>${requests(g)}${reviewDetails(g)}</div><div class="actions"><button data-action="edit" ${closed(g) ? 'disabled' : ''}>Править</button>${taskControls(g)}${terminalControl(g)}</div></div><section class="section" id="task-assignment"><div class="section-heading"><h2>Задание</h2></div>${g.managedBrief ? brief(g) : `<div class="brief-box prose">${esc(bodyText(g) || 'Задание не записано')}</div>`}</section>${diagnosticSection}<section class="section"><div class="section-heading"><h2>Ссылки</h2></div>${g.links.length ? `<div class="rows">${g.links.map(ref => link(ref, g.report ? g.id : undefined)).join('')}</div>` : '<p class="muted">У задачи нет ссылок в Firstmate.</p>'}</section>`);
}

const brief = (g: Goal) => `<div class="brief-box"><dl><dt>Зачем</dt><dd class="prose">${esc(g.why)}</dd><dt>Готово, когда</dt><dd class="prose">${esc(g.doneWhen)}</dd><dt>Контекст</dt><dd class="prose">${esc(g.context)}</dd><dt>Ограничения</dt><dd class="prose">${esc(g.constraints.join('\n'))}</dd></dl></div>`;
const linkList = (refs: string[], report?: string) => refs.map(ref => report && ref === ownReport(report) ? reportAnchor(report) : /^https?:\/\//.test(ref) ? `<a href="${esc(ref)}" target="_blank" rel="noopener noreferrer">${esc(ref)}</a>` : esc(ref)).join(' · ');
const caseTask = (t: CaseTask, live: boolean) => `<div class="row${live ? ' go' : ''}"><div class="row-content"><strong>${live ? `<a href="#${encodeURIComponent(t.id)}">${esc(t.title)}</a>` : esc(t.title)}</strong><small>${esc(taskState(t))}${t.current ? ` · ${esc(t.current)}` : ''}${t.nextStep || t.until ? ` · ${esc(waitNote(t))}` : ''}${t.reason ? ` · ${esc(t.reason)}${responsible(t) ? ` · ${esc(responsible(t))}` : ''}` : ''}${t.links.length ? ' · ' : ''}${linkList(t.links, t.report ? t.id : undefined)}</small>${reviewDetails(t)}</div><div class="row-actions">${terminalControl(t)}${live ? taskControls(t) : ''}</div></div>`;
function renderCase(c: ViewCase) {
  current = c; document.title = `${c.title} — Дело`;
  const open = !c.archived && c.state !== 'done';
  const buttons = open ? '<button data-action="agent-case" class="primary">Новый агент</button><button data-action="edit">Править</button><button data-action="close-case">Закрыть дело</button>' : c.archived ? '<button data-action="continue-case">Продолжить</button>' : '<button data-action="reopen-case">Вернуть</button>';
  const groups = Object.entries(phaseLabels).map(([key, label]) => ({ label, rows: c.tasks.filter(t => t.phase === key) })).filter(g => g.rows.length);
  renderMain(`<a class="back" href="#">← Что происходит</a><div class="page-heading"><div><p class="eyebrow">Дело${c.archived ? ' · в архиве' : c.state === 'done' ? ' · закрыто' : ''}</p><h1>${esc(c.title)}</h1><p class="muted">${esc(c.why || 'Зачем нужно дело, пока не записано')}</p><p class="muted">${c.caseType === 'duty' ? 'Дежурство · только чтение' : c.review ? c.review.kind === 'sa' ? 'Ревью системной аналитики' : 'Код-ревью' : 'Обычное дело'} · Проект: ${esc(c.repo || c.review?.repo || 'не выбран')}${c.folder ? `<br>Материалы для чтения: ${esc(c.folder)}` : ''}</p>${reviewDetails(c)}</div><div class="actions">${buttons}</div></div><section class="section"><div class="section-heading"><h2>Бриф</h2></div>${brief(c)}${open ? '' : '<p class="disabled-note">Бриф заморожен после закрытия дела.</p>'}</section><section class="section"><div class="section-heading"><h2>Задачи</h2></div>${groups.length ? groups.map(g => `<p class="eyebrow">${esc(g.label)}</p><div class="rows">${g.rows.map(t => caseTask(t, true)).join('')}</div>`).join('') : '<p class="muted">В бэклоге нет задач этого дела.</p>'}</section><section class="section"><div class="section-heading"><h2>Закрыты раньше</h2></div>${c.earlier.length ? `<div class="rows">${c.earlier.map(t => caseTask(t, false)).join('')}</div>` : '<p class="muted">В архиве нет задач этого дела.</p>'}</section><section class="section"><div class="section-heading"><h2>Ссылки</h2></div>${c.links.length ? `<div class="rows">${c.links.map(ref => link(ref)).join('')}</div>` : '<p class="muted">У дела и его задач нет ссылок.</p>'}</section>`);
}
function renderClosed(list: { id: string; title: string; closed?: string }[]) {
  current = undefined; document.title = 'Закрытые дела — Дело';
  renderMain(`<a class="back" href="#">← Что происходит</a><div class="page-heading"><div><p class="eyebrow">Архив Firstmate</p><h1>Закрытые дела</h1></div></div>${list.length ? `<div class="rows">${list.map(c => `<div class="row go"><div class="row-content"><strong><a href="#case:${encodeURIComponent(c.id)}">${esc(c.title)}</a></strong><small>${esc([c.id, c.closed].filter(Boolean).join(' · '))}</small></div></div>`).join('')}</div>` : '<p class="muted">В архиве нет закрытых дел.</p>'}`);
}

function renderReport(taskId: string, r: { path: string; title: string; text: string }) {
  current = undefined; document.title = `Отчёт: ${r.title} — Дело`;
  renderMain(`<a class="back" href="#">← Что происходит</a><div class="page-heading"><div><p class="eyebrow">Отчёт · ${esc(taskId)}</p><h1>${esc(r.title)}</h1></div></div><section class="section"><p class="report-path"><code id="report-path">${esc(r.path)}</code> <button class="quiet" data-action="copy-path">Копировать путь</button> <button class="quiet" data-action="open-report" data-id="${esc(taskId)}">Открыть в приложении</button></p><pre class="report-text">${esc(r.text)}</pre></section>`);
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
  const [folders, projects] = await Promise.all([api<string[]>('/api/folders'), api<ProjectChoice[]>('/api/review-projects')]);
  const folder = g.kind !== 'program' || g.caseType === 'duty' || g.folder ? folderField(folders, g.folder) : '';
  modal(g.kind === 'program' ? 'Править дело' : 'Править задачу', `${field('title', 'Название', g.title, false, true)}${g.kind === 'program' ? projectField('repo', projects, g.repo || g.review?.repo || '') : ''}${field('body', 'Описание', bodyText(g).split('\n').filter(l => l !== personalLine && !(folder && l.startsWith(folderLine)) && l !== 'Вид дела: duty').join('\n'), true)}${folder}${personalBox(g.personal)}`, async f => { await api(base, { title: f.get('title'), body: f.get('body'), personal: f.has('personal'), ...(g.kind === 'program' ? { repo: f.get('repo') } : {}), folder: f.get('folder') ?? undefined }, 'PATCH'); refresh(); });
  if (g.kind === 'program') loadProjectChoices('repo');
}

async function caseAction(c: ViewCase, action: string) {
  const base = `/api/cases/${encodeURIComponent(c.id)}`;
  if (action === 'reopen-case') { await api(`${base}/reopen`, {}); message('Дело возвращено в список. Исполнители этим действием не запущены.'); refresh(); return; }
  if (action === 'agent-case') return newAgent(c);
  if (action === 'continue-case') { const next = await api<Goal>(`${base}/continue`, {}); location.hash = `case:${next.id}`; message('Продолжение дела создано. Исполнители этим действием не запущены.'); refresh(); return; }
  // Q40В: nothing is sent until the warning that lists every open task is confirmed.
  const open = c.tasks.filter(t => t.phase !== 'done');
  const close = async () => { const result = await api(`${base}/close`, { confirmed: open.map(t => t.id) }); message(`Дело закрыто${result.notes.length ? `, сохранено просьб Firstmate о закрытии задач: ${result.notes.length}` : ''}.`); refresh(); };
  if (!open.length) return close();
  modal('Закрыть дело', `<p>У дела есть незакрытые задачи. Будет сохранена просьба Firstmate закрыть каждую из них. Выполнение потребует обработки:</p><ul id="close-case-tasks">${open.map(t => `<li>${esc(t.title)} · ${esc(phaseLabels[t.phase])}</li>`).join('')}</ul><p class="muted">Пока вы не подтвердите, ничего не отправится и дело останется открытым.</p>`, close, 'Подтвердить и закрыть');
}

async function navigate() {
  const route = location.hash; const request = ++navigation;
  const goalId = decodeURIComponent(route.slice(1));
  const active = () => request === navigation && route === location.hash;
  if (!goalId) return renderOverview();
  try {
    if (goalId === ':closed') { const list = await api('/api/cases'); if (active()) renderClosed(list); return; }
    const reportId = /^report:(.+)$/.exec(goalId)?.[1];
    if (reportId) { const report = await api(`/api/reports/${encodeURIComponent(reportId)}`); if (active()) renderReport(reportId, report); return; }
    const caseId = /^case:(.+)$/.exec(goalId)?.[1];
    const goal = caseId ? undefined : await api<ViewGoal>(`/api/goals/${encodeURIComponent(goalId)}`);
    if (!active()) return;
    if (goal && goal.kind !== 'program') return renderGoal(goal);
    const c = await api<ViewCase>(`/api/cases/${encodeURIComponent(caseId ?? goalId)}`);
    if (active()) renderCase(c);
  }
  catch (e: any) { if (active()) { message(e.message, true); location.hash = ''; renderOverview(); } }
}
async function reload() {
  const request = ++refreshRequest;
  if (location.hash) await navigate();
  const next = await api<Overview>('/api/overview');
  if (request !== refreshRequest) return;
  // Snapshot timestamps change on every read even when the visible data is identical.
  if (JSON.stringify({ ...next, generated: undefined }) !== JSON.stringify({ ...view, generated: undefined })) view = next;
  if (!location.hash) renderOverview();
}
function refresh() { reload().catch(e => message(e.message, true)); }
$('new-goal').onclick = () => { newGoal().catch(e => message(e.message, true)); };
$('new-case').onclick = newCase;
$('dialog').addEventListener('close', () => { if (dialogOpener?.isConnected) dialogOpener.focus(); });
$('dialog-close').onclick = $('dialog-cancel').onclick = () => { saveDraft(); ($('dialog') as HTMLDialogElement).close(); };
$('dialog-form').onsubmit = async event => {
  event.preventDefault(); if (($('dialog-submit') as HTMLButtonElement).disabled) return;
  const generation = dialogGeneration; const action = submitDialog; const label = $('dialog-submit').innerHTML;
  $('dialog-submit').setAttribute('disabled', ''); $('dialog-form').setAttribute('aria-busy', 'true'); $('dialog-submit').textContent = 'Отправляем…';
  try { saveDraft(); await action(new FormData($('dialog-form') as HTMLFormElement)); if (generation === dialogGeneration) ($('dialog') as HTMLDialogElement).close(); }
  catch (e: any) { if (generation === dialogGeneration) $('dialog-error').textContent = e.message; else message(e.message, true); }
  finally { if (generation === dialogGeneration) { $('dialog-submit').innerHTML = label; $('dialog-submit').removeAttribute('disabled'); $('dialog-form').removeAttribute('aria-busy'); } }
};
$('main').onclick = async event => {
  const taskButton = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-task-action]');
  if (taskButton) { event.preventDefault(); if (taskButton.disabled || pendingTasks.has(taskButton.dataset.id!)) return; try { await taskAction({ id: taskButton.dataset.id!, title: taskButton.dataset.title!, holdKind: taskButton.dataset.holdKind, inFlight: !!taskButton.dataset.inFlight, question: taskButton.dataset.question }, taskButton.dataset.taskAction!, taskButton.dataset.taskAttempt ? Number(taskButton.dataset.taskAttempt) : undefined); } catch (e: any) { message(e.message, true); } return; }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
  if (!button) { const go = (event.target as HTMLElement).closest('.row.go'); if (go && !(event.target as HTMLElement).closest('a, button, input, select, textarea, label, details, .task-actions, .row-actions')) go.querySelector('a')?.click(); return; }
  if (button.disabled || button.dataset.action === 'pin' && pendingTasks.has(button.dataset.id!)) return;
  try { button.disabled = true; button.setAttribute('aria-busy', 'true'); if (button.dataset.action === 'new') return await newGoal(); if (button.dataset.action === 'copy-path') return await copyPath(); if (button.dataset.action === 'open-terminal') { button.disabled = true; await api(`/api/tasks/${encodeURIComponent(button.dataset.id!)}/terminal/open`, { binding: button.dataset.binding }); message('Терминал выбран. Переключитесь в окно Herdr.'); return; } if (button.dataset.action === 'open-report') { button.disabled = true; await api(`/api/reports/${encodeURIComponent(button.dataset.id!)}/open`, {}); message('Отчёт передан приложению для открытия.'); return; } if (button.dataset.action === 'refresh') { button.disabled = true; await reload(); message('Список обновлён.'); return; }
    if (button.dataset.action === 'pin') { taskPending(button.dataset.id!, true); await api(`/api/tasks/${encodeURIComponent(button.dataset.id!)}/pin`, { pinned: !!button.dataset.on }); const feedback = button.dataset.on ? 'Задача закреплена.' : 'Задача откреплена.'; message(feedback); try { await reload(); } catch { message(`${feedback} Не удалось обновить список. Нажмите «Обновить».`, true); } return; } if (button.dataset.action!.endsWith('-case') && current) return await caseAction(current as ViewCase, button.dataset.action!); await goalAction(button.dataset.action!); }
  catch (e: any) { message(e.message, true); } finally { button.disabled = false; button.removeAttribute('aria-busy'); if (button.dataset.action === 'pin') taskPending(button.dataset.id!, false); }
};
window.onhashchange = () => { navigate().catch(e => message(e.message, true)); };
async function start() { const meta = await api('/api/meta'); csrf = meta.csrf; draftScope = meta.draftScope; await reload(); }
start().catch(e => { if (markup) return message(e.message, true); renderMain(`<div class="empty"><h2>Не удалось прочитать задачи Firstmate</h2><p>${esc(e.message)}</p><button data-action="refresh">Повторить</button></div>`); });
// The overview runs two Firstmate snapshots, so it refreshes only while the tab is visible.
window.setInterval(async () => { if (document.visibilityState !== 'visible' || ($('dialog') as HTMLDialogElement).open) return; try { await reload(); } catch { /* The next refresh retries after the local server returns. */ } }, 30000);
