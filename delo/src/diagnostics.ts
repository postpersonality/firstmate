import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { id } from './model.ts';

export type Diagnostics = { available: boolean; entries: string[]; note: string; truncated?: boolean };

// Status declarations can contain copied errors; never display credential-bearing lines.
export const diagnosticText = (text: string) => text.split('\n').map(line => /token|secret|password|passwd|authorization|cookie|api[-_. ]?key|access[-_. ]?key|credential|private.key|\.env\b|bearer\s|sk-[\w-]{12,}|gh[pousr]_[\w]+|https?:\/\/[^\s/]+@/i.test(line)
  ? '[Строка с возможными секретами скрыта]' : line.replace(/\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f]/g, '')).join('\n');

// Fixed local paths only: no path supplied by a link, query string or worker metadata is opened.
export function taskDiagnostics(home: string, taskId: string, worker: any): Diagnostics {
  const missing: Diagnostics = { available: false, entries: [], note: 'Диагностика не подтверждена: нет доступного журнала, связанного с этим исполнителем. Полный журнал процесса здесь недоступен.' };
  if (!id.safeParse(taskId).success || worker?.id !== taskId || !worker.spawn_gen || worker.remote || !['ship', 'scout'].includes(worker.kind)) return missing;
  try {
    const state = join(realpathSync(home), 'state');
    if (realpathSync(state) !== state) return missing;
    const read = (suffix: string, limit: number, tail = false) => {
      if (realpathSync(join(state, `${taskId}.${suffix}`)) !== resolve(state, `${taskId}.${suffix}`)) throw new Error('unbound file');
      const fd = openSync(join(state, `${taskId}.${suffix}`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1 || !tail && info.size > limit) throw new Error('unbound file');
        const start = tail ? Math.max(0, info.size - limit) : 0;
        const buffer = Buffer.alloc(Math.min(info.size, limit));
        const count = readSync(fd, buffer, 0, buffer.length, start);
        const text = buffer.subarray(0, count).toString('utf8');
        if (realpathSync(state) !== state || realpathSync(join(state, `${taskId}.${suffix}`)) !== resolve(state, `${taskId}.${suffix}`)) throw new Error('unbound file');
        return { text: start ? text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '' : text, truncated: start > 0 };
      } finally { closeSync(fd); }
    };
    const source = read('meta', 131072).text;
    const meta = new Map<string, string>();
    for (const line of source.split('\n').filter(Boolean)) {
      const match = /^([a-z_]+)=(.*)$/.exec(line);
      if (!match || meta.has(match[1])) return missing;
      meta.set(match[1], match[2]);
    }
    for (const [key, expected] of Object.entries({ spawn_gen: worker.spawn_gen, kind: worker.kind, project: worker.project ?? '', branch: worker.branch ?? '', worktree: worker.paths?.worktree?.path ?? '' })) {
      if ((meta.get(key) ?? '') !== expected) return missing;
    }
    if (meta.get('remote_host') || meta.has('endpoint_task_id') && meta.get('endpoint_task_id') !== taskId) return missing;
    const log = read('status', 16384, true);
    if (read('meta', 131072).text !== source) return missing;
    const lines = log.text.split('\n').filter(line => /^(failed|blocked|paused|needs-decision)(?:\s*\[[^\]]*\])*\s*:/.test(line));
    return { available: true, entries: lines.slice(-12).map(line => diagnosticText(line).slice(0, 2000)), truncated: log.truncated || lines.length > 12 || lines.some(line => line.length > 2000), note: 'Последние сообщения об ошибках и ожидании из журнала этой задачи. Это история, включая прежние запуски, а не текущее состояние. Полный журнал процесса здесь недоступен.' };
  } catch { return missing; }
}
