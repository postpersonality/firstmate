import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { stripTypeScriptTypes } from 'node:module';
import { Store } from '../src/store.ts';
import { firstmateHome } from './firstmate-home.ts';
import { router } from '../src/server.ts';
import { run } from '../src/process.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as any;

test('public overview and case pages group all waits and keep closed retained workers completed', async t => {
  const root = mkdtempSync(join(tmpdir(), 'delo-waiting-ui-'));
  const store = new Store({ firstmateHome: firstmateHome(root) });
  const task = (id: string, extra: any = {}) => ({ id, title: id, kind: 'ship', repo: 'project', state: 'in_flight', body: 'Дело: case', ...extra });
  const tasks = [task('case', { kind: 'program', body: '' }),
    task('human', { hold_kind: 'captain', hold_reason: 'Выбрать вариант' }), task('coordinator'), task('ci'),
    task('dependency', { state: 'queued', blocked_by: 'busy' }), task('held', { state: 'queued', held: 'yes', hold_kind: 'parked', hold_reason: 'Ждём поставщика' }),
    task('ready'), task('busy'), task('closed', { state: 'done' }), task('unknown', { kind: 'scout' })];
  const fleet = { backlog: { records: tasks.map(t => ({ ...t, body_lines: t.body.split('\n') })) }, tasks: [
    { id: 'coordinator', current_state: { state: 'needs-decision', detail: 'Нужен разбор' } },
    { id: 'ci', current_state: { state: 'working', source: 'run-step', detail: 'ci running' } },
    { id: 'ready', mode: 'local-only', current_state: { state: 'unknown' } },
    { id: 'busy', current_state: { state: 'working' } },
    { id: 'closed', current_state: { state: 'unknown' } },
    { id: 'unknown', current_state: { state: 'unknown' }, hints: { pending_decision: true, last_event_text: 'done: ready' } },
  ] };
  const bearings = { generated: '2026-10-20T16:00:00Z', decisions_open: [{ id: 'human' }], in_flight: fleet.tasks.map(t => ({ id: t.id })), gates: [{ id: 'dependency' }, { id: 'held' }] };
  t.mock.method(store.firstmate, 'snapshot', async (script: string) => script === 'fm-bearings-snapshot.sh' ? bearings : fleet);
  t.mock.method(store.firstmate, 'delivery', async (worker: any) => worker?.id === 'ready' ? { state: 'pending', head: 'a'.repeat(40) } : undefined);
  t.mock.method(store.firstmate, 'list', () => tasks);
  t.mock.method(store.firstmate, 'archive', () => []);
  t.mock.method(store.firstmate, 'receipts', () => ({ pending: [], handled: [] }));
  t.mock.method(store.firstmate, 'show', (id: string) => tasks.find(t => t.id === id)!);
  const handle = router(store);
  const dom = new JSDOM(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost:4317/', runScripts: 'outside-only' });
  const { window } = dom; const document = window.document;
  window.setInterval = (() => 0) as typeof window.setInterval;
  (window as any).fetch = async (input: string, init: RequestInit = {}) => handle(new Request(new URL(input, window.location.href), init));
  const until = async (check: () => unknown) => { for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(check()); };
  const rowIds = (section: string) => [...document.querySelectorAll(`#overview-${section} .row strong a`)].map(a => a.getAttribute('href')!.slice(1)).sort();
  try {
    window.eval(stripTypeScriptTypes(readFileSync(new URL('../web/app.ts', import.meta.url), 'utf8')));
    await until(() => document.querySelector('#overview-waiting'));
    assert.match(document.querySelector('#overview-waiting h2')!.textContent!, /^Ждёт 6$/);
    assert.deepEqual(rowIds('waiting'), ['ci', 'coordinator', 'dependency', 'held', 'human', 'ready']);
    assert.deepEqual(rowIds('working'), ['busy']); assert.deepEqual(rowIds('done'), ['closed']); assert.deepEqual(rowIds('next'), ['unknown']);
    assert.match(document.querySelector('#overview-waiting')!.textContent!, /Ответственный: Firstmate/);
    assert.match(document.querySelector('a[href="#held"]')!.closest('.row')!.textContent!, /Ждём поставщика.*Ответственный неизвестен/);
    assert.ok(document.querySelector('#overview-waiting [data-task-action="answer"]'), 'human answers remain available');
    assert.ok(document.querySelector('#overview-waiting [data-task-action="unhold"]'), 'held tasks can resume');
    assert.ok(document.querySelector('#overview-done [data-task-action="reopen"]'), 'closed tasks can return');
    assert.match(document.querySelector('a[href="#case:case"]')!.closest('.row')!.textContent!, /в работе 1 · ждёт 6 · дальше 1 · сделано 1/);
    const kind = document.getElementById('kind') as HTMLSelectElement;
    kind.value = 'scout'; kind.dispatchEvent(new window.Event('change'));
    assert.deepEqual(rowIds('waiting'), []);
    const resetKind = document.getElementById('kind') as HTMLSelectElement;
    resetKind.value = ''; resetKind.dispatchEvent(new window.Event('change'));
    (document.querySelector('#overview-waiting a[href="#coordinator"]') as HTMLAnchorElement).click();
    await until(() => document.querySelector('main h1')?.textContent === 'coordinator');
    assert.match(document.querySelector('.page-heading')!.textContent!, /Нужен разбор/);
    const response = await handle(new Request('http://localhost:4317/api/cases/case'));
    assert.equal(response.status, 200);
    const c = await response.json();
    assert.deepEqual(c.tasks.filter((t: any) => t.phase === 'waiting').map((t: any) => t.id).sort(), ['ci', 'coordinator', 'dependency', 'held', 'human', 'ready']);
    window.location.hash = 'case:case';
    await until(() => document.querySelector('[data-action="agent-case"]'));
    assert.match(document.querySelector('main')!.textContent!, /ждёт.*Нужен разбор/);
  } finally { window.close(); rmSync(root, { recursive: true, force: true }); }
});

test('browser app uses the real router for goal forms, the card and task actions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-ui-'));
  const store = new Store({ firstmateHome: firstmateHome(root) }); let handle = router(store);
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const source = stripTypeScriptTypes(readFileSync(new URL('../web/app.ts', import.meta.url), 'utf8'));
  const dom = new JSDOM(html, { url: 'http://localhost:4317/', runScripts: 'outside-only' });
  const { window } = dom;
  window.setInterval = (() => 0) as typeof window.setInterval;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {} } });
  let mutations = 0; let releaseRequest: (() => void) | undefined; let delayRequest = false; let failRequest = false;
  (window as any).fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input), window.location.href);
    if (init.method === 'POST' && /\/api\/tasks\//.test(url.pathname)) {
      mutations++;
      if (delayRequest) { delayRequest = false; await new Promise<void>(resolve => { releaseRequest = resolve; }); }
      if (failRequest) { failRequest = false; return Response.json({ error: 'Не удалось выполнить действие' }, { status: 400 }); }
    }
    const request = new Request(url, { ...init, headers: init.headers });
    return handle(request);
  };
  try {
    window.eval(source);
    const until = async (check: () => unknown) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 25)); assert.ok(check()); };
    await until(() => window.document.querySelector('main h1'));
    assert.equal(window.document.title, 'Дело — что происходит');
    assert.equal(window.document.getElementById('sidebar'), null);
    assert.deepEqual([...window.document.querySelectorAll('main h2')].map(h => h.firstChild?.textContent?.trim()), ['Ждёт', 'В работе', 'Дальше', 'Сделано']);
    const dialogOpen = () => (window.document.getElementById('dialog') as HTMLDialogElement).open;
    const product = join(root, 'product'); mkdirSync(product);
    window.document.getElementById('new-goal')?.click(); await until(dialogOpen);
    assert.equal(window.document.getElementById('dialog-title')?.textContent, 'Новая задача');
    assert.equal(window.document.querySelector('[name=repository]'), null, 'goal creation has no launch folder');
    assert.equal(window.document.querySelector('[name=areas]'), null);
    assert.equal(window.document.getElementById('inbox-button'), null);
    assert.deepEqual([...window.document.querySelectorAll('#dialog-body [name]')].map(e => e.getAttribute('name')), ['title', 'personal', 'caseId', 'kind', 'repo', 'folder', 'body', 'blockedBy', 'holdUntil']);
    (window.document.querySelector('[name=folder]') as HTMLInputElement).value = product;
    (window.document.querySelector('[name=title]') as HTMLInputElement).value = 'UI цель';
    (window.document.querySelector('[name=body]') as HTMLTextAreaElement).value = 'Описание из формы';
    (window.document.querySelector('[name=personal]') as HTMLInputElement).checked = true;
    (window.document.getElementById('dialog-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => store.list().length);
    const goal = store.list()[0]; assert.equal(goal.title, 'UI цель');
    assert.equal(goal.body, `Папка: ${product}\nОписание из формы\nЛичное`);
    window.location.hash = goal.id; await until(() => window.document.querySelector('.page-heading [data-action="edit"]'));
    assert.deepEqual([...window.document.querySelectorAll('[data-task-action]')].map(b => b.textContent), ['Взять в работу', 'Пауза', 'Закрыть', 'Отказ']);
    assert.equal(window.document.getElementById('goal-state'), null, 'buttons replace the state selector');
    (window.document.querySelector('.page-heading [data-action="edit"]') as HTMLButtonElement).click(); await until(dialogOpen);
    assert.equal((window.document.querySelector('[name=body]') as HTMLTextAreaElement).value, 'Описание из формы', 'the personal and folder lines are fields, not text');
    assert.equal((window.document.querySelector('[name=folder]') as HTMLInputElement).value, product);
    assert.deepEqual([...window.document.querySelectorAll('#folder-list option')].map(o => o.getAttribute('value')), [product], 'backlog folders are suggested');
    (window.document.querySelector('[name=folder]') as HTMLInputElement).value = 'relative/path';
    (window.document.getElementById('dialog-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => window.document.getElementById('dialog-error')?.textContent);
    assert.match(window.document.getElementById('dialog-error')?.textContent ?? '', /^Папка: нужен абсолютный путь или ~\/…/);
    assert.equal(store.get(goal.id).folder, product, 'a refused folder changes nothing');
    (window.document.querySelector('[name=folder]') as HTMLInputElement).value = '';
    assert.equal((window.document.querySelector('[name=personal]') as HTMLInputElement).checked, true);
    (window.document.querySelector('[name=body]') as HTMLTextAreaElement).value = 'Правка из карточки';
    (window.document.querySelector('[name=personal]') as HTMLInputElement).checked = false;
    handle = router(store); // The shared helper also recovers PATCH requests after a restart.
    (window.document.getElementById('dialog-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => store.get(goal.id).body === 'Правка из карточки');
    assert.equal(window.document.querySelector('[data-action="launch"]'), null, 'a goal has no own agent launch');
    assert.equal(window.document.querySelector('[data-action="brief"]'), null);
    for (const action of ['cover', 'link', 'report', 'knowledge', 'tracker']) assert.equal(window.document.querySelector(`[data-action="${action}"]`), null, action);
    assert.equal(window.document.getElementById('search-form'), null);
    assert.deepEqual([...window.document.querySelectorAll('main h2')].map(h => h.textContent), ['Ссылки', 'Бриф']);
    const nativeId = goal.id;
    store.update(goal.id, { personal: true });
    window.location.hash = ''; await until(() => window.document.querySelector(`[data-action="pin"][data-id="${nativeId}"]`));
    (window.document.querySelector('[data-action="refresh"]') as HTMLButtonElement).click();
    await until(() => /личное/.test(window.document.querySelector(`[data-id="${nativeId}"]`)?.closest('.row')?.textContent ?? ''));
    assert.match(window.document.querySelector(`[data-id="${nativeId}"]`)?.closest('.row')?.textContent ?? '', /личное/);
    assert.ok([...(window.document.getElementById('kind') as HTMLSelectElement).options].some(o => o.textContent === 'Личное'));
    (window.document.querySelector(`[data-action="pin"][data-id="${nativeId}"]`) as HTMLButtonElement).click();
    const focus = () => window.document.getElementById('overview-focus');
    await until(() => focus()?.querySelector('h2')?.textContent?.includes('1'));
    assert.match(focus()?.textContent ?? '', /UI цель/, 'a pinned row shows in focus');
    assert.equal(window.location.hash, '', 'the pin button does not open the task');
    const taskButtons = () => [...window.document.querySelectorAll(`[data-task-action][data-id="${nativeId}"]`)] as HTMLButtonElement[];
    assert.deepEqual([...focus()!.querySelectorAll('[data-task-action]')].map(b => b.getAttribute('data-task-action')), ['start', 'pause', 'close', 'decline']);
    assert.match(focus()?.textContent ?? '', /В очереди/);
    const beforeStart = mutations;
    delayRequest = true;
    const startButtons = taskButtons().filter(b => b.dataset.taskAction === 'start');
    startButtons[0].click(); startButtons[1].click();
    assert.equal(mutations, beforeStart + 1, 'duplicate focus/overview controls send one command while pending');
    assert.ok(taskButtons().every(b => b.disabled), 'all controls for the task are disabled');
    assert.match(focus()?.textContent ?? '', /Выполняется/);
    releaseRequest!();
    await until(() => taskButtons().length && taskButtons().every(b => !b.disabled));
    assert.equal(window.location.hash, '', 'list action does not navigate');
    await until(() => focus()?.textContent?.includes('Запуск запрошен'));
    assert.equal(taskButtons().some(b => b.dataset.taskAction === 'start'), false);
    assert.equal(store.inbox(nativeId).requests.length, 1, 'start reuses the existing request path');
    failRequest = true;
    taskButtons().find(b => b.dataset.taskAction === 'pause')!.click();
    await until(() => window.document.getElementById('message')?.textContent === 'Не удалось выполнить действие');
    assert.ok(taskButtons().every(b => !b.disabled), 'failure restores the buttons for retry');
    taskButtons().find(b => b.dataset.taskAction === 'pause')!.click();
    await until(() => taskButtons().some(b => !b.disabled && b.dataset.taskAction === 'unhold'));
    assert.match(focus()?.textContent ?? '', /На паузе/);
    const confirm = () => (window.document.getElementById('dialog-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    for (const paused of [true, false]) {
      if (!paused) {
        taskButtons().find(b => b.dataset.taskAction === 'unhold')!.click();
        await until(() => taskButtons().some(b => !b.disabled && b.dataset.taskAction === 'pause'));
      }
      const before = mutations;
      taskButtons().find(b => b.dataset.taskAction === 'close')!.click();
      assert.equal(window.location.hash, '', 'closure is available directly from the list');
      assert.match(window.document.getElementById('dialog-body')!.textContent!, /UI цель.*Сделано.*Вернуть/);
      assert.equal(mutations, before, 'confirmation does not mutate');
      window.document.getElementById('dialog-cancel')!.click();
      assert.equal(dialogOpen(), false);
      assert.equal(store.firstmate.show(nativeId).state, 'queued');
      assert.equal(store.get(nativeId).state, paused ? 'paused' : 'active');
      taskButtons().find(b => b.dataset.taskAction === 'close')!.click();
      confirm(); confirm();
      await until(() => taskButtons().some(b => !b.disabled && b.dataset.taskAction === 'reopen') && window.document.querySelector('#message button'));
      assert.equal(mutations, before + 1, 'double confirmation closes once');
      const undo = window.document.querySelector('#message button') as HTMLButtonElement;
      assert.equal(undo.textContent, 'Вернуть');
      undo.click();
      await until(() => taskButtons().some(b => !b.disabled && b.dataset.taskAction === (paused ? 'unhold' : 'pause')));
      assert.equal(store.firstmate.show(nativeId).state, 'queued');
      assert.equal(store.firstmate.show(nativeId).held, paused ? 'yes' : 'no', 'undo preserves the existing parked hold');
    }
    taskButtons().find(b => b.dataset.taskAction === 'pause')!.click();
    await until(() => taskButtons().some(b => !b.disabled && b.dataset.taskAction === 'unhold'));

    taskButtons().find(b => b.dataset.taskAction === 'unhold')!.click();
    await until(() => taskButtons().some(b => !b.disabled && b.dataset.taskAction === 'pause'));
    assert.equal((window.document.querySelector(`main section a[href="#${nativeId}"]`) as HTMLAnchorElement | null)?.textContent, 'UI цель', 'a row opens the goal card');
    (window.document.querySelector(`main section a[href="#${nativeId}"]`)?.closest('.row')?.querySelector('small') as HTMLElement).click();
    await until(() => window.location.hash === `#${nativeId}`);
    const buttons = async (hash: string) => { window.location.hash = hash; window.dispatchEvent(new window.HashChangeEvent('hashchange')); await until(() => window.document.querySelector('.page-heading .eyebrow')?.textContent?.includes(`· ${hash} ·`)); return [...window.document.querySelectorAll('[data-task-action]')].map(b => b.getAttribute('data-task-action')); };
    const env = { ...process.env }; for (const name of Object.keys(env)) if (name.startsWith('FM_')) delete env[name]; env.FM_HOME = store.firstmate.home;
    run(join(store.firstmate.home, 'bin', 'fm-captain-hold.sh'), ['hold', 'ui-call', '--title', 'Вопрос капитану', '--reason', 'Нужен выбор'], store.firstmate.home, 45000, env);
    assert.deepEqual(await buttons('ui-call'), ['answer', 'later', 'close']);
    (window.document.querySelector('[data-task-action="answer"]') as HTMLButtonElement).click();
    (window.document.querySelector('[name=answer]') as HTMLInputElement).value = 'Ответ из карточки';
    (window.document.getElementById('dialog-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => store.firstmate.show('ui-call').state === 'done');
    assert.match(readFileSync(join(store.firstmate.home, 'data', 'backlog.md'), 'utf8'), /Ответ из карточки/);
    const obsolete = store.create({ title: 'Неактуальная задача' }).id;
    run(join(store.firstmate.home, 'bin', 'fm-captain-hold.sh'), ['hold', obsolete, '--reason', 'Нужно решение'], store.firstmate.home, 45000, env);
    const beforeView = mutations;
    assert.deepEqual(await buttons(obsolete), ['release', 'later', 'close']);
    assert.equal(mutations, beforeView, 'opening a held task never requests an action');
    assert.equal(window.document.querySelector('[data-task-action="close"]')?.textContent, 'Закрыть как неактуальную');
    (window.document.querySelector('[data-task-action="close"]') as HTMLButtonElement).click();
    assert.equal(mutations, beforeView, 'opening confirmation does not close the task');
    assert.equal(store.firstmate.show(obsolete).state, 'queued');
    assert.equal(window.document.getElementById('dialog-submit')?.textContent, 'Закрыть как неактуальную');
    const dismiss = window.document.getElementById('dialog-close') as HTMLButtonElement;
    assert.equal(dismiss.textContent, '×', 'the modal uses an icon to dismiss, distinct from closing the task');
    assert.equal(dismiss.getAttribute('aria-label'), 'Закрыть диалог');
    assert.equal(dismiss.type, 'button', 'dismiss never submits the confirmation');
    assert.equal((window.document.getElementById('dialog-submit') as HTMLButtonElement).disabled, false, 'confirmation is enabled before submission');
    window.document.getElementById('dialog-close')!.click();
    assert.equal(store.firstmate.show(obsolete).state, 'queued', 'cancelling confirmation preserves the hold');
    window.location.hash = '';
    await until(() => window.document.querySelector(`[data-task-action="close"][data-id="${obsolete}"]`));
    (window.document.querySelector(`[data-task-action="close"][data-id="${obsolete}"]`) as HTMLButtonElement).click();
    assert.equal(window.location.hash, '', 'held-close button on the waiting row does not navigate');
    failRequest = true;
    (window.document.getElementById('dialog-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => window.document.getElementById('dialog-error')?.textContent === 'Не удалось выполнить действие');
    assert.equal(store.firstmate.show(obsolete).state, 'queued', 'failed confirmation leaves work held');
    delayRequest = true;
    const submit = () => (window.document.getElementById('dialog-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    submit(); submit();
    assert.equal(mutations, beforeView + 2, 'one failed request and one retry; repeated form submission sends one command');
    releaseRequest!();
    await until(() => !(window.document.getElementById('dialog') as HTMLDialogElement).open);
    assert.equal(store.firstmate.show(obsolete).state, 'done');
    assert.match(store.firstmate.show(obsolete).body, /Answer: Закрыть как неактуальную/);
    store.firstmate.start(nativeId);
    assert.deepEqual(await buttons(goal.id), ['stop', 'close'], 'an In flight row is closed by a note for firstmate');
    for (const action of ['stop', 'close']) {
      const before = mutations;
      const button = () => window.document.querySelector(`[data-task-action="${action}"]`) as HTMLButtonElement;
      button().click();
      assert.match(window.document.getElementById('dialog-body')!.textContent!, /UI цель/);
      if (action === 'stop') assert.match(window.document.getElementById('dialog-body')!.textContent!, /сохранить сделанное.*оставить задачу открытой.*не немедленная остановка/);
      window.document.getElementById('dialog-cancel')!.click();
      assert.equal(mutations, before);
      button().click(); delayRequest = true; confirm(); confirm();
      assert.equal(mutations, before + 1);
      releaseRequest!();
      await until(() => !dialogOpen());
      assert.equal(store.firstmate.show(nativeId).state, 'in_flight');
      assert.match(window.document.getElementById('message')!.textContent!, /просьба.*сохранена/i);
      await until(() => !button());
      assert.match(window.document.querySelector('main')!.textContent!, action === 'stop' ? /Остановка запрошена/ : /Закрытие запрошено/);
      assert.equal(store.inbox(nativeId).requests.filter(r => r.requestId.startsWith(`delo-${action}-${nativeId}-`)).length, 1);
    }

    run(join(store.firstmate.home, 'bin', 'fm-captain-hold.sh'), ['hold', nativeId, '--reason', 'Какой вариант брать?\nA или B'], store.firstmate.home, 45000, env);
    // The card reloads asynchronously on the same hash, so wait for the new state before reading its buttons.
    const asking = () => /В работе · ждёт ответа/.test(window.document.querySelector('.page-heading .eyebrow')?.textContent ?? '');
    const shown = () => [...window.document.querySelectorAll('[data-task-action]')].map(b => b.getAttribute('data-task-action'));
    await buttons(goal.id); await until(asking);
    assert.deepEqual(shown(), ['answer'], 'the answer remains available while existing stop/close requests stay pending');
    assert.match(window.document.querySelector('main')!.textContent!, /Остановка запрошена/);
    assert.match(window.document.querySelector('main')!.textContent!, /Закрытие запрошено/);
    (window.document.querySelector('[data-task-action="answer"]') as HTMLButtonElement).click();
    assert.equal(window.document.getElementById('answer-question')?.textContent, 'Какой вариант брать?\nA или B', 'the dialog shows the whole question');
    const reply = window.document.querySelector('[name=answer]') as HTMLTextAreaElement;
    assert.equal(reply.tagName, 'TEXTAREA');
    reply.value = 'Выбираю A\nпотому что быстрее';
    (window.document.getElementById('dialog-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => store.firstmate.show(nativeId).held === 'no');
    assert.equal(store.firstmate.show(nativeId).state, 'in_flight');
    assert.match(store.firstmate.show(nativeId).body ?? '', /Answer: Выбираю A \/ потому что быстрее/);
    await until(() => !dialogOpen());
    await buttons(goal.id); await until(() => !asking());
    assert.deepEqual(shown(), [], 'answering leaves pending stop/close receipts intact');
    window.document.getElementById('new-case')?.click();
    assert.deepEqual([...window.document.querySelectorAll('#dialog-body [name]')].map(e => e.getAttribute('name')), ['title', 'reviewKind', 'reviewRepo', 'folder', 'sources', 'why', 'doneWhen', 'context', 'constraints']);
    (window.document.querySelector('[name=title]') as HTMLInputElement).value = 'UI дело';
    (window.document.querySelector('[name=why]') as HTMLTextAreaElement).value = 'Собрать задачи';
    (window.document.getElementById('dialog-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => window.document.querySelector('main h1')?.textContent === 'UI дело');
    const caseId = decodeURIComponent(window.location.hash.slice('#case:'.length));
    assert.deepEqual([store.firstmate.show(caseId).kind, store.firstmate.show(caseId).state, store.getCase(caseId).why], ['program', 'in_flight', 'Собрать задачи']);
    const member = store.create({ title: 'Задача дела', caseId }).id;
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await until(() => window.document.querySelector(`[data-task-action="close"][data-id="${member}"]`));
    const caseHash = window.location.hash;
    (window.document.querySelector(`[data-task-action="close"][data-id="${member}"]`) as HTMLButtonElement).click();
    (window.document.getElementById('dialog-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => window.document.querySelector(`[data-task-action="reopen"][data-id="${member}"]:not(:disabled)`));
    assert.equal(window.location.hash, caseHash, 'a case list action keeps the case page open');
    (window.document.querySelector(`[data-task-action="reopen"][data-id="${member}"]`) as HTMLButtonElement).click();
    await until(() => window.document.querySelector(`[data-task-action="start"][data-id="${member}"]:not(:disabled)`));
    assert.equal(store.firstmate.show(member).state, 'queued');
    (window.document.querySelector(`[data-task-action="decline"][data-id="${member}"]`) as HTMLButtonElement).click();
    assert.equal(window.document.getElementById('dialog-title')?.textContent, 'Отказ');
    assert.equal(window.location.hash, caseHash, 'an action with arguments opens its modal without navigating');
    (window.document.querySelector('[name=reason]') as HTMLInputElement).value = 'Больше не нужна';
    submit();
    await until(() => !(window.document.getElementById('dialog') as HTMLDialogElement).open);
    assert.match(store.firstmate.show(member).body, /Отказ: Больше не нужна/);
    window.location.hash = ''; await until(() => window.document.querySelector(`main a[href="#case:${caseId}"]`));
    window.document.getElementById('new-goal')?.click(); await until(dialogOpen);
    assert.deepEqual([...window.document.querySelectorAll('[name=caseId] option')].map(o => o.textContent), ['Без дела', 'UI дело'], '«Новая задача» offers the open дела');
  } finally {
    dom.window.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('«Новый агент» appears only on an open дело, defaults its form, switches an interactive run to codex, and the task page shows the running executor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-ui-agent-'));
  const store = new Store({ firstmateHome: firstmateHome(root) }); const handle = router(store);
  const dom = new JSDOM(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost:4317/', runScripts: 'outside-only' });
  const { window } = dom; const document = window.document;
  window.setInterval = (() => 0) as typeof window.setInterval;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  (window as any).fetch = async (input: string, init: RequestInit = {}) => handle(new Request(new URL(String(input), window.location.href), init));
  const until = async (check: () => unknown) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 25)); assert.ok(check()); };
  const open = async (hash: string, ready: () => unknown) => { window.location.hash = hash; await until(ready); };
  const input = (name: string) => document.querySelector(`#dialog-body [name=${name}]`) as HTMLInputElement;
  try {
    window.eval(stripTypeScriptTypes(readFileSync(new URL('../web/app.ts', import.meta.url), 'utf8')));
    await until(() => document.querySelector('main h1'));
    const folder = join(root, 'product'); mkdirSync(folder);
    const c = store.createCase({ title: 'Дело с агентом', why: 'Причина', doneWhen: 'Готово', context: '', constraints: '', sources: '' });
    store.update(c.id, { folder });

    await open(`case:${c.id}`, () => document.querySelector('[data-action="agent-case"]'));
    (document.querySelector('[data-action="agent-case"]') as HTMLButtonElement).click();
    await until(() => input('direction'));
    assert.equal(input('direction').value, 'Разбери текущее дело по ориентировке и прикреплённым материалам. Прочитай источники, необходимые для понимания задания. Если задание понятно, приступай к работе. Если сведений недостаточно, задай уточняющий вопрос.');
    assert.deepEqual([input('kind').value, input('harness').value, input('folder').value], ['scout', '', folder]);
    assert.deepEqual([...document.querySelectorAll('#dialog-body [name=harness] option')].map(o => o.textContent), ['как решит firstmate', 'claude', 'codex', 'opencode', 'pi', 'grok', 'kimi', 'gemini', 'agy']);
    assert.equal((document.getElementById('agent-repo') as HTMLElement).hidden, false, 'Проект is visible for research as well as edits');
    input('kind').value = 'ship'; input('kind').dispatchEvent(new window.Event('change'));
    assert.equal((document.getElementById('agent-repo') as HTMLElement).style.display, '');
    input('kind').value = 'scout'; input('kind').dispatchEvent(new window.Event('change'));
    input('interactive').checked = true; input('interactive').dispatchEvent(new window.Event('change'));
    assert.equal(input('harness').value, 'codex');
    document.getElementById('dialog-form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => /Новый агент: задача/.test(document.querySelector('.message')?.textContent ?? ''));
    const task = store.getCase(c.id).tasks[0]!;
    assert.match(document.querySelector('.message')!.textContent!, new RegExp(`задача ${task.id}\\. Firstmate сейчас занят; просьба сохранена`));
    assert.equal(store.firstmate.show(task.id).body, `Дело: ${c.id}\nИсполнитель: codex\nИнтерактивно\nПапка: ${folder}\n\n${input('direction').value}`);

    mkdirSync(join(store.firstmate.home, 'state'), { recursive: true });
    writeFileSync(join(store.firstmate.home, 'state', `${task.id}.meta`), 'harness=claude\nkind=scout\n');
    await open(task.id, () => document.getElementById('executor'));
    assert.equal(document.getElementById('executor')!.textContent, 'Исполнитель: codex · работает: claude');

    store.closeCase(c.id, { confirmed: [task.id] });
    await open(`case:${c.id}`, () => document.querySelector('[data-action="reopen-case"]'));
    assert.equal(document.querySelector('[data-action="agent-case"]'), null, 'a closed дело has no «Новый агент»');
  } finally { window.close(); rmSync(root, { recursive: true, force: true }); }
});

test('overview rows explain dependencies and holds, link fleet PRs, and hide blocked quick starts', async () => {
  const { overview } = await import('../src/overview.ts');
  const reason = 'Ждём согласования условий возврата. '.repeat(15);
  const records = [
    { id: 'rr-refund-q2', title: 'Согласовать возвраты', state: 'queued', kind: 'ship' },
    { id: 'rr-refund-q3', title: 'Внедрить возвраты', state: 'queued', kind: 'ship', priority: '0', hold_reason: reason, blocked_by: 'rr-refund-q2', unresolved_blocker_ids: ['rr-refund-q2'] },
    ...['busy', 'check', 'ask', 'unknown', 'orphan'].map(id => ({ id, title: id, state: 'in_flight', kind: 'ship' })),
  ];
  const view = overview({ generated: '2026-10-20T12:00:00Z', gates: [{ id: 'rr-refund-q3', reason: 'Ждём…' }, { id: '(main-inventory)', title: 'in-flight backlog item has no child metadata', reason: 'main inventory' }], in_flight: ['busy', 'check', 'ask', 'unknown'].map(id => ({ id })) }, {
    backlog: { records }, main_inventory: { orphan_in_flight: ['orphan'] }, tasks: [
      { id: 'busy', current_state: { state: 'working', detail: 'harness busy (claude-hook)' } },
      { id: 'check', current_state: { state: 'working', detail: 'validating (running) · run: 123' }, pr: { url: 'https://example.org/pull/2' } },
      { id: 'ask', current_state: { state: 'parked', detail: 'waiting' }, hints: { pending_decision: true } },
      { id: 'unknown', current_state: { state: 'unknown', detail: 'harness state unavailable' }, hints: { pending_decision: true } },
    ],
  });
  const dom = new JSDOM(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost:4317/', runScripts: 'outside-only' });
  const { window } = dom; const document = window.document;
  window.setInterval = (() => 0) as typeof window.setInterval;
  (window as any).fetch = async (input: string) => Response.json(input === '/api/meta' ? { csrf: 'synthetic' } : view);
  try {
    window.eval(stripTypeScriptTypes(readFileSync(new URL('../web/app.ts', import.meta.url), 'utf8')));
    for (let i = 0; i < 100 && !document.querySelector('.row'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    const blocked = [...document.querySelectorAll('.row')].filter(r => r.querySelector('strong a')?.getAttribute('href') === '#rr-refund-q3');
    assert.equal(blocked.length, 2, 'the same explanation and action policy applies in focus');
    for (const row of blocked) {
      assert.ok(row.textContent?.includes(reason));
      const dependency = row.querySelector('small a[href="#rr-refund-q2"]');
      assert.equal(dependency?.textContent, 'Согласовать возвраты');
      assert.ok(row.textContent?.includes('Ждёт:'));
      assert.equal(row.querySelector('[data-task-action="start"]'), null);
    }
    const text = document.querySelector('main')?.textContent ?? '';
    for (const state of ['Работает', 'Идёт проверка', 'Вопрос исполнителя', 'Состояние неизвестно', 'Нет исполнителя']) assert.ok(text.includes(state), state);
    assert.doesNotMatch(text, /harness|claude-hook|run:|in-flight backlog|main.inventory|validating/);
    const pr = document.querySelector('a[href="https://example.org/pull/2"]');
    assert.equal(pr?.textContent, 'PR');
    assert.equal(pr?.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(document.querySelector('[data-task-action="start"][data-id="rr-refund-q3"]'), null);
  } finally { window.close(); }
});

test('a deep link renders its card before overview and unchanged refresh preserves DOM and focus', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-refresh-ui-'));
  const store = new Store({ firstmateHome: firstmateHome(root) });
  const goal = store.create({ title: 'Карточка без ожидания', body: '## Зачем\nПричина\n## Критерий готовности\nГотово\n## Контекст\nКонтекст\n## Ограничения\n- Сохранить' });
  const handle = router(store);
  const dom = new JSDOM(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), { url: `http://localhost:4317/#${goal.id}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  let tick: () => Promise<void> = async () => {};
  window.setInterval = (fn: () => Promise<void>) => { tick = fn; return 0; };
  let release: () => void = () => {};
  let gate = new Promise<void>(resolve => { release = resolve; });
  const paths: string[] = []; let failOverview = true;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  let holdCard = false; let releaseCard = () => {};
  const cardGate = new Promise<void>(resolve => { releaseCard = resolve; });
  window.fetch = async (path: string, init: RequestInit) => {
    paths.push(path);
    if (path === '/api/overview') { await gate; if (failOverview) { failOverview = false; return Response.json({ error: 'Обзор недоступен' }, { status: 400 }); } return Response.json({ generated: String(paths.length), cases: [], focus: [], waiting: [], working: [], next: [], done: [], kinds: [], repos: [] }); }
    if (holdCard && path.startsWith('/api/goals/') && !init.body) await cardGate;
    return handle(new Request(new URL(path, window.location.href), init));
  };
  const until = async (check: () => unknown) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(check()); };
  try {
    window.eval(stripTypeScriptTypes(readFileSync(new URL('../web/app.ts', import.meta.url), 'utf8')));
    await until(() => window.document.querySelector('main h1')?.textContent === goal.title);
    await until(() => paths.includes('/api/overview'));
    assert.ok(paths.indexOf(`/api/goals/${goal.id}`) < paths.indexOf('/api/overview'));
    release(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(window.document.querySelector('main h1')?.textContent, goal.title, 'failure of the background overview keeps the loaded card');
    const details = window.document.querySelector('main details'); details.open = true;
    const button = window.document.querySelector('main [data-action="edit"]'); button.focus();
    const main = window.document.querySelector('main'); main.scrollTop = 123;
    await tick();
    assert.equal(window.document.querySelector('main [data-action="edit"]'), button);
    assert.equal(window.document.activeElement, button);
    assert.equal(details.open, true);
    assert.equal(main.scrollTop, 123);
    gate = new Promise<void>(resolve => { release = resolve; });
    button.click(); await until(() => window.document.getElementById('dialog').open);
    window.document.querySelector('[name=title]').value = 'Сохранено до обзора';
    window.document.getElementById('dialog-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => !window.document.getElementById('dialog').open);
    await until(() => window.document.querySelector('main h1')?.textContent === 'Сохранено до обзора');
    assert.equal(store.get(goal.id).title, 'Сохранено до обзора', 'an accepted edit finishes while overview is gated');
    release(); await new Promise(resolve => setTimeout(resolve, 20));
    window.location.hash = ''; await until(() => window.document.getElementById('kind'));
    const filter = window.document.getElementById('kind'); filter.focus();
    await tick();
    assert.equal(window.document.getElementById('kind'), filter, 'generated timestamp alone does not rebuild the overview');
    assert.equal(window.document.activeElement, filter);
    holdCard = true;
    const before = paths.filter(p => p === `/api/goals/${goal.id}`).length;
    window.location.hash = goal.id;
    await until(() => paths.filter(p => p === `/api/goals/${goal.id}`).length > before);
    window.location.hash = ''; await until(() => window.document.getElementById('kind'));
    releaseCard(); await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(window.document.getElementById('kind'), filter, 'a late card response cannot replace the overview after navigating back');
  } finally { release(); releaseCard(); window.close(); rmSync(root, { recursive: true, force: true }); }
});

test('task cards expose full status, blockers, PR/report and native prose while preserving managed briefs and edit bodies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-ui-card-'));
  const store = new Store({ firstmateHome: firstmateHome(root) });
  const blocker = store.create({ title: 'Согласовать условия' });
  const body = 'Обычный текст задачи\n\n## Свой раздел\nПроверить <условия> и сохранить весь текст.';
  const goal = store.create({ title: 'Карточка с причиной', body, blockedBy: blocker.id });
  const reason = 'Нужны полные условия согласования. '.repeat(20).trim();
  store.firstmate.hold(goal.id, reason);
  const env = { ...process.env, FM_HOME: store.firstmate.home };
  run(join(store.firstmate.home, 'bin', 'fm-tasks-axi.sh'), ['update', goal.id, '--report', `data/${goal.id}/report.md`], store.firstmate.home, 45000, env);
  const title = store.get(goal.id).title;
  const managed = store.create({ title: 'Управляемый бриф', body: '## Зачем\nПричина\n## Критерий готовности\nГотово\n## Контекст\nКонтекст\n## Ограничения\n- Не терять' });
  // Reconciled fleet fields are synthetic; every backlog operation uses the scratch home.
  let worker: any = { id: goal.id, harness: 'codex', current_state: { state: 'working', source: 'run-step', detail: 'validating (running) · run: 123' }, pr: { url: 'https://example.org/pull/6' } };
  store.firstmate.snapshot = async script => script === 'fm-fleet-snapshot.sh' ? { tasks: [worker], backlog: { records: store.firstmate.list() } } : { generated: '2026-10-20T12:00:00Z' };
  const handle = router(store);
  const dom = new JSDOM(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), { url: `http://localhost:4317/#${goal.id}`, runScripts: 'outside-only' });
  const { window } = dom; const document = window.document;
  window.setInterval = (() => 0) as typeof window.setInterval;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  (window as any).fetch = async (input: string, init: RequestInit = {}) => handle(new Request(new URL(String(input), window.location.href), init));
  const until = async (check: () => unknown) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 25)); assert.ok(check()); };
  const submit = () => document.getElementById('dialog-form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  try {
    window.eval(stripTypeScriptTypes(readFileSync(new URL('../web/app.ts', import.meta.url), 'utf8')));
    await until(() => document.querySelector('main h1')?.textContent === title);
    const heading = () => document.querySelector('.page-heading')!;
    assert.ok(heading().textContent?.includes(reason), 'full pause reason is visible below the title');
    assert.equal(heading().querySelector(`a[href="#${blocker.id}"]`)?.textContent, blocker.title);
    assert.equal(heading().querySelector('a[href="https://example.org/pull/6"]')?.textContent, 'PR');
    assert.equal(heading().querySelector(`a[href="#report:${goal.id}"]`)?.textContent, 'Отчёт');
    assert.equal(document.querySelector('.brief-box')?.textContent, body);
    assert.equal(document.querySelector('.brief-box')?.closest('details'), null, 'native prose is immediately open');
    assert.doesNotMatch(document.querySelector('main')!.textContent!, /пока не записано/);
    assert.equal(document.querySelector('.brief-box условия'), null, 'native prose is escaped');
    (document.querySelector('[data-action="edit"]') as HTMLButtonElement).click();
    await until(() => document.querySelector('#dialog-body [name=body]'));
    assert.equal(document.getElementById('dialog-title')?.textContent, 'Править задачу');
    assert.equal((document.querySelector('[name=body]') as HTMLTextAreaElement).value, body);
    submit(); await until(() => !(document.getElementById('dialog') as HTMLDialogElement).open);
    assert.equal(store.firstmate.show(goal.id).body, body, 'saving an unchanged form preserves the raw body');

    store.firstmate.unhold(goal.id); store.firstmate.start(goal.id);
    worker = { ...worker, current_state: { state: 'needs-decision', detail: 'Какой из вариантов выбрать?\nA: сохранить\nB: заменить' } };
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await until(() => heading().textContent?.includes('Вопрос исполнителя'));
    assert.ok(heading().textContent?.includes(worker.current_state.detail), 'the full worker question is open');
    assert.equal(store.firstmate.show(goal.id).body, body, 'read-only status rendering preserves the backlog body');

    store.firstmate.snapshot = async script => script === 'fm-fleet-snapshot.sh' ? { tasks: [{ id: goal.id, current_state: { state: 'working', source: 'run-step' } }], backlog: { records: [] } } : { generated: '2026-10-20T12:00:00Z' };
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await until(() => heading().textContent?.includes('Идёт проверка'));
    window.location.hash = managed.id;
    await until(() => document.querySelector('main h1')?.textContent === managed.title);
    assert.deepEqual([...document.querySelectorAll('details dd')].map(e => e.textContent), ['Причина', 'Готово', 'Контекст', 'Не терять']);
    assert.equal(store.get(managed.id).managedBrief, true);
    assert.equal(store.get(goal.id).managedBrief, false);
  } finally { window.close(); rmSync(root, { recursive: true, force: true }); }
});


test('request feedback shows pending and accepted without claiming execution or exposing technical IDs', async t => {
  const root = mkdtempSync(join(tmpdir(), 'delo-ui-receipts-'));
  const store = new Store({ firstmateHome: firstmateHome(root) });
  const task = store.create({ title: 'Синтетическая просьба' });
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  store.firstmate.snapshot = async () => {
    const records = store.firstmate.list();
    return { gates: records.filter(r => r.state === 'queued').map(r => ({ id: r.id })), in_flight: records.filter(r => r.state === 'in_flight').map(r => ({ id: r.id })), backlog: { records } };
  };
  const handle = router(store);
  const dom = new JSDOM(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost:4317/', runScripts: 'outside-only' });
  const { window } = dom; const document = window.document;
  window.setInterval = (() => 0) as typeof window.setInterval;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  (window as any).fetch = async (input: string, init: RequestInit = {}) => handle(new Request(new URL(input, window.location.href), init));
  const until = async (check: () => unknown) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 25)); assert.ok(check()); };
  const text = () => document.querySelector('main')?.textContent ?? '';
  const control = () => document.querySelector(`[data-task-action="start"][data-id="${task.id}"]:not([data-task-attempt])`) as HTMLButtonElement | null;
  try {
    window.eval(stripTypeScriptTypes(readFileSync(new URL('../web/app.ts', import.meta.url), 'utf8')));
    await until(control); control()!.click();
    await until(() => text().includes('Запуск запрошен'));
    assert.equal(control(), null);
    assert.match(text(), /В очереди/);
    assert.doesNotMatch(document.getElementById('message')!.textContent!, /delo-start-|can_receive|posture/);
    const note = store.firstmate.receipts().pending[0];
    run(join(store.firstmate.home, 'bin', 'fm-inbox.sh'), ['drain', '--ack', note.id], store.firstmate.home, 45000, { ...process.env, FM_HOME: store.firstmate.home });
    now += 2001; (document.querySelector('[data-action="refresh"]') as HTMLButtonElement).click();
    await until(() => text().includes('Запуск принят'));
    assert.equal(control(), null); assert.match(text(), /В очереди/);
    assert.equal(store.firstmate.show(task.id).state, 'queued');
    window.location.hash = task.id;
    await until(() => document.querySelector('main h1')?.textContent === task.title);
    assert.equal(control(), null); assert.match(text(), /Запуск принят/);
    const technical = [...document.querySelectorAll('details')].find(e => e.querySelector('summary')?.textContent === 'Технические детали просьб');
    assert.ok(technical); assert.equal(technical.open, false);
    assert.match(technical.textContent!, /delo-start-/);
    assert.doesNotMatch(text().replace(technical.textContent!, ''), /delo-start-|can_receive|posture/);
    const retry = () => document.querySelector('[data-task-attempt="2"]') as HTMLButtonElement | null;
    await until(() => retry() && !retry()!.disabled);
    assert.match(retry()!.textContent!, /Повторить просьбу о запуске/);
    retry()!.click(); document.getElementById('dialog-cancel')!.click();
    assert.equal(store.firstmate.receipts().pending.length, 0, 'cancel sends no new request');
    retry()!.click();
    const submit = () => document.getElementById('dialog-form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    submit(); submit();
    await until(() => text().includes('Запуск запрошен') && !(document.getElementById('dialog') as HTMLDialogElement).open);
    assert.equal(retry(), null, 'a pending retry cannot itself be retried');
    assert.equal(store.firstmate.receipts().pending.length, 1, 'double confirmation produces one new note');
    assert.equal(store.firstmate.receipts().pending[0].request_id, `delo-start-${task.id}-2`);

  } finally { dom.window.close(); rmSync(root, { recursive: true, force: true }); }
});

test('an open case form survives a server restart and refreshes its token once', async () => {
  for (const host of ['localhost', '127.0.0.1']) {
    const root = mkdtempSync(join(tmpdir(), 'delo-ui-restart-'));
    const store = new Store({ firstmateHome: firstmateHome(root) });
    let handle = router(store);
    const dom = new JSDOM(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), { url: `http://${host}:4317/`, runScripts: 'outside-only' });
    const { window } = dom; const document = window.document;
    window.setInterval = (() => 0) as typeof window.setInterval;
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    const requests: { path: string; status: number }[] = [];
    let unavailableMeta = false; let restartOnRefresh = false; let foreign = false; let failure = '';
    (window as any).fetch = async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, window.location.href); const headers = new Headers(init.headers);
      if (init.method !== 'GET') headers.set('origin', foreign ? 'https://evil.example' : url.origin);
      if (url.pathname === '/api/meta' && unavailableMeta) throw new Error('offline');
      if (url.pathname === '/api/cases' && init.method === 'POST' && failure) {
        requests.push({ path: url.pathname, status: 500 });
        if (failure === 'network') throw new Error('offline');
        return Response.json({ error: 'Не удалось сохранить' }, { status: 500 });
      }
      const response = await handle(new Request(url, { ...init, headers }));
      requests.push({ path: url.pathname, status: response.status });
      if (url.pathname === '/api/meta' && restartOnRefresh) handle = router(store);
      return response;
    };
    const until = async (check: () => unknown) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 25)); assert.ok(check()); };
    const submit = async () => {
      requests.length = 0;
      document.getElementById('dialog-form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await until(() => !document.getElementById('dialog-submit')!.hasAttribute('disabled'));
    };
    const error = () => document.getElementById('dialog-error')!.textContent!;
    try {
      window.eval(stripTypeScriptTypes(readFileSync(new URL('../web/app.ts', import.meta.url), 'utf8')));
      await until(() => document.querySelector('main h1'));
      document.getElementById('new-case')!.click();
      const title = document.querySelector('[name=title]') as HTMLInputElement;
      title.value = 'https://example.com/discussion';
      const why = document.querySelector('[name=why]') as HTMLTextAreaElement; why.value = 'Сохранить контекст';
      handle = router(store); // A new service instance invalidates the page's startup token.
      await submit();
      assert.equal(error(), '', host);
      assert.equal(store.list().length, 1, 'only one case is created');
      assert.deepEqual(requests.filter(r => ['/api/meta', '/api/cases'].includes(r.path)), [
        { path: '/api/cases', status: 403 }, { path: '/api/meta', status: 200 }, { path: '/api/cases', status: 201 },
      ]);
      assert.equal((document.getElementById('dialog') as HTMLDialogElement).open, false);
      await until(() => document.querySelector('main h1')?.textContent === 'Новое дело');
      document.getElementById('new-case')!.click();
      const draft = document.querySelector('[name=title]') as HTMLInputElement; draft.value = 'Черновик';
      const context = document.querySelector('[name=context]') as HTMLTextAreaElement; context.value = 'Не терять';
      handle = router(store); unavailableMeta = true;
      await submit();
      assert.match(error(), /Повторите отправку/);
      assert.equal(draft.value, 'Черновик'); assert.equal(context.value, 'Не терять');
      assert.equal((document.getElementById('dialog') as HTMLDialogElement).open, true);
      assert.equal(store.list().length, 1);
      unavailableMeta = false; restartOnRefresh = true;
      await submit();
      assert.match(error(), /Повторите отправку/);
      assert.deepEqual(requests.map(r => r.status), [403, 200, 403], 'a second restart does not cause an unbounded retry');
      assert.equal(draft.value, 'Черновик'); assert.equal(context.value, 'Не терять');
      restartOnRefresh = false; foreign = true;
      await submit();
      assert.deepEqual(requests.map(r => r.status), [403], 'a foreign-origin failure is never refreshed or replayed');
      assert.match(error(), /другого сайта/);
      foreign = false;
      for (failure of ['server', 'network']) {
        await submit();
        assert.deepEqual(requests.map(r => r.status), [500], 'ambiguous failures are never replayed');
        assert.equal(draft.value, 'Черновик'); assert.equal(context.value, 'Не терять');
        assert.equal(store.list().length, 1);
      }
    } finally { window.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test('duty/project path from New case through editing and New agent preserves drafts and queues the chosen context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-duty-ui-'));
  const store = new Store({ firstmateHome: firstmateHome(root) }); const handle = router(store);
  const product = join(root, 'materials'); mkdirSync(product);
  mkdirSync(join(store.firstmate.home, 'projects', 'app'), { recursive: true });
  writeFileSync(join(store.firstmate.home, 'data/projects.md'), '- app [local-only] - fixture\n');
  const dom = new JSDOM(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost:4317/', runScripts: 'outside-only' });
  const { window } = dom; const document: Document = window.document;
  window.setInterval = () => 0;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const payloads: any[] = [];
  window.fetch = async (path: string, init: RequestInit = {}) => {
    if (/\/agent$/.test(path) && init.body) payloads.push(JSON.parse(String(init.body)));
    return handle(new Request(new URL(path, window.location.href), init));
  };
  const until = async (check: () => unknown) => { for (let i = 0; i < 300 && !check(); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(check()); };
  const input = (name: string) => document.querySelector<HTMLInputElement>(`#dialog-body [name=${name}]`)!;
  const change = (name: string, value: string) => { input(name).value = value; input(name).dispatchEvent(new window.Event('change', { bubbles: true })); };
  const submit = () => document.getElementById('dialog-form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const chooseProject = (name: string) => { const select = document.querySelector<HTMLSelectElement>(`[data-project-choice=${name}]`)!; select.value = 'app'; select.dispatchEvent(new window.Event('change', { bubbles: true })); };
  try {
    window.eval(stripTypeScriptTypes(readFileSync(new URL('../web/app.ts', import.meta.url), 'utf8')));
    await until(() => document.querySelector('main h1'));
    document.getElementById('new-case')!.click();
    await until(() => document.querySelector('[data-project-choice=reviewRepo] option[value=app]'));
    chooseProject('reviewRepo'); assert.equal(input('reviewRepo').value, 'app');
    input('title').value = 'Дежурство из формы'; input('why').value = 'Проверить обращение';
    input('sources').value = 'https://example.com/thread'; change('reviewKind', 'duty');
    assert.equal(input('reviewRepo').value, 'app', 'changing type preserves project');
    assert.equal(input('folder').required, true); assert.equal(payloads.length, 0);
    input('folder').value = 'relative/path'; submit();
    await until(() => /Папка:/.test(document.getElementById('dialog-error')!.textContent ?? ''));
    assert.equal(input('title').value, 'Дежурство из формы'); assert.equal(input('reviewRepo').value, 'app');
    assert.equal(store.list().length, 0, 'validation failure leaves the complete draft intact and writes nothing');
    input('folder').value = product; input('reviewRepo').value = 'unknown-project'; submit();
    await until(() => /Проект:/.test(document.getElementById('dialog-error')!.textContent ?? ''));
    assert.equal(input('reviewRepo').value, 'unknown-project'); assert.equal(input('why').value, 'Проверить обращение');
    assert.equal(store.list().length, 0);
    chooseProject('reviewRepo'); submit();
    await until(() => document.querySelector('main h1')?.textContent === 'Дежурство из формы');
    const caseId = window.location.hash.slice('#case:'.length);
    assert.match(document.querySelector('main')!.textContent!, /Дежурство · только чтение · Проект: app/);
    assert.equal(store.firstmate.receipts().pending.length, 0, 'saving a duty never starts a worker');
    document.querySelector<HTMLButtonElement>('[data-action=edit]')!.click(); await until(() => input('repo'));
    assert.equal(input('repo').value, 'app'); assert.equal(input('folder').value, product);
    input('repo').value = product; submit();
    await until(() => !(document.getElementById('dialog') as HTMLDialogElement).open);
    assert.equal(store.getCase(caseId).repo, product); assert.equal(store.getCase(caseId).caseType, 'duty');
    await until(() => document.querySelector('main')!.textContent!.includes(`Проект: ${product}`));
    document.querySelector<HTMLButtonElement>('[data-action=agent-case]')!.click(); await until(() => input('direction'));
    assert.equal(input('repo').value, product); assert.equal(input('folder').value, product);
    assert.equal(document.querySelector('[name=kind] option[value=ship]'), null, 'duty stays read-only');
    chooseProject('repo'); input('direction').value = 'Разбери материалы.'; submit();
    await until(() => payloads.length === 1 && store.getCase(caseId).tasks.length === 1);
    const dutyTask = store.getCase(caseId).tasks[0];
    assert.equal(store.get(dutyTask.id).repo, 'app'); assert.equal(store.get(dutyTask.id).folder, product);
    assert.equal(store.firstmate.show(dutyTask.id).state, 'queued');
    assert.equal(payloads[0].kind, 'scout'); assert.equal(payloads[0].repo, 'app');
    await until(() => !(document.getElementById('dialog') as HTMLDialogElement).open);
    const ordinary = store.createCase({ title: 'Правка файлов', repo: 'app' });
    window.location.hash = `case:${ordinary.id}`;
    await until(() => document.querySelector('main h1')?.textContent === 'Правка файлов');
    document.querySelector<HTMLButtonElement>('[data-action=agent-case]')!.click(); await until(() => (document.getElementById('dialog') as HTMLDialogElement).open && document.querySelector('[name=kind] option[value=ship]'));
    assert.equal(input('repo').value, 'app');
    assert.match(document.getElementById('dialog-body')!.textContent!, /Исследование: отчёт без изменения файлов/);
    input('folder').value = product; change('kind', 'ship');
    assert.equal(document.getElementById('agent-folder')!.hidden, true);
    assert.match(document.getElementById('agent-mode-help')!.textContent!, /изолированном рабочем дереве/);
    input('repo').value = product; input('direction').value = 'Исправь проект.'; submit();
    await until(() => payloads.length === 2 && store.getCase(ordinary.id).tasks.length === 1);
    const ship = store.firstmate.show(store.getCase(ordinary.id).tasks[0].id);
    assert.equal(ship.kind, 'ship'); assert.equal(ship.repo, product); assert.equal(ship.state, 'queued');
    assert.equal(payloads[1].folder, ''); assert.ok(!ship.body.includes('Папка:'), 'read-only materials never become writable workspace');
  } finally { window.close(); rmSync(root, { recursive: true, force: true }); }
});
