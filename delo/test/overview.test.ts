import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { overview, groupByRepo, pinRefusal } from '../src/overview.ts';
import { Store } from '../src/store.ts';
import { firstmateHome } from './firstmate-home.ts';

const record = (id: string, fields: Record<string, unknown> = {}): Record<string, unknown> => ({ id, title: id, state: 'queued', kind: 'ship', repo: null, priority: null, ...fields });
const ids = (groups: { rows: { id: string }[] }[]) => groups.flatMap(g => g.rows.map(r => r.id));

test('sections follow bearings, orphan In flight rows join «В работе» without a worker', () => {
  const fleet = {
    backlog: { records: [record('ask', { repo: 'delo', hold_reason: 'Нужен выбор' }), record('run', { repo: 'delo', state: 'in_flight' }), record('orphan', { kind: 'scout', state: 'in_flight' }), record('next', { repo: 'fm', priority: '0' }), record('old', { state: 'done', priority: '0' })] },
    tasks: [{ id: 'run', current_state: { state: 'working', detail: 'пишет тесты' } }],
    main_inventory: { orphan_in_flight: ['orphan'] },
  };
  const bearings = {
    generated: 'now', decisions_open: [{ id: 'ask', summary: 'Вопрос' }], in_flight: [{ id: 'run', name: 'run', state: 'running' }],
    gates: [{ id: 'next', title: 'next', reason: 'ready to dispatch' }, { id: '(main-inventory)', title: 'main', reason: 'проверить', filed: null }],
    landed: [{ id: 'old', what: 'old' }],
  };
  const view = overview(bearings, fleet);
  assert.deepEqual(ids(view.waiting), ['ask']);
  assert.equal(view.waiting[0].rows[0].reason, 'Нужен выбор');
  assert.deepEqual(ids(view.working), ['run', 'orphan']);
  assert.equal(view.working[0].rows[0].current, 'Работает');
  assert.equal(view.working[1].rows[0].noWorker, true);
  assert.deepEqual(ids(view.next), ['next', '(main-inventory)']);
  assert.equal(view.next.flatMap(g => g.rows).find(r => r.id === '(main-inventory)')?.task, false);
  assert.deepEqual(ids(view.done), ['old']);
  assert.deepEqual(view.focus.map(r => r.id), ['next'], 'a Done row never stays in focus');
  assert.deepEqual(view.kinds, ['scout', 'ship']);
  assert.deepEqual(view.repos, ['delo', 'fm']);
});

test('«Дела» lists open program rows with task counts from the records and the archive', () => {
  const records = [record('c1', { kind: 'program', state: 'in_flight' }), record('c0', { kind: 'program', state: 'done' }), record('w', { state: 'in_flight', body_lines: ['Дело: c1'] }),
    record('q', { hold_kind: 'captain', body_lines: ['Дело: c1'] }), record('n', { body_lines: ['Дело: c1', 'текст'] }), record('d', { state: 'done', body_lines: ['Дело: c1'] }), record('x', { body_lines: ['Не дело: c1'] })];
  const view = overview({}, { backlog: { records } }, [{ id: 'a', body: 'Дело: c1\nтекст' }, { id: 'b', body: 'Дело: c0' }]);
  assert.deepEqual(view.cases.map(r => [r.id, r.counts]), [['c1', { working: 1, waiting: 1, next: 1, done: 2 }]]);
});

test('a row whose body has a line equal to «Личное» is personal', () => {
  const fleet = { backlog: { records: [record('mine', { body_lines: ['Описание', 'Личное'] }), record('work', { body_lines: ['Личное дело соседа'] })] } };
  const view = overview({ gates: [{ id: 'mine' }, { id: 'work' }] }, fleet);
  assert.deepEqual(view.next.flatMap(g => g.rows).map(r => [r.id, r.personal]), [['mine', true], ['work', false]]);
});

test('overview and focus actions come from current backlog state, warnings have none', () => {
  const records = [record('ready', { priority: '0' }), record('held', { held: 'yes', hold_kind: 'captain' }), record('paused', { held: 'yes', hold_kind: 'parked' }), record('done', { state: 'done' })];
  const view = overview({ decisions_open: [{ id: 'held' }], gates: [{ id: 'ready' }, { id: 'paused' }, { id: 'warning' }], landed: [{ id: 'done' }] }, { backlog: { records } });
  assert.deepEqual(view.focus[0].actions, ['start', 'pause', 'close', 'decline']);
  assert.deepEqual(view.waiting[0].rows[0].actions, ['release', 'later', 'close']);
  assert.deepEqual(view.next.flatMap(g => g.rows).map(r => r.actions), [['start', 'pause', 'close', 'decline'], ['unhold', 'close', 'decline'], []]);
  assert.deepEqual(view.done[0].rows[0].actions, ['reopen']);
});

