import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { overview, groupByRepo, pinRefusal } from '../src/overview.ts';
import { Store } from '../src/store.ts';
import { run } from '../src/process.ts';
import { firstmateHome } from './firstmate-home.ts';

const record = (id: string, fields: Record<string, unknown> = {}): Record<string, unknown> => ({ id, title: id, state: 'queued', kind: 'ship', repo: null, priority: null, ...fields });
const ids = (groups: { rows: { id: string }[] }[]) => groups.flatMap(g => g.rows.map(r => r.id));

test('HTTP overview projects linked external executors without confusing parent presence, activity or DoD', async t => {
  const { router } = await import('../src/server.ts');
  const root = mkdtempSync(join(tmpdir(), 'delo-external-overview-'));
  const store = new Store({ firstmateHome: root });
  const names = ['pi', 'agy', 'unverified', 'lost', 'stopped', 'absent', 'spawned'];
  const records = names.flatMap(id => [
    { id: `case-${id}`, title: id, kind: 'program', state: 'in_flight' as const, repo: '/user/research', body: '' },
    { id, title: id, kind: id === 'spawned' ? 'ship' : 'external', state: 'in_flight' as const, repo: '/user/research', body: `Дело: case-${id}\nExternal DoD: {"version":"v1","criteria":"Проверенный результат","human_required":true,"confirmation":null,"achievement":null,"human_acceptance":null}` },
  ]);
  const external = (id: string, observation: Record<string, unknown>) => ({
    id, kind: 'external', origin: 'existing-external-process', harness: id === 'agy' ? 'agy' : 'pi',
    external: { binding: `/home/state/${id}.external.json`, revision: id, case: `case-${id}`,
      identity: { native: { kind: id === 'agy' ? 'agy-parent' : 'path', value: id === 'agy' ? 'parent' : '/user/session.jsonl' } },
      observation: { receipt: true, completion: { confirmed: false, achieved: false, human_required: true }, ...observation } },
    current_state: { state: id === 'pi' ? 'working' : 'unknown', source: 'external-session' },
  });
  const workers = [
    external('pi', { identity: 'verified', presence: 'alive', activity: 'working', state: 'working' }),
    external('agy', { identity: 'verified', presence: 'alive', activity: 'unknown', native_status: 'done', reported_session: { kind: 'id', value: 'child' }, state: 'unknown' }),
    external('unverified', { identity: 'unknown', presence: 'unknown', activity: 'unknown', state: 'unknown' }),
    external('lost', { identity: 'lost', presence: 'unknown', state: 'unknown' }),
    external('stopped', { identity: 'lost', presence: 'stopped', state: 'stopped' }),
    { id: 'spawned', kind: 'ship', spawn_gen: 'g1', current_state: { state: 'working', source: 'run-step' } },
  ];
  t.mock.method(store.firstmate, 'list', () => records);
  t.mock.method(store.firstmate, 'archive', () => []);
  t.mock.method(store.firstmate, 'receipts', () => ({}));
  t.mock.method(store.firstmate, 'snapshot', async (script: string) => script === 'fm-fleet-snapshot.sh'
    ? { schema: 'fm-fleet-snapshot.v1', backlog: { records: records.map(r => ({ ...r, body_lines: r.body.split('\n') })) }, tasks: workers }
    : { generated: 'now', in_flight: records.map(r => ({ id: r.id })) });
  try {
    const response = await router(store)(new Request('http://localhost:4317/api/overview'));
    assert.equal(response.status, 200);
    const view = await response.json();
    const cases = new Map<string, any>(view.cases.map((r: any) => [r.id, r]));
    const tasks = new Map<string, any>(['working', 'waiting', 'next', 'done'].flatMap(p => view[p].flatMap((g: any) => g.rows.map((r: any) => [r.id, r]))));
    for (const [id, current] of [['pi', 'Работает'], ['agy', 'Исполнитель на связи · активность неизвестна'], ['spawned', 'Идёт проверка']]) {
      const c = cases.get(`case-${id}`), task = tasks.get(id);
      assert.equal(c.noWorker, false, id);
      assert.equal(c.current, current, id);
      assert.equal(task.current, current, id);
      assert.deepEqual(c.counts, { working: 1, waiting: 0, next: 0, done: 0 });
      assert.equal(task.waitKind, undefined, 'unconfirmed DoD and a child done hook are not a user decision or task completion');
      assert.equal(task.owner, undefined);
      assert.notEqual(c.nextStep, 'Текущее состояние исполнителя не подтверждено');
    }
    assert.equal(cases.get('case-absent').current, 'Нет исполнителя');
    assert.equal(cases.get('case-absent').noWorker, true);
    assert.equal(cases.get('case-unverified').current, 'Состояние неизвестно');
    assert.equal(cases.get('case-unverified').noWorker, false, 'unknown identity retains the recorded executor without claiming it is alive');
    assert.equal(cases.get('case-lost').current, 'Идентичность исполнителя потеряна');
    assert.equal(cases.get('case-stopped').current, 'Исполнитель остановлен');
    for (const id of ['lost', 'stopped']) {
      assert.equal(tasks.get(id).waitKind, 'attention');
      assert.equal(tasks.get(id).owner, 'Firstmate');
      assert.deepEqual(cases.get(`case-${id}`).counts, { working: 0, waiting: 1, next: 0, done: 0 });
    }
    assert.equal((await store.worker('agy')).current, cases.get('case-agy').current, 'the task card and its case share the same runtime projection');
    assert.deepEqual(store.reviewQueue(), [], 'unconfirmed DoD does not create a native question');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('business work survives unknown runtime while actual waits and completion take precedence', () => {
  const records = [
    record('human', { hold_kind: 'captain', hold_reason: 'Выбрать вариант' }),
    record('coordinator', { state: 'in_flight' }), record('checks', { state: 'in_flight' }),
    record('dependency', { blocked_by: 'working' }), record('held', { held: 'yes', hold_kind: 'parked', hold_reason: 'Ждём поставщика' }),
    record('working', { state: 'in_flight' }), record('ready', { state: 'in_flight' }),
    record('closed', { state: 'done', hold_kind: 'captain', hold_reason: 'Старый вопрос' }),
    record('unknown', { state: 'in_flight' }), record('queued'),
  ];
  const tasks = [
    { id: 'coordinator', current_state: { state: 'parked', detail: 'needs-decision: нужен разбор' } },
    { id: 'checks', current_state: { state: 'working', source: 'run-step', detail: 'validating (running)' } },
    { id: 'working', current_state: { state: 'working', source: 'pane', detail: 'harness busy' } },
    { id: 'ready', mode: 'local-only', delivery: { state: 'pending', head: 'a'.repeat(40) }, current_state: { state: 'unknown' } },
    { id: 'closed', current_state: { state: 'working' } },
    { id: 'unknown', current_state: { state: 'unknown' }, hints: { pending_decision: true, last_event_text: 'done: ready in branch fm/old' } },
  ];
  const view = overview({ decisions_open: [{ id: 'human' }, { id: 'closed' }], in_flight: tasks.map(t => ({ id: t.id })), gates: records.map(r => ({ id: r.id })), landed: [{ id: 'closed' }] }, { backlog: { records }, tasks });
  assert.deepEqual(ids(view.waiting).sort(), ['coordinator', 'dependency', 'held', 'human', 'ready']);
  assert.deepEqual(ids(view.working), ['checks', 'working', 'unknown']);
  assert.deepEqual(ids(view.next), ['queued']);
  assert.deepEqual(ids(view.done), ['closed']);
  const rows = new Map(view.waiting.flatMap(g => g.rows).map(r => [r.id, r]));
  assert.equal(rows.get('human')?.owner, 'Вы');
  assert.equal(rows.get('coordinator')?.owner, 'Firstmate');
  assert.equal(rows.get('held')?.owner, undefined, 'an external hold never invents a responsible person');
  assert.equal(rows.get('held')?.reason, 'Ждём поставщика');
  assert.match(rows.get('ready')?.reason ?? '', /основную ветку/);
  assert.match(view.working.flatMap(g => g.rows).find(r => r.id === 'unknown')?.current ?? '', /неизвестно/);
  const queued = records.map(r => r.id === 'unknown' ? { ...r, state: 'queued' } : r);
  assert.ok(ids(overview({}, { backlog: { records: queued }, tasks }).next).includes('unknown'), 'a live unknown endpoint alone does not prove business work');
  const busyHeld = overview({}, { backlog: { records }, tasks: [{ id: 'held', current_state: { state: 'working' } }] });
  assert.ok(ids(busyHeld.waiting).includes('held'), 'positive runtime activity cannot release an explicit business hold');
  const all = [...ids(view.waiting), ...ids(view.working), ...ids(view.next), ...ids(view.done)];
  assert.equal(new Set(all).size, all.length, 'a row has exactly one section despite overlapping Bearings lists');
  assert.deepEqual(rows.get('human')?.actions, ['release', 'later', 'close']);
  assert.deepEqual(rows.get('ready')?.actions, ['stop', 'close']);
  assert.deepEqual(view.done[0].rows[0].actions, []);
});

test('a landed or resumed handoff stops awaiting landing and historical ready text is insufficient', () => {
  const records = ['pending', 'landed', 'resumed', 'stale'].map(id => record(id, { state: 'in_flight' }));
  const tasks = [
    { id: 'pending', current_state: { state: 'unknown' }, delivery: { state: 'pending' } },
    { id: 'landed', current_state: { state: 'unknown' }, delivery: { state: 'landed' } },
    { id: 'resumed', current_state: { state: 'working' }, delivery: { state: 'pending' } },
    { id: 'stale', current_state: { state: 'unknown' }, hints: { last_event_text: 'done: ready in branch fm/stale' } },
  ];
  const view = overview({}, { backlog: { records }, tasks });
  assert.deepEqual(ids(view.waiting), ['pending']);
  assert.deepEqual(ids(view.working), ['landed', 'resumed', 'stale']);
  assert.deepEqual(ids(view.next), []);
});

test('completed retained metadata without an open backlog obligation stays completed', () => {
  const view = overview({ in_flight: [{ id: 'finished' }] }, { tasks: [{ id: 'finished', current_state: { state: 'done' } }] });
  assert.deepEqual(ids(view.done), ['finished']);
  assert.deepEqual(ids(view.waiting), []);
  assert.deepEqual(ids(view.working), []);
});

test('canonical unresolved decisions and external waits survive unknown liveness without inferring a captain call', () => {
  const records = ['question', 'external', 'ci', 'failed'].map(id => record(id, { state: 'in_flight' }));
  const tasks = [
    { id: 'question', current_state: { state: 'unknown' }, hints: { open_decisions: [{ key: 'review', verb: 'needs-decision', summary: 'Проверить замечание' }] } },
    { id: 'external', current_state: { state: 'paused', detail: 'Ждём загрузки данных' } },
    { id: 'ci', current_state: { state: 'working', source: 'pane', detail: 'ci running' } },
    { id: 'failed', current_state: { state: 'failed', detail: 'Шаг завершился с ошибкой' } },
  ];
  const view = overview({}, { backlog: { records }, tasks });
  assert.deepEqual(ids(view.waiting), ['question', 'external', 'failed']);
  assert.deepEqual(ids(view.working), ['ci']);
  assert.equal(view.waiting[0].rows[0].owner, 'Firstmate');
  assert.equal(view.waiting[0].rows[1].owner, undefined);
  assert.match(view.waiting[0].rows[1].reason ?? '', /Ждём загрузки данных/);
});

test('sections reconcile bearings with backlog and only proven work joins «В работе»', () => {
  const fleet = {
    backlog: { records: [record('ask', { repo: 'delo', hold_kind: 'captain', hold_reason: 'Нужен выбор' }), record('run', { repo: 'delo', state: 'in_flight' }), record('orphan', { kind: 'scout', state: 'in_flight' }), record('next', { repo: 'fm', priority: '0' }), record('old', { state: 'done', priority: '0' })] },
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
  assert.equal(view.working.flatMap(g => g.rows).find(r => r.id === 'orphan')?.noWorker, true);
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
  const view = overview({}, { backlog: { records }, tasks: [{ id: 'w', current_state: { state: 'working' } }] }, [{ id: 'a', body: 'Дело: c1\nтекст' }, { id: 'b', body: 'Дело: c0' }]);
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
  assert.deepEqual(view.next.flatMap(g => g.rows).map(r => r.actions), [['start', 'pause', 'close', 'decline'], []]);
  assert.deepEqual(view.waiting[0].rows.find(r => r.id === 'paused')?.actions, ['unhold', 'close', 'decline']);
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
  assert.deepEqual(view.next[0].rows.find(r => r.id === 'expired')?.actions, ['start', 'pause', 'close', 'decline']);
  assert.equal(view.next[0].rows.find(r => r.id === 'expired')?.state, 'active');
});

test('wait subsets preserve deliberate parking and distinguish answers, external waits, failures and delivery', () => {
  const records = [record('park', { held: 'yes', hold_kind: 'parked', hold_reason: 'Мой перерыв', hold_until: '2026-12-01', blocked_by: 'dependency' }),
    record('answer', { hold_kind: 'captain' }), record('dependency'),
    ...['quota', 'failed', 'ready', 'busy', 'unknown', 'gate', 'blocked'].map(id => record(id, { state: 'in_flight' }))];
  const tasks = [
    { id: 'quota', current_state: { state: 'blocked', detail: 'token quota reached until 2026-12-01T10:00Z' } },
    { id: 'failed', current_state: { state: 'failed', detail: 'process exited' } },
    { id: 'ready', current_state: { state: 'unknown' }, delivery: { state: 'pending' } },
    { id: 'busy', current_state: { state: 'working' }, hints: { last_event_text: 'paused: old quota' } },
    { id: 'unknown', current_state: { state: 'unknown' }, hints: { last_event_text: 'failed: old failure' } },
    { id: 'gate', current_state: { state: 'parked', source: 'run-step', detail: 'parked at Review' } },
    { id: 'blocked', current_state: { state: 'blocked', detail: 'Cannot finish the task' } },
  ];
  const view = overview({}, { backlog: { records }, tasks });
  const waiting = view.waiting.flatMap(g => g.rows);
  assert.deepEqual(waiting.map(r => [r.id, r.waitKind]), [['park', 'parked'], ['answer', 'answer'], ['quota', 'environment'], ['failed', 'attention'], ['ready', 'delivery'], ['gate', 'answer'], ['blocked', 'attention']]);
  assert.equal((waiting[0] as any).until, '2026-12-01');
  assert.equal((waiting[2] as any).until, '2026-12-01T10:00Z');
  assert.match((waiting[0] as any).nextStep, /Снимите паузу/);
  assert.deepEqual(ids(view.working), ['busy', 'unknown']);
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
    ['paused', { state: 'paused', detail: 'waiting' }, 'Исполнитель ожидает'],
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
  const blocked = view.waiting[0].rows.find(r => r.id === 'rr-refund-q3')!;
  assert.equal(blocked.reason, reason);
  assert.deepEqual(blocked.blockers, [{ id: 'rr-refund-q2', title: 'Согласовать возвраты' }, { id: 'missing', title: 'missing' }]);
  assert.deepEqual(view.focus[0].blockers, blocked.blockers);
  assert.deepEqual(view.next[0].rows.find(r => r.id === 'released')?.blockers, []);
  const rows = [...view.working, ...view.waiting, ...view.next].flatMap(g => g.rows);
  for (const [id, , label] of states) assert.equal(rows.find(r => r.id === id)?.current, label, id);
  assert.equal(rows.find(r => r.id === 'orphan')?.current, 'Нет исполнителя');
  assert.equal(rows.find(r => r.id === 'check')?.prUrl, 'https://example.org/pull/2');
  const hinted = overview({ in_flight: [{ id: 'ask' }] }, { backlog: { records }, tasks: [{ id: 'ask', current_state: { state: 'unknown' }, hints: { pending_decision: true } }] });
  assert.equal(hinted.working.flatMap(g => g.rows).find(r => r.id === 'ask')?.current, 'Состояние неизвестно', 'business work does not invent runtime activity from a hint');
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
  store.firstmate.list = () => []; store.firstmate.archive = () => []; store.firstmate.receipts = () => ({});
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


test('synthetic home receipts appear in overview once per read and handled never means executed', async t => {
  const root = mkdtempSync(join(tmpdir(), 'delo-request-feedback-'));
  const store = new Store({ firstmateHome: firstmateHome(root) });
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  try {
    const queued = store.firstmate.add('request-a', 'Запустить');
    const flying = store.firstmate.add('request-a-extra', 'Остановить'); store.firstmate.start(flying.id);
    const snapshots = async () => ({ gates: [{ id: queued.id }], in_flight: [{ id: flying.id }], backlog: { records: store.firstmate.list() }, tasks: [{ id: flying.id, current_state: { state: 'working' } }] });
    store.firstmate.snapshot = snapshots;
    const original = store.firstmate.receipts.bind(store.firstmate); let reads = 0;
    store.firstmate.receipts = () => { reads++; return original(); };
    store.act(queued.id, 'start', {}); store.act(flying.id, 'stop', {}); store.act(flying.id, 'close', {});
    reads = 0;
    let view = await store.overview();
    assert.equal(reads, 1, 'one receipt read for all rows');
    assert.equal(await store.overview(), view); assert.equal(reads, 1, 'cached overview does not reread receipts');
    assert.deepEqual(view.next[0].rows[0].requests?.map(r => [r.action, r.state]), [['start', 'pending']]);
    assert.deepEqual(view.working[0].rows[0].requests?.map(r => [r.action, r.state]).sort(), [['close', 'pending'], ['stop', 'pending']]);
    for (const note of original().pending) run(join(store.firstmate.home, 'bin', 'fm-inbox.sh'), ['drain', '--ack', note.id], store.firstmate.home, 45000, { ...process.env, FM_HOME: store.firstmate.home });
    now += 2001; view = await store.overview();
    assert.deepEqual(view.next[0].rows[0].requests?.map(r => [r.action, r.state]), [['start', 'handled']]);
    assert.deepEqual(view.working[0].rows[0].requests?.map(r => [r.action, r.state]).sort(), [['close', 'handled'], ['stop', 'handled']]);
    const restarted = new Store({ firstmateHome: store.firstmate.home });
    for (const [id, action] of [[queued.id, 'start'], [flying.id, 'stop'], [flying.id, 'close']] as const) {
      assert.equal(restarted.act(id, action, {}).note.outcome, 'replay', 'handled request is reused across server restarts');
    }
    assert.equal(original().handled.length, 3); assert.equal(original().pending.length, 0);
    assert.equal(store.firstmate.show(queued.id).state, 'queued');
    assert.equal(store.firstmate.show(flying.id).state, 'in_flight');
    store.firstmate.start(queued.id); store.firstmate.done(flying.id); now += 2001;
    view = await store.overview();
    assert.deepEqual(view.working.flatMap(g => g.rows).find(r => r.id === queued.id)?.requests, [], 'actual dispatch replaces the start request and establishes business work');
    assert.deepEqual(view.done[0].rows[0].requests, [], 'actual completion replaces stop/close requests');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
