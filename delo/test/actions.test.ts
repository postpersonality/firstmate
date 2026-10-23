import { test } from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actions } from '../src/model.ts';
import { Store } from '../src/store.ts';
import { router } from '../src/server.ts';
import { run } from '../src/process.ts';
import { firstmateHome, stubLog } from './firstmate-home.ts';

test('card actions follow the backlog row state', () => {
  assert.deepEqual(actions({ state: 'queued', held: 'no', hold_kind: '-', kind: 'ship' }), ['start', 'pause', 'close', 'decline']);
  assert.deepEqual(actions({ state: 'queued', held: 'yes', hold_kind: 'parked', kind: 'ship' }), ['unhold', 'close', 'decline']);
  assert.deepEqual(actions({ state: 'queued', held: 'yes', hold_kind: 'captain', kind: 'captain' }), ['answer', 'later', 'close']);
  assert.deepEqual(actions({ state: 'queued', held: 'yes', hold_kind: 'captain', kind: 'scout' }), ['release', 'later', 'close']);
  assert.deepEqual(actions({ state: 'in_flight', held: 'no', kind: 'ship' }), ['stop', 'close']);
  assert.deepEqual(actions({ state: 'in_flight', held: 'yes', hold_kind: 'captain', kind: 'ship' }), ['answer', 'stop', 'close']);
  assert.deepEqual(actions({ state: 'done', held: 'no', kind: 'ship' }), ['reopen']);
  assert.deepEqual(actions({ state: 'done', held: 'no', kind: 'captain' }), []);
});

