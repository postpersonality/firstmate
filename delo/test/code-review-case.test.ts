import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.ts';
import { router } from '../src/server.ts';
import { firstmateHome, stubLog } from './firstmate-home.ts';

// Real backlog/inbox scripts in a scratch home; no reviewer, network or paid model is started.
async function client(store: Store) {
  const handle = router(store);
  const meta = await (await handle(new Request('http://localhost:4317/api/meta'))).json();
  return (path: string, body?: unknown) => handle(new Request(`http://localhost:4317${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-delo-csrf': meta.csrf }, body: JSON.stringify(body),
  }));
}

test('code-review case refuses missing/non-task links before creating any backlog row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-code-invalid-'));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) }); const request = await client(store);
    for (const url of [undefined, '', 'https://github.com/org/repo', 'https://jira.example.invalid/browse/EXAMPLE-123 https://github.com/org/repo/pull/7']) {
      const response = await request('/api/cases', { title: 'Ревью', requestId: randomUUID(), review: { kind: 'code', url } });
      assert.equal(response.status, 400, String(url));
      assert.match((await response.json()).error, /ссылк.*Jira.*pull request/i);
    }
    assert.deepEqual(await store.firstmate.list(), [], 'invalid input writes nothing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('code-review creation is durable and idempotent, then uses the ordinary scout start inbox', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-code-case-'));
  try {
    const home = firstmateHome(root); const store = new Store({ firstmateHome: home }); const request = await client(store);
    const before = (() => { try { return readFileSync(stubLog, 'utf8'); } catch { return ''; } })();
    const input = { title: 'Проверить изменение', requestId: randomUUID(), review: { kind: 'code', url: 'https://jira.example.invalid/browse/EXAMPLE-123' } };
    const responses = await Promise.all([request('/api/cases', input), request('/api/cases', input)]);
    for (const response of responses) assert.equal(response.status, 201, await response.clone().text());
    const [first, repeat] = await Promise.all(responses.map(r => r.json()));
    assert.equal(first.id, repeat.id);
    const restarted = new Store({ firstmateHome: home }); const afterRestart = await client(restarted);
    const replay = await afterRestart('/api/cases', input);
    assert.equal(replay.status, 201, await replay.clone().text()); assert.equal((await replay.json()).id, first.id);
    const tasks = await restarted.firstmate.list();
    assert.equal(tasks.length, 2, 'one ordinary program and one review scout');
    assert.equal(tasks.find(t => t.id === first.id)?.kind, 'program');
    const child = tasks.find(t => t.kind === 'scout')!;
    assert.ok(child); assert.equal(child.state, 'queued');
    assert.match(child.body, new RegExp(`^Дело: ${first.id}\\n`));
    assert.match(child.body, /^Review: .+$/m);
    assert.match(child.body, /code-review-workflow/);
    assert.match(child.body, /code-review-workflow/);
    assert.match(child.body, /EXAMPLE-123/);
    assert.equal((await restarted.inbox(child.id)).requests.length, 0, 'creation never dispatches a worker');
    const starts = await Promise.all([afterRestart(`/api/tasks/${child.id}/start`, {}), afterRestart(`/api/tasks/${child.id}/start`, {})]);
    for (const start of starts) assert.equal(start.status, 200, await start.clone().text());
    assert.equal((await restarted.inbox(child.id)).requests.length, 1, 'two clicks send one durable start request');
    assert.equal((await restarted.firstmate.show(child.id)).state, 'queued', 'only firstmate may dispatch the actual agent');
    const after = (() => { try { return readFileSync(stubLog, 'utf8'); } catch { return ''; } })();
    assert.equal(after, before, 'no paid model or infrastructure command was called');
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('fixture review worker consumes the start request, enriches local context and exposes live phases plus its skill report', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-code-worker-'));
  let childProcess: ReturnType<typeof spawn> | undefined;
  try {
    const home = firstmateHome(root); const store = new Store({ firstmateHome: home }); const request = await client(store);
    const response = await request('/api/cases', { title: 'Код-ревью fixture', requestId: randomUUID(), review: { kind: 'code', url: 'https://github.com/org/repo/pull/7' } });
    assert.equal(response.status, 201, await response.clone().text());
    const c = await response.json(); const task = (await store.firstmate.list()).find(t => t.kind === 'scout')!;
    assert.ok(task); assert.match(task.body, new RegExp(`^Дело: ${c.id}\\n`));
    await request(`/api/tasks/${task.id}/start`, {});
    const note = (await store.firstmate.receipts()).pending.find((n: any) => n.kind === 'start' && n.task === task.id);
    assert.ok(note, 'fixture worker is launched only from a typed Firstmate start request');
    const release = join(root, 'continue'); const fixture = join(root, 'fixture.mjs');
    writeFileSync(fixture, `
      import assert from 'node:assert/strict';
      import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      import { join } from 'node:path';
      import { Firstmate } from ${JSON.stringify(new URL('../src/firstmate.ts', import.meta.url).href)};
      const home = ${JSON.stringify(home)}, taskId = ${JSON.stringify(task.id)};
      const fm = new Firstmate(home);
      const task = fm.show(taskId);
      assert.match(task.body, /code-review-workflow/);
      assert.ok(task.body.includes('code-review-workflow'));
      const metadata = JSON.parse(task.body.split('\\n').find(l => l.startsWith('Review: ')).slice(8));
      assert.equal(metadata.kind, 'code'); assert.equal(metadata.url, 'https://github.com/org/repo/pull/7');
      const call = (command, args) => {
        const result = spawnSync(command, args, { cwd: home, env: { ...process.env, FM_HOME: home }, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
      };
      call(join(home, 'bin/fm-inbox.sh'), ['drain', '--ack', ${JSON.stringify(note.id)}]);
      fm.start(taskId);
      const progress = (event, phase, detail = '') => call(process.execPath, [${JSON.stringify(fileURLToPath(new URL('../src/review-progress.ts', import.meta.url)))}, '--home', home, '--task', taskId, '--event', event, '--phase', phase, '--detail', detail]);
      progress('start', 'Сбор контекста');
      // Metadata-only source fixture: deliberately has no Jira description.
      const context = { epic: 'https://jira.example.invalid/browse/EXAMPLE-123', sa: 'https://jira.example.invalid/browse/EXAMPLE-123' };
      fm.update(taskId, { body: task.body + '\\n\\n## Связанный контекст\\nЭпик: ' + context.epic + '\\nСА: ' + context.sa });
      progress('end', 'Сбор контекста', 'Подтверждены epic/SA связи из metadata fixture');
      progress('start', 'Ревью');
      writeFileSync(${JSON.stringify(join(root, 'running'))}, 'ready');
      for (let i = 0; !existsSync(${JSON.stringify(release)}); i++) { assert.ok(i < 2000, 'fixture release timed out'); await new Promise(r => setTimeout(r, 10)); }
      progress('end', 'Ревью', 'Fixture SHA abc123; код только прочитан');
      progress('start', 'Перепроверка замечаний'); progress('end', 'Перепроверка замечаний');
      progress('start', 'Отчёт');
      mkdirSync(join(home, 'data', taskId), { recursive: true });
      writeFileSync(join(home, 'data', taskId, 'report.md'), '# Fixture code-review-workflow\\n\\nВердикт: нужны исправления\\nПроверенный SHA: abc123\\nPR: https://github.com/org/repo/pull/7\\nЭпик: ' + context.epic + '\\nСА: ' + context.sa + '\\nДоказанное fixture замечание: unreachable branch\\nОграничение: синтетические данные, настоящее ревью не выполнялось\\n');
      progress('end', 'Отчёт'); progress('done', 'Отчёт', 'нужны исправления; fixture');
      call(join(home, 'bin/fm-tasks-axi.sh'), ['update', taskId, '--report', 'data/' + taskId + '/report.md']);
      if (fm.show(taskId).state !== 'done') fm.done(taskId);
    `);
    let output = '';
    childProcess = spawn(process.execPath, [fixture], { stdio: ['ignore', 'pipe', 'pipe'] });
    childProcess.stdout?.on('data', chunk => { output += chunk; }); childProcess.stderr?.on('data', chunk => { output += chunk; });
    const exited = new Promise<number | null>((resolve, reject) => { childProcess!.once('error', reject); childProcess!.once('exit', resolve); });
    for (let i = 0; i < 400 && !existsSync(join(root, 'running')) && childProcess.exitCode === null; i++) await new Promise(r => setTimeout(r, 25));
    assert.ok(existsSync(join(root, 'running')), output);
    const live = await (await request(`/api/goals/${task.id}`)).json();
    assert.equal(live.reviewProgress.status, 'running'); assert.equal(live.reviewProgress.current, 'Ревью');
    assert.match(live.body, /Эпик: https:\/\/jira.example.invalid\/browse\/EXAMPLE-123/);
    assert.match(live.body, /СА: https:\/\/jira.example.invalid\/browse\/EXAMPLE-123/);
    assert.equal(live.inbox.requests.length, 1); assert.equal(live.inbox.requests[0].acknowledged, true);
    assert.equal(live.reviewProgress.phases[0].name, 'Сбор контекста'); assert.ok(live.reviewProgress.phases[0].elapsedMs >= 0);
    writeFileSync(release, 'continue');
    assert.equal(await exited, 0, output);
    const done = await (await request(`/api/goals/${task.id}`)).json();
    assert.equal(done.reviewProgress.status, 'done'); assert.equal(done.state, 'done');
    assert.equal(done.reviewProgress.result, 'нужны исправления; fixture', 'the result is available beside the phases');
    assert.equal(done.reviewProgress.phases.length, 4); assert.ok(done.reviewProgress.elapsedMs > 0);
    assert.equal(done.report, true);
    const report = await (await request(`/api/reports/${task.id}`)).json();
    assert.match(report.text, /Вердикт: нужны исправления/);
    assert.match(report.text, /Доказанное fixture замечание: unreachable branch/, 'progress completion preserves the skill-authored report');
    assert.match(readFileSync(join(home, 'state', task.id + '.status'), 'utf8'), /^done \[at=\d+\]:.*нужны исправления/m);
  } finally {
    if (childProcess?.exitCode === null) childProcess.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('New case exposes code review with one required link and starts its scout through the existing controls', async () => {
  const { createRequire, stripTypeScriptTypes } = await import('node:module');
  const { JSDOM } = createRequire(import.meta.url)('jsdom') as any;
  const root = mkdtempSync(join(tmpdir(), 'delo-code-ui-'));
  const dom = new JSDOM(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost:4317/', runScripts: 'outside-only' });
  const { window } = dom; const document: Document = window.document;
  window.setInterval = () => 0;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) }); const handle = router(store);
    let creations = 0; let releaseCreate: (() => void) | undefined; let deferCreate = false;
    window.fetch = async (input: string, init: RequestInit = {}) => {
      if (String(input) === '/api/cases' && init.method === 'POST') {
        creations++;
        if (deferCreate) { deferCreate = false; await new Promise<void>(r => { releaseCreate = r; }); }
      }
      return handle(new Request(new URL(input, window.location.href), init));
    };
    const until = async (check: () => unknown) => { for (let i = 0; i < 300 && !check(); i++) await new Promise(r => setTimeout(r, 25)); assert.ok(check()); };
    const submit = () => document.getElementById('dialog-form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    window.eval(stripTypeScriptTypes(readFileSync(new URL('../web/app.ts', import.meta.url), 'utf8')));
    await until(() => document.querySelector('main h1'));
    document.getElementById('new-case')!.click();
    await until(() => (document.getElementById('dialog') as HTMLDialogElement).open);
    const kind = [...document.querySelectorAll<HTMLSelectElement>('#dialog-body select')].find(s => [...s.options].some(o => o.value === 'code'));
    assert.ok(kind, 'code review is offered in the existing New case dialog');
    kind.value = 'code'; kind.dispatchEvent(new window.Event('change', { bubbles: true }));
    const visible = (e: HTMLElement) => { for (let p: HTMLElement | null = e; p; p = p.parentElement) if (p.hidden || p.style.display === 'none') return false; return true; };
    const urlLabel = [...document.querySelectorAll<HTMLLabelElement>('#dialog-body label')].find(l => /Jira.*pull request|pull request.*Jira/i.test(l.textContent ?? '') && visible(l));
    assert.ok(urlLabel); const url = urlLabel.querySelector<HTMLInputElement>('input')!;
    assert.equal(url?.required, false, 'a link in the description is sufficient; the optional override stays typed');
    const sourceList = document.querySelector<HTMLTextAreaElement>('#dialog-body [name=sources]');
    assert.ok(!sourceList || !visible(sourceList), 'code review does not offer an arbitrary list of links');
    assert.equal(document.querySelector<HTMLInputElement>('[name=document]')!.disabled, true, 'code review disables the separate SA document input');
    document.querySelector<HTMLInputElement>('#dialog-body [name=description]')!.value = 'Код-ревью из UI';
    url.value = 'https://github.com/org/repo'; submit();
    await until(() => /ссылк.*Jira.*pull request/i.test(document.getElementById('dialog-error')!.textContent ?? ''));
    assert.equal((await store.firstmate.list()).length, 0, 'invalid URL leaves the dialog open and writes nothing');
    document.querySelector<HTMLInputElement>('#dialog-body [name=reviewRepo]')!.value = root;
    url.value = 'https://github.com/org/repo/pull/7'; deferCreate = true; submit(); submit();
    assert.equal(creations, 2, 'one invalid attempt plus one in-flight submit; duplicate submit is ignored');
    assert.ok((document.getElementById('dialog-submit') as HTMLButtonElement).disabled);
    releaseCreate!();
    await until(() => document.querySelector('[data-task-action=start]'));
    const tasks = await store.firstmate.list(); const task = tasks.find(t => t.kind === 'scout')!;
    assert.equal(tasks.length, 2); assert.ok(task);
    assert.equal(task.repo, root, 'code-review scout preserves the full context folder');
    assert.equal(store.getCase(window.location.hash.slice('#case:'.length)).repo, root);
    assert.ok(document.querySelector('[data-action=agent-case]'), 'ordinary New agent stays available');
    const start = document.querySelector<HTMLButtonElement>('[data-task-action=start]')!;
    start.click(); start.click();
    await until(() => !document.querySelector<HTMLButtonElement>('[data-task-action=start]')?.disabled);
    assert.equal((await store.inbox(task.id)).requests.length, 1, 'UI uses ordinary inbox start without duplicate launch');
  } finally { window.close(); rmSync(root, { recursive: true, force: true }); }
});
