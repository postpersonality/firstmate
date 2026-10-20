import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Firstmate } from '../src/firstmate.ts';
import { runAsync } from '../src/process.ts';
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


test('async snapshots use only the selected home and preserve subprocess and JSON errors', async () => {
  const home = mkdtempSync(join(tmpdir(), 'delo-snapshot-'));
  mkdirSync(join(home, 'bin'));
  const script = join(home, 'bin', 'fm-fleet-snapshot.sh');
  const fm = new Firstmate(home);
  const old = process.env.FM_SNAPSHOT_LEAK;
  process.env.FM_SNAPSHOT_LEAK = 'must not reach snapshot';
  try {
    writeFileSync(script, `#!/usr/bin/env node
console.log(JSON.stringify({ home: process.env.FM_HOME, cwd: process.cwd(), leaked: process.env.FM_SNAPSHOT_LEAK || null, args: process.argv.slice(2) }));
`, { mode: 0o755 });
    assert.deepEqual(await fm.snapshot('fm-fleet-snapshot.sh'), { home, cwd: home, leaked: null, args: ['--json'] });
    writeFileSync(script, `#!/bin/sh\necho '{"error":{"message":"snapshot refused","code":"REFUSED"}}'\nexit 3\n`);
    await assert.rejects(fm.snapshot('fm-fleet-snapshot.sh'), { message: 'snapshot refused', code: 'REFUSED', status: 3 });
    writeFileSync(script, '#!/bin/sh\necho invalid-json\n');
    await assert.rejects(fm.snapshot('fm-fleet-snapshot.sh'), SyntaxError);
    rmSync(script);
    await assert.rejects(fm.snapshot('fm-fleet-snapshot.sh'), { code: 'ENOENT' });
  } finally {
    if (old === undefined) delete process.env.FM_SNAPSHOT_LEAK; else process.env.FM_SNAPSHOT_LEAK = old;
    rmSync(home, { recursive: true, force: true });
  }
});


test('the async snapshot runner terminates a timed-out child', async () => {
  await assert.rejects(runAsync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], undefined, 100), { status: null });
});
