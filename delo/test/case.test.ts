import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { Store } from '../src/store.ts';
import { router } from '../src/server.ts';
import { run } from '../src/process.ts';
import { firstmateHome } from './firstmate-home.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as any;

test('a дело gathers its tasks from the backlog and the archive, closes only after the warning, and continues from the archive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-case-'));
  const store = new Store({ firstmateHome: firstmateHome(root, { doneKeep: 1 }) });
  const fm = store.firstmate.home;
  const env = { ...process.env }; for (const name of Object.keys(env)) if (name.startsWith('FM_')) delete env[name]; env.FM_HOME = fm;
  const axi = (...args: string[]) => run(join(fm, 'bin', 'fm-tasks-axi.sh'), args, fm, 45000, env);
  const archive = () => readFileSync(join(fm, 'data', 'done-archive.md'), 'utf8');
  const pending = () => store.firstmate.receipts().pending.map((r: any) => r.request_id);
  const dom = new JSDOM(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost:4317/', runScripts: 'outside-only' });
  const { window } = dom; const document = window.document; const handle = router(store);
  window.setInterval = (() => 0) as typeof window.setInterval;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  (window as any).fetch = async (input: string, init: RequestInit = {}) => handle(new Request(new URL(String(input), window.location.href), init));
  const until = async (check: () => unknown) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 25)); assert.ok(check()); };
  const open = async (hash: string, ready: () => unknown) => { window.location.hash = hash; await until(ready); };
  const section = (title: string) => [...document.querySelectorAll('main section')].find((s: any) => s.querySelector('h2')?.textContent === title) as HTMLElement;
  const submit = () => document.getElementById('dialog-form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  try {
    window.eval(stripTypeScriptTypes(readFileSync(new URL('../web/app.ts', import.meta.url), 'utf8')));
    await until(() => document.querySelector('main h1'));

    const c = store.createCase({ title: 'Пробное дело https://example.com/spec', why: 'Причина', doneWhen: 'Готово', context: 'Контекст', constraints: '- Не ломать', sources: 'https://example.com/extra' });
    assert.deepEqual([store.firstmate.show(c.id).kind, store.firstmate.show(c.id).state], ['program', 'in_flight']);
    assert.deepEqual([c.title, c.why, c.doneWhen, c.context, c.constraints, c.sources], ['Пробное дело', 'Причина', 'Готово', 'Контекст', ['Не ломать'], ['https://example.com/spec', 'https://example.com/extra']]);
    assert.throws(() => store.act(c.id, 'close', {}), /недоступно/, 'a дело has no task buttons');
    const first = store.create({ title: 'Первая задача', caseId: c.id }).id;
    const second = store.create({ title: 'Вторая задача', caseId: c.id }).id;
    assert.equal(store.firstmate.show(first).body, `Дело: ${c.id}`);
    assert.throws(() => store.create({ title: 'Не в дело', caseId: first }), /открытого дела нет/);

    axi('done', first, '--pr', 'https://github.com/o/r/pull/7', '--report', `data/${first}/report.md`);
    store.act(store.create({ title: 'Без дела' }).id, 'close', {});
    assert.match(archive(), new RegExp(first), 'done_keep = 1 moved the closed task to the archive');
    assert.deepEqual((await store.overview()).cases.map(r => [r.id, r.counts]), [[c.id, { working: 0, waiting: 0, next: 1, done: 1 }]]);

    await open(`case:${c.id}`, () => document.querySelector('main h1')?.textContent === 'Пробное дело');
    assert.deepEqual([...document.querySelectorAll('main h2')].map(h => h.textContent), ['Бриф', 'Задачи', 'Закрыты раньше', 'Ссылки']);
    assert.match(section('Задачи').textContent!, /Вторая задача/);
    assert.match(section('Закрыты раньше').textContent!, /Первая задача/);
    assert.ok(section('Закрыты раньше').querySelector('a[href="https://github.com/o/r/pull/7"]'), 'an archived task keeps its PR link');
    assert.ok(section('Закрыты раньше').querySelector(`a[href="#report:${first}"]`), 'a task with its own report links to it as «Отчёт»');
    assert.deepEqual([...section('Ссылки').querySelectorAll('.row')].map(r => r.textContent), ['https://example.com/spec', 'https://example.com/extra', 'https://github.com/o/r/pull/7', `data/${first}/report.md`]);

    (document.querySelector('[data-action="close-case"]') as HTMLButtonElement).click();
    await until(() => document.getElementById('close-case-tasks'));
    assert.deepEqual([...document.querySelectorAll('#close-case-tasks li')].map(li => li.textContent), ['Вторая задача · дальше']);
    document.getElementById('dialog-close')!.click();
    assert.deepEqual(pending(), [], 'the warning sends nothing');
    assert.equal(store.firstmate.show(c.id).state, 'in_flight', 'a cancelled warning leaves the дело open');
    assert.throws(() => store.closeCase(c.id, {}), /Вторая задача/, 'the server refuses an unconfirmed task');

    (document.querySelector('[data-action="close-case"]') as HTMLButtonElement).click();
    await until(() => document.getElementById('close-case-tasks')); submit();
    await until(() => store.firstmate.show(c.id).state === 'done');
    assert.deepEqual(pending(), [`delo-close-${second}-1`], 'one close note per unclosed task, with the task «Закрыть» request id');
    assert.equal(store.firstmate.show(second).state, 'queued', 'firstmate, not Delo, closes the task');
    await until(() => document.querySelector('[data-action="reopen-case"]'));
    assert.equal(document.querySelector('[data-action="edit"]'), null, 'a closed дело brief is frozen');

    assert.equal(store.reopenCase(c.id).state, 'active');
    assert.equal(store.firstmate.show(c.id).state, 'in_flight', '«Вернуть» reopens and starts the дело');
    assert.equal(store.closeCase(c.id, { confirmed: [second] }).notes[0].outcome, 'replay', 'a second close replays the pending request');
    store.act(store.create({ title: 'Ещё без дела' }).id, 'close', {});
    assert.match(archive(), new RegExp(`${c.id} - Пробное дело`), 'the closed дело reached the archive');
    assert.throws(() => store.reopenCase(c.id), /только закрытое дело из бэклога/);

    await open(':closed', () => document.querySelector('main h1')?.textContent === 'Закрытые дела');
    (document.querySelector(`main a[href="#case:${c.id}"]`) as HTMLAnchorElement).click();
    await until(() => document.querySelector('[data-action="continue-case"]'));
    assert.equal(document.querySelector('[data-action="reopen-case"]'), null, 'an archived дело offers «Продолжить» instead of «Вернуть»');
    (document.querySelector('[data-action="continue-case"]') as HTMLButtonElement).click();
    await until(() => window.location.hash.startsWith('#case:') && window.location.hash !== `#case:${c.id}`);
    const next = store.getCase(decodeURIComponent(window.location.hash.slice('#case:'.length)));
    assert.deepEqual([next.kind, next.state, next.archived], ['program', 'active', false]);
    assert.deepEqual([next.title, next.why, next.doneWhen, next.context, next.constraints, next.sources], [c.title, c.why, c.doneWhen, c.context, c.constraints, c.sources]);
  } finally {
    window.close();
    rmSync(root, { recursive: true, force: true });
  }
});
