import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { router } from '../src/server.ts';
import { firstmateHome } from './firstmate-home.ts';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as any;
const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const app = stripTypeScriptTypes(readFileSync(new URL('../web/app.ts', import.meta.url), 'utf8'));
const until = async (check: () => unknown) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 25)); assert.ok(check()); };

// Each call is a fresh tab on a fresh server process over the same Firstmate home.
function open(home: string, hash: string) {
  const handle = router(new Store({ firstmateHome: home }));
  const dom = new JSDOM(page, { url: `http://localhost:4317/${hash}`, runScripts: 'outside-only' });
  const { window } = dom;
  window.setInterval = (() => 0) as typeof window.setInterval;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.fetch = async (input: string, init: RequestInit = {}) => handle(new Request(new URL(String(input), window.location.href), init));
  window.eval(app);
  return window;
}

test('the queue filters and pins materials, and the desk keeps a draft across a restart and returns to the queue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-artifact-ui-'));
  const home = firstmateHome(root); const store = new Store({ firstmateHome: home });
  const windows: any[] = [];
  try {
    const task = store.create({ title: 'Подготовить итоги' });
    mkdirSync(join(root, 'work'));
    writeFileSync(join(root, 'work', 'summary.md'), '# Итоги\n');
    writeFileSync(join(root, 'work', 'review.html'), '<!doctype html><html><head></head><body><div data-lavish-question="q"><input name="a"></div></body></html>');
    const notes = store.publishArtifact({ source: join(root, 'work', 'summary.md'), title: 'Итоги недели', action: 'Прочитать итоги', taskId: task.id });
    const form = store.publishArtifact({ source: join(root, 'work', 'review.html'), title: 'Опрос по плану', action: 'Ответить на вопросы', taskId: task.id });

    let window = open(home, '#artifacts'); windows.push(window);
    const doc = () => window.document as Document;
    await until(() => doc().querySelectorAll('#artifact-rows .row').length === 2);
    assert.equal(doc().getElementById('artifacts-count')!.textContent, '2');
    assert.deepEqual([...doc().querySelectorAll('#artifact-rows strong a')].map(a => a.textContent), ['Итоги недели', 'Опрос по плану'], 'the oldest material comes first');
    const search = doc().getElementById('artifact-search') as HTMLInputElement;
    search.value = 'опрос'; search.dispatchEvent(new window.Event('input'));
    assert.deepEqual([...doc().querySelectorAll('#artifact-rows strong a')].map(a => a.textContent), ['Опрос по плану']);
    search.value = ''; search.dispatchEvent(new window.Event('input'));
    (doc().querySelectorAll<HTMLButtonElement>('[data-action="artifact-pin"]')[1]).click();
    await until(() => doc().querySelector('#artifact-rows strong a')?.textContent === 'Опрос по плану');
    assert.match(doc().querySelector('#artifact-rows .row')!.textContent!, /Закреплено/);

    window.location.hash = `artifact:${notes.id}`;
    await until(() => doc().getElementById('artifact-comment'));
    assert.ok(doc().body.classList.contains('desk'), 'the desk takes the full width');
    assert.equal(doc().getElementById('artifact-submit')!.textContent, 'Ознакомился');
    const comment = doc().getElementById('artifact-comment') as HTMLTextAreaElement;
    comment.value = 'Добавьте раздел о рисках'; comment.dispatchEvent(new window.Event('input'));
    assert.equal(doc().getElementById('artifact-submit')!.textContent, 'Передать комментарий');
    await until(() => store.artifacts.get(notes.id).draftValue);
    window.close();

    window = open(home, `#artifact:${notes.id}`); windows.push(window);
    await until(() => doc().getElementById('artifact-comment'));
    assert.equal((doc().getElementById('artifact-comment') as HTMLTextAreaElement).value, 'Добавьте раздел о рисках', 'the draft comes back after a restart');
    assert.match(doc().getElementById('artifact-draft-state')!.textContent!, /Черновик сохранён/);
    doc().getElementById('artifact-submit')!.click();
    await until(() => window.location.hash === '#artifacts' && doc().querySelectorAll('#artifact-rows .row').length === 1);
    assert.match(doc().getElementById('message')!.textContent!, /передан Firstmate/);
    const done = store.artifacts.get(notes.id).completion!;
    assert.deepEqual([done.action.kind, done.comment], ['comment', 'Добавьте раздел о рисках']);
    assert.equal(doc().getElementById('artifacts-count')!.textContent, '1');

    window.location.hash = 'artifacts:archive';
    await until(() => doc().querySelector('main h1')?.textContent?.startsWith('Архив материалов') && doc().querySelector('#artifact-rows .row'));
    assert.match(doc().querySelector('#artifact-rows .row')!.textContent!, /Итоги недели.*Передать комментарий/s);

    window.location.hash = `artifact:${form.id}`;
    await until(() => doc().getElementById('artifact-frame'));
    const frame = doc().getElementById('artifact-frame') as HTMLIFrameElement;
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts allow-forms allow-modals allow-popups allow-downloads');
    assert.equal(doc().getElementById('artifact-submit'), null, 'an interactive material answers with its own button');
    const replies: any[] = [];
    frame.contentWindow!.postMessage = ((message: unknown) => { replies.push(message); }) as any;
    const send = { type: 'delo-artifact', kind: 'send', request: 'r1', prompts: [{ prompt: 'План принят частично', queueKey: 'q' }], fields: { 'q|a|': 'частично' }, label: 'Отправить ответ' };
    window.dispatchEvent(new window.MessageEvent('message', { data: send, source: window }));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(store.artifacts.get(form.id).completion, undefined, 'only the desk frame may answer');
    window.dispatchEvent(new window.MessageEvent('message', { data: send, source: frame.contentWindow }));
    await until(() => store.artifacts.get(form.id).completion);
    assert.deepEqual(store.artifacts.get(form.id).completion!.payload, { prompts: send.prompts, fields: send.fields });
    await until(() => replies.some(r => r.kind === 'sent' && r.ok));
  } finally { windows.forEach(w => w.close()); rmSync(root, { recursive: true, force: true }); }
});

