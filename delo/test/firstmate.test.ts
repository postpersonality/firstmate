import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Firstmate } from '../src/firstmate.ts';
import { run, runAsync } from '../src/process.ts';
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

test('local handoff evidence requires current ready declaration, clean named head and an outstanding landing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-delivery-'));
  const home = firstmateHome(root); const fm = new Firstmate(home);
  const project = join(root, 'project'); const worktree = join(root, 'worker');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  const git = (cwd: string, ...args: string[]) => run('git', args, cwd, 45000, env);
  try {
    mkdirSync(project); git(project, 'init', '-q', '-b', 'main'); git(project, 'commit', '-qm', 'base', '--allow-empty');
    git(root, 'clone', '-q', project, worktree); git(worktree, 'checkout', '-qb', 'fm/delivery');
    git(worktree, 'commit', '-qm', 'result', '--allow-empty'); const head = git(worktree, 'rev-parse', 'HEAD');
    git(project, 'fetch', '-q', worktree, 'fm/delivery:fm/delivery');
    mkdirSync(join(home, 'state'));
    const meta = join(home, 'state', 'delivery.meta'); const status = join(home, 'state', 'delivery.status');
    const fields = `kind=ship\nmode=local-only\nspawn_gen=g1\nbranch=fm/delivery\nproject=${project}\nworktree=${worktree}\n`;
    writeFileSync(meta, fields); writeFileSync(status, 'done [at=1792510000]: ready in branch fm/delivery\n');
    const worker = { id: 'delivery', kind: 'ship', mode: 'local-only', spawn_gen: 'g1', branch: 'fm/delivery', project, current_state: { state: 'unknown' }, paths: { worktree: { path: worktree } } };
    assert.deepEqual(await fm.delivery(worker), { state: 'pending', head }, 'unknown runtime does not erase a verified pending delivery');
    writeFileSync(status, 'done: ready in branch fm/delivery\nworking: resumed after feedback\n');
    assert.equal(await fm.delivery(worker), undefined, 'the canonical status fold sees resumed work');
    writeFileSync(status, 'done: ready in branch fm/delivery\n');
    writeFileSync(join(worktree, 'unfinished'), 'new work'); assert.equal(await fm.delivery(worker), undefined, 'a dirty branch is not frozen ready'); rmSync(join(worktree, 'unfinished'));
    git(worktree, 'commit', '-qm', 'new unpublished head', '--allow-empty');
    assert.equal(await fm.delivery(worker), undefined, 'historical ready text cannot prove a different unpublished head');
    git(project, 'fetch', '-q', worktree, 'fm/delivery:fm/delivery');
    git(project, 'merge', '-q', '--ff-only', 'fm/delivery');
    assert.deepEqual(await fm.delivery(worker), { state: 'landed', head: git(worktree, 'rev-parse', 'HEAD') });
    writeFileSync(meta, fields.replace('spawn_gen=g1', 'spawn_gen=g2'));
    assert.equal(await fm.delivery(worker), undefined, 'a replacement generation cannot inherit the old handoff');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unknown runtime preserves a current declared wait without reviving history or another generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-declared-wait-'));
  const home = firstmateHome(root); const fm = new Firstmate(home);
  mkdirSync(join(home, 'state'));
  const meta = join(home, 'state', 'waiting.meta'), status = join(home, 'state', 'waiting.status');
  const fields = `kind=scout\nspawn_gen=g1\nproject=${root}\nworktree=${root}\nbranch=fm/waiting\n`;
  const worker = { id: 'waiting', kind: 'scout', spawn_gen: 'g1', project: root, branch: 'fm/waiting', current_state: { state: 'unknown' }, paths: { worktree: { path: root } } };
  try {
    writeFileSync(meta, fields);
    writeFileSync(status, 'paused [at=1792510000]: Frozen checkpoint awaiting landing\n');
    assert.deepEqual(await fm.declaredWait(worker), { state: 'paused', detail: 'Frozen checkpoint awaiting landing' });
    assert.equal(await fm.declaredWait({ ...worker, current_state: { state: 'working', source: 'run-step' } }), undefined, 'authoritative running validation overrides old declarations');
    writeFileSync(status, 'paused: old checkpoint\nresolved: resumed after landing\nworking: continuing\n');
    assert.equal(await fm.declaredWait(worker), undefined, 'resolved wait cannot be revived');
    writeFileSync(status, 'done: ready in branch fm/waiting\n');
    assert.equal(await fm.declaredWait(worker), undefined, 'ready delivery requires its separate named-head gate');
    writeFileSync(status, 'paused: old generation\n'); writeFileSync(meta, fields.replace('spawn_gen=g1', 'spawn_gen=g2'));
    assert.equal(await fm.declaredWait(worker), undefined, 'a replacement generation cannot inherit a pause');
    rmSync(meta); assert.equal(await fm.declaredWait(worker), undefined, 'missing evidence creates no wait');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
