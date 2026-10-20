import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { firstmateHome } from './firstmate-home.ts';

test('a duty folder is a validated `Папка:` body line that edits change, an empty field removes and suggestions list', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'delo-folder-')));
  const home = process.env.HOME;
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) });
    const product = join(root, 'product'); const other = join(root, 'home', 'other');
    mkdirSync(product); mkdirSync(other, { recursive: true }); writeFileSync(join(root, 'file.txt'), 'x');
    const backlog = () => readFileSync(join(store.firstmate.home, 'data', 'backlog.md'), 'utf8');

    const duty = store.create({ title: 'Дежурство https://example.com/thread/1', kind: 'scout', body: 'Разобрать тред', folder: `${product}/` });
    assert.equal(store.firstmate.show(duty.id).body, `Источник: https://example.com/thread/1\nПапка: ${product}\nРазобрать тред`);
    assert.equal(duty.folder, product);

    process.env.HOME = join(root, 'home');
    store.update(duty.id, { folder: '~/other' });
    assert.equal(store.firstmate.show(duty.id).body, `Источник: https://example.com/thread/1\nПапка: ${other}\nРазобрать тред`, '~/… expands to the home folder');
    process.env.HOME = home;

    const before = backlog();
    for (const [folder, message] of [['relative/path', /Папка: нужен абсолютный путь или ~\/…, а не «relative\/path»$/], [join(root, 'missing'), /Папка: нет такой папки .*\/missing$/], [join(root, 'file.txt'), /Папка: нет такой папки .*\/file\.txt$/]] as const) {
      assert.throws(() => store.update(duty.id, { folder }), message);
      assert.throws(() => store.create({ title: 'Отказ', folder }), message);
    }
    assert.equal(backlog(), before, 'a refused folder writes nothing');

    const plain = store.create({ title: 'Без папки', body: 'Текст' });
    assert.equal(store.firstmate.show(plain.id).body, 'Текст');
    assert.equal(plain.folder, '');
    store.create({ title: 'Та же папка', folder: product });
    assert.deepEqual(store.folders(), [other, product]);

    store.update(duty.id, { folder: '' });
    assert.equal(store.firstmate.show(duty.id).body, 'Источник: https://example.com/thread/1\nРазобрать тред', 'an empty field removes the line');
    assert.deepEqual(store.folders(), [product]);

    const native = `Вводный текст\nПапка: ${product}\nХвост`;
    store.firstmate.update(plain.id, { body: native });
    store.update(plain.id, { title: 'Новое название' });
    assert.equal(store.firstmate.show(plain.id).body, native, 'a rename keeps an unchanged folder line where it is');
    store.update(plain.id, { body: 'Вводный текст\nХвост', folder: other });
    assert.equal(store.firstmate.show(plain.id).body, `Папка: ${other}\nВводный текст\nХвост`);
  } finally { process.env.HOME = home; rmSync(root, { recursive: true, force: true }); }
});

test('duty cases persist project and read-only context through edits and reopen, and launch only a queued scout', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'delo-duty-case-')));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root) });
    const product = join(root, 'product'); mkdirSync(product);
    mkdirSync(join(store.firstmate.home, 'projects'));
    mkdirSync(join(store.firstmate.home, 'projects', 'app'));
    writeFileSync(join(store.firstmate.home, 'data/projects.md'), '- app [local-only] - fixture\n');
    assert.throws(() => store.createCase({ title: 'Missing folder', caseType: 'duty' }), /папк/i);
    const c = store.createCase({ title: 'Дежурство', caseType: 'duty', repo: 'app', folder: product, why: 'Разобрать обращение', sources: 'https://example.com/thread' });
    assert.equal(c.caseType, 'duty'); assert.equal(c.repo, 'app'); assert.equal(c.folder, product);
    assert.equal(c.why, 'Разобрать обращение'); assert.equal(c.managedBrief, true);
    assert.equal(store.firstmate.list().length, 1); assert.equal(store.firstmate.receipts().pending.length, 0);
    store.update(c.id, { title: 'Уточнённое дежурство', repo: product });
    const restarted = new Store({ firstmateHome: store.firstmate.home });
    assert.equal(restarted.getCase(c.id).caseType, 'duty'); assert.equal(restarted.getCase(c.id).repo, product);
    assert.throws(() => restarted.newAgent(c.id, { direction: 'Правь файлы', kind: 'ship' }), /дежурств/i);
    const result = restarted.newAgent(c.id, { direction: 'Исследуй обращение.' });
    const task = restarted.firstmate.show(result.task.id);
    assert.equal(task.kind, 'scout'); assert.equal(task.repo, product); assert.equal(task.state, 'queued');
    assert.match(task.body, new RegExp(`^Дело: ${c.id}\\n`)); assert.ok(task.body.includes(`Папка: ${product}`));
    assert.ok(task.body.includes('Источник: https://example.com/thread'), 'duty sources reach the task body read by the existing workflow');
    assert.equal(restarted.firstmate.receipts().pending[0].task, task.id);
    restarted.firstmate.done(task.id); restarted.closeCase(c.id, {});
    assert.equal(restarted.reopenCase(c.id).caseType, 'duty');
    const ordinary = restarted.createCase({ title: 'Личное дело' });
    assert.equal(ordinary.caseType, 'ordinary'); assert.equal(ordinary.repo, undefined);
    const research = restarted.newAgent(ordinary.id, { direction: 'Изучи проект', kind: 'scout', repo: 'app' });
    assert.equal(research.task.repo, 'app', 'research retains the explicitly chosen project');
    assert.throws(() => restarted.newAgent(ordinary.id, { direction: 'Не дать запись', kind: 'ship', repo: product, folder: product }), /только для чтения/);
    const edit = restarted.newAgent(ordinary.id, { direction: 'Исправь проект', kind: 'ship', repo: product, folder: '' });
    assert.equal(edit.task.kind, 'ship'); assert.equal(edit.task.repo, product); assert.equal(edit.task.folder, '');
    restarted.update(ordinary.id, { repo: 'app' });
    assert.equal(restarted.update(ordinary.id, { repo: '' }).repo, undefined, 'clearing an optional project is persisted');
    restarted.firstmate.update(ordinary.id, { repo: 'legacy-project' });
    assert.equal(restarted.update(ordinary.id, { repo: 'legacy-project', title: 'Legacy' }).repo, 'legacy-project');
    assert.equal(restarted.newAgent(ordinary.id, { direction: 'Legacy research' }).task.repo, 'legacy-project', 'unchanged historical project names remain usable');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('continuing an archived duty preserves its type, project, materials and orientation', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'delo-duty-archive-')));
  try {
    const store = new Store({ firstmateHome: firstmateHome(root, { doneKeep: 1 }) });
    const c = store.createCase({ title: 'Дежурство в архив', caseType: 'duty', repo: root, folder: root, why: 'Ориентировка', sources: 'https://example.com/thread' });
    store.closeCase(c.id, {});
    store.act(store.create({ title: 'Сдвинуть архив' }).id, 'close', {});
    assert.equal(store.getCase(c.id).archived, true);
    const continued = store.continueCase(c.id);
    assert.deepEqual([continued.caseType, continued.repo, continued.folder, continued.why, continued.sources], ['duty', root, root, 'Ориентировка', ['https://example.com/thread']]);
    assert.equal(store.firstmate.receipts().pending.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
