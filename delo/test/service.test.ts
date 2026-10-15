import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('the user unit serves Firstmate without a data folder and always names the Firstmate home', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts['service:init'] ?? '', /scripts\/service\.ts init/);
  const { serviceUnit } = await import('../scripts/service.ts');
  const root = mkdtempSync(join(tmpdir(), 'delo-service-')); const project = join(root, 'Дело $100% "версия"');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'cli.ts'), '');
  const unit = join(root, 'delo.service');
  try {
    const text = serviceUnit(project, { PATH: '/usr/bin:/bin', HERDR_SOCKET_PATH: '/tmp/herdr.sock', DELO_HOME: '/tmp/old-data', DELO_FIRSTMATE_HOME: '/tmp/fm' });
    writeFileSync(unit, text);
    const verified = spawnSync('systemd-analyze', ['--user', 'verify', unit], { encoding: 'utf8' });
    assert.equal(verified.status, 0, verified.stderr);
    assert.ok(text.includes('$$100%%'));
    assert.ok(text.includes(process.execPath));
    assert.match(text, /cli\.ts" "serve"\n/);
    assert.doesNotMatch(text, /--home|\.data|DELO_HOME|HERDR/);
    assert.match(text, /^Environment="DELO_FIRSTMATE_HOME=\/tmp\/fm"$/m);
    assert.match(text, /WantedBy=default.target/);

    const fallback = serviceUnit(project, { PATH: '/usr/bin:/bin' });
    assert.ok(fallback.includes(`Environment="DELO_FIRSTMATE_HOME=${resolve(project, '../../firstmate').replace(/%/g, '%%')}"`), fallback);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
