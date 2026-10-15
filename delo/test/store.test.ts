import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/process.ts';
import { firstmateHome } from './firstmate-home.ts';

test('create writes the typed body, the title source and the personal line to the backlog only', async () => {
  const { Store } = await import('../src/store.ts');
  const root = mkdtempSync(join(tmpdir(), 'delo-create-'));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) });
    const data = () => readdirSync(root, { recursive: true }).map(String).filter(f => f !== 'fm' && !f.startsWith('fm/')).sort();
    const before = data();
    const url = 'https://example.com/issue/7';
    const body = 'Своими словами\n\n## Не шаблон\nтекст';
    const goal = store.create({ title: `Разобрать ${url}`, kind: 'scout', repo: 'delo', body, personal: true, holdUntil: '2026-12-01' });
    const task = store.firstmate.show(goal.id);
    assert.equal(task.title, 'Разобрать');
    assert.equal(task.body, `Источник: ${url}\n${body}\nЛичное`);
    assert.equal(task.kind, 'scout');
    assert.equal(task.hold_kind, 'parked');
    assert.equal(task.hold_until, '2026-12-01');
    const backlog = readFileSync(join(store.firstmate.home, 'data', 'backlog.md'), 'utf8');
    assert.match(backlog, /\(kind: scout\).*\(repo: delo\)|\(repo: delo\).*\(kind: scout\)/);
    assert.equal(backlog.split(url).length - 1, 1);
    assert.equal(goal.personal, true);
    assert.deepEqual(goal.actions, ['unhold', 'close', 'decline']);
    assert.equal(store.overview().next.flatMap(g => g.rows).find(r => r.id === goal.id)?.personal, true);
    const empty = store.create({ title: 'Без описания', blockedBy: goal.id });
    assert.equal(store.firstmate.show(empty.id).body, '');
    assert.equal(store.firstmate.show(empty.id).kind, 'ship');
    assert.match(String((store.firstmate.show(empty.id) as any).blocked_by), new RegExp(goal.id));
    assert.equal(store.get(empty.id).personal, false);
    assert.throws(() => store.create({ title: 'Нет такой', blockedBy: 'missing-x1' }));
    store.update(goal.id, { title: 'Разобрать заново', body: 'Новое описание', personal: false });
    assert.equal(store.firstmate.show(goal.id).body, 'Новое описание');
    assert.match(readFileSync(join(store.firstmate.home, 'data', 'note-archive.md'), 'utf8'), /Своими словами/);
    store.update(goal.id, { personal: true });
    assert.equal(store.firstmate.show(goal.id).body, 'Новое описание\nЛичное');
    assert.deepEqual(data(), before, 'create and edit write nothing to the data folder');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('keeps native prose intact when it contains one managed heading', async () => {
  const { Store } = await import('../src/store.ts');
  const root = mkdtempSync(join(tmpdir(), 'delo-native-prose-'));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) });
    const goal = store.create({ title: 'Свободный текст' });
    const nativeId = goal.id;
    const body = 'Вводный текст\n\n## Зачем\nПричина\n\n## Критерий готовности\nГотово\n\n## Контекст\nОсновной контекст\n\n## Ограничения\n- Не терять';
    store.firstmate.update(nativeId, { body });
    assert.equal(store.get(goal.id).why, '');
    assert.equal(store.get(goal.id).context, body);
    assert.equal(store.list().find(item => item.id === goal.id)?.context, body);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('title-only rename preserves the native body byte-for-byte', async () => {
  const { Store } = await import('../src/store.ts');
  const root = mkdtempSync(join(tmpdir(), 'delo-native-title-'));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) });
    const goal = store.create({ title: 'Старое название', body: 'Тело записи' });
    const nativeId = goal.id;
    store.firstmate.update(nativeId, { body: 'Внешнее тело\n\n## Произвольный раздел\nСодержимое' });
    const before = store.firstmate.show(nativeId).body;
    store.update(goal.id, { title: 'Новое название' });
    assert.equal(store.firstmate.show(nativeId).body, before);
    assert.equal(store.get(goal.id).title, 'Новое название');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('moves links out of Russian goal titles into source lines of the body', async () => {
  const { Store } = await import('../src/store.ts');
  const root = mkdtempSync(join(tmpdir(), 'delo-title-links-'));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) });
    const source = 'https://chat.example.com/team/pl/3br1exs8mfrozmnt1nbi19e4zh';
    const pr = 'https://github.com/example/project/pull/3';
    const goal = store.create({ title: `дежурство (${source}) ${pr}. ${source}` });
    assert.equal(goal.title, 'дежурство');
    assert.equal(goal.body, `Источник: ${source}\nИсточник: ${pr}`);
    const next = 'https://example.com/new-source';
    store.update(goal.id, { title: `Другое задание ${next}` });
    assert.equal(store.get(goal.id).title, 'Другое задание');
    assert.equal(store.get(goal.id).body, `Источник: ${next}\nИсточник: ${source}\nИсточник: ${pr}`);
    store.update(goal.id, { title: `Ещё раз ${next}` });
    assert.equal(store.get(goal.id).body.split(next).length - 1, 1, 'a source already in the body is not added twice');
    const onlyLink = store.create({ title: source });
    assert.equal(onlyLink.title, 'Новое дело');
    assert.equal(onlyLink.body, `Источник: ${source}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('projects native state and external body and links', async () => {
  const { Store } = await import('../src/store.ts');
  const root = mkdtempSync(join(tmpdir(), 'delo-native-'));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) });
    const goal = store.create({ title: 'Состояние', body: 'Контекст' });
    const nativeId = goal.id;
    store.update(goal.id, { state: 'paused' });
    assert.equal(store.firstmate.show(nativeId).held, 'yes');
    store.update(goal.id, { state: 'active' });
    assert.equal(store.firstmate.show(nativeId).held, 'no');
    store.firstmate.start(nativeId);
    store.update(goal.id, { body: 'Изменённый контекст' });
    assert.equal(store.firstmate.show(nativeId).state, 'in_flight');
    for (const state of ['paused', 'done', 'dropped'] as const) assert.throws(() => store.update(goal.id, { state }), /меняет Firstmate/);
    assert.equal(store.firstmate.show(nativeId).state, 'in_flight');
    assert.equal(store.firstmate.show(nativeId).held, 'no');
    store.firstmate.done(nativeId);
    store.update(goal.id, { state: 'active' });
    assert.equal(store.firstmate.show(nativeId).state, 'queued');
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('FM_') || name === 'TASKS_AXI_FILE' || name === 'TASKS_AXI_BACKEND') delete env[name];
    env.FM_HOME = store.firstmate.home;
    run('tasks-axi', ['rm', nativeId, '--json'], store.firstmate.home, 45000, env);
    assert.equal(store.list().some(item => item.id === goal.id), false);
    store.firstmate.add('native-z9', 'Внешняя', 'Свободный контекст');
    const longExternalBody = 'y'.repeat(700);
    store.firstmate.add('native-long', 'Длинная внешняя', longExternalBody);
    run('tasks-axi', ['add', 'native-link', 'Ссылка', '--pr', 'https://github.com/example/project/pull/1', '--json'], store.firstmate.home, 45000, env);
    const external = store.list().find(item => item.id === 'native-z9');
    assert.equal(external?.context, 'Свободный контекст');
    assert.equal(store.list().find(item => item.id === 'native-long')?.context, longExternalBody);
    assert.equal(store.list().find(item => item.id === 'native-link')?.links[0], 'https://github.com/example/project/pull/1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pause parks the row, reopen lifts the hold, and captain or in-flight rows refuse Delo state changes', async () => {
  const { Store } = await import('../src/store.ts');
  const root = mkdtempSync(join(tmpdir(), 'delo-safety-'));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) });
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('FM_') || name === 'TASKS_AXI_FILE' || name === 'TASKS_AXI_BACKEND') delete env[name];
    env.FM_HOME = store.firstmate.home;
    const hold = join(store.firstmate.home, 'bin', 'fm-captain-hold.sh');
    const goal = store.create({ title: 'Пауза' });
    const nativeId = goal.id;
    store.update(goal.id, { state: 'paused' });
    assert.equal(store.firstmate.show(nativeId).hold_kind, 'parked');
    assert.throws(() => run(hold, ['open', nativeId], store.firstmate.home, 45000, env), 'a paused row is not a captain question');
    store.update(goal.id, { state: 'dropped' });
    store.update(goal.id, { state: 'active' });
    assert.equal(store.firstmate.show(nativeId).state, 'queued');
    assert.equal(store.firstmate.show(nativeId).held, 'no');
    assert.equal(store.get(goal.id).state, 'active');

    run(hold, ['hold', 'cap-call', '--title', 'Вопрос капитану', '--reason', 'Нужен выбор направления'], store.firstmate.home, 45000, env);
    const question = store.list().find(item => item.id === 'cap-call')!;
    assert.equal(question.holdKind, 'captain');
    for (const state of ['active', 'done', 'dropped'] as const) assert.throws(() => store.update('cap-call', { state }), /только ответом/);
    assert.equal(store.firstmate.show('cap-call').held, 'yes');
    run(hold, ['open', 'cap-call'], store.firstmate.home, 45000, env);

    store.firstmate.start(nativeId);
    assert.equal(store.get(goal.id).inFlight, true);
    for (const state of ['paused', 'done', 'dropped'] as const) assert.throws(() => store.update(goal.id, { state }), /меняет Firstmate/);
    assert.equal(store.firstmate.show(nativeId).held, 'no');
    assert.equal(store.firstmate.show(nativeId).state, 'in_flight');
    assert.equal(store.get(goal.id).links.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Firstmate home comes from the flag, then DELO_FIRSTMATE_HOME, then the folder next to the projects', async () => {
  const { Store, defaultFirstmateHome } = await import('../src/store.ts');
  const root = mkdtempSync(join(tmpdir(), 'delo-home-order-'));
  const previous = process.env.DELO_FIRSTMATE_HOME;
  try {
    delete process.env.DELO_FIRSTMATE_HOME;
    const project = fileURLToPath(new URL('..', import.meta.url));
    assert.equal(new Store().firstmate.home, resolve(project, '../../firstmate'));
    assert.equal(defaultFirstmateHome('/a/b/delo'), '/a/firstmate');
    process.env.DELO_FIRSTMATE_HOME = join(root, 'variable');
    assert.equal(new Store().firstmate.home, join(root, 'variable'));
    assert.equal(new Store({ firstmateHome: join(root, 'flag') }).firstmate.home, join(root, 'flag'));
    assert.deepEqual(readdirSync(root), [], 'choosing a home writes nothing');
  } finally {
    if (previous === undefined) delete process.env.DELO_FIRSTMATE_HOME; else process.env.DELO_FIRSTMATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('create leaves no file behind when native add fails', async () => {
  const { Store } = await import('../src/store.ts');
  const root = mkdtempSync(join(tmpdir(), 'delo-create-failure-'));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) });
    store.firstmate.add = () => { throw new Error('simulated add failure'); };
    assert.throws(() => store.create({ title: 'Не создано' }), /simulated add failure/);
    assert.deepEqual(readdirSync(root), ['fm']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
