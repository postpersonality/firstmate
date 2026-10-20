import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function checkFolder(value: string) {
  const typed = value.trim();
  if (!typed) return '';
  const path = typed === '~' || typed.startsWith('~/') ? join(homedir(), typed.slice(1)) : typed;
  if (!isAbsolute(path)) throw new Error(`Папка: нужен абсолютный путь или ~/…, а не «${typed}»`);
  let directory = false; try { directory = statSync(path).isDirectory(); } catch { /* A missing path is refused below. */ }
  if (!directory) throw new Error(`Папка: нет такой папки ${path}`);
  return resolve(path);
}
