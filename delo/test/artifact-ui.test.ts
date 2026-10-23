import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { router } from '../src/server.ts';
import { firstmateHome } from './firstmate-home.ts';
import { run } from '../src/process.ts';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as any;
const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const app = stripTypeScriptTypes(readFileSync(new URL('../web/app.ts', import.meta.url), 'utf8'));
const until = async (check: () => unknown) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 25)); assert.ok(check()); };

// Each call is a fresh tab on a fresh server process over the same Firstmate home.
function open(home: string, hash: string, handle = router(new Store({ firstmateHome: home })), storage: Record<string, string> = {}) {
  const dom = new JSDOM(page, { url: `http://localhost:4317/${hash}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.setInterval = ((callback: () => Promise<void>) => { window.deloRefresh = callback; return 0; }) as typeof window.setInterval;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.fetch = async (input: string, init: RequestInit = {}) => handle(new Request(new URL(String(input), window.location.href), init));
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
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
    const reading = doc().querySelector('.artifact-frame') as HTMLIFrameElement;
    assert.match(reading.getAttribute('src')!, /\/files\/summary\.md\?view=markdown$/, 'Markdown is shown formatted');
    assert.equal(reading.getAttribute('sandbox'), 'allow-popups allow-popups-to-escape-sandbox');
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
  const dom = new JSDOM('<!doctype html><html><head></head><body><div data-lavish-question="choice"><label><input type="radio" name="v" value="a"></label><label><input type="radio" name="v" value="b"></label></div><textarea id="note"></textarea><button id="send">Отправить выбор</button></body></html>', { url: 'http://localhost:4317/artifacts/x/files/index.html', runScripts: 'outside-only', pretendToBeVisual: true });
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


test('native questions share the queue and desk, preserving drafts through refresh, failure and repeated submission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-question-ui-'));
  const home = firstmateHome(root); const store = new Store({ firstmateHome: home });
  let window: any;
  try {
    const question = 'Какой путь выбрать?\n' + 'Полный вариант и его последствия. '.repeat(120);
    const call = store.firstmate.add('native-call', 'Выбор пути', 'Контекст вопроса без сокращения', { kind: 'captain', repo: 'firstmate' });
    run(join(home, 'bin', 'fm-captain-hold.sh'), ['hold', call.id, '--reason', question], home, 45000, { ...process.env, FM_HOME: home });
    const real = router(store); let posts = 0; let fail = true; let release: (() => void) | undefined;
    window = open(home, '#artifacts', async req => {
      if (req.method === 'POST' && req.url.endsWith('/answer')) {
        posts++;
        if (fail) return Response.json({ error: 'Ответ не записан' }, { status: 400 });
        await new Promise<void>(resolve => { release = resolve; });
      }
      return real(req);
    });
    const doc = window.document as Document;
    await until(() => doc.querySelector('#artifact-rows strong a'));
    assert.equal(doc.getElementById('artifacts-count')!.textContent, '1');
    assert.equal(doc.querySelector('#artifact-rows strong a')!.getAttribute('href'), '#question:native-call');
    // A saved task URL keeps the task card and links to the same desk, without a second answer form.
    window.location.hash = call.id;
    await until(() => doc.getElementById('task-assignment'));
    assert.equal(doc.querySelector('a[href="#question:native-call"]')?.textContent, 'Открыть вопрос на просмотр');
    (doc.querySelector('[data-task-action=answer]') as HTMLButtonElement).click();
    await until(() => doc.getElementById('question-answer'));
    assert.ok(doc.body.classList.contains('desk'));
    assert.equal(doc.getElementById('answer-question')!.textContent, question);
    assert.match(doc.getElementById('question-context')!.textContent!, /Контекст вопроса без сокращения/);
    assert.equal(doc.querySelector('#dialog-body [name=answer]'), null);
    let answer = doc.getElementById('question-answer') as HTMLTextAreaElement;
    answer.value = 'Выбираю второй вариант'; answer.dispatchEvent(new window.Event('input'));
    const localDraft = Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)).find((k: any) => k.includes('question:'));
    assert.ok(localDraft); assert.match(window.localStorage.getItem(localDraft), /Выбираю второй вариант/);
    const restarted = open(home, '#question:native-call', undefined, { [localDraft as string]: window.localStorage.getItem(localDraft) });
    try {
      await until(() => restarted.document.getElementById('question-answer'));
      assert.equal(restarted.document.getElementById('question-answer').value, 'Выбираю второй вариант', 'a new tab/server restores the browser draft');
    } finally { restarted.close(); }

    window.location.hash = 'artifacts';
    await until(() => doc.getElementById('artifact-started'));
    await until(() => /Есть черновик/.test(doc.getElementById('artifact-rows')!.textContent!));
    const started = doc.getElementById('artifact-started') as HTMLInputElement;
    started.checked = true; started.dispatchEvent(new window.Event('change'));
    assert.equal(doc.querySelectorAll('#artifact-rows .row').length, 1);
    const search = doc.getElementById('artifact-search') as HTMLInputElement;
    search.value = 'другой'; search.dispatchEvent(new window.Event('input'));
    assert.equal(doc.querySelectorAll('#artifact-rows .row').length, 0);
    search.value = 'выбор'; search.dispatchEvent(new window.Event('input'));
    assert.equal(doc.querySelectorAll('#artifact-rows .row').length, 1);
    const group = doc.getElementById('artifact-group') as HTMLSelectElement;
    group.value = 'project:firstmate'; group.dispatchEvent(new window.Event('change'));
    assert.equal(doc.querySelectorAll('#artifact-rows .row').length, 1);
    (doc.querySelector('[data-action=question-pin]') as HTMLButtonElement).click();
    await until(() => /Закреплено/.test(doc.getElementById('artifact-rows')!.textContent!));
    window.location.hash = 'question:native-call';
    await until(() => doc.getElementById('question-answer'));
    assert.equal((doc.getElementById('question-answer') as HTMLTextAreaElement).value, 'Выбираю второй вариант');
    answer = doc.getElementById('question-answer') as HTMLTextAreaElement;
    await window.deloRefresh();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(doc.getElementById('question-answer'), answer, 'background refresh keeps the input node');
    (doc.querySelector('[data-task-action=answer]') as HTMLButtonElement).click();
    await until(() => doc.getElementById('question-error')!.textContent === 'Ответ не записан');
    assert.equal(answer.value, 'Выбираю второй вариант'); assert.equal(answer.disabled, false); assert.equal(store.firstmate.show(call.id).held, 'yes');
    fail = false;
    const submit = doc.querySelector('[data-task-action=answer]') as HTMLButtonElement;
    submit.click(); submit.click();
    await until(() => release);
    assert.equal(posts, 2, 'one failed attempt and one retry, double click sends no extra request');
    assert.equal(answer.disabled, true, 'the submitted answer cannot change while saving');
    await window.deloRefresh();
    await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(doc.getElementById('question-answer'), answer);
    release!();
    await until(() => window.location.hash === '#artifacts' && doc.getElementById('artifacts-count')!.textContent === '0');
    assert.equal(store.firstmate.show(call.id).state, 'done');
    assert.equal(window.localStorage.getItem(localDraft), null);
    window.location.hash = 'question:native-call';
    await until(() => /уже ответили/.test(doc.getElementById('question-status')?.textContent ?? ''));
    assert.equal(doc.querySelector('[data-task-action=answer]'), null, 'answered deep links do not reopen the call');
    assert.match(doc.getElementById('question-context')!.textContent!, /Выбираю второй вариант/);
    assert.equal(store.artifacts.list().length, 0);
  } finally { window?.close(); rmSync(root, { recursive: true, force: true }); }
});


test('the native desk keeps defer and release actions on the existing hold lifecycle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-question-release-ui-'));
  const home = firstmateHome(root); const store = new Store({ firstmateHome: home }); let window: any;
  try {
    const task = store.create({ title: 'Разрешить продолжение' });
    run(join(home, 'bin', 'fm-captain-hold.sh'), ['hold', task.id, '--reason', 'Нужно разрешение'], home, 45000, { ...process.env, FM_HOME: home });
    window = open(home, `#question:${task.id}`); const doc = window.document as Document;
    await until(() => doc.getElementById('question-answer'));
    assert.deepEqual([...doc.querySelectorAll<HTMLElement>('[data-task-action]')].map(e => e.dataset.taskAction), ['release', 'later', 'close']);
    const answer = doc.getElementById('question-answer') as HTMLTextAreaElement;
    answer.value = 'Проверю условия'; answer.dispatchEvent(new window.Event('input'));
    (doc.querySelector('[data-task-action=later]') as HTMLButtonElement).click();
    (doc.querySelector('[name=reason]') as HTMLInputElement).value = 'Вернуться завтра';
    (doc.querySelector('[name=until]') as HTMLInputElement).value = '2099-12-01';
    doc.getElementById('dialog-form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => window.location.hash === '#artifacts');
    assert.equal(store.firstmate.show(task.id).hold_until, '2099-12-01');
    assert.equal(store.firstmate.show(task.id).held, 'yes');
    assert.equal(doc.getElementById('artifacts-count')!.textContent, '1');
    window.location.hash = `question:${task.id}`;
    await until(() => doc.getElementById('question-answer'));
    const restored = doc.getElementById('question-answer') as HTMLTextAreaElement;
    assert.equal(restored.value, 'Проверю условия', 'deferring preserves the answer draft');
    restored.value = ''; restored.dispatchEvent(new window.Event('input'));
    (doc.querySelector('[data-task-action=release]') as HTMLButtonElement).click();
    await until(() => window.location.hash === '#artifacts' && doc.getElementById('artifacts-count')!.textContent === '0');
    assert.deepEqual([store.firstmate.show(task.id).state, store.firstmate.show(task.id).held], ['queued', 'no']);
    assert.match(store.firstmate.show(task.id).body, /Answer: Разрешаю работу/);
    assert.equal(store.artifacts.list().length, 0);
  } finally { window?.close(); rmSync(root, { recursive: true, force: true }); }
});


test('materials stay personal, questions hand over durably, and an external answer preserves the composing draft', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-question-owner-ui-'));
  const home = firstmateHome(root); const store = new Store({ firstmateHome: home }); let window: any;
  try {
    const task = store.firstmate.add('shared-question', 'Выбор подхода', 'Контекст решения', { kind: 'captain' });
    run(join(home, 'bin', 'fm-captain-hold.sh'), ['hold', task.id, '--reason', 'Какой подход выбрать?'], home, 45000, { ...process.env, FM_HOME: home });
    const report = store.publishArtifact({ source: 'https://example.com/report', title: 'Отчёт для просмотра', action: 'Прочитать лично', taskId: task.id });
    window = open(home, '#artifacts'); const doc = window.document as Document;
    await until(() => doc.querySelectorAll('#artifact-rows .row').length === 2);
    assert.match(doc.querySelector(`a[href="#artifact:${report.id}"]`)!.closest('.row')!.textContent!, /Материал · Только вам/);
    assert.match(doc.querySelector(`a[href="#question:${task.id}"]`)!.closest('.row')!.textContent!, /Вопрос/);
    window.location.hash = `artifact:${report.id}`;
    await until(() => doc.getElementById('artifact-comment'));
    assert.match(doc.querySelector('.page-heading .eyebrow')!.textContent!, /Только вам/);
    assert.equal(doc.querySelector('[data-action=question-handoff]'), null, 'a report cannot be delegated');
    window.location.hash = `question:${task.id}`;
    await until(() => doc.getElementById('question-answer'));
    const draft = doc.getElementById('question-answer') as HTMLTextAreaElement;
    draft.value = 'Мой ещё не отправленный ответ'; draft.dispatchEvent(new window.Event('input'));
    (doc.querySelector('[data-action=question-handoff]') as HTMLButtonElement).click();
    await until(() => window.location.hash === '#artifacts' && doc.getElementById('artifacts-count')!.textContent === '1');
    assert.equal(store.getQuestion(task.id).questionOwner, 'firstmate');
    assert.equal(store.firstmate.show(task.id).held, 'yes');
    assert.equal(store.firstmate.receipts().pending.length, 1);
    await window.deloRefresh(); assert.equal(doc.querySelectorAll('#artifact-rows .row').length, 1);
    window.location.hash = 'artifacts:delegated';
    await until(() => doc.querySelector('main h1')?.textContent?.startsWith('Вопросы у Яна'));
    assert.equal(doc.querySelectorAll('#artifact-rows .row').length, 1);
    assert.match(doc.getElementById('artifact-rows')!.textContent!, /У Яна/);
    window.location.hash = `question:${task.id}`;
    await until(() => doc.getElementById('question-answer'));
    const composing = doc.getElementById('question-answer') as HTMLTextAreaElement;
    assert.equal(composing.value, draft.value);
    assert.match(doc.getElementById('question-status')!.textContent!, /Передано Яну/);
    assert.equal(doc.querySelector('[data-action=question-handoff]'), null);

    // An authorized Firstmate answer races the open user form through the same native owner.
    run(join(home, 'bin', 'fm-captain-hold.sh'), ['answers', '--source', 'firstmate', '--actor', 'firstmate', '--wake'], home, 45000, { ...process.env, FM_HOME: home }, `${task.id}\tРешение Firstmate в пределах полномочий\tОтвет Firstmate\tdone\n`);
    const saved = store.firstmate.show(task.id).body;
    assert.match(saved, /Resolution actor: firstmate/); assert.match(saved, /Firstmate decision:/);
    assert.doesNotMatch(saved, /Captain answered this call|Captain decision:/);
    await window.deloRefresh();
    assert.equal(doc.getElementById('question-answer'), composing, 'refresh never replaces the composing field');
    assert.equal(composing.value, draft.value); assert.equal(composing.readOnly, true);
    assert.match(doc.getElementById('question-status')!.textContent!, /уже ответили/);
    assert.match(doc.getElementById('question-current-answer')!.textContent!, /Решение Firstmate/);
    const submit = doc.querySelector('[data-task-action=answer]') as HTMLButtonElement;
    assert.equal(submit.disabled, true); submit.click();
    assert.equal((store.firstmate.show(task.id).body.match(/Resolution recorded/g) ?? []).length, 1);
    const storage = Object.fromEntries(Array.from({ length: window.localStorage.length }, (_, i) => { const k = window.localStorage.key(i); return [k, window.localStorage.getItem(k)]; }));
    const restarted = open(home, `#question:${task.id}`, undefined, storage);
    try {
      await until(() => restarted.document.getElementById('question-answer'));
      assert.equal(restarted.document.getElementById('question-answer').value, draft.value, 'a restart preserves the unanswered user draft after the competing answer');
      assert.match(restarted.document.getElementById('question-status').textContent, /уже ответили/);
    } finally { restarted.close(); }
  } finally { window?.close(); rmSync(root, { recursive: true, force: true }); }
});
