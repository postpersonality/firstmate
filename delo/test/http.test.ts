import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
