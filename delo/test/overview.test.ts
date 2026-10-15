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
  assert.equal(view.working[0].rows[0].current, 'working: пишет тесты');
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

test('rows group by repo, rows without one go last under «Без проекта»', () => {
  const row = (id: string, repo?: string) => ({ id, title: id, repo, pinned: false, open: true, task: true, personal: false });
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

test('Store pins through the backlog priority and keeps the backlog unchanged on a refused fourth pin', () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-pin-'));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) });
    for (const id of ['p1', 'p2', 'p3', 'p4']) store.firstmate.add(id, `Задача ${id}`);
    for (const id of ['p1', 'p2', 'p3']) store.pin(id, true);
    const backlog = join(store.firstmate.home, 'data', 'backlog.md');
    assert.deepEqual(store.overview().focus.map(r => r.id).sort(), ['p1', 'p2', 'p3']);
    assert.equal(readFileSync(backlog, 'utf8').match(/\(priority: 0\)/g)?.length, 3);
    const before = readFileSync(backlog, 'utf8');
    assert.throws(() => store.pin('p4', true), /уже 3/);
    assert.equal(readFileSync(backlog, 'utf8'), before);
    const after = store.pin('p2', false);
    assert.deepEqual(after.focus.map(r => r.id).sort(), ['p1', 'p3']);
    assert.match(readFileSync(backlog, 'utf8'), /p2 .*\(priority: 2\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
