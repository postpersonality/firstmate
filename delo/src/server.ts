import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z, ZodError } from 'zod';
import type { Store } from './store.ts';
import { id, type Action } from './model.ts';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const send = (data: unknown, status = 200) => Response.json(data, { status });

// Tests pass a stub opener so no real desktop app starts.
export function router(store: Store, opener = 'xdg-open') {
  const csrf = randomBytes(24).toString('hex');
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return send({ error: 'Разрешён только локальный адрес' }, 403);
    if (req.headers.get('origin') && req.headers.get('origin') !== url.origin) return send({ error: 'Запрос с другого сайта запрещён' }, 403);
    if (!['GET', 'HEAD'].includes(req.method) && (req.headers.get('x-delo-csrf') !== csrf || !req.headers.get('content-type')?.startsWith('application/json'))) return send({ error: 'Запрос не прошёл проверку происхождения' }, 403);
    try {
      if (req.method === 'GET' && ['/', '/index.html', '/app.js', '/style.css'].includes(url.pathname)) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const content = name === 'app.js' ? stripTypeScriptTypes(readFileSync(`${web}/app.ts`, 'utf8')) : readFileSync(`${web}/${name}`, 'utf8');
        return new Response(content, { headers: { 'content-type': { 'index.html': 'text/html; charset=utf-8', 'style.css': 'text/css; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8' }[name]!, 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } });
      }
      if (req.method === 'GET' && url.pathname === '/api/meta') return send({ csrf });
      if (req.method === 'GET' && url.pathname === '/api/overview') return send(await store.overview());
      const pin = /^\/api\/tasks\/([^/]+)\/pin$/.exec(url.pathname);
      if (req.method === 'POST' && pin) {
        const taskId = decodeURIComponent(pin[1]); id.parse(taskId);
        return send(await store.pin(taskId, z.object({ pinned: z.boolean() }).parse(await req.json()).pinned));
      }
      const act = /^\/api\/tasks\/([^/]+)\/(start|pause|unhold|close|stop|decline|answer|release|later|reopen)$/.exec(url.pathname);
      if (req.method === 'POST' && act) {
        const taskId = decodeURIComponent(act[1]); id.parse(taskId);
        return send(store.act(taskId, act[2] as Action, await req.json()));
      }
      if (req.method === 'POST' && url.pathname === '/api/goals') return send(store.create(await req.json()), 201);
      if (req.method === 'POST' && url.pathname === '/api/cases') return send(store.createCase(await req.json()), 201);
      if (req.method === 'GET' && url.pathname === '/api/cases') return send(store.closedCases());
      if (req.method === 'GET' && url.pathname === '/api/review-projects') return send(store.reviewProjects());
      if (req.method === 'GET' && url.pathname === '/api/folders') return send(store.folders());
      const report = /^\/api\/reports\/([^/]+)$/.exec(url.pathname);
      const reportOpen = /^\/api\/reports\/([^/]+)\/open$/.exec(url.pathname);
      if ((req.method === 'GET' && report) || (req.method === 'POST' && reportOpen)) {
        let taskId = ''; try { taskId = decodeURIComponent((report ?? reportOpen)![1]); } catch { /* A malformed id is just not found. */ }
        const found = store.report(taskId);
        if (report) return send(found);
        // Q36Б: only a listed task's own report path is opened, detached and without a shell.
        const child = spawn(opener, [found.path], { detached: true, stdio: 'ignore' });
        await new Promise((resolve, reject) => child.once('spawn', resolve).once('error', error => reject(new Error(`Не удалось открыть отчёт в приложении: ${error.message}`))));
        child.unref(); return send({ ok: true });
      }
      const caseRoute = /^\/api\/cases\/([^/]+)(?:\/(close|reopen|continue|agent))?$/.exec(url.pathname);
      if (caseRoute) {
        const caseId = decodeURIComponent(caseRoute[1]); id.parse(caseId);
        if (req.method === 'GET' && !caseRoute[2]) return send(store.getCase(caseId));
        if (req.method === 'POST' && caseRoute[2] === 'close') return send(store.closeCase(caseId, await req.json()));
        if (req.method === 'POST' && caseRoute[2] === 'reopen') return send(store.reopenCase(caseId));
        if (req.method === 'POST' && caseRoute[2] === 'continue') return send(store.continueCase(caseId), 201);
        if (req.method === 'POST' && caseRoute[2] === 'agent') return send(store.newAgent(caseId, await req.json()), 201);
        return send({ error: 'Метод не поддерживается' }, 405);
      }
      const route = /^\/api\/goals\/([^/]+)$/.exec(url.pathname);
      if (!route) return send({ error: 'Не найдено' }, 404);
      const goalId = decodeURIComponent(route[1]); id.parse(goalId);
      if (req.method === 'GET') {
        const goal = store.get(goalId); const inbox = store.inbox(goalId);
        return send({ ...goal, requests: inbox.requests.filter(r => r.action && goal.actions.includes(r.action)), inbox, worker: await store.worker(goalId) });
      }
      if (req.method === 'PATCH') return send(store.update(goalId, await req.json()));
      return send({ error: 'Метод не поддерживается' }, 405);
    } catch (error: any) { return send({ error: error instanceof ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : error.message }, ['Цель не найдена', 'Отчёт не найден'].includes(error.message) ? 404 : 400); }
  };
}

export function serve(store: Store, port = 4317) {
  const handle = router(store);
  const server = createServer(async (incoming, outgoing) => {
    try {
      const host = incoming.headers.host ?? `localhost:${port}`;
      let body = ''; for await (const chunk of incoming) { body += chunk.toString(); if (Buffer.byteLength(body) > 1024 * 1024) { outgoing.writeHead(413); outgoing.end(); return; } }
      const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const request = new Request(`http://${host}${incoming.url}`, { method: incoming.method, headers, ...(!['GET', 'HEAD'].includes(incoming.method ?? 'GET') ? { body } : {}) });
      const response = await handle(request); outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
    } catch (error: any) { outgoing.writeHead(500, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify({ error: error.message })); }
  });
  server.on('error', error => { console.error(`Дело: ${error.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Дело: http://localhost:${port}\nFirstmate: ${store.firstmate.home}`));
  return server;
}