test('the material adapter queues answers per question, reports the draft and restores it', async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div data-lavish-question="choice"><label><input type="radio" name="v" value="a"></label><label><input type="radio" name="v" value="b"></label></div><textarea id="note"></textarea><button id="send">Отправить выбор</button></body></html>', { url: 'http://localhost:4317/artifacts/x/files/index.html', runScripts: 'outside-only' });
  const { window } = dom; const posted: any[] = [];
  window.postMessage = ((message: unknown) => { posted.push(message); }) as any;
  try {
    window.eval(stripTypeScriptTypes(readFileSync(new URL('../web/artifact-adapter.ts', import.meta.url), 'utf8')));
    const [a, b] = window.document.querySelectorAll('input');
    window.lavish.queuePrompt('Вариант А', { element: a });
    assert.equal(window.lavish.queuePrompt('Вариант Б', { element: b }), 1, 'a new answer to the same question replaces the old one');
    b.checked = true; b.dispatchEvent(new window.Event('change', { bubbles: true }));
    await until(() => posted.some(m => m.kind === 'draft' && m.fields['choice|v|b'] === true));
    assert.equal(posted.findLast(m => m.kind === 'draft').prompts.map((p: any) => p.prompt).join('|'), 'Вариант Б');

    window.document.getElementById('send')!.click();
    const sent = window.lavish.sendQueuedPrompts();
    const request = posted.findLast(m => m.kind === 'send');
    assert.equal(request.label, 'Отправить выбор');
    window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'delo-artifact', kind: 'sent', request: request.request, ok: true }, source: window }));
    assert.equal((await sent).ok, true);

    window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'delo-artifact', kind: 'restore', fields: { 'choice|v|a': true, 'choice|v|b': false, '|note|': 'Черновик' }, prompts: [] }, source: window }));
    assert.equal(a.checked, true);
    assert.equal((window.document.getElementById('note') as HTMLTextAreaElement).value, 'Черновик');
  } finally { window.close(); }
});
