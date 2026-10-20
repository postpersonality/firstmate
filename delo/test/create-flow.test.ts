import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { randomUUID } from 'node:crypto';
import { validateReview } from '../src/review.ts';
import { Store } from '../src/store.ts';
import { router } from '../src/server.ts';
import { firstmateHome, stubLog } from './firstmate-home.ts';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const source = stripTypeScriptTypes(readFileSync(new URL('../web/app.ts', import.meta.url), 'utf8'));
const until = async (check: () => unknown) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 15)); assert.ok(check()); };

// The real router/backlog in temporary homes; snapshots and transport stay synthetic.
function browser(store: Store, saved: [string, string][] = []) {
  const handle = router(store);
  store.overview = async () => ({ generated: '', cases: [], repos: [], kinds: [], focus: [], waiting: [], working: [], next: [], done: [] }) as any;
  const dom = new JSDOM(html, { url: 'http://localhost:4317/', runScripts: 'outside-only' });
  const { window } = dom; const document: Document = window.document;
  window.setInterval = () => 0;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  for (const [key, value] of saved) window.localStorage.setItem(key, value);
  window.fetch = async (path: string, init: RequestInit = {}) => {
    assert.ok(path.startsWith('/api/'), 'no external URL is fetched by the frontend');
    return handle(new Request(new URL(path, window.location.href), init));
  };
  window.eval(source);
  const input = (name: string) => document.querySelector<HTMLInputElement>(`#dialog-body [name=${name}]`)!;
  const change = (name: string, value: string) => { input(name).value = value; input(name).dispatchEvent(new window.Event('input', { bubbles: true })); input(name).dispatchEvent(new window.Event('change', { bubbles: true })); };
  const submit = () => document.getElementById('dialog-form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const savedDrafts = (): [string, string][] => Object.entries(window.localStorage);
  return { window, document, input, change, submit, savedDrafts, handle };
}

test('description-only creation keeps text and link context, accepts any existing project, and keeps typed review/duty guards', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-create-input-')); const originalHome = process.env.HOME;
  try {
    process.env.HOME = root;
    const home = firstmateHome(root); const store = new Store({ firstmateHome: home });
    const project = join(root, 'External project'); const materials = join(root, 'Materials'); mkdirSync(project); mkdirSync(materials);
    writeFileSync(join(project, 'untouched'), 'original');
    const description = '  https://private.example/spec/123?token=opaque\n  ';
    const goal = store.create({ description, repo: '~/External project' });
    assert.equal(goal.title, 'private.example/spec/123'); assert.equal(goal.repo, project);
    assert.equal(goal.description, description, 'the stored description round-trips even when native Markdown normalizes whitespace');
    assert.equal(validateReview({ kind: 'sa', document: 'https://private.example/spec/123', repo: '~/External project' }, home).repo, project);
    process.env.HOME = originalHome;
    const c = store.createCase({ description: 'Разобрать поток. Следующий шаг', repo: project });
    assert.equal(c.title, 'Разобрать поток.'); assert.equal(c.context, 'Разобрать поток. Следующий шаг');
    const duty = store.createCase({ description: 'Дежурство', caseType: 'duty', repo: project });
    assert.equal(duty.folder, project, 'one chosen project supplies the default read-only duty context');
    assert.throws(() => store.newAgent(duty.id, { direction: 'Правь файлы', kind: 'ship' }), /дежурств/i);
    const review = store.createCase({ description, requestId: randomUUID(), review: { kind: 'sa', document: 'https://private.example/spec/123', repo: project } });
    assert.equal(review.repo, project); assert.equal(review.review?.repo, project);
    assert.equal(store.get(review.tasks[0].id).description, description, 'review worker receives the exact original description');
    assert.equal(review.description, description);
    const code = store.createCase({ description: 'https://github.com/org/repo/pull/7', requestId: randomUUID(), review: { kind: 'code', url: 'https://github.com/org/repo/pull/7', repo: project } });
    assert.equal(store.get(code.tasks[0].id).kind, 'scout');
    store.create({ title: 'Legacy API', body: 'Original', repo: 'legacy-name', folder: materials });
    const before = store.list().length;
    writeFileSync(join(root, 'file'), 'not a folder');
    for (const repo of ['relative/path', join(root, 'absent'), join(root, 'file')]) {
      assert.throws(() => store.create({ description: 'Invalid project', repo }), /Проект:/);
      assert.throws(() => store.createCase({ description: 'Invalid project', repo }), /Проект:/);
    }
    assert.throws(() => store.create({ description: ' \n ' }), /описание/);
    assert.throws(() => store.createCase({ description: '' }), /описание/);
    assert.equal(store.list().length, before);
    assert.deepEqual(store.projectFolders(), [project], 'source-only folders and unresolved historical names are not project recents');
    assert.equal(readFileSync(join(project, 'untouched'), 'utf8'), 'original');
    assert.equal(store.firstmate.receipts().pending.length, 0, 'creation queues context, never starts a worker');
    assert.equal((existsSync(stubLog) ? readFileSync(stubLog, 'utf8').trim() : ''), '', 'no paid/native lifecycle transport');
  } finally { process.env.HOME = originalHome; rmSync(root, { recursive: true, force: true }); }
});

