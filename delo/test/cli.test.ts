import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/process.ts';
import { firstmateHome } from './firstmate-home.ts';
import { Firstmate } from '../src/firstmate.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

test('CLI reads Firstmate rows and ignores --home and DELO_HOME', () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-cli-'));
  const home = firstmateHome(root); const old = join(root, 'old-data'); const variable = join(root, 'variable-data');
  const env: NodeJS.ProcessEnv = { ...process.env, DELO_HOME: variable }; delete env.DELO_FIRSTMATE_HOME;
  const args = ['--disable-warning=ExperimentalWarning', cli, '--home', old, '--firstmate-home', home];
  try {
    assert.throws(() => run(process.execPath, [...args, 'new', 'CLI цель'], root, 45000, env), /Неизвестная команда: new/, 'tasks are created with fm-tasks-axi.sh add');
    const g = new Firstmate(home).add('cli-a1', 'CLI цель', 'Контекст');
    assert.match(run(process.execPath, [...args, 'list'], root, 45000, env), /cli-a1\tactive\tCLI цель/);
    assert.match(run(process.execPath, [...args, 'show', g.id], root, 45000, env), /Контекст/);
    assert.match(run(process.execPath, [...args, 'state', g.id, 'paused'], root, 45000, env), /"state": "paused"/);
    assert.equal(JSON.parse(run(process.execPath, [...args, 'doctor'], root, 45000, env)).firstmateHome, home);
    for (const command of ['migrate', 'link', 'report', 'knowledge', 'search', 'rebuild']) assert.throws(() => run(process.execPath, [...args, command, g.id], root, 45000, env), /Неизвестная команда/, command);
    assert.match(run(process.execPath, [...args.slice(0, 2), 'list'], root, 45000, { ...env, DELO_FIRSTMATE_HOME: home }), /cli-a1/, 'DELO_FIRSTMATE_HOME without the flag');
    assert.deepEqual(readdirSync(root), ['fm'], 'nothing appears at --home, DELO_HOME or next to them');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI help marks --home as obsolete and names the Firstmate home order', () => {
  const help = run(process.execPath, ['--disable-warning=ExperimentalWarning', cli, '--help']);
  assert.match(help, /--home и DELO_HOME устарели и игнорируются/);
  assert.match(help, /--firstmate-home[\s\S]*DELO_FIRSTMATE_HOME[\s\S]*\.\.\/\.\.\/firstmate/);
  assert.doesNotMatch(help, /migrate|report|knowledge|search|rebuild|delo link/);
});
