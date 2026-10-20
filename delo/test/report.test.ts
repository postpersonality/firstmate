import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { Store } from '../src/store.ts';
import { router } from '../src/server.ts';
import { run } from '../src/process.ts';
import { firstmateHome } from './firstmate-home.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as any;

test('a task opens its own report read-only with its absolute path, and nothing else is served', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-report-'));
  const store = new Store({ firstmateHome: firstmateHome(root, { doneKeep: 1 }) });
  // The stub opener records each call's arguments, one line per call, so no real xdg-open runs.
  const opened = join(root, 'opened.log'); const opener = join(root, 'opener');
  writeFileSync(opener, `#!/bin/sh\nprintf '%s|' "$@" >> '${opened}'\necho >> '${opened}'\n`, { mode: 0o755 });
  const fm = store.firstmate.home; const handle = router(store, opener);
  const env = { ...process.env }; for (const name of Object.keys(env)) if (name.startsWith('FM_')) delete env[name]; env.FM_HOME = fm;
  const axi = (...args: string[]) => run(join(fm, 'bin', 'fm-tasks-axi.sh'), args, fm, 45000, env);
  const file = (taskId: string, text: string) => { mkdirSync(join(fm, 'data', taskId), { recursive: true }); writeFileSync(join(fm, 'data', taskId, 'report.md'), text); };
  const get = (taskId: string) => handle(new Request(`http://localhost:4317/api/reports/${taskId}`));
  const text = '# Отчёт\n\n<script>alert(1)</script> **как есть**\n';
  try {
    axi('add', 'own', 'Своя задача'); axi('update', 'own', '--report', 'data/own/report.md'); file('own', text);
    axi('add', 'nolink', 'Без ссылки'); file('nolink', 'не отдаётся');
    axi('add', 'other', 'Чужой отчёт'); axi('update', 'other', '--report', 'data/own/report.md');
    axi('add', 'missing', 'Нет файла'); axi('update', 'missing', '--report', 'data/missing/report.md');
    axi('add', 'old', 'В архиве'); axi('done', 'old', '--report', 'data/old/report.md'); file('old', 'архивный отчёт');
    axi('add', 'shipped', 'Сделанная', '--kind', 'scout'); axi('done', 'shipped', '--report', 'data/shipped/report.md'); file('shipped', 'отчёт сделанной');
    assert.match(readFileSync(join(fm, 'data', 'done-archive.md'), 'utf8'), /old/, 'done_keep = 1 moved the earlier closed task to the archive');

    // The markdown backlog keeps a queued row's report link in its title, so titles are read back from the backlog.
    const title = (taskId: string) => store.firstmate.show(taskId).title;
    const own = await get('own'); assert.equal(own.status, 200);
    assert.deepEqual(await own.json(), { path: join(fm, 'data', 'own', 'report.md'), title: title('own'), text });
    assert.equal((await (await get('old')).json()).text, 'архивный отчёт', 'an archived task keeps its report');
    for (const taskId of ['nolink', 'other', 'missing', 'ghost', '..%2F..%2Fetc%2Fpasswd', '%2e%2e', 'own%2F..%2Fown', '%E0%A4%A']) assert.equal((await get(taskId)).status, 404, taskId);

    const csrf = (await (await handle(new Request('http://localhost:4317/api/meta'))).json()).csrf;
    const open = (taskId: string, headers: Record<string, string> = { 'content-type': 'application/json', 'x-delo-csrf': csrf }, h = handle) => h(new Request(`http://localhost:4317/api/reports/${taskId}/open`, { method: 'POST', headers, body: '{}' }));
    const calls = () => existsSync(opened) ? readFileSync(opened, 'utf8').split('\n').filter(Boolean) : [];
    const settle = () => new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await open('own', { 'content-type': 'application/json' })).status, 403, 'no CSRF header');
    for (const taskId of ['nolink', 'other', 'missing', 'ghost', '..%2F..%2Fetc%2Fpasswd', '%2e%2e', 'own%2F..%2Fown', '%E0%A4%A']) {
      assert.equal((await open(taskId)).status, 404, taskId);
    }
    await settle(); assert.deepEqual(calls(), [], 'a refused request opens nothing');
    const opening = await open('own'); assert.equal(opening.status, 200); assert.deepEqual(await opening.json(), { ok: true });
    for (let i = 0; i < 200 && !calls().length; i++) await new Promise(resolve => setTimeout(resolve, 25));
    await settle(); assert.deepEqual(calls(), [`${join(fm, 'data', 'own', 'report.md')}|`], 'the opener ran once with exactly the absolute report path');
    const broken = router(store, join(root, 'no-such-opener')); const brokenCsrf = (await (await broken(new Request('http://localhost:4317/api/meta'))).json()).csrf;
    const failed = await open('own', { 'content-type': 'application/json', 'x-delo-csrf': brokenCsrf }, broken);
    assert.equal(failed.status, 400); assert.match((await failed.json()).error, /Не удалось открыть отчёт в приложении: .*ENOENT/);

    const dom = new JSDOM(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost:4317/', runScripts: 'outside-only' });
    const { window } = dom; const document = window.document;
    window.setInterval = (() => 0) as typeof window.setInterval;
    let copied = '';
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (value: string) => { copied = value; } } });
    (window as any).fetch = async (input: string, init: RequestInit = {}) => handle(new Request(new URL(String(input), window.location.href), init));
    const until = async (check: () => unknown) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 25)); assert.ok(check()); };
    try {
      window.eval(stripTypeScriptTypes(readFileSync(new URL('../web/app.ts', import.meta.url), 'utf8')));
      await until(() => document.querySelector('main h1'));
      const reportLinks = () => [...document.querySelectorAll('main a.report-link')].map(a => a.getAttribute('href'));
      assert.deepEqual(reportLinks().sort(), ['#report:missing', '#report:own', '#report:shipped'], 'only rows with their own report link get «Отчёт», «Сделано» included');

      window.location.hash = 'own'; await until(() => document.querySelector('main h1')?.textContent === title('own'));
      assert.deepEqual(reportLinks(), ['#report:own', '#report:own'], 'the task heading and «Ссылки» open the report');
      window.location.hash = 'other'; await until(() => document.querySelector('main h1')?.textContent === title('other'));
      assert.deepEqual(reportLinks(), [], 'a link to another task report stays plain text');

      window.location.hash = 'report:own'; await until(() => document.querySelector('pre.report-text'));
      assert.equal(document.querySelector('main h1')?.textContent, title('own'));
      assert.equal(document.querySelector('pre.report-text')?.textContent, text, 'the report text is shown as is, not rendered');
      assert.equal(document.querySelector('main script'), null);
      assert.equal(document.getElementById('report-path')?.textContent, join(fm, 'data', 'own', 'report.md'));
      (document.querySelector('[data-action="copy-path"]') as HTMLButtonElement).click();
      await until(() => copied);
      assert.equal(copied, join(fm, 'data', 'own', 'report.md'));
      (document.querySelector('[data-action="open-report"]') as HTMLButtonElement).click();
      await until(() => calls().length === 2);
      assert.equal(calls()[1], `${join(fm, 'data', 'own', 'report.md')}|`, '«Открыть в приложении» asks the service to open the report');
    } finally { window.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
