import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.ts';
import { router } from '../src/server.ts';
import { run } from '../src/process.ts';
import { firstmateHome } from './firstmate-home.ts';

// A worker's material: an HTML page with its own stylesheet and image, kept outside the Firstmate home.
function material(root: string, question = 'Какой вариант оставить?') {
  const folder = join(root, 'work', 'review'); mkdirSync(join(folder, 'img'), { recursive: true });
  writeFileSync(join(folder, 'index.html'), `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><img src="img/plan.png"><div data-lavish-question="choice"><label><input type="radio" name="v" value="a">А</label><label><input type="radio" name="v" value="b">Б</label></div><p>${question}</p><button onclick="lavish.sendQueuedPrompts()">Отправить выбор</button></body></html>`);
  writeFileSync(join(folder, 'style.css'), 'body{color:#333}');
  writeFileSync(join(folder, 'img', 'plan.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return join(folder, 'index.html');
}

test('a published material outlives its source, replays by request id and refuses a changed one', () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-artifact-'));
  const store = new Store({ firstmateHome: firstmateHome(root) });
  try {
    const task = store.create({ title: 'Сравнить варианты' });
    const source = material(root);
    const first = store.publishArtifact({ source, title: 'Варианты плана', action: 'Выбрать вариант', taskId: task.id, requestId: 'review-1' });
    assert.equal(first.outcome, 'created');
    assert.equal(first.path, join(store.firstmate.home, 'data', task.id, 'artifacts', first.id));
    assert.equal(store.publishArtifact({ source, title: 'Варианты плана', action: 'Выбрать вариант', taskId: task.id, requestId: 'review-1' }).outcome, 'replay');
    const auto = store.publishArtifact({ source, title: 'Варианты плана', action: 'Выбрать вариант', taskId: task.id });
    assert.deepEqual(store.publishArtifact({ source, title: 'Варианты плана', action: 'Выбрать вариант', taskId: task.id }), { ...auto, outcome: 'replay' }, 'without a request id the same material is one record');
    writeFileSync(join(root, 'work', 'review', 'style.css'), 'body{color:red}');
    assert.throws(() => store.publishArtifact({ source, title: 'Варианты плана', action: 'Выбрать вариант', taskId: task.id, requestId: 'review-1' }), /уже принят с другим материалом/);

    rmSync(join(root, 'work'), { recursive: true });
    const view = store.artifacts.get(first.id);
    assert.equal(view.kind, 'html'); assert.equal(view.interactive, true); assert.equal(view.entry, 'index.html');
    assert.deepEqual(view.files.map(f => f.path).sort(), ['img/plan.png', 'index.html', 'style.css']);
    assert.equal(readFileSync(store.artifacts.file(first.id, 'style.css'), 'utf8'), 'body{color:#333}', 'the copy keeps the published bytes');
    assert.throws(() => store.artifacts.file(first.id, '../artifact.json'), /не найден/i);
    assert.equal(view.task.title, 'Сравнить варианты');
    assert.equal(store.artifacts.list().filter(a => !a.completedAt).length, 2, 'the replay and the changed copy add nothing');

    const link = store.publishArtifact({ source: 'https://example.com/report', title: 'Внешний отчёт', action: 'Прочитать', taskId: task.id });
    assert.equal(store.artifacts.get(link.id).kind, 'url');
    assert.throws(() => store.publishArtifact({ source: join(root, 'missing.html'), title: 'Нет файла', action: 'Прочитать', taskId: task.id }), /не найден/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the full answer, its draft and the delivery to Firstmate survive a restart and a stopped worker', async t => {
  const root = mkdtempSync(join(tmpdir(), 'delo-artifact-answer-'));
  const home = firstmateHome(root); let store = new Store({ firstmateHome: home });
  try {
    const task = store.create({ title: 'Опрос по плану' });
    const { id } = store.publishArtifact({ source: material(root), title: 'Варианты плана', action: 'Выбрать вариант', taskId: task.id });
    store.artifacts.saveDraft(id, { comment: 'Склоняюсь к Б', fields: { 'choice|v|b': true } });
    store = new Store({ firstmateHome: home });
    assert.deepEqual(store.artifacts.get(id).draftValue?.draft, { comment: 'Склоняюсь к Б', fields: { 'choice|v|b': true } });
    assert.equal(store.artifacts.list()[0].draft, true);

    const notes = t.mock.method(store.firstmate, 'note', () => { throw new Error('Firstmate недоступен'); });
    const answer = { submissionId: 'answer-0001', comment: 'Берём Б', action: { kind: 'interactive', label: 'Отправить выбор' }, payload: { prompts: [{ prompt: 'Вариант Б', queueKey: 'choice' }], fields: { 'choice|v|b': true } } };
    const done = store.completeArtifact(id, answer);
    assert.equal(done.outcome, 'created'); assert.equal(done.delivered, false);
    const saved = JSON.parse(readFileSync(done.path, 'utf8'));
    assert.deepEqual(saved.payload, answer.payload, 'the structured answer is kept whole');
    assert.equal(done.sha256, createHash('sha256').update(readFileSync(done.path)).digest('hex'));
    assert.equal(store.artifacts.get(id).draft, false);
    assert.throws(() => store.artifacts.saveDraft(id, { comment: 'поздно' }), /уже обработан/);
    assert.equal(store.completeArtifact(id, answer).outcome, 'replay', 'a retried submission is the same answer');
    assert.throws(() => store.completeArtifact(id, { ...answer, submissionId: 'answer-0002' }), (e: any) => e.status === 409);
    assert.equal(store.artifacts.undelivered().length, 1);

    notes.mock.restore();
    const sent = t.mock.method(store.firstmate, 'note');
    assert.deepEqual(store.deliverArtifacts(), []);
    assert.equal(sent.mock.callCount(), 1);
    const [text, requestId] = sent.mock.calls[0].arguments;
    assert.equal(requestId, 'delo-artifact-answer-0001');
    assert.match(text, /ответ по материалу «Варианты плана».*Отправить выбор/);
    assert.match(text, new RegExp(`Полный ответ: ${done.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(text, /не рассмотрено/);
    assert.ok(existsSync(join(store.firstmate.home, 'data', task.id, 'artifacts', id, 'receipts', 'answer-0001.json')));
    assert.deepEqual(store.deliverArtifacts(), []); assert.equal(sent.mock.callCount(), 1, 'a delivered answer is not sent again');

    const more = store.supplementArtifact(id, { submissionId: 'more-00001', comment: 'И добавьте сроки' });
    assert.equal(more.delivered, true);
    assert.match(sent.mock.calls[1].arguments[0], /дополнение к ответу.*Прежний ответ остаётся в силе/s);
    assert.equal(store.artifacts.get(id).supplements.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('HTTP serves the copied material sandboxed, keeps the API from it and rejects an oversized answer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-artifact-http-'));
  const store = new Store({ firstmateHome: firstmateHome(root) }); const handle = router(store);
  try {
    const task = store.create({ title: 'Просмотр' });
    const { id } = store.publishArtifact({ source: material(root), title: 'Варианты', action: 'Выбрать', taskId: task.id });
    const meta = await (await handle(new Request('http://localhost:4317/api/meta'))).json();
    const call = (path: string, body: unknown, method = 'POST') => handle(new Request(`http://localhost:4317${path}`, { method, headers: { 'content-type': 'application/json', 'x-delo-csrf': meta.csrf, origin: 'http://localhost:4317' }, body: JSON.stringify(body) }));

    const page = await handle(new Request(`http://localhost:4317/artifacts/${id}/files/index.html`, { headers: { origin: 'null' } }));
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /sandbox allow-scripts.*frame-ancestors 'self'/);
    assert.doesNotMatch(page.headers.get('content-security-policy') ?? '', /allow-same-origin/);
    assert.match(await page.text(), /<head><script src="\/artifact-adapter.js"><\/script>/);
    assert.equal((await handle(new Request(`http://localhost:4317/artifacts/${id}/files/img/plan.png`))).headers.get('content-type'), 'image/png');
    assert.equal((await handle(new Request('http://localhost:4317/artifact-adapter.js', { headers: { origin: 'null' } }))).status, 200);
    assert.equal((await handle(new Request(`http://localhost:4317/artifacts/${id}/files/..%2Fartifact.json`))).status, 404);
    assert.equal(await (await handle(new Request(`http://localhost:4317/artifacts/${id}/files/index.html?view=markdown`))).text(), await (await handle(new Request(`http://localhost:4317/artifacts/${id}/files/index.html`))).text(), 'only Markdown has a rendered view');

    const source = '# Отчёт\n\n| Шаг | Итог |\n| --- | --- |\n| Проверка | `npm test` |\n\n```sh\nnpm run build\n```\n\n[Подробности](notes.md) <script>alert(1)</script> [опасная](javascript:alert(1))\n';
    writeFileSync(join(root, 'report.md'), source);
    const notes = store.publishArtifact({ source: join(root, 'report.md'), title: 'Отчёт', action: 'Прочитать', taskId: task.id });
    const raw = await handle(new Request(`http://localhost:4317/artifacts/${notes.id}/files/report.md`));
    assert.equal(raw.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await raw.text(), source, 'the plain address still serves the file as written');
    const view = await handle(new Request(`http://localhost:4317/artifacts/${notes.id}/files/report.md?view=markdown`));
    assert.equal(view.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(view.headers.get('content-security-policy'), "sandbox allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'");
    const rendered = await view.text();
    assert.match(rendered, /<h1>Отчёт<\/h1>[\s\S]*<table>[\s\S]*<td><code>npm test<\/code><\/td>[\s\S]*<pre><code class="language-sh">npm run build\n<\/code><\/pre>/);
    assert.match(rendered, /<a href="notes.md">Подробности<\/a> &lt;script&gt;alert\(1\)&lt;\/script&gt; \[опасная\]\(javascript:alert\(1\)\)/);
    assert.doesNotMatch(rendered, /<script/);
    assert.equal((await handle(new Request('http://localhost:4317/api/artifacts', { headers: { origin: 'null' } }))).status, 403, 'the material cannot read the queue');
    assert.equal((await handle(new Request(`http://localhost:4317/api/artifacts/${id}/draft`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: 'null' }, body: '{"draft":{}}' }))).status, 403);

    assert.equal((await call(`/api/artifacts/${id}/draft`, { draft: { comment: 'черновик' } }, 'PUT')).status, 200);
    assert.equal((await call(`/api/artifacts/${id}/pin`, { pinned: true })).status, 200);
    const list = await (await handle(new Request('http://localhost:4317/api/artifacts'))).json();
    const pinned = list.find((item: { id: string }) => item.id === id);
    assert.deepEqual([pinned.pinned, pinned.draft], [true, true]);
    const answered = await call(`/api/artifacts/${id}/complete`, { submissionId: 'http-answer-1', action: { kind: 'done', label: 'Ознакомился' } });
    assert.equal(answered.status, 200); assert.equal((await answered.json()).delivered, true);
    assert.equal((await call(`/api/artifacts/${id}/complete`, { submissionId: 'http-answer-2', action: { kind: 'done', label: 'Ознакомился' } })).status, 409);
    assert.equal((await handle(new Request('http://localhost:4317/api/artifacts/not-a-uuid'))).status, 400);
    assert.equal((await handle(new Request('http://localhost:4317/api/artifacts/00000000-0000-4000-8000-000000000000'))).status, 404);
  } finally { rmSync(root, { recursive: true, force: true }); }

  const { serve } = await import('../src/server.ts');
  const serverRoot = mkdtempSync(join(tmpdir(), 'delo-artifact-size-'));
  const server = serve(new Store({ firstmateHome: firstmateHome(serverRoot) }), 0);
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const response = await fetch(`${base}/api/artifacts/00000000-0000-4000-8000-000000000000/complete`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ comment: 'я'.repeat(600 * 1024) }) });
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /больше 1 МиБ.*введённое осталось/);
  } finally { server.close(); rmSync(serverRoot, { recursive: true, force: true }); }
});

test('CLI publishes a material for the task named in FM_TASK_ID', () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-artifact-cli-'));
  const home = firstmateHome(root); const store = new Store({ firstmateHome: home });
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  try {
    const task = store.create({ title: 'Сдача отчёта' });
    writeFileSync(join(root, 'notes.md'), '# Итог\n');
    const args = ['--disable-warning=ExperimentalWarning', cli, '--firstmate-home', home, 'publish-artifact', join(root, 'notes.md'), '--title', 'Итог работы', '--action', 'Прочитать итог', '--request-id', 'cli-1'];
    const env = { ...process.env, FM_TASK_ID: task.id };
    const created = JSON.parse(run(process.execPath, args, root, 45000, env));
    assert.equal(created.outcome, 'created');
    assert.equal(JSON.parse(run(process.execPath, args, root, 45000, env)).outcome, 'replay');
    assert.equal(store.artifacts.get(created.id).kind, 'file');
    assert.throws(() => run(process.execPath, args.slice(0, 5), root, 45000, env), /--title/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
