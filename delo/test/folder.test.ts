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