test('card actions reach Firstmate through notes, answers and backlog commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-actions-'));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) });
    const fm = store.firstmate.home;
    const backlog = () => readFileSync(join(fm, 'data', 'backlog.md'), 'utf8');
    const env = { ...process.env, FM_HOME: fm };
    const hold = (...args: string[]) => run(join(fm, 'bin', 'fm-captain-hold.sh'), args, fm, 45000, env);

    const row = store.create({ title: 'Обычная задача' }).id;
    const first = store.act(row, 'start', {});
    assert.equal(first.note.outcome, 'created');
    assert.equal(store.act(row, 'start', {}).note.outcome, 'replay', 'a repeated click replays the pending request');
    assert.equal(readdirSync(join(fm, 'state', 'inbox')).filter(f => f.endsWith('.note')).length, 1);
    assert.match(readFileSync(join(fm, 'state', '.wake-queue'), 'utf8'), /check: captain inbox note/);
    assert.deepEqual(store.inbox(row).requests.map(r => [r.requestId, r.state]), [[`delo-start-${row}-1`, 'pending']]);
    assert.equal(store.firstmate.show(row).state, 'queued');

    assert.throws(() => store.act(row, 'stop', {}), /недоступно/);
    store.act(row, 'pause', {});
    assert.equal(store.firstmate.show(row).hold_kind, 'parked');
    assert.throws(() => store.act(row, 'start', {}), /недоступно/);
    store.act(row, 'unhold', {});
    assert.equal(store.firstmate.show(row).held, 'no');
    store.act(row, 'close', {});
    assert.equal(store.firstmate.show(row).state, 'done');
    store.act(row, 'reopen', {});
    assert.equal(store.firstmate.show(row).state, 'queued');
    assert.throws(() => store.act(row, 'decline', {}), /причину/);
    store.act(row, 'decline', { reason: 'не нужно' });
    assert.equal(store.firstmate.show(row).state, 'done');
    assert.match(backlog(), /Отказ: не нужно/);

    const flying = store.create({ title: 'В работе' }).id;
    store.firstmate.start(flying);
    assert.deepEqual(store.get(flying).actions, ['stop', 'close']);
    assert.equal(store.act(flying, 'stop', {}).note.outcome, 'created');
    assert.equal(store.act(flying, 'stop', {}).note.outcome, 'replay');
    const stop = store.firstmate.receipts().pending.find((n: any) => n.request_id === `delo-stop-${flying}-1`);
    assert.equal(stop.body, `Дело: останови работу по задаче ${flying}, сохрани сделанное, задачу не закрывай`);
    assert.deepEqual([stop.kind, stop.task], [null, null]);
    assert.equal(store.firstmate.show(flying).state, 'in_flight');
    assert.equal(store.inbox(flying).requests.filter(r => r.requestId === `delo-stop-${flying}-1`).length, 1);
    assert.equal(store.act(flying, 'close', {}).note.outcome, 'created');
    assert.equal(store.act(flying, 'close', {}).note.outcome, 'replay');
    assert.equal(store.firstmate.show(flying).state, 'in_flight');
    assert.ok(store.inbox(flying).requests.some(r => r.requestId === `delo-close-${flying}-1`));
    hold('hold', flying, '--reason', 'Нужен выбор во время работы');
    assert.equal(store.firstmate.show(flying).state, 'in_flight');
    assert.equal(store.act(flying, 'close', {}).note.outcome, 'replay', 'closing active held work remains a request to firstmate');
    assert.equal(store.firstmate.show(flying).state, 'in_flight');

    hold('hold', 'cap-a', '--title', 'Какой путь', '--reason', 'Нужен выбор пути');
    assert.deepEqual(store.get('cap-a').actions, ['answer', 'later', 'close']);
    store.act('cap-a', 'later', { reason: 'Вернуться в декабре', until: '2026-12-01' });
    assert.equal(store.firstmate.show('cap-a').hold_until, '2026-12-01');
    store.act('cap-a', 'answer', { answer: 'Идём вторым путём' });
    assert.match(backlog(), /Resolution mode: answered/);
    assert.match(backlog(), /Идём вторым путём/);

    hold('hold', 'cap-b', '--title', 'Можно начинать', '--reason', 'Нужно разрешение');
    store.firstmate.update('cap-b', { kind: 'ship' });
    assert.deepEqual(store.get('cap-b').actions, ['release', 'later', 'close']);
    store.act('cap-b', 'release', {});
    assert.match(backlog(), /Resolution mode: released/);
    assert.equal(store.firstmate.show('cap-b').state, 'queued');
    assert.equal(store.firstmate.show('cap-b').held, 'no');
    assert.equal(existsSync(stubLog), false, 'no agent or Herdr stub was called');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('closing obsolete held work records the explicit choice through the captain-hold owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-held-close-'));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) });
    const fm = store.firstmate.home;
    const hold = (id: string) => run(join(fm, 'bin', 'fm-captain-hold.sh'), ['hold', id, '--reason', 'Нужно решение'], fm, 45000, { ...process.env, FM_HOME: fm });
    for (const kind of ['scout', 'captain']) {
      const id = store.firstmate.add(undefined, 'Больше не актуальна', '', { kind }).id;
      hold(id);
      if (kind === 'scout') { store.act(id, 'release', {}); hold(id); }
      const before = store.firstmate.show(id);
      assert.equal(store.get(id).actions.includes('close'), true);
      assert.deepEqual([before.state, before.held], ['queued', 'yes'], 'viewing offers controls without acting');
      store.act(id, 'close', {});
      const after = store.firstmate.show(id);
      assert.equal(after.state, 'done');
      assert.match(after.body ?? '', /Resolution recorded by fm-captain-hold\./);
      assert.match(after.body ?? '', /Resolution mode: answered/);
      assert.match(after.body ?? '', /Answer: Закрыть как неактуальную/);
      assert.match(after.body ?? '', /Answer as shown to the captain: Закрыть как неактуальную/);
      assert.match(readFileSync(join(fm, 'state', '.wake-queue'), 'utf8'), new RegExp(`captain answered through delo: ${id}`));
    }
    assert.equal(store.firstmate.receipts().pending.length, 0, 'held closure uses the answer owner, not a free-text note');
    assert.equal(existsSync(stubLog), false, 'no worker lifecycle command runs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an answer to a question asked during work is recorded once and the work keeps running', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-held-flight-'));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) });
    const fm = store.firstmate.home;
    const wakes = () => existsSync(join(fm, 'state', '.wake-queue')) ? readFileSync(join(fm, 'state', '.wake-queue'), 'utf8').split('\n').filter(Boolean) : [];
    const records = () => (store.firstmate.show(work).body ?? '').split('Resolution recorded by fm-captain-hold.').length - 1;
    const work = store.create({ title: 'Работа с вопросом' }).id;
    store.firstmate.start(work);
    const question = 'Какой вариант брать?\nA - быстрее\nB - дешевле';
    run(join(fm, 'bin', 'fm-captain-hold.sh'), ['hold', work, '--reason', question], fm, 45000, { ...process.env, FM_HOME: fm });
    const asked = store.get(work);
    assert.deepEqual([asked.actions, asked.inFlight, asked.holdKind, asked.reason], [['answer', 'stop', 'close'], true, 'captain', question]);
    assert.ok((await store.overview()).waiting.some(g => g.rows.some(r => r.id === work && r.reason === question)), 'the row waits for the answer with its question');
    assert.throws(() => store.act(work, 'answer', { answer: ' \n ' }), /ответ/);

    const before = wakes().length;
    store.act(work, 'answer', { answer: 'Выбираю A\nпотому что быстрее' });
    const after = store.firstmate.show(work);
    assert.deepEqual([after.state, after.held], ['in_flight', 'no'], 'the work keeps running without the hold');
    assert.match(after.body ?? '', /Resolution mode: released/);
    assert.match(after.body ?? '', /Answer: Выбираю A \/ потому что быстрее/);
    assert.equal(records(), 1);
    assert.equal(wakes().length - before, 1, 'one answer wakes firstmate once');
    assert.deepEqual(store.get(work).actions, ['stop', 'close']);
    assert.equal((await store.overview()).waiting.some(g => g.rows.some(r => r.id === work)), false, 'the row leaves «Ждёт меня»');

    assert.throws(() => store.act(work, 'answer', { answer: 'Выбираю A\nпотому что быстрее' }), /недоступно/);
    assert.deepEqual([records(), wakes().length - before, store.firstmate.show(work).state], [1, 1, 'in_flight'], 'a repeated answer records nothing');
    assert.equal(store.firstmate.receipts().pending.length, 0, 'the answer is not a note');
    assert.equal(existsSync(stubLog), false, 'no worker lifecycle command runs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an answer given in Дело wakes firstmate exactly once and leaves no inbox note', () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-answer-wake-'));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) });
    const fm = store.firstmate.home;
    const wakes = () => existsSync(join(fm, 'state', '.wake-queue')) ? readFileSync(join(fm, 'state', '.wake-queue'), 'utf8').split('\n').filter(Boolean) : [];
    run(join(fm, 'bin', 'fm-captain-hold.sh'), ['hold', 'cap-w', '--title', 'Какой путь', '--reason', 'Нужен выбор пути'], fm, 45000, { ...process.env, FM_HOME: fm });
    const before = wakes().length;
    assert.equal('note' in store.act('cap-w', 'answer', { answer: 'Первым путём' }), false);
    const added = wakes().slice(before);
    assert.equal(added.length, 1, 'one answer appends exactly one wake');
    assert.match(added[0], /\tcheck\t.*captain answered through delo: cap-w$/);
    assert.equal(existsSync(join(fm, 'state', 'inbox')) ? readdirSync(join(fm, 'state', 'inbox')).filter(f => f.endsWith('.note')).length : 0, 0, 'no inbox note is created');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('«Взять в работу» reaches firstmate as a structured start request for that row', () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-start-request-'));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) });
    const fm = store.firstmate.home;
    const wakes = () => existsSync(join(fm, 'state', '.wake-queue')) ? readFileSync(join(fm, 'state', '.wake-queue'), 'utf8').split('\n').filter(Boolean) : [];
    const row = store.create({ title: 'Начать из Дела' }).id;
    const before = wakes().length;
    assert.equal(store.act(row, 'start', {}).note.outcome, 'created');
    const receipts = JSON.parse(run(join(fm, 'bin', 'fm-inbox.sh'), ['receipts', '--all-pending'], fm, 45000, { ...process.env, FM_HOME: fm }));
    assert.deepEqual(receipts.pending.map((n: any) => [n.kind, n.task, n.request_id, n.body]), [['start', row, `delo-start-${row}-1`, `Дело: возьми в работу задачу ${row}`]]);
    const added = wakes().slice(before);
    assert.equal(added.length, 1, 'one start request appends exactly one wake');
    assert.match(added[0], new RegExp(`start request for task ${row} `));

    const flying = store.create({ title: 'Закрыть из Дела' }).id;
    store.firstmate.start(flying);
    store.act(flying, 'close', {});
    const close = store.firstmate.receipts().pending.find((n: any) => n.request_id === `delo-close-${flying}-1`);
    assert.deepEqual([close.kind, close.task], [null, null], 'the close request stays a free-text note');
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('explicit retries use stable attempts across reopen and restarts, while native actions remain authoritative', () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-request-retry-'));
  const store = new Store({ firstmateHome: firstmateHome(root) });
  const fm = store.firstmate.home;
  const acknowledge = (note: any) => run(join(fm, 'bin', 'fm-inbox.sh'), ['drain', '--ack', note.id], fm, 45000, { ...process.env, FM_HOME: fm });
  try {
    const row = store.create({ title: 'Повтор после возвращения' }).id;
    assert.throws(() => store.act(row, 'start', { attempt: 2 }), /повтор доступен/);
    const initial = store.act(row, 'start', {}).note;
    assert.throws(() => store.act(row, 'start', { attempt: 2 }), /после принятия/);
    acknowledge(initial);
    store.firstmate.start(row); store.firstmate.done(row); store.firstmate.reopen(row);
    const second = store.act(row, 'start', { attempt: 2 }).note;
    assert.equal(second.outcome, 'created'); assert.notEqual(second.id, initial.id);
    const restart = new Store({ firstmateHome: fm });
    assert.equal(restart.act(row, 'start', { attempt: 2 }).note.id, second.id, 'stale tabs and retries share the exact attempt');
    assert.equal(restart.act(row, 'start', {}).note.id, second.id, 'ordinary clicks reuse the latest request');
    assert.throws(() => restart.act(row, 'start', { attempt: 3 }), /после принятия/);
    assert.throws(() => restart.act(row, 'start', { attempt: 99 }), /Обновите/);
    assert.throws(() => restart.act(row, 'start', { attempt: 2.5 }));
    assert.equal(restart.firstmate.receipts().pending.length, 1);
    store.firstmate.start(row);
    assert.throws(() => restart.act(row, 'start', { attempt: 2 }), /недоступно/);
    for (const action of ['stop', 'close'] as const) {
      const first = store.act(row, action, {}).note; acknowledge(first);
      const next = store.act(row, action, { attempt: 2 }).note;
      assert.equal(next.outcome, 'created');
      assert.equal(restart.act(row, action, { attempt: 2 }).note.id, next.id);
    }
    store.firstmate.done(row); store.firstmate.reopen(row);
    assert.throws(() => restart.act(row, 'close', { attempt: 3 }), /Повторная просьба недоступна/);
    assert.equal(store.firstmate.show(row).state, 'queued', 'stale close retry cannot close reopened work directly');
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('the review queue projects native pending questions once and never republishes resolved calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-question-queue-'));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) });
    const fm = store.firstmate.home;
    const hold = (id: string) => run(join(fm, 'bin', 'fm-captain-hold.sh'), ['hold', id, '--reason', 'Нужен выбор'], fm, 45000, { ...process.env, FM_HOME: fm });
    const call = store.firstmate.add('call', 'Выбор решения', 'Полный контекст', { kind: 'captain', repo: 'firstmate' });
    hold(call.id);
    const work = store.create({ title: 'Работа с вопросом' }); store.firstmate.start(work.id); hold(work.id);
    const parked = store.create({ title: 'Ждёт Firstmate' }); store.act(parked.id, 'pause', {});
    const artifact = store.publishArtifact({ source: 'https://example.com/result', title: 'Результат', action: 'Прочитать', taskId: work.id });
    const handle = router(store);
    const queue = async () => (await (await handle(new Request('http://localhost:4317/api/review-queue'))).json()) as any[];
    assert.deepEqual((await queue()).map(q => q.id).sort(), [artifact.id, 'question:call', `question:${work.id}`].sort());
    assert.equal((await queue()).find(q => q.kind === 'question').author, 'Firstmate');
    assert.deepEqual(await queue(), await queue(), 'refresh reads existing questions, without publishing copies');
    store.act('call', 'answer', { answer: 'Второй вариант' });
    assert.equal(store.firstmate.show('call').state, 'done');
    assert.equal((await queue()).some(q => q.id === 'question:call'), false);
    store.act(work.id, 'answer', { answer: 'Продолжить' });
    assert.deepEqual([store.firstmate.show(work.id).state, store.firstmate.show(work.id).held], ['in_flight', 'no']);
    assert.deepEqual((await queue()).map(q => q.id), [artifact.id]);
    assert.deepEqual(store.artifacts.list().map(a => a.id), [artifact.id], 'questions have no artifact or answer copies');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('question handoff is durable next-action ownership, not an answer, and stale versions cannot answer a later call', () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-question-handoff-'));
  try {
    let store = new Store({ firstmateHome: firstmateHome(root) }); const fm = store.firstmate.home;
    const hold = () => run(join(fm, 'bin', 'fm-captain-hold.sh'), ['hold', 'handoff-call', '--title', 'Выбрать решение', '--reason', 'A или B?'], fm, 45000, { ...process.env, FM_HOME: fm });
    hold(); const original = store.getQuestion('handoff-call');
    writeFileSync(join(fm, 'state', 'inbox'), 'inbox unavailable');
    assert.throws(() => store.act('handoff-call', 'handoff', { questionVersion: original.questionVersion }));
    assert.equal(store.getQuestion('handoff-call').questionOwner, 'user', 'a failed inbox handoff cannot hide the question');
    rmSync(join(fm, 'state', 'inbox'));
    store.act('handoff-call', 'handoff', { questionVersion: original.questionVersion });
    assert.equal(store.firstmate.show('handoff-call').state, 'queued');
    assert.equal(store.firstmate.show('handoff-call').held, 'yes');
    assert.doesNotMatch(store.firstmate.show('handoff-call').body, /Resolution recorded/);
    assert.match(readFileSync(join(fm, 'state', '.wake-queue'), 'utf8'), /captain inbox note/);
    const notes = store.firstmate.receipts().pending; assert.equal(notes.length, 1);
    assert.match(notes[0].body, /handoff-call[\s\S]*ask-user-authority/);
    store.act('handoff-call', 'handoff', { questionVersion: original.questionVersion });
    assert.equal(store.firstmate.receipts().pending.length, 1, 'handoff retry reuses the durable request');
    store = new Store({ firstmateHome: fm });
    assert.equal(store.getQuestion('handoff-call').questionOwner, 'firstmate');
    assert.equal(store.reviewQueue().filter(q => q.kind === 'question').find(q => q.id === 'question:handoff-call')?.questionOwner, 'firstmate');
    const handed = store.getQuestion('handoff-call');
    store.act('handoff-call', 'answer', { answer: 'Выбираю A', questionVersion: handed.questionVersion });
    assert.equal(store.firstmate.show('handoff-call').state, 'done');
    assert.throws(() => store.act('handoff-call', 'answer', { answer: 'Устаревший B', questionVersion: original.questionVersion }));
    assert.doesNotMatch(store.firstmate.show('handoff-call').body, /Устаревший B/);

    const work = store.create({ title: 'Следующее ожидание' }); store.firstmate.start(work.id);
    const askWork = () => run(join(fm, 'bin', 'fm-captain-hold.sh'), ['hold', work.id, '--reason', 'Требуется выбор'], fm, 45000, { ...process.env, FM_HOME: fm });
    askWork(); const previous = store.getQuestion(work.id);
    store.act(work.id, 'answer', { answer: 'Первое решение', questionVersion: previous.questionVersion });
    askWork();
    assert.throws(() => store.act(work.id, 'answer', { answer: 'Устаревшее решение', questionVersion: previous.questionVersion }), /changed|изменил/);
    assert.equal(store.firstmate.show(work.id).held, 'yes');
    assert.doesNotMatch(store.firstmate.show(work.id).body, /Устаревшее решение/);
    const next = store.getQuestion(work.id); store.act(work.id, 'handoff', { questionVersion: next.questionVersion });
    askWork(); const returned = store.getQuestion(work.id);
    assert.equal(returned.questionOwner, 'user', 'a genuine new captain call returns the action to the user');
    assert.notEqual(returned.questionVersion, next.questionVersion, 'ownership return cannot reuse an earlier form version');
    assert.throws(() => store.act(work.id, 'handoff', { questionVersion: next.questionVersion }), /changed/);
    const beforeRetry = store.firstmate.receipts().pending.length;
    store.act(work.id, 'handoff', { questionVersion: returned.questionVersion });
    assert.equal(store.firstmate.receipts().pending.length, beforeRetry + 1, 'a fresh handoff after return has its own actionable wake');
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('two process answers with one native version serialize and retain the actual Firstmate actor', async t => {
  const root = mkdtempSync(join(tmpdir(), 'delo-question-race-'));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) }); const fm = store.firstmate.home;
    const command = join(fm, 'bin', 'fm-captain-hold.sh'); const env = { ...process.env, FM_HOME: fm };
    run(command, ['hold', 'racing-call', '--title', 'Решение', '--reason', 'A или B'], fm, 45000, env);
    const question = store.getQuestion('racing-call');
    const answer = (value: string) => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const path = join(root, value + '.txt'); writeFileSync(path, value);
      const child = spawn('bash', [command, 'answer', 'racing-call', '--decision-file', path, '--expected-version', question.questionVersion, '--actor', 'firstmate'], { cwd: fm, env, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject); child.once('close', code => resolve({ code, stderr }));
    });
    const statuses = await Promise.all([answer('Firstmate-A'), answer('Firstmate-B')]);
    t.diagnostic(JSON.stringify({ firstmateBin: process.env.DELO_TEST_FIRSTMATE_BIN, answers: statuses }));
    assert.deepEqual(statuses.map(s => s.code).sort(), [0, 1], JSON.stringify(statuses));
    assert.match(statuses.find(s => s.code === 1)!.stderr, /question changed/, 'the losing process rejects the stale version');
    const body = store.firstmate.show('racing-call').body;
    assert.equal((body.match(/Resolution recorded by fm-captain-hold/g) ?? []).length, 1);
    assert.match(body, /Firstmate decision:/); assert.match(body, /Resolution actor: firstmate/);
    assert.doesNotMatch(body, /Captain decision:/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('HTTP rejects report handoff, missing versions and handoff of an ordinary task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-question-boundary-'));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) }); const task = store.create({ title: 'Прочитать отчёт' });
    const artifact = store.publishArtifact({ source: 'https://example.com/report', title: 'Отчёт', action: 'Прочитать', taskId: task.id });
    const handle = router(store); const base = 'http://localhost:4317';
    const meta = await (await handle(new Request(base + '/api/meta'))).json();
    const post = (path: string, body: unknown) => handle(new Request(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-delo-csrf': meta.csrf }, body: JSON.stringify(body) }));
    assert.equal((await post(`/api/artifacts/${artifact.id}/handoff`, { questionVersion: '0'.repeat(64) })).status, 404);
    assert.equal((await post(`/api/artifacts/${artifact.id}/complete`, { submissionId: 'report-handoff', action: { kind: 'handoff', label: 'Передать Яну' } })).status, 400);
    assert.equal((await post(`/api/tasks/${task.id}/handoff`, { questionVersion: '0'.repeat(64) })).status, 400);
    assert.equal((await post(`/api/tasks/${task.id}/answer`, { answer: 'Без версии' })).status, 400);
    assert.equal(store.artifacts.get(artifact.id).completion, undefined);
    assert.equal(store.firstmate.receipts().pending.length, 0);
    const fm = store.firstmate.home; const command = join(fm, 'bin', 'fm-captain-hold.sh');
    const env = { ...process.env, FM_HOME: fm };
    run(command, ['hold', task.id, '--reason', 'Первый вопрос'], fm, 45000, env);
    const old = store.getQuestion(task.id);
    run(command, ['hold', task.id, '--reason', 'Обновлённый вопрос'], fm, 45000, env);
    assert.equal((await post(`/api/tasks/${task.id}/release`, { answer: 'Старое разрешение', questionVersion: old.questionVersion })).status, 400);
    assert.equal(store.firstmate.show(task.id).held, 'yes');
    assert.doesNotMatch(store.firstmate.show(task.id).body, /Старое разрешение/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
