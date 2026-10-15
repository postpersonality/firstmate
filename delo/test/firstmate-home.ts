import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

// The wrapper is resolved from the selected home, so every scratch home carries the Firstmate code's bin/.
const firstmateBin = process.env.DELO_TEST_FIRSTMATE_BIN || join(userInfo().homedir, 'Projects', 'firstmate', 'bin');

// Agent and Herdr binaries are stubs in every test run: they log their call and fail, so stubLog stays empty.
const stubs = mkdtempSync(join(tmpdir(), 'delo-stubs-'));
export const stubLog = join(stubs, 'calls.log');
for (const name of ['claude', 'codex', 'herdr', 'herdr-focus', 'xdg-open', 'gh', 'pi', 'systemctl', 'lavish-axi', 'notify-send']) writeFileSync(join(stubs, name), `#!/bin/sh\necho "${name} $*" >> '${stubLog}'\nexit 97\n`, { mode: 0o755 });
process.env.PATH = `${stubs}:${process.env.PATH}`;

// doneKeep makes tasks-axi move Done rows beyond that count into the archive.
export function firstmateHome(root: string, options: { doneKeep?: number } = {}) {
  const home = join(root, 'fm');
  mkdirSync(join(home, 'data'), { recursive: true });
  writeFileSync(join(home, '.tasks.toml'), `backend = "markdown"\n[markdown]\npath = "data/backlog.md"\narchive = "data/done-archive.md"\n${options.doneKeep === undefined ? '' : `done_keep = ${options.doneKeep}\n`}`);
  if (!existsSync(join(firstmateBin, 'fm-tasks-axi.sh'))) throw new Error(`Set DELO_TEST_FIRSTMATE_BIN: no fm-tasks-axi.sh in ${firstmateBin}`);
  symlinkSync(firstmateBin, join(home, 'bin'));
  return home;
}
