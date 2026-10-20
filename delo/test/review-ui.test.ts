import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { Store } from '../src/store.ts';
import { router } from '../src/server.ts';
import { firstmateHome } from './firstmate-home.ts';

const { JSDOM } = createRequire(import.meta.url)('jsdom');

test('New case SA fields validate, suggest registry projects, deduplicate double submit, and display observed progress', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-review-ui-'));
  const store = new Store({ firstmateHome: firstmateHome(root) }); const handle = router(store);
  mkdirSync(join(store.firstmate.home, 'projects', 'avia'), { recursive: true });
  writeFileSync(join(store.firstmate.home, 'data/projects.md'), '- avia [local-only] - fixture (added 2026-10-20)\n');
  const dom = new JSDOM(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost:4317/', runScripts: 'outside-only' });
  const { window } = dom; const document = window.document; let creations = 0;
  window.setInterval = () => 0;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.fetch = async (input: string, init: RequestInit = {}) => {
    if (input === '/api/cases' && init.method === 'POST') creations++;
    return handle(new Request(new URL(String(input), window.location.href), init));
  };
  const until = async (check: () => unknown) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(check()); };
  const input = (name: string) => document.querySelector(`[name=${name}]`) as HTMLInputElement;
  const submit = () => document.getElementById('dialog-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  try {
    window.eval(stripTypeScriptTypes(readFileSync(new URL('../web/app.ts', import.meta.url), 'utf8')));
    await until(() => document.querySelector('main h1'));
    document.getElementById('new-case').click();
    input('reviewKind').value = 'sa'; input('reviewKind').dispatchEvent(new window.Event('change'));
    await until(() => document.querySelector('#reviewRepo-list option'));
    assert.equal(input('document').required, true); assert.equal(input('reviewRepo').required, true);
    assert.equal(document.querySelector('#reviewRepo-list option').value, 'avia');
    input('title').value = 'Ревью СА через форму'; input('document').value = 'file:///tmp/spec'; input('reviewRepo').value = 'avia';
    assert.equal(input('document').checkValidity(), false);
    submit(); await until(() => document.getElementById('dialog-error').textContent);
    assert.equal(store.list().length, 0, 'server refuses bad URL even if browser validation is bypassed');
    input('document').value = 'https://example.com/pages/1'; submit(); submit();
    await until(() => document.querySelector('main h1')?.textContent === 'Ревью СА через форму');
    assert.equal(creations, 2, 'one invalid submit and one accepted submit');
    const c = store.getCase(window.location.hash.slice('#case:'.length)); const task = c.tasks[0];
    assert.equal(c.repo, join(store.firstmate.home, 'projects/avia'));
    assert.equal(c.tasks.length, 1); assert.equal(store.firstmate.receipts().pending.length, 0);
    assert.ok(document.querySelector(`[data-task-action=start][data-id="${task.id}"]`));
    const dir = join(store.firstmate.home, 'data', task.id); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'review-progress.json'), JSON.stringify({status:'failed',current:'audit_review',startedAt:'2026-10-20T12:00:00Z',endedAt:'2026-10-20T12:00:03Z',elapsedMs:3000,exitCode:7,result:'blocked',phases:[{name:'audit',startedAt:'2026-10-20T12:00:00Z',endedAt:'2026-10-20T12:00:02Z',elapsedMs:2000,source:'ledger'}],warnings:['Protocol unknown']}));
    window.location.hash = task.id;
    await until(() => document.querySelector('[data-review-progress]'));
    const progress = document.querySelector('[data-review-progress]').textContent;
    assert.match(progress, /Ошибка/); assert.match(progress, /Проверка аудита/); assert.match(progress, /3 с/); assert.match(progress, /2 с/); assert.match(progress, /Protocol unknown/);
    assert.match(progress, /12:00/); assert.match(progress, /ledger/);
    assert.match(document.querySelector('main').textContent, /Проект контекста/);
    window.location.hash = `case:${c.id}`;
    await until(() => document.querySelector('main h1')?.textContent === c.title);
    document.querySelector('[data-action=agent-case]').click();
    await until(() => input('repo'));
    assert.equal(input('repo').value, c.repo, 'SA New agent inherits the project');
    assert.ok(document.querySelector('[data-project-choice=repo]'));
    assert.equal(store.firstmate.receipts().pending.length, 0, 'opening New agent never starts it');
  } finally { window.close(); rmSync(root, { recursive: true, force: true }); }
});
