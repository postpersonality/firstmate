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

test('browser app uses the real router for goal forms, the card and task actions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-ui-'));
  const store = new Store({ firstmateHome: firstmateHome(root) }); const handle = router(store);
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
    assert.deepEqual([...window.document.querySelectorAll('main h2')].map(h => h.firstChild?.textContent?.trim()), ['Ждёт меня', 'В работе', 'Дальше', 'Сделано']);
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
    assert.equal(store.inbox(nativeId).requests.length, 1, 'start reuses the existing request path');
    failRequest = true;
    taskButtons().find(b => b.dataset.taskAction === 'pause')!.click();
    await until(() => window.document.getElementById('message')?.textContent === 'Не удалось выполнить действие');
    assert.ok(taskButtons().every(b => !b.disabled), 'failure restores the buttons for retry');
    taskButtons().find(b => b.dataset.taskAction === 'pause')!.click();
    await until(() => taskButtons().some(b => b.dataset.taskAction === 'unhold'));
    assert.match(focus()?.textContent ?? '', /На паузе/);
    const confirm = () => (window.document.getElementById('dialog-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    for (const paused of [true, false]) {
      if (!paused) {
        taskButtons().find(b => b.dataset.taskAction === 'unhold')!.click();
        await until(() => taskButtons().some(b => b.dataset.taskAction === 'start'));
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
      await until(() => taskButtons().some(b => b.dataset.taskAction === 'reopen') && window.document.querySelector('#message button'));
      assert.equal(mutations, before + 1, 'double confirmation closes once');
      const undo = window.document.querySelector('#message button') as HTMLButtonElement;
      assert.equal(undo.textContent, 'Вернуть');
      undo.click();
      await until(() => taskButtons().some(b => b.dataset.taskAction === (paused ? 'unhold' : 'start')));
      assert.equal(store.firstmate.show(nativeId).state, 'queued');
      assert.equal(store.firstmate.show(nativeId).held, paused ? 'yes' : 'no', 'undo preserves the existing parked hold');
    }
    taskButtons().find(b => b.dataset.taskAction === 'pause')!.click();
    await until(() => taskButtons().some(b => b.dataset.taskAction === 'unhold'));

    taskButtons().find(b => b.dataset.taskAction === 'unhold')!.click();
    await until(() => taskButtons().some(b => b.dataset.taskAction === 'start'));
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
      assert.match(window.document.getElementById('message')!.textContent!, /Просьба.*сохранена/);
      button().click(); confirm();
      await until(() => !dialogOpen());
      assert.equal(store.inbox(nativeId).requests.filter(r => r.requestId.startsWith(`delo-${action}-${nativeId}-`)).length, 1);
    }

    window.document.getElementById('new-case')?.click();
    assert.deepEqual([...window.document.querySelectorAll('#dialog-body [name]')].map(e => e.getAttribute('name')), ['title', 'reviewKind', 'sources', 'why', 'doneWhen', 'context', 'constraints']);
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
    await until(() => window.document.querySelector(`[data-task-action="reopen"][data-id="${member}"]`));
    assert.equal(window.location.hash, caseHash, 'a case list action keeps the case page open');
    (window.document.querySelector(`[data-task-action="reopen"][data-id="${member}"]`) as HTMLButtonElement).click();
    await until(() => window.document.querySelector(`[data-task-action="start"][data-id="${member}"]`));
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
    assert.equal((document.getElementById('agent-repo') as HTMLElement).style.display, 'none', 'Проект is for ship only');
    input('kind').value = 'ship'; input('kind').dispatchEvent(new window.Event('change'));
    assert.equal((document.getElementById('agent-repo') as HTMLElement).style.display, '');
    input('kind').value = 'scout'; input('kind').dispatchEvent(new window.Event('change'));
    input('interactive').checked = true; input('interactive').dispatchEvent(new window.Event('change'));
    assert.equal(input('harness').value, 'codex');
    document.getElementById('dialog-form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => /Новый агент: задача/.test(document.querySelector('.message')?.textContent ?? ''));
    const task = store.getCase(c.id).tasks[0]!;
    assert.match(document.querySelector('.message')!.textContent!, new RegExp(`задача ${task.id}\\. Заметка для firstmate: отправлена`));
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
