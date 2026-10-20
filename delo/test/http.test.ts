import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';
import { firstmateHome } from './firstmate-home.ts';

test('HTTP creates a goal, edits it, reads the card and rejects foreign origins and removed routes', async () => {
  const { router } = await import('../src/server.ts');
  const root = mkdtempSync(join(tmpdir(), 'delo-http-')); const s = new Store({ firstmateHome: firstmateHome(root) }); const handle = router(s);
  try {
    const meta = await (await handle(new Request('http://localhost:4317/api/meta'))).json();
    const request = (path: string, body: unknown, method = 'POST') => handle(new Request(`http://localhost:4317${path}`, { method, headers: { 'content-type': 'application/json', 'x-delo-csrf': meta.csrf, origin: 'http://localhost:4317' }, body: JSON.stringify(body) }));
    const created = await request('/api/goals', { title: 'Проверка HTTP', body: 'Важные сведения' }); assert.equal(created.status, 201);
    const g = await created.json();
    const patch = await request(`/api/goals/${g.id}`, { title: 'Проверка HTTP заново' }, 'PATCH'); assert.equal(patch.status, 200);
    assert.equal(s.get(g.id).body, 'Важные сведения');
    const card = await handle(new Request(`http://localhost:4317/api/goals/${g.id}`)); assert.equal(card.status, 200);
    assert.deepEqual(Object.keys(await card.json()).filter(k => ['cover', 'journal', 'knowledge', 'tracker', 'areas', 'space'].includes(k)), []);
    assert.equal((await request(`/api/tasks/${g.id}/pause`, {})).status, 200);
    assert.equal(s.firstmate.show(g.id).hold_kind, 'parked');
    assert.equal((await request(`/api/tasks/${g.id}/start`, {})).status, 400, 'a paused row cannot be started');
    assert.equal((await request(`/api/tasks/${g.id}/spawn`, {})).status, 404);
    assert.equal((await request('/api/tasks/..%2Fx/close', {})).status, 400);
    const actionCsrf = await handle(new Request(`http://localhost:4317/api/tasks/${g.id}/unhold`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })); assert.equal(actionCsrf.status, 403);
    assert.equal(s.firstmate.show(g.id).hold_kind, 'parked');
    for (const path of [`/api/goals/${g.id}/reports`, `/api/goals/${g.id}/links`, `/api/goals/${g.id}/knowledge`, `/api/goals/${g.id}/seen`, `/api/goals/${g.id}/tracker`, '/api/refresh']) assert.equal((await request(path, {})).status, 404, path);
    assert.equal((await handle(new Request('http://localhost:4317/api/search?q=SQLite'))).status, 404);
    const foreign = await handle(new Request('http://localhost:4317/api/goals', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json', 'x-delo-csrf': meta.csrf }, body: '{}' })); assert.equal(foreign.status, 403);
    const rebinding = await handle(new Request('http://evil.example:4317/api/goals')); assert.equal(rebinding.status, 403);
    const csrf = await handle(new Request('http://localhost:4317/api/goals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })); assert.equal(csrf.status, 403);
    const pinCsrf = await handle(new Request(`http://localhost:4317/api/tasks/${g.id}/pin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"pinned":true}' })); assert.equal(pinCsrf.status, 403);
    const overview = await handle(new Request('http://localhost:4317/api/overview')); assert.equal(overview.status, 200); assert.ok('focus' in await overview.json());
    assert.equal((await handle(new Request('http://localhost:4317/api/goals'))).status, 404, 'the goal list gave way to the overview');
    const page = await handle(new Request('http://localhost:4317/')); assert.equal(page.status, 200); assert.match(await page.text(), /Дело/);
    const code = await handle(new Request('http://localhost:4317/app.js')); assert.equal(code.status, 200);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('gated snapshots leave HTTP responsive and concurrent overviews share one read', async t => {
  const { serve } = await import('../src/server.ts');
  const root = mkdtempSync(join(tmpdir(), 'delo-slow-http-'));
  mkdirSync(join(root, 'bin'));
  for (const name of ['fm-bearings-snapshot.sh', 'fm-fleet-snapshot.sh']) writeFileSync(join(root, 'bin', name), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.FM_HOME + '/calls', '${name}\\n');
const end = Date.now() + 600;
while (!fs.existsSync(process.env.FM_HOME + '/release') && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
console.log('{}');
`, { mode: 0o755 });
  const store = new Store({ firstmateHome: root });
  store.firstmate.list = () => []; store.firstmate.archive = () => []; store.firstmate.receipts = () => ({});
  const server = serve(store, 0);
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    let finished = false;
    const first = fetch(`${base}/api/overview`).then(r => { finished = true; return r.json(); });
    const second = fetch(`${base}/api/overview`).then(r => r.json());
    for (let i = 0; i < 100 && !existsSync(join(root, 'calls')); i++) await new Promise(resolve => setTimeout(resolve, 10));
    const start = performance.now();
    assert.ok((await fetch(`${base}/api/meta`)).ok);
    const elapsed = performance.now() - start;
    t.diagnostic(`meta during gated snapshot: ${elapsed.toFixed(1)} ms`);
    assert.ok(elapsed < 100, 'meta responds in under 100 ms while snapshot is gated');
    assert.equal(finished, false, 'the overview is still waiting on the synthetic gate');
    writeFileSync(join(root, 'release'), '');
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.deepEqual(readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').sort(), ['fm-bearings-snapshot.sh', 'fm-fleet-snapshot.sh']);
    assert.deepEqual(await (await fetch(`${base}/api/overview`)).json(), a, 'a recent overview is cached');
    assert.equal(readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').length, 2);
  } finally {
    writeFileSync(join(root, 'release'), '');
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});


test('pin and task POSTs return receipts without waiting for an overview', async () => {
  const { router } = await import('../src/server.ts');
  const root = mkdtempSync(join(tmpdir(), 'delo-receipt-http-'));
  const store = new Store({ firstmateHome: firstmateHome(root) });
  const task = store.create({ title: 'Квитанция' });
  let calls = 0;
  store.firstmate.snapshot = async script => {
    calls++;
    assert.equal(script, 'fm-fleet-snapshot.sh', 'a POST never starts the bearings overview');
    return { backlog: { records: [{ id: task.id, state: 'queued' }] } };
  };
  const handle = router(store);
  try {
    const { csrf } = await (await handle(new Request('http://localhost/api/meta'))).json();
    const post = (action: string, body: unknown) => handle(new Request(`http://localhost/api/tasks/${task.id}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-delo-csrf': csrf }, body: JSON.stringify(body) }));
    const pin = await post('pin', { pinned: true });
    assert.equal(pin.status, 200); assert.deepEqual(await pin.json(), { ok: true });
    const start = await post('start', {});
    assert.equal(start.status, 200); assert.ok((await start.json()).note.id);
    assert.equal(calls, 1, 'only the authoritative pin check needs a snapshot');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
