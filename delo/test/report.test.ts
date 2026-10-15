import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const fm = store.firstmate.home; const handle = router(store);
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
      assert.deepEqual(reportLinks(), ['#report:own'], 'the task page «Ссылки» opens the report');
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
    } finally { window.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