test('case and task drafts survive kind changes, close, reload and refusals; success clears only the accepted form in its home', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-create-draft-'));
  let b: ReturnType<typeof browser> | undefined;
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) }); const project = join(root, 'User folder'); mkdirSync(project);
    b = browser(store); await until(() => b!.document.querySelector('main h1'));
    b.document.getElementById('new-case')!.click();
    assert.equal(b.document.querySelector('[name=title]'), null, 'no invented title is required');
    assert.deepEqual([...b.document.querySelectorAll('#dialog-body > label [name]')].map(e => e.getAttribute('name')), ['description', 'reviewKind', 'reviewRepo']);
    assert.equal(b.document.querySelector('details')?.open, false);
    b.change('description', 'https://github.com/org/repo/pull/7'); b.change('reviewRepo', project);
    b.change('reviewKind', 'sa'); b.change('document', 'https://private.example/spec');
    b.change('reviewKind', 'code'); b.change('url', 'https://github.com/org/repo/pull/8');
    b.change('reviewKind', 'sa'); assert.equal(b.input('document').value, 'https://private.example/spec');
    const requestId = b.input('requestId').value;
    b.document.getElementById('dialog-close')!.click();
    b.document.getElementById('new-goal')!.click(); b.change('description', 'Task draft'); b.change('kind', 'scout'); b.change('repo', project); b.change('folder', project);
    b.document.getElementById('dialog-close')!.click();
    let saved = b.savedDrafts(); b.window.close(); b = browser(store, saved);
    await until(() => b!.document.querySelector('main h1')); b.document.getElementById('new-case')!.click();
    assert.equal(b.input('description').value, 'https://github.com/org/repo/pull/7'); assert.equal(b.input('reviewKind').value, 'sa');
    assert.equal(b.input('document').value, 'https://private.example/spec'); assert.equal(b.input('requestId').value, requestId);
    b.change('reviewKind', ''); b.change('reviewRepo', 'relative/project'); b.submit();
    await until(() => b!.document.getElementById('dialog-error')!.textContent?.includes('Проект:'));
    b.document.getElementById('dialog-close')!.click(); b.document.getElementById('new-case')!.click();
    assert.equal(b.input('reviewRepo').value, 'relative/project'); b.change('reviewRepo', project);
    const originalFetch = b.window.fetch;
    b.window.fetch = async () => { throw new Error('network offline'); }; b.submit();
    await until(() => b!.document.getElementById('dialog-error')!.textContent === 'network offline');
    b.document.getElementById('dialog-close')!.click(); b.document.getElementById('new-case')!.click();
    assert.equal(b.input('description').value, 'https://github.com/org/repo/pull/7');
    b.window.fetch = originalFetch; b.submit(); await until(() => !(b!.document.getElementById('dialog') as HTMLDialogElement).open);
    assert.equal(store.list().length, 1); assert.ok(b.savedDrafts().every(([key]) => !key.endsWith(':case')));
    b.document.getElementById('new-case')!.click(); assert.equal(b.input('description').value, '');
    b.document.getElementById('dialog-close')!.click(); b.document.getElementById('new-goal')!.click();
    assert.equal(b.input('description').value, 'Task draft'); assert.equal(b.input('kind').value, 'scout'); assert.equal(b.input('folder').value, project);
    b.submit(); await until(() => !(b!.document.getElementById('dialog') as HTMLDialogElement).open);
    assert.equal(store.list().length, 2);
    b.document.getElementById('new-goal')!.click(); b.change('description', 'Only in original home');
    saved = b.savedDrafts(); b.window.close();
    const otherRoot = join(root, 'other'); mkdirSync(otherRoot);
    b = browser(new Store({ firstmateHome: firstmateHome(otherRoot) }), saved);
    await until(() => b!.document.querySelector('main h1')); b.document.getElementById('new-goal')!.click();
    assert.equal(b.input('description').value, '', 'another home at the same browser origin cannot inherit the draft');
  } finally { b?.window.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a link alone creates a typed code review through the real browser/router without fetching it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-create-link-')); let b: ReturnType<typeof browser> | undefined;
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) }); b = browser(store);
    await until(() => b!.document.querySelector('main h1')); b.document.getElementById('new-case')!.click();
    b.change('description', 'https://jira.example.invalid/browse/EXAMPLE-123'); b.change('reviewKind', 'code');
    b.submit(); await until(() => store.list().length === 2);
    const c = store.list().find(g => g.kind === 'program')!;
    assert.equal(c.review?.kind, 'code'); assert.equal(c.title, 'jira.example.invalid/browse/EXAMPLE-123');
    assert.equal(c.context, 'https://jira.example.invalid/browse/EXAMPLE-123');
    assert.equal(store.firstmate.receipts().pending.length, 0);
  } finally { b?.window.close(); rmSync(root, { recursive: true, force: true }); }
});

