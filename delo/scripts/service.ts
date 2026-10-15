import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { run } from '../src/process.ts';
import { defaultFirstmateHome } from '../src/store.ts';

const unitName = 'delo.service';
const project = fileURLToPath(new URL('../', import.meta.url));
const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;

export function serviceUnit(root: string, env: NodeJS.ProcessEnv = process.env) {
  const path = `${dirname(process.execPath)}:${env.PATH || `${homedir()}/.local/bin:${homedir()}/.asdf/shims:/usr/local/bin:/usr/bin:/bin`}`;
  const args = [process.execPath, '--disable-warning=ExperimentalWarning', join(root, 'src', 'cli.ts'), 'serve'];
  const firstmateHome = resolve(env.DELO_FIRSTMATE_HOME || defaultFirstmateHome(root));
  return `[Unit]
Description=Дело — локальная карта целей
After=graphical-session.target

[Service]
Type=exec
WorkingDirectory=${root.replace(/%/g, '%%')}
ExecStart=${args.map(arg => quote(arg.replace(/\$/g, '$$$$'))).join(' ')}
Environment=${quote(`PATH=${path}`)}
Environment=${quote(`DELO_FIRSTMATE_HOME=${firstmateHome}`)}
Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=default.target
`;
}

function main(action: string) {
  if (action !== 'init') throw new Error('Используйте npm run service:init');
  run('systemctl', ['--user', 'show', '--property=Version', '--value']);
  const desktop = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE'].filter(name => process.env[name]);
  if (desktop.length) run('systemctl', ['--user', 'import-environment', ...desktop]);
  const folder = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
  mkdirSync(folder, { recursive: true });
  const file = join(folder, unitName); const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, serviceUnit(project), { mode: 0o600 }); renameSync(temp, file);
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', unitName]);
  run('systemctl', ['--user', 'restart', unitName]);
  console.log(run('systemctl', ['--user', 'status', '--no-pager', '--full', unitName]));
}

if (import.meta.main) {
  try { main(process.argv[2]); }
  catch (error: any) { console.error(`Дело: ${error.message}`); process.exitCode = 1; }
}
