import { spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function run(command: string, args: string[], cwd?: string, timeout = 45000, env?: NodeJS.ProcessEnv, input?: string) {
  const folder = mkdtempSync(join(tmpdir(), 'delo-command-'));
  const output = join(folder, 'out'); const error = join(folder, 'err');
  const out = openSync(output, 'w', 0o600); const err = openSync(error, 'w', 0o600);
  try {
    const result = spawnSync(command, args, { cwd, timeout, env, stdio: [input === undefined ? 'ignore' : 'pipe', out, err], input });
    const stdout = readFileSync(output, 'utf8').trim(); const stderr = readFileSync(error, 'utf8').trim();
    if (result.error || result.status !== 0) {
      let response: any; try { response = JSON.parse(stdout || stderr); } catch { /* Ordinary commands return plain text. */ }
      throw Object.assign(new Error(response?.error?.message || stderr || result.error?.message || stdout || `${command}: код ${result.status}`), { code: response?.error?.code ?? (result.error as NodeJS.ErrnoException | undefined)?.code, status: result.status, stdout });
    }
    return stdout;
  } finally { closeSync(out); closeSync(err); rmSync(folder, { recursive: true, force: true }); }
}
