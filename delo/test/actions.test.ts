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
  assert.deepEqual(actions({ state: 'queued', held: 'yes', hold_kind: 'captain', kind: 'captain' }), ['answer', 'later']);
  assert.deepEqual(actions({ state: 'queued', held: 'yes', hold_kind: 'captain', kind: 'scout' }), ['release', 'later']);
  assert.deepEqual(actions({ state: 'in_flight', held: 'no', kind: 'ship' }), ['close']);
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
    assert.deepEqual(store.get(flying).actions, ['close']);
    assert.equal(store.act(flying, 'close', {}).note.outcome, 'created');
    assert.equal(store.firstmate.show(flying).state, 'in_flight');
    assert.ok(store.inbox(flying).requests.some(r => r.requestId === `delo-close-${flying}-1`));

    hold('hold', 'cap-a', '--title', 'Какой путь', '--reason', 'Нужен выбор пути');
    assert.deepEqual(store.get('cap-a').actions, ['answer', 'later']);
    assert.throws(() => store.act('cap-a', 'close', {}), /недоступно/);
    store.act('cap-a', 'later', { reason: 'Вернуться в декабре', until: '2026-12-01' });
    assert.equal(store.firstmate.show('cap-a').hold_until, '2026-12-01');
    store.act('cap-a', 'answer', { answer: 'Идём вторым путём' });
    assert.match(backlog(), /Resolution mode: answered/);
    assert.match(backlog(), /Идём вторым путём/);

    hold('hold', 'cap-b', '--title', 'Можно начинать', '--reason', 'Нужно разрешение');
    store.firstmate.update('cap-b', { kind: 'ship' });
    assert.deepEqual(store.get('cap-b').actions, ['release', 'later']);
    store.act('cap-b', 'release', {});
    assert.match(backlog(), /Resolution mode: released/);
    assert.equal(store.firstmate.show('cap-b').state, 'queued');
    assert.equal(store.firstmate.show('cap-b').held, 'no');
    assert.equal(existsSync(stubLog), false, 'no agent or Herdr stub was called');
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