test('recent project suggestions include archived and external folders, with registry only supplying suggestions', async t => {
  const root = mkdtempSync(join(tmpdir(), 'delo-project-recents-'));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) }); const older = join(root, 'old'); const recent = join(root, 'recent');
    mkdirSync(older); mkdirSync(recent);
    t.mock.method(store.firstmate, 'list', () => [{ id: 'new', title: 'New', kind: 'ship', state: 'queued', body: '', repo: recent, created: '2026-10-20' }]);
    t.mock.method(store.firstmate, 'archive', () => [{ id: 'old', title: 'Old', kind: 'program', state: 'done', body: '', repo: older, created: '2026-10-01' }]);
    const response = await router(store)(new Request('http://localhost:4317/api/project-folders'));
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), [recent, older]);
    const b = browser(store);
    try {
      await until(() => b.document.querySelector('main h1')); b.document.getElementById('new-case')!.click();
      await until(() => b.document.querySelectorAll('#reviewRepo-list option').length === 2);
      assert.deepEqual([...b.document.querySelectorAll<HTMLOptionElement>('#reviewRepo-list option')].map(o => o.value), [recent, older]);
      assert.equal(b.document.querySelector('[data-project-choice]'), null, 'one path input also contains the suggestions');
      b.change('reviewRepo', root); assert.equal(b.input('reviewRepo').checkValidity(), true, 'a folder outside the suggestions is accepted');
    } finally { b.window.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an accepted slow request cannot erase or close a different form opened while it was pending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-create-race-')); let b: ReturnType<typeof browser> | undefined;
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) }); b = browser(store);
    await until(() => b!.document.querySelector('main h1')); b.document.getElementById('new-case')!.click(); b.change('description', 'Slow case');
    const fetch = b.window.fetch; let release: (() => void) | undefined;
    b.window.fetch = async (path: string, init: RequestInit = {}) => {
      if (path === '/api/cases' && init.method === 'POST') await new Promise<void>(resolve => { release = resolve; });
      return fetch(path, init);
    };
    b.submit(); await until(() => release);
    b.document.getElementById('dialog-close')!.click(); b.document.getElementById('new-goal')!.click(); b.change('description', 'New task draft');
    release!(); await until(() => store.list().length === 1);
    await new Promise(r => setTimeout(r, 30));
    assert.equal((b.document.getElementById('dialog') as HTMLDialogElement).open, true);
    assert.equal(b.input('description').value, 'New task draft');
    assert.ok(b.savedDrafts().some(([key, value]) => key.endsWith(':goal') && value.includes('New task draft')));
    assert.ok(b.savedDrafts().every(([key]) => !key.endsWith(':case')));
  } finally { b?.window.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a service switching homes refuses the old form instead of replaying its mutation into the new home', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-create-home-switch-')); let b: ReturnType<typeof browser> | undefined;
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) }); b = browser(store);
    await until(() => b!.document.querySelector('main h1')); b.document.getElementById('new-case')!.click(); b.change('description', 'Home-bound draft');
    const otherRoot = join(root, 'other'); mkdirSync(otherRoot);
    const other = new Store({ firstmateHome: firstmateHome(otherRoot) }); const handle = router(other);
    b.window.fetch = async (path: string, init: RequestInit = {}) => handle(new Request(new URL(path, b!.window.location.href), init));
    b.submit(); await until(() => b!.document.getElementById('dialog-error')!.textContent);
    assert.equal(store.list().length, 0); assert.equal(other.list().length, 0);
    assert.equal(b.input('description').value, 'Home-bound draft');
    assert.ok(b.savedDrafts().some(([, value]) => value.includes('Home-bound draft')));
  } finally { b?.window.close(); rmSync(root, { recursive: true, force: true }); }
});

