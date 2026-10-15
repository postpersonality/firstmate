import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Firstmate } from '../src/firstmate.ts';
import { firstmateHome } from './firstmate-home.ts';

test('Firstmate bridge creates and reads a task in the selected home', () => {
  const home = firstmateHome(mkdtempSync(join(tmpdir(), 'delo-firstmate-')));
  const fm = new Firstmate(home);
  const created = fm.add('bridge-a1', 'Bridge title', 'why text');
  assert.equal(created.id, 'bridge-a1');
  assert.equal(created.title, 'Bridge title');
  assert.equal(fm.show('bridge-a1').body, 'why text');
  assert.equal(fm.list().find(task => task.id === 'bridge-a1')?.state, 'queued');
});

test('Firstmate runs the wrapper from the selected home, not from the code directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'delo-firstmate-wrapper-'));
  mkdirSync(join(home, 'bin'));
  writeFileSync(join(home, 'bin', 'fm-tasks-axi.sh'), `#!/bin/sh\nprintf '%s\\n' "$FM_HOME" > "${home}/called"\nprintf 'count: 0\\ntasks[0]:\\n'\n`, { mode: 0o755 });
  assert.deepEqual(new Firstmate(home).list(), []);
  assert.equal(readFileSync(join(home, 'called'), 'utf8').trim(), home);
});
