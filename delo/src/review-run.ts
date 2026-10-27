import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { reviewConfig } from './review-config.ts';
import { Firstmate } from './firstmate.ts';
import { id } from './model.ts';
import { reviewOf, validateReview, type ReviewProgress } from './review.ts';
import { CompactReviewEvents, eventPhase, eventFailure } from './review-events.ts';

export const saCommand = { command: 'npm' };
const enrichment = z.object({
  status: z.enum(['found', 'none', 'unavailable']), links: z.array(z.string().url().refine(v => /^https?:\/\//i.test(v))),
  note: z.string().trim().min(1).max(4000), startedAt: z.iso.datetime({ offset: true }), endedAt: z.iso.datetime({ offset: true }),
}).refine(v => Date.parse(v.startedAt) <= Date.parse(v.endedAt) && Date.parse(v.endedAt) <= Date.now(), 'Некорректное время поиска связей')
  .refine(v => v.status !== 'found' || v.links.length > 0, 'Нет найденных ссылок');

// Long console lines are discarded; only the entrypoint's one bounded run-directory announcement is parsed.
function lines(onLine: (line: string) => void) {
  let pending = '', dropping = false;
  const decoder = new StringDecoder('utf8');
  return (chunk: Buffer) => {
    for (const [i, part] of decoder.write(chunk).split('\n').entries()) {
      if (i) { if (!dropping) onLine(pending.replace(/\r$/, '')); pending = ''; dropping = false; }
      if (!dropping) { if (pending.length + part.length > 65536) { pending = ''; dropping = true; } else pending += part; }
    }
  };
}

export function saveProgress(home: string, taskId: string, progress: ReviewProgress) {
  progress.updatedAt = new Date().toISOString();
  const dir = join(home, 'data', taskId); mkdirSync(dir, { recursive: true });
  const path = join(dir, 'review-progress.json');
  writeFileSync(path + '.tmp', JSON.stringify(progress, null, 2) + '\n', { mode: 0o600 }); renameSync(path + '.tmp', path);
}
export function reviewStatus(home: string, taskId: string, state: string, detail: string) {
  mkdirSync(join(home, 'state'), { recursive: true });
  appendFileSync(join(home, 'state', taskId + '.status'), `${state} [at=${Math.floor(Date.now() / 1000)}]: ${detail.replace(/[\r\n]/g, ' ')}\n`);
}

// Called inside the launched agent only. Overrides are an offline fixture seam, never HTTP inputs.
export async function runSaReview(options: { home: string; taskId: string; command?: string; cwd?: string; pollMs?: number }): Promise<ReviewProgress> {
  const { home, taskId } = options; id.parse(taskId);
  const fm = new Firstmate(home), task = fm.show(taskId);
  const input = reviewOf(task.body ?? '');
  if (!input || input.kind !== 'sa' || task.kind !== 'scout' || task.state === 'done') throw new Error('Нужна открытая scout задача SA ревью');
  const review = validateReview(input, home);
  if (review.kind !== 'sa') throw new Error('Нужен вид SA');
  let links: z.infer<typeof enrichment>;
  try { links = enrichment.parse(JSON.parse((task.body ?? '').split('\n').find(l => l.startsWith('Review links: '))?.slice(14) ?? '')); }
  catch { throw new Error('Сначала агент должен проверить связи Confluence/Jira и сохранить Review links'); }
  for (const link of links.links) if (!(task.body ?? '').split('\n').includes(`Источник: ${link}`)) throw new Error('Найденная связь не добавлена к описанию задачи');
  const dir = join(home, 'data', taskId), lock = join(home, 'state', taskId + '.review-lock');
  mkdirSync(join(home, 'state'), { recursive: true });
  try { mkdirSync(lock); } catch { throw new Error('Ревью уже запущено; проверьте существующий процесс'); }
  try {
    if (existsSync(join(dir, 'review-progress.json'))) throw new Error('Ревью уже завершено или прервано; повтор требует новой задачи');
    mkdirSync(dir, { recursive: true });
    const startedAt = new Date().toISOString();
    const progress: ReviewProgress = { status: 'running', current: 'unknown', startedAt, elapsedMs: 0,
      protocol: 'ralph-events-jsonl/observed-2026-10-20', warnings: [],
      phases: [{ name: 'links', startedAt: links.startedAt, endedAt: links.endedAt, elapsedMs: Date.parse(links.endedAt) - Date.parse(links.startedAt), source: 'agent' }] };
    const cwd = options.cwd ?? reviewConfig(home).saReviewCwd;
    if (!cwd) throw new Error('Укажите saReviewCwd в config/delo-review.json');
    const argv = ['run', 'sa-review', '--', review.document, '--repo', review.repo];
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt }));
    saveProgress(home, taskId, progress);
    reviewStatus(home, taskId, 'working', 'SA review command start; phase=unknown; elapsed=0ms');
    let consoleBytes = 0, runDirectory = '', lastStatus = Date.now();
    const warn = (message: string) => { if (!progress.warnings!.includes(message)) progress.warnings!.push(message); };
    const compact = new CompactReviewEvents(progress, detail => reviewStatus(home, taskId, 'working', detail));
    const output = lines(line => {
      if (compact.consume(line)) return;
      if (!line.startsWith('Run directory: ')) return;
      const candidate = line.slice(15), rel = relative(resolve(cwd, 'runs'), resolve(candidate));
      if (isAbsolute(candidate) && rel && !rel.startsWith('..') && !isAbsolute(rel)) { runDirectory = candidate; progress.runDirectory = candidate; }
      else warn('Run directory announcement is outside the command runs folder');
    });
    const journals = new Map<string, { offset: number; consume: (chunk: Buffer) => void }>();
    let lastEventTime = Date.parse(startedAt);
    const transition = (event: any) => {
      if (event.topic === 'iteration.summary') return;
      progress.events ??= []; if (progress.events.length < 500) progress.events.push(JSON.stringify(event).slice(0, 4096));
      if (['FACTORY_STOP', 'loop.terminate', 'audit.blocked', 'audit_defender.exhausted'].includes(event.topic)) {
        const payload = String(event.payload ?? '');
        if (eventFailure(event.topic, payload)) progress.terminalFailure = payload.slice(0, 4096) || event.topic;
        if (event.topic === 'loop.terminate') progress.reportedTotal = /Duration:\s*(.*?)\s*(?:- Exit code:|$)/i.exec(payload)?.[1];
      }
      const time = typeof event.ts === 'string' ? Date.parse(event.ts) : NaN;
      if (!Number.isFinite(time) || time < Date.parse(startedAt) || time > Date.now() + 1000 || time < lastEventTime) {
        warn('Unsupported event timestamp; stage timing unknown'); progress.current = 'unknown'; return;
      }
      const name = eventPhase(event.topic);
      if (!name) { warn(`Unsupported transition: ${String(event.topic).slice(0, 120)}; stage unknown`); }
      const at = new Date(time).toISOString(), previous = progress.phases.at(-1);
      if (previous && !previous.endedAt) {
        previous.endedAt = at; previous.elapsedMs = time - Date.parse(previous.startedAt);
        reviewStatus(home, taskId, 'working', `${previous.name} end=${at}; elapsed=${previous.elapsedMs}ms`);
      }
      lastEventTime = time;
      progress.current = name ?? 'unknown';
      progress.phases.push({ name: progress.current, startedAt: at, elapsedMs: 0, source: 'ledger' });
      reviewStatus(home, taskId, 'working', `${progress.current} start=${at}; elapsed=0ms; source=ledger`);
    };
    const poll = () => {
      if (runDirectory && !compact.seen) {
        const journalDir = join(runDirectory, '.ralph');
        let names: string[] = []; try { names = readdirSync(journalDir).filter(n => /^events-.*\.jsonl$/.test(n)).sort(); } catch { /* Not created yet. */ }
        for (const name of names) {
          const path = join(journalDir, name);
          let cursor = journals.get(path);
          if (!cursor) { cursor = { offset: 0, consume: lines(line => { try { transition(JSON.parse(line)); } catch { warn('Malformed journal event; stage timing unknown'); } }) }; journals.set(path, cursor); }
          let fd: number | undefined;
          try {
            if (statSync(path).size < cursor.offset) { warn('Journal truncated; stage timing unknown'); continue; }
            fd = openSync(path, 'r'); const buffer = Buffer.alloc(65536);
            // Bound each poll to 1MiB per journal and retain only one bounded partial line.
            for (let n = 0; n < 16; n++) { const count = readSync(fd, buffer, 0, buffer.length, cursor.offset); if (!count) break; cursor.offset += count; cursor.consume(buffer.subarray(0, count)); }
          } catch { warn('Journal unavailable; stage timing unknown'); } finally { if (fd !== undefined) closeSync(fd); }
        }
      }
      const now = Date.now(); progress.elapsedMs = now - Date.parse(startedAt);
      const phase = progress.phases.at(-1); if (phase && !phase.endedAt && phase.source !== 'console') phase.elapsedMs = now - Date.parse(phase.startedAt);
      if (now - lastStatus >= 60000) { reviewStatus(home, taskId, 'working', `phase=${progress.current}; elapsed=${progress.elapsedMs}ms`); lastStatus = now; }
      saveProgress(home, taskId, progress);
    };
    let spawnError = '', signal: NodeJS.Signals | null = null;
    const child = spawn(options.command ?? saCommand.command, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = (chunk: Buffer) => { const remaining = 2 * 1024 * 1024 - consoleBytes; if (remaining > 0) { const part = chunk.subarray(0, remaining); appendFileSync(join(dir, 'review-console.log'), part); consoleBytes += part.length; } };
    child.stdout.on('data', (chunk: Buffer) => { log(chunk); output(chunk); }); child.stderr.on('data', log);
    const timer = setInterval(poll, options.pollMs ?? 1000);
    const exitCode = await new Promise<number>(resolve => {
      child.on('error', error => { spawnError = error.message; });
      child.on('close', (code, stopped) => { signal = stopped; resolve(code ?? 1); });
    });
    clearInterval(timer); poll();
    let result: any;
    try { if (runDirectory) result = JSON.parse(readFileSync(join(runDirectory, 'result.json'), 'utf8')); } catch { warn('No valid result.json; result unknown'); }
    if (!result) warn('No valid result.json; result unknown');
    const endedAt = new Date().toISOString(), phase = progress.phases.at(-1);
    if (phase && !phase.endedAt && phase.source !== 'console') { phase.endedAt = endedAt; phase.elapsedMs = Date.parse(endedAt) - Date.parse(phase.startedAt); }
    progress.endedAt = endedAt; progress.exitCode = exitCode; progress.result = typeof result?.status === 'string' ? result.status : 'unknown';
    progress.status = exitCode === 0 && result?.status === 'ready' && !progress.terminalFailure ? 'done' : 'failed';
    progress.error = spawnError || (signal ? `signal ${signal}` : '') || progress.terminalFailure || (progress.status === 'failed' ? String(result?.error ?? result?.payload ?? `Command exit ${exitCode}; result ${progress.result}`) : undefined);
    if (!journals.size && !compact.seen) warn('No supported events; phases unknown, only command elapsed is available');
    saveProgress(home, taskId, progress);
    const report = ['# Ревью системной аналитики', '', `Документ: ${review.document}`, `Проект контекста: ${review.repo}`, `Связи: ${links.status} - ${links.note}`, ...links.links,
      '', `Итог: ${progress.status}; exit=${exitCode}; result=${progress.result}`, `Начало: ${startedAt}`, `Окончание: ${endedAt}`, `Общее время команды: ${progress.elapsedMs} ms`,
      `Каталог результатов: ${runDirectory || 'unknown'}`, `Протокол: ${progress.protocol}`, '',
      `Общее время по оркестратору: ${progress.reportedTotal ?? 'unknown'}`,
      'Время стадий - границы наблюдаемых событий журнала; исполнение между событиями не детализировано.',
      ...progress.phases.map(p => `${p.name}: ${p.startedAt} → ${p.endedAt ?? 'unknown'}; ${p.elapsedMs ?? 'unknown'} ms; source=${p.source}`),
      ...(progress.events ?? []),
      ...progress.warnings!.map(w => `Ограничение: ${w}`), progress.error ?? '', '', 'Консоль: review-console.log (первые 2 MiB).',
    ].join('\n');
    writeFileSync(join(dir, 'report.md'), report + '\n');
    reviewStatus(home, taskId, progress.status === 'failed' ? 'failed' : 'working', `SA review command ${progress.status}; phase=${progress.current}; exit=${exitCode}; elapsed=${progress.elapsedMs}ms; report=data/${taskId}/report.md`);
    return progress;
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { home: { type: 'string' }, task: { type: 'string' } } });
    if (!values.home || !isAbsolute(values.home) || !values.task) throw new Error('Usage: node review-run.ts --home <absolute FM_HOME> --task <id>');
    const result = await runSaReview({ home: values.home, taskId: values.task }); process.exitCode = result.status === 'done' ? 0 : result.exitCode || 1;
  } catch (error: any) { console.error(error.message); process.exitCode = 1; }
}