test('native task rows supply computed holds when the fleet snapshot omits them', () => {
  const fleet = { backlog: { records: [record('paused', { hold_kind: 'parked', priority: '0' }), record('expired', { hold_kind: 'parked' })] } };
  const native = [
    { id: 'paused', title: 'paused', body: '', state: 'queued' as const, held: 'yes', hold_kind: 'parked' },
    { id: 'expired', title: 'expired', body: '', state: 'queued' as const, held: 'no', hold_kind: 'parked' },
  ];
  const view = overview({ gates: [{ id: 'paused' }, { id: 'expired' }] }, fleet, [], native);
  assert.deepEqual(view.focus[0].actions, ['unhold', 'close', 'decline']);
  assert.equal(view.focus[0].state, 'paused');
  assert.deepEqual(view.next[0].rows[1].actions, ['start', 'pause', 'close', 'decline']);
  assert.equal(view.next[0].rows[1].state, 'active');
});

test('rows group by repo, rows without one go last under «Без проекта»', () => {
  const row = (id: string, repo?: string) => ({ id, title: id, repo, pinned: false, open: true, task: true, personal: false, actions: [] });
  assert.deepEqual(groupByRepo([row('a'), row('b', 'zeta'), row('c', 'alpha'), row('d', 'zeta')]).map(g => [g.repo, g.rows.map(r => r.id)]), [['alpha', ['c']], ['zeta', ['b', 'd']], ['Без проекта', ['a']]]);
});

test('pinRefusal allows three pins and refuses a fourth, a Done row and an unknown row', () => {
  const records = [record('a', { priority: '0' }), record('b', { priority: '0' }), record('c'), record('d'), record('x', { state: 'done' })];
  assert.equal(pinRefusal({ backlog: { records } }, 'c'), undefined);
  records[2].priority = '0';
  assert.match(pinRefusal({ backlog: { records } }, 'd') ?? '', /уже 3/);
  assert.equal(pinRefusal({ backlog: { records } }, 'a'), undefined, 'a pinned row may be pinned again');
  assert.match(pinRefusal({ backlog: { records } }, 'x') ?? '', /Закрытую/);
  assert.match(pinRefusal({ backlog: { records } }, 'nope') ?? '', /нет в бэклоге/);
});

test('Store pins through the backlog priority and keeps the backlog unchanged on a refused fourth pin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-pin-'));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) });
    for (const id of ['p1', 'p2', 'p3', 'p4']) store.firstmate.add(id, `Задача ${id}`);
    for (const id of ['p1', 'p2', 'p3']) await store.pin(id, true);
    const backlog = join(store.firstmate.home, 'data', 'backlog.md');
    assert.deepEqual((await store.overview()).focus.map(r => r.id).sort(), ['p1', 'p2', 'p3']);
    assert.equal(readFileSync(backlog, 'utf8').match(/\(priority: 0\)/g)?.length, 3);
    const before = readFileSync(backlog, 'utf8');
    await assert.rejects(store.pin('p4', true), /уже 3/);
    assert.equal(readFileSync(backlog, 'utf8'), before);
    await store.pin('p2', false);
    const after = await store.overview();
    assert.deepEqual(after.focus.map(r => r.id).sort(), ['p1', 'p3']);
    assert.match(readFileSync(backlog, 'utf8'), /p2 .*\(priority: 2\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rows expose full holds, unresolved dependencies, fleet PRs and honest worker states', () => {
  const reason = 'Пауза до согласования условий. '.repeat(20);
  const states = [
    ['busy', { state: 'working', detail: 'harness busy (claude-hook)' }, 'Работает'],
    ['check', { state: 'working', detail: 'validating (running) · run: 123' }, 'Идёт проверка'],
    ['ci', { state: 'working', source: 'run-step', detail: 'run active' }, 'Идёт проверка'],
    ['ask', { state: 'parked', detail: 'needs-decision: choose' }, 'Вопрос исполнителя'],
    ['unknown', { state: 'unknown', detail: 'harness state unavailable' }, 'Состояние неизвестно'],
    ['paused', { state: 'paused', detail: 'waiting' }, 'Исполнитель на паузе'],
    ['failed', { state: 'failed', detail: 'run failed' }, 'Работа завершилась с ошибкой'],
  ] as const;
  const records = [record('rr-refund-q2', { title: 'Согласовать возвраты' }),
    record('rr-refund-q3', { blocked_by: 'rr-refund-q2,missing', unresolved_blocker_ids: ['rr-refund-q2', 'missing'], hold_reason: reason, priority: '0' }),
    record('released', { blocked_by: 'finished', unresolved_blocker_ids: [] }), record('finished', { state: 'done' }),
    ...states.map(([id]) => record(id, { state: 'in_flight' })), record('orphan', { state: 'in_flight' })];
  const view = overview({ gates: [{ id: 'rr-refund-q3', reason: 'Пауза…' }, { id: 'released' }], in_flight: states.map(([id]) => ({ id })) }, {
    backlog: { records }, main_inventory: { orphan_in_flight: ['orphan'] },
    tasks: states.map(([id, current_state]) => ({ id, current_state, pr: id === 'check' ? { url: 'https://example.org/pull/2' } : undefined })),
  });
  const blocked = view.next[0].rows[0];
  assert.equal(blocked.reason, reason);
  assert.deepEqual(blocked.blockers, [{ id: 'rr-refund-q2', title: 'Согласовать возвраты' }, { id: 'missing', title: 'missing' }]);
  assert.deepEqual(view.focus[0].blockers, blocked.blockers);
  assert.deepEqual(view.next[0].rows[1].blockers, []);
  const rows = view.working.flatMap(g => g.rows);
  for (const [id, , label] of states) assert.equal(rows.find(r => r.id === id)?.current, label, id);
  assert.equal(rows.find(r => r.id === 'orphan')?.current, 'Нет исполнителя');
  assert.equal(rows.find(r => r.id === 'check')?.prUrl, 'https://example.org/pull/2');
  const hinted = overview({ in_flight: [{ id: 'ask' }] }, { backlog: { records }, tasks: [{ id: 'ask', current_state: { state: 'unknown' }, hints: { pending_decision: true } }] });
  assert.equal(hinted.working[0].rows[0].current, 'Состояние неизвестно', 'unknown is never upgraded using a hint');
});

