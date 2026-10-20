import type { Goal, TaskRequest } from '../src/model.ts';
import type { Overview, Row, CaseRow } from '../src/overview.ts';
type ViewGoal = Goal & { inbox?: { requests: { action?: TaskRequest['action']; requestId: string; at: string; state: string; acknowledged: boolean; reply: unknown }[]; ready?: any }; worker?: { phase?: keyof typeof phaseLabels; harness: string; current?: string; reason?: string; owner?: string; prUrl?: string } };
type CaseTask = Pick<Goal, 'id' | 'title' | 'state' | 'actions' | 'holdKind' | 'reason' | 'inFlight' | 'links' | 'report' | 'requests' | 'review' | 'reviewProgress'> & { phase: keyof typeof phaseLabels; owner?: string; current?: string };
type ViewCase = Goal & { archived: boolean; sources: string[]; tasks: CaseTask[]; earlier: CaseTask[] };
const phaseLabels = { working: 'в работе', waiting: 'ждёт', next: 'дальше', done: 'сделано' };
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
const pendingTasks = new Set<string>();
let markup = ''; let navigation = 0; let refreshRequest = 0;
function renderMain(html: string) {
  if (markup === html) return;
  $('main').innerHTML = html; markup = html;
}

async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const verb = method ?? (body === undefined ? 'GET' : 'POST');
  const request = () => fetch(path, { method: verb, cache: 'no-store', headers: { 'content-type': 'application/json', 'x-delo-csrf': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let response = await request(); let value = await response.json();
  // Only this pre-mutation refusal is safe to replay; network and action failures may already have applied.
  if (!['GET', 'HEAD'].includes(verb) && response.status === 403 && value.code === 'CSRF_MISMATCH') {
    try { csrf = (await api('/api/meta')).csrf; }
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
  $('dialog-title').textContent = title; $('dialog-body').innerHTML = body; $('dialog-error').textContent = '';
  $('dialog-submit').textContent = submit; $('dialog-cancel').hidden = true;
  submitDialog = action; $('dialog-submit').hidden = !submit;
  ($('dialog') as HTMLDialogElement).showModal();
}
const personalLine = 'Личное';
const personalBox = (on = false) => `<label class="checkbox"><input type="checkbox" name="personal" ${on ? 'checked' : ''}> Личное</label>`;
// The folder is the body's `Папка:` line; suggestions are the folders other backlog tasks name.
const folderLine = 'Папка: ';
type ProjectChoice = { name: string; path: string };
const pathField = (name: string, label: string, choices: { value: string; label?: string }[], value = '', required = false) => `<label>${esc(label)}<input name="${name}" value="${esc(value)}" list="${name}-list" maxlength="500" ${required ? 'required' : ''} placeholder="${name === 'folder' ? 'абсолютный путь или ~/…' : 'проект из списка или полный путь к папке'}"><datalist id="${name}-list">${choices.map(f => `<option value="${esc(f.value)}">${esc(f.label)}</option>`).join('')}</datalist></label>${name === 'folder' ? '' : `<label>Зарегистрированный проект<select data-project-choice="${name}" aria-label="${esc(label)}: зарегистрированные проекты"><option value="">Выбрать зарегистрированный проект…</option>${choices.map(f => `<option value="${esc(f.value)}">${esc(f.label || f.value)}</option>`).join('')}</select></label>`}`;
const projectField = (name: string, projects: ProjectChoice[], value = '', required = false) => pathField(name, 'Проект (необязательно)', projects.map(p => ({ value: p.name, label: `${p.name} · ${p.path}` })), value, required);
function projectChoices(name: string, projects: ProjectChoice[]) {
  const options = projects.map(p => `<option value="${esc(p.name)}">${esc(p.name)} · ${esc(p.path)}</option>`).join('');
  const list = document.getElementById(`${name}-list`);
  const select = document.querySelector(`[data-project-choice="${name}"]`);
  if (!list || !select) return;
  list.innerHTML = options;
  select.innerHTML = '<option value="">Выбрать зарегистрированный проект…</option>' + options;
}
$('dialog-body').addEventListener('change', e => {
  const select = e.target as HTMLSelectElement;
  if (select.dataset.projectChoice && select.value) {
    const input = document.querySelector<HTMLInputElement>(`#dialog-body [name=${select.dataset.projectChoice}]`)!;
    input.value = select.value; input.dispatchEvent(new Event('input', { bubbles: true }));
    select.value = '';
  }
});
const folderField = (folders: string[], value = '') => pathField('folder', 'Материалы для чтения: папка', folders.map(value => ({ value })), value) + '<p class="muted">Необязательно для обычного исследования. Агент читает эту папку без права менять её файлы. Для правок выберите «Изменение файлов» и проект.</p>';
async function newGoal() {
  const folders = await api<string[]>('/api/folders');
  const repos = view?.repos ?? [];
  const cases = view?.cases ?? [];
  modal('Новая задача', `${field('title', 'Название', '', false, true)}${personalBox()}<label>Дело<select name="caseId"><option value="">Без дела</option>${cases.map(c => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('')}</select></label><label>Вид<select name="kind"><option value="ship">Изменение файлов</option><option value="scout">Исследование</option></select></label><label>Проект<input name="repo" list="repo-list" maxlength="500"><datalist id="repo-list">${repos.map(r => `<option value="${esc(r)}">`).join('')}</datalist></label>${folderField(folders)}${field('body', 'Описание', '', true)}${field('blockedBy', 'После задачи (id)')}<label>Отложить до<input type="date" name="holdUntil"></label>`, async f => {
    const g = await api<Goal>('/api/goals', { title: f.get('title'), kind: f.get('kind'), repo: f.get('repo'), body: f.get('body'), blockedBy: f.get('blockedBy'), holdUntil: f.get('holdUntil'), personal: f.has('personal'), caseId: f.get('caseId'), folder: f.get('folder') });
    location.hash = g.id; refresh();
  }, 'Завести задачу');
}
function newCase() {
  const requestId = crypto.randomUUID();
  modal('Новое дело', `${field('title', 'Название', '', false, true)}<label>Вид дела<select name="reviewKind"><option value="">Обычное дело</option><option value="duty">Дежурство</option><option value="sa">Ревью системной аналитики</option><option value="code">Код-ревью</option></select></label>${projectField('reviewRepo', [])}<p class="muted">Проект задаёт контекст агенту. Правки выполняются в отдельном рабочем дереве выбранного проекта. Личное дело можно оставить без проекта.</p><div id="review-fields"></div><div id="duty-fields" hidden>${folderField([])}<p class="muted">Для дежурства папка обязательна. Дежурный исследует обращение и готовит отчёт и черновики. Публикация и правки файлов не выполняются.</p></div><div id="case-sources">${field('sources', 'Источники, по одной ссылке в строке', '', true)}</div>${field('why', 'Зачем', '', true)}${field('doneWhen', 'Критерий готовности', '', true)}${field('context', 'Контекст', '', true)}${field('constraints', 'Ограничения, по одному в строке', '', true)}`, async f => {
    const review = f.get('reviewKind') === 'sa' ? { kind: 'sa', document: f.get('document'), repo: f.get('reviewRepo') } : f.get('reviewKind') === 'code' ? { kind: 'code', url: f.get('url'), repo: f.get('reviewRepo') } : undefined;
    const c = await api<Goal>('/api/cases', { ...Object.fromEntries(['title', 'sources', 'why', 'doneWhen', 'context', 'constraints'].map(k => [k, f.get(k)])), repo: f.get('reviewRepo'), caseType: f.get('reviewKind') === 'duty' ? 'duty' : 'ordinary', folder: f.get('reviewKind') === 'duty' ? f.get('folder') : '', ...(review ? { review, requestId, ...(review.kind === 'code' ? { sources: '' } : {}) } : {}) });
    location.hash = `case:${c.id}`; refresh();
  }, 'Завести дело');
  const select = document.querySelector<HTMLSelectElement>('[name=reviewKind]')!;
  select.onchange = () => {
    $('case-sources').hidden = select.value === 'code';
    $('duty-fields').hidden = select.value !== 'duty';
    const folder = document.querySelector<HTMLInputElement>('#dialog-body [name=folder]')!;
    folder.disabled = select.value !== 'duty'; folder.required = select.value === 'duty';
    const project = document.querySelector<HTMLInputElement>('[name=reviewRepo]')!;
    project.required = select.value === 'sa';
    project.closest('label')!.firstChild!.textContent = select.value === 'sa' ? 'Проект контекста' : 'Проект (необязательно)';
    $('review-fields').innerHTML = select.value === 'sa' ? '<label>Документ для ревью<input name="document" type="url" pattern="https?://.+" maxlength="2000" required placeholder="https://confluence…"></label>' : select.value === 'code' ? '<label>Задача Jira или pull request<input name="url" type="url" maxlength="2000" required placeholder="https://jira.example.invalid/browse/…"></label>' : '';
  };
  select.onchange(new Event('change'));
  api<ProjectChoice[]>('/api/review-projects').then(projects => projectChoices('reviewRepo', projects)).catch(error => { $('dialog-error').textContent = error.message; });
}
// The browser loads app.ts with types stripped, so it keeps a copy of `harnesses` from src/model.ts; edit both together.
const harnesses = ['claude', 'codex', 'opencode', 'pi', 'grok', 'kimi', 'gemini', 'agy'];
const defaultDirection = 'Разбери текущее дело по ориентировке и прикреплённым материалам. Прочитай источники, необходимые для понимания задания. Если задание понятно, приступай к работе. Если сведений недостаточно, задай уточняющий вопрос.';
// The receipt of a note for firstmate, as «Взять в работу» and «Новый агент» show it.
const receipt = (result: any) => {
  if (result.note.acknowledged) return 'Firstmate принял просьбу. Ждём изменения задачи.';
  return result.ready?.can_receive === false
    ? 'Firstmate сейчас занят; просьба сохранена и будет прочитана позже.'
    : 'Просьба сохранена для Firstmate. Ждём принятия; выполнение ещё не подтверждено.';
};
async function newAgent(c: ViewCase) {
  const [folders, projects] = await Promise.all([api<string[]>('/api/folders'), api<ProjectChoice[]>('/api/review-projects')]);
  const duty = c.caseType === 'duty';
  modal('Новый агент', `${field('direction', 'Направление', defaultDirection, true, true)}<label>Режим работы<select name="kind"><option value="scout">Исследование: отчёт без изменения файлов</option>${duty ? '' : '<option value="ship">Изменение файлов: отдельное рабочее дерево проекта</option>'}</select></label><p id="agent-mode-help" class="muted"></p><div id="agent-repo">${projectField('repo', projects, c.repo || c.review?.repo || '')}</div><label>Исполнитель<select name="harness"><option value="">как решит firstmate</option>${(duty ? ['claude'] : harnesses).map(h => `<option value="${h}">${h}</option>`).join('')}</select></label>${duty ? '<p class="muted">Дежурство использует claude для доступа к материалам только для чтения.</p>' : '<label class="checkbox"><input type="checkbox" name="interactive"> Работаю в окне сам</label>'}<div id="agent-folder">${folderField(folders, c.folder)}</div>`, async f => {
    const result = await api(`/api/cases/${encodeURIComponent(c.id)}/agent`, { direction: f.get('direction'), kind: f.get('kind'), repo: f.get('repo'), harness: f.get('harness'), interactive: f.has('interactive'), folder: f.get('kind') === 'scout' ? f.get('folder') : '' });
    message(`Новый агент: задача ${result.task.id}. ${receipt(result)}`);
    refresh();
  }, 'Запустить');
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
const taskState = (g: { state?: Goal['state']; holdKind?: string; inFlight?: boolean; phase?: keyof typeof phaseLabels }) => g.state === 'done' ? 'Закрыта' : g.holdKind === 'captain' ? (g.inFlight ? 'В работе · ждёт ответа' : 'Ждёт решения') : g.state === 'paused' ? 'На паузе' : g.phase === 'waiting' ? 'Ждёт' : g.inFlight ? (g.phase === 'next' ? 'Передана Firstmate' : 'В работе') : g.state === 'active' ? 'В очереди' : '';
const requestLabel = (r: TaskRequest) => r.action === 'start'
  ? r.state === 'pending' ? 'Запуск запрошен. Ждём принятия Firstmate.' : 'Запуск принят. Ждём начала работы.'
  : r.action === 'stop'
    ? r.state === 'pending' ? 'Остановка запрошена. Работа ещё не остановлена.' : 'Просьба об остановке принята. Остановка ещё не подтверждена.'
    : r.state === 'pending' ? 'Закрытие запрошено. Задача ещё не закрыта.' : 'Просьба о закрытии принята. Закрытие ещё не подтверждено.';
const retryLabel = (action: string) => ({ start: 'Повторить просьбу о запуске', stop: 'Повторить просьбу об остановке', close: 'Повторить просьбу о закрытии' } as Record<string, string>)[action];
function taskControls(g: Pick<Goal, 'id' | 'title' | 'actions' | 'holdKind' | 'reason' | 'inFlight' | 'requests'>) {
  const pending = pendingTasks.has(g.id);
  return `<div class="actions task-actions">${g.actions.filter(a => !g.requests?.some(r => r.action === a)).map(a => `<button data-task-action="${a}" data-id="${esc(g.id)}" data-title="${esc(g.title)}" data-hold-kind="${esc(g.holdKind)}" data-in-flight="${g.inFlight ? '1' : ''}"${a === 'answer' ? ` data-question="${esc(g.reason)}"` : ''} ${pending ? 'disabled' : ''}>${a === 'close' && g.inFlight ? 'Запросить закрытие' : a === 'close' && g.holdKind === 'captain' ? 'Закрыть как неактуальную' : actionLabels[a]}</button>`).join('')}${(g.requests ?? []).filter(r => g.actions.includes(r.action)).map(r => `<small role="status">${requestLabel(r)}</small>${r.state === 'handled' ? `<button data-task-action="${r.action}" data-task-attempt="${Number(r.requestId.split('-').at(-1)) + 1}" data-id="${esc(g.id)}" data-title="${esc(g.title)}" data-in-flight="${g.inFlight ? '1' : ''}" ${pending ? 'disabled' : ''}>${retryLabel(r.action)}</button>` : ''}`).join('')}<small data-task-pending data-id="${esc(g.id)}" role="status" ${pending ? '' : 'hidden'}>Выполняется…</small></div>`;
}
function taskPending(id: string, on: boolean) {
  if (on) pendingTasks.add(id); else pendingTasks.delete(id);
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
      if (action === 'stop' || action === 'close' && g.inFlight) {
        message(`${receipt(result)} ${action === 'stop' ? 'Остановка ещё не подтверждена. Просьба: сохранить сделанное и оставить задачу открытой.' : 'Закрытие ещё не подтверждено; задача пока остаётся в работе.'}`);
      } else if (action === 'close' && result.task) {
        message(`Задача «${g.title}» закрыта.`, false, () => taskAction(g, 'reopen'));
      } else message(result.note ? receipt(result) : `${actionLabels[action]}: готово.`);
      await reload();
    } finally { taskPending(g.id, false); }
  };
  if (attempt !== undefined) {
    modal(retryLabel(action), `<p>Задача «${esc(g.title)}»</p><p>Предыдущая просьба принята, но это не подтверждает выполнение. Отправить новую просьбу? Повторное подтверждение отправит её только один раз.</p>`, () => run(), 'Отправить ещё раз');
    $('dialog-cancel').hidden = false;
  }
  else if (action === 'close' || action === 'stop') {
    const consequence = action === 'stop' ? 'Firstmate получит просьбу остановить работу, сохранить сделанное и оставить задачу открытой. Это не немедленная остановка; ждём обработки просьбы.'
      : g.inFlight ? 'Firstmate получит просьбу закрыть задачу. Исполнитель не будет остановлен этим нажатием; ждём обработки просьбы.'
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
  const marks = [r.kind ? badge(r.kind) : '', r.personal ? badge('личное') : '', r.pinned && !inFocus ? badge('В фокусе') : ''].join('');
  const detail = [r.task ? r.id : undefined, taskState(r), r.current, r.reason, r.owner ? `Ответственный: ${r.owner}` : r.reason ? 'Ответственный неизвестен' : undefined].filter(Boolean).join(' · ');
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
    return `<section class="area" id="overview-${key}"><div class="area-heading"><h2>${title} <span class="count">${groups.reduce((n, g) => n + g.rows.length, 0)}</span></h2></div>${groups.length ? groups.map(g => `<p class="eyebrow">${esc(g.repo)}</p><div class="rows">${g.rows.map(r => row(r)).join('')}</div>`).join('') : '<p class="muted">Здесь пусто.</p>'}</section>`;
  };
  renderMain(`<div class="page-heading"><div><p class="eyebrow">Firstmate · ${date(v.generated)}</p><h1>Что сейчас происходит</h1></div><div class="actions"><label class="sr-only" for="kind">Вид задачи</label><select id="kind"><option value="">Все виды</option>${v.kinds.map(k => `<option value="${esc(k)}" ${kind === k ? 'selected' : ''}>${esc(({ ship: 'Доработка', scout: 'Исследование', captain: 'Вопрос' } as Record<string, string>)[k] ?? k)}</option>`).join('')}<option value=":personal" ${kind === ':personal' ? 'selected' : ''}>Личное</option></select><button data-action="refresh" class="quiet">Обновить</button></div></div>${part('waiting', 'Ждёт')}${v.cases.length ? `<section class="area"><div class="area-heading"><h2>Дела <span class="count">${v.cases.length}</span></h2><a href="#:closed">Закрытые дела</a></div><div class="rows">${v.cases.map(caseRow).join('')}</div></section>` : '<p class="muted">Дела: открытых нет. <a href="#:closed">Закрытые дела</a></p>'}${focus.length ? `<section class="area" id="overview-focus"><div class="area-heading"><h2>В фокусе <span class="count">${focus.length}</span></h2></div><div class="rows">${focus.map(r => row(r, true)).join('')}</div></section>` : '<p class="muted">В фокусе: задач нет. <a id="focus-tasks" href="#overview-next">Выберите задачи ниже</a> и нажмите «Закрепить».</p>'}${sections.filter(([key]) => key !== 'waiting').map(([key, title]) => part(key, title)).join('')}`);
  const focusTasks = document.getElementById('focus-tasks');
  if (focusTasks) focusTasks.onclick = e => { e.preventDefault(); $('overview-next').scrollIntoView(); };
  $('kind').onchange = () => { kind = ($('kind') as HTMLSelectElement).value; renderOverview(); };
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
function renderGoal(g: ViewGoal) {
  current = g; document.title = `${g.title} — Дело`;
  const status = [taskState({ ...g, phase: g.worker?.phase }), g.inFlight || g.worker?.harness ? g.worker?.current : undefined].filter(Boolean).join(' · ');
  const reasons = [...new Set([g.reason, g.worker?.reason].filter(Boolean))];
  const owner = reasons.length && !closed(g) ? `<p>${esc(g.worker?.owner ? `Ответственный: ${g.worker.owner}` : 'Ответственный неизвестен')}</p>` : '';
  const blockers = g.blockers?.length ? `<p>Ждёт: ${g.blockers.map(b => `<a href="#${encodeURIComponent(b.id)}">${esc(b.title)}</a>`).join(', ')}</p>` : '';
  const pr = g.worker?.prUrl || g.prUrl;
  const refs = [pr && /^https?:\/\//.test(pr) ? `<a href="${esc(pr)}" target="_blank" rel="noopener noreferrer">PR</a>` : '', g.report ? reportAnchor(g.id) : ''].filter(Boolean).join(' · ');
  renderMain(`<a class="back" href="#">← Что происходит</a><div class="page-heading"><div><p class="eyebrow">Задача Firstmate · ${esc(g.id)} · ${esc(taskState({ ...g, phase: g.worker?.phase }))}${g.personal ? ' · личное' : ''}</p><h1>${esc(g.title)}</h1><p>${esc(status)}</p>${reasons.map(reason => `<p class="prose">${esc(reason)}</p>`).join('')}${owner}${blockers}${refs ? `<p>${refs}</p>` : ''}${g.why ? `<p class="prose">${esc(g.why)}</p>` : ''}${executor(g)}${requests(g)}${reviewDetails(g)}</div><div class="actions"><button data-action="edit" ${closed(g) ? 'disabled' : ''}>Править</button>${taskControls(g)}</div></div><section class="section"><div class="section-heading"><h2>Ссылки</h2></div>${g.links.length ? `<div class="rows">${g.links.map(ref => link(ref, g.report ? g.id : undefined)).join('')}</div>` : '<p class="muted">У задачи нет ссылок в Firstmate.</p>'}</section><section class="section"><div class="section-heading"><h2>Бриф</h2></div>${g.managedBrief ? `<details class="brief-box"><summary>Зачем, критерий готовности и контекст</summary><dl><dt>Зачем</dt><dd class="prose">${esc(g.why)}</dd><dt>Готово, когда</dt><dd class="prose">${esc(g.doneWhen)}</dd><dt>Контекст</dt><dd class="prose">${esc(g.context)}</dd><dt>Ограничения</dt><dd class="prose">${esc(g.constraints.join('\n'))}</dd></dl>${closed(g) ? '<p class="disabled-note">Бриф заморожен после закрытия цели.</p>' : ''}</details>` : `<div class="brief-box prose">${esc(g.body)}</div>`}</section>`);
}

const brief = (g: Goal) => `<div class="brief-box"><dl><dt>Зачем</dt><dd class="prose">${esc(g.why)}</dd><dt>Готово, когда</dt><dd class="prose">${esc(g.doneWhen)}</dd><dt>Контекст</dt><dd class="prose">${esc(g.context)}</dd><dt>Ограничения</dt><dd class="prose">${esc(g.constraints.join('\n'))}</dd></dl></div>`;
const linkList = (refs: string[], report?: string) => refs.map(ref => report && ref === ownReport(report) ? reportAnchor(report) : /^https?:\/\//.test(ref) ? `<a href="${esc(ref)}" target="_blank" rel="noopener noreferrer">${esc(ref)}</a>` : esc(ref)).join(' · ');
const caseTask = (t: CaseTask, live: boolean) => `<div class="row${live ? ' go' : ''}"><div class="row-content"><strong>${live ? `<a href="#${encodeURIComponent(t.id)}">${esc(t.title)}</a>` : esc(t.title)}</strong><small>${esc(t.id)} · ${esc(taskState(t))}${t.current ? ` · ${esc(t.current)}` : ''}${t.reason ? ` · ${esc(t.reason)} · ${esc(t.owner ? `Ответственный: ${t.owner}` : 'Ответственный неизвестен')}` : ''}${t.links.length ? ' · ' : ''}${linkList(t.links, t.report ? t.id : undefined)}</small>${reviewDetails(t)}</div>${live ? taskControls(t) : ''}</div>`;
function renderCase(c: ViewCase) {
  current = c; document.title = `${c.title} — Дело`;
  const open = !c.archived && c.state !== 'done';
  const buttons = open ? '<button data-action="agent-case" class="primary">Новый агент</button><button data-action="edit">Править</button><button data-action="close-case">Закрыть дело</button>' : c.archived ? '<button data-action="continue-case">Продолжить</button>' : '<button data-action="reopen-case">Вернуть</button>';
  const groups = Object.entries(phaseLabels).map(([key, label]) => ({ label, rows: c.tasks.filter(t => t.phase === key) })).filter(g => g.rows.length);
  renderMain(`<a class="back" href="#">← Что происходит</a><div class="page-heading"><div><p class="eyebrow">Дело · ${esc(c.id)}${c.archived ? ' · в архиве' : c.state === 'done' ? ' · закрыто' : ''}</p><h1>${esc(c.title)}</h1><p class="muted">${esc(c.why || 'Зачем нужно дело, пока не записано')}</p><p class="muted">${c.caseType === 'duty' ? 'Дежурство · только чтение' : c.review ? c.review.kind === 'sa' ? 'Ревью системной аналитики' : 'Код-ревью' : 'Обычное дело'} · Проект: ${esc(c.repo || c.review?.repo || 'не выбран')}${c.folder ? `<br>Материалы для чтения: ${esc(c.folder)}` : ''}</p>${reviewDetails(c)}</div><div class="actions">${buttons}</div></div><section class="section"><div class="section-heading"><h2>Бриф</h2></div>${brief(c)}${open ? '' : '<p class="disabled-note">Бриф заморожен после закрытия дела.</p>'}</section><section class="section"><div class="section-heading"><h2>Задачи</h2></div>${groups.length ? groups.map(g => `<p class="eyebrow">${esc(g.label)}</p><div class="rows">${g.rows.map(t => caseTask(t, true)).join('')}</div>`).join('') : '<p class="muted">В бэклоге нет задач этого дела.</p>'}</section><section class="section"><div class="section-heading"><h2>Закрыты раньше</h2></div>${c.earlier.length ? `<div class="rows">${c.earlier.map(t => caseTask(t, false)).join('')}</div>` : '<p class="muted">В архиве нет задач этого дела.</p>'}</section><section class="section"><div class="section-heading"><h2>Ссылки</h2></div>${c.links.length ? `<div class="rows">${c.links.map(ref => link(ref)).join('')}</div>` : '<p class="muted">У дела и его задач нет ссылок.</p>'}</section>`);
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
  modal(g.kind === 'program' ? 'Править дело' : 'Править задачу', `${field('title', 'Название', g.title, false, true)}${g.kind === 'program' ? projectField('repo', projects, g.repo || g.review?.repo || '') : ''}${field('body', 'Описание', g.body.split('\n').filter(l => l !== personalLine && !(folder && l.startsWith(folderLine)) && l !== 'Вид дела: duty').join('\n'), true)}${folder}${personalBox(g.personal)}`, async f => { await api(base, { title: f.get('title'), body: f.get('body'), personal: f.has('personal'), ...(g.kind === 'program' ? { repo: f.get('repo') } : {}), folder: f.get('folder') ?? undefined }, 'PATCH'); refresh(); });
}

async function caseAction(c: ViewCase, action: string) {
  const base = `/api/cases/${encodeURIComponent(c.id)}`;
  if (action === 'reopen-case') { await api(`${base}/reopen`, {}); refresh(); return; }
  if (action === 'agent-case') return newAgent(c);
  if (action === 'continue-case') { const next = await api<Goal>(`${base}/continue`, {}); location.hash = `case:${next.id}`; refresh(); return; }
  // Q40В: nothing is sent until the warning that lists every open task is confirmed.
  const open = c.tasks.filter(t => t.phase !== 'done');
  const close = async () => { const result = await api(`${base}/close`, { confirmed: open.map(t => t.id) }); message(`Дело закрыто${result.notes.length ? `, firstmate получил запросов закрыть задачу: ${result.notes.length}` : ''}.`); refresh(); };
  if (!open.length) return close();
  modal('Закрыть дело', `<p>У дела есть незакрытые задачи. Firstmate получит запрос закрыть каждую из них:</p><ul id="close-case-tasks">${open.map(t => `<li>${esc(t.title)} · ${esc(phaseLabels[t.phase])}</li>`).join('')}</ul><p class="muted">Пока вы не подтвердите, ничего не отправится и дело останется открытым.</p>`, close, 'Подтвердить и закрыть');
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
$('dialog-close').onclick = $('dialog-cancel').onclick = () => ($('dialog') as HTMLDialogElement).close();
$('dialog-form').onsubmit = async event => { event.preventDefault(); if (($('dialog-submit') as HTMLButtonElement).disabled) return; $('dialog-submit').setAttribute('disabled', ''); try { await submitDialog(new FormData($('dialog-form') as HTMLFormElement)); ($('dialog') as HTMLDialogElement).close(); } catch (e: any) { $('dialog-error').textContent = e.message; } finally { $('dialog-submit').removeAttribute('disabled'); } };
$('main').onclick = async event => {
  const taskButton = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-task-action]');
  if (taskButton) { event.preventDefault(); if (taskButton.disabled || pendingTasks.has(taskButton.dataset.id!)) return; try { await taskAction({ id: taskButton.dataset.id!, title: taskButton.dataset.title!, holdKind: taskButton.dataset.holdKind, inFlight: !!taskButton.dataset.inFlight, question: taskButton.dataset.question }, taskButton.dataset.taskAction!, taskButton.dataset.taskAttempt ? Number(taskButton.dataset.taskAttempt) : undefined); } catch (e: any) { message(e.message, true); } return; }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
  if (!button) { const go = (event.target as HTMLElement).closest('.row.go'); if (go && !(event.target as HTMLElement).closest('a, button, input, select, textarea, label, .task-actions, .row-actions')) go.querySelector('a')?.click(); return; }
  try { if (button.dataset.action === 'new') return await newGoal(); if (button.dataset.action === 'copy-path') return await copyPath(); if (button.dataset.action === 'open-report') { button.disabled = true; await api(`/api/reports/${encodeURIComponent(button.dataset.id!)}/open`, {}); return; } if (button.dataset.action === 'refresh') { button.disabled = true; await reload(); return; }
    if (button.dataset.action === 'pin') { button.disabled = true; await api(`/api/tasks/${encodeURIComponent(button.dataset.id!)}/pin`, { pinned: !!button.dataset.on }); refresh(); return; } if (button.dataset.action!.endsWith('-case') && current) return await caseAction(current as ViewCase, button.dataset.action!); await goalAction(button.dataset.action!); }
  catch (e: any) { message(e.message, true); } finally { button.disabled = false; }
};
window.onhashchange = () => { navigate().catch(e => message(e.message, true)); };
async function start() { const meta = await api('/api/meta'); csrf = meta.csrf; await reload(); }
start().catch(e => { if (markup) return message(e.message, true); renderMain(`<div class="empty"><h2>Не удалось прочитать задачи Firstmate</h2><p>${esc(e.message)}</p><button data-action="refresh">Повторить</button></div>`); });
// The overview runs two Firstmate snapshots, so it refreshes only while the tab is visible.
window.setInterval(async () => { if (document.visibilityState !== 'visible' || ($('dialog') as HTMLDialogElement).open) return; try { await reload(); } catch { /* The next refresh retries after the local server returns. */ } }, 30000);
