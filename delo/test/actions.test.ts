import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actions } from '../src/model.ts';
import { Store } from '../src/store.ts';
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