test('new-agent drafts belong to the selected case and its project context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-agent-draft-')); let b: ReturnType<typeof browser> | undefined;
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) }); const project = join(root, 'project'); mkdirSync(project);
    const first = store.createCase({ description: 'First', repo: root }); const second = store.createCase({ description: 'Second', repo: project });
    b = browser(store); await until(() => b!.document.querySelector('main h1'));
    const open = async (id: string, title: string) => {
      b!.window.location.hash = `case:${id}`; await until(() => b!.document.querySelector('main h1')?.textContent === title);
      b!.document.querySelector<HTMLButtonElement>('[data-action=agent-case]')!.click(); await until(() => (b!.document.getElementById('dialog') as HTMLDialogElement).open && b!.document.getElementById('dialog-title')?.textContent === 'Новый агент');
    };
    await open(first.id, 'First'); b.change('direction', 'First direction'); b.document.getElementById('dialog-close')!.click();
    await open(second.id, 'Second'); assert.notEqual(b.input('direction').value, 'First direction'); assert.equal(b.input('repo').value, project);
    b.document.getElementById('dialog-close')!.click(); await open(first.id, 'First'); assert.equal(b.input('direction').value, 'First direction');
    b.document.getElementById('dialog-close')!.click(); store.update(first.id, { repo: project });
    b.window.location.hash = ''; await until(() => b!.document.querySelector('main h1')?.textContent === 'Что сейчас происходит');
    await open(first.id, 'First'); assert.notEqual(b.input('direction').value, 'First direction'); assert.equal(b.input('repo').value, project);
    assert.equal(store.firstmate.receipts().pending.length, 0, 'opening/restoring a draft never requests an agent');
  } finally { b?.window.close(); rmSync(root, { recursive: true, force: true }); }
});

test('description cards and editing retain later native context while hiding exact-input storage metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-description-card-')); let b: ReturnType<typeof browser> | undefined;
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) });
    const goal = store.create({ description: 'Initial description' });
    store.firstmate.update(goal.id, { body: goal.body + '\nLater context from the agent' });
    b = browser(store); await until(() => b!.document.querySelector('main h1')); b.window.location.hash = goal.id;
    await until(() => b!.document.querySelector('main h1')?.textContent === goal.title);
    assert.match(b.document.querySelector('main')!.textContent!, /Initial description.*Later context from the agent/s);
    assert.doesNotMatch(b.document.querySelector('main')!.textContent!, /Delo description:/);
    b.document.querySelector<HTMLButtonElement>('[data-action=edit]')!.click();
    await until(() => (b!.document.getElementById('dialog') as HTMLDialogElement).open);
    assert.match(b.input('body').value, /Later context from the agent/); assert.doesNotMatch(b.input('body').value, /Delo description:/);
    assert.equal(store.get(goal.id).description, 'Initial description', 'exact original input remains available separately');
  } finally { b?.window.close(); rmSync(root, { recursive: true, force: true }); }
});