test('overview cache expires and every accepted mutation invalidates it', async t => {
  const root = mkdtempSync(join(tmpdir(), 'delo-overview-cache-'));
  const store = new Store({ firstmateHome: firstmateHome(root) });
  let calls = 0; let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  store.firstmate.snapshot = async () => { calls++; return {}; };
  try {
    const first = await store.overview();
    assert.equal(calls, 2);
    assert.equal(await store.overview(), first);
    now += 2001;
    assert.notEqual(await store.overview(), first);
    assert.equal(calls, 4);
    const task = store.create({ title: 'Свежая задача' });
    await store.overview(); assert.equal(calls, 6, 'create invalidates');
    store.update(task.id, { title: 'Правка' });
    await store.overview(); assert.equal(calls, 8, 'update invalidates');
    store.act(task.id, 'pause', {});
    await store.overview(); assert.equal(calls, 10, 'action invalidates');
    // Action availability is checked against the backlog, independently of the overview cache.
    assert.throws(() => store.act(task.id, 'start', {}), /недоступно/);
    assert.equal(store.firstmate.receipts().pending.length, 0);
    const c = store.createCase({ title: 'Дело' });
    await store.overview(); assert.equal(calls, 12);
    store.newAgent(c.id, { direction: 'Исследуй' });
    await store.overview(); assert.equal(calls, 14, 'new-agent request invalidates');
    store.closeCase(c.id, { confirmed: store.getCase(c.id).tasks.map(t => t.id) });
    await store.overview(); assert.equal(calls, 16);
    store.reopenCase(c.id);
    await store.overview(); assert.equal(calls, 18);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a mutation during an overview read prevents stale in-flight data from being cached or returned', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-overview-race-'));
  const store = new Store({ firstmateHome: firstmateHome(root) });
  const releases: (() => void)[] = [];
  let calls = 0;
  store.firstmate.snapshot = async () => {
    calls++;
    if (calls <= 2) { await new Promise<void>(resolve => releases.push(resolve)); return { generated: 'old' }; }
    return { generated: 'new' };
  };
  try {
    const before = store.overview();
    store.create({ title: 'Изменение во время снимка' });
    const after = await store.overview();
    releases.forEach(release => release());
    assert.equal((await before).generated, 'new');
    assert.equal(await store.overview(), after);
    assert.equal(calls, 4);
  } finally { releases.forEach(release => release()); rmSync(root, { recursive: true, force: true }); }
});

test('failed overview reads are retried instead of being cached', async () => {
  const store = new Store({ firstmateHome: tmpdir() });
  store.firstmate.snapshot = async () => { throw new Error('snapshot failed'); };
  await assert.rejects(store.overview(), /snapshot failed/);
  store.firstmate.snapshot = async () => ({});
  store.firstmate.list = () => []; store.firstmate.archive = () => [];
  assert.deepEqual((await store.overview()).focus, []);
});

test('concurrent pins recheck fresh state and cannot exceed the focus limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-pin-race-'));
  const store = new Store({ firstmateHome: firstmateHome(root) });
  try {
    for (const id of ['a', 'b', 'c', 'd']) store.firstmate.add(id, id);
    await store.pin('a', true); await store.pin('b', true);
    await store.overview();
    const results = await Promise.allSettled([store.pin('c', true), store.pin('d', true)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.match((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.message, /уже 3/);
    assert.equal((await store.overview()).focus.length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
