import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { Firstmate } from './firstmate.ts';
import { id } from './model.ts';
import { readReviewProgress, reviewOf } from './review.ts';
import { reviewStatus, saveProgress } from './review-run.ts';

// Observation writer only: the invoking agent owns the review skill and actual phase boundaries.
export function recordReviewProgress(home: string, taskId: string, input: unknown) {
  id.parse(taskId);
  const { event, phase, detail } = z.object({ event: z.enum(['start', 'end', 'done', 'failed']), phase: z.string().trim().min(1).max(120).refine(v => !/[\r\n]/.test(v)), detail: z.string().max(4000).default('') }).parse(input);
  const fm = new Firstmate(home), task = fm.show(taskId);
  if (!reviewOf(task.body ?? '') || task.kind !== 'scout' || task.state === 'done') throw new Error('Нужна открытая задача ревью');
  const now = new Date().toISOString();
  const progress = readReviewProgress(home, taskId) ?? { status: 'running' as const, current: 'unknown', startedAt: now, elapsedMs: 0, phases: [], protocol: 'agent-observations/v1' };
  if (progress.status !== 'running') throw new Error('Ревью уже завершено');
  if (progress.protocol !== 'agent-observations/v1') throw new Error('Этот прогресс принадлежит запущенной команде');
  const active = progress.phases.at(-1);
  if (event === 'start') {
    if (active && !active.endedAt) {
      if (active.name === phase) return progress;
      throw new Error('Сначала отметьте окончание текущего этапа');
    }
    progress.phases.push({ name: phase, startedAt: now, elapsedMs: 0, source: 'agent' }); progress.current = phase;
  } else {
    if (active && !active.endedAt) {
      if (active.name !== phase) throw new Error('Не совпадает текущий этап');
      active.endedAt = now; active.elapsedMs = Date.parse(now) - Date.parse(active.startedAt);
    } else if (event === 'end') throw new Error('Этот этап не начат');
    progress.current = event === 'end' ? 'unknown' : phase;
  }
  progress.elapsedMs = Date.parse(now) - Date.parse(progress.startedAt);
  if (event === 'done' || event === 'failed') { progress.status = event; progress.endedAt = now; if (event === 'failed') progress.error = detail || 'Агент сообщил об ошибке'; }
  saveProgress(home, taskId, progress);
  reviewStatus(home, taskId, event === 'failed' ? 'failed' : 'working', `review ${phase} ${event}; at=${now}; elapsed=${progress.elapsedMs}ms${detail ? '; ' + detail : ''}`);
  if (event === 'done' || event === 'failed') {
    const path = join(home, 'data', taskId, 'report.md');
    const summary = ['## Ход ревью', `Итог: ${progress.status}`, `Начало: ${progress.startedAt}`, `Окончание: ${now}`, `Общее время: ${progress.elapsedMs} ms`, detail,
      ...progress.phases.map(p => `${p.name}: ${p.startedAt} → ${p.endedAt ?? 'unknown'}; ${p.elapsedMs ?? 'unknown'} ms; source=agent`),
      ...(task.body ?? '').split('\n').filter(l => /^(Источник: |Review: |Review links: )/.test(l)), '',
    ].join('\n');
    // The skill may already have written its findings; preserve them and append observations.
    if (existsSync(path)) appendFileSync(path, '\n' + summary); else writeFileSync(path, '# Отчёт ревью\n\n' + summary);
  }
  return progress;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { home: { type: 'string' }, task: { type: 'string' }, event: { type: 'string' }, phase: { type: 'string' }, detail: { type: 'string' } } });
    if (!values.home || !isAbsolute(values.home) || !values.task) throw new Error('Usage: node review-progress.ts --home <absolute-home> --task <id> --event start|end|done|failed --phase <actual-phase> [--detail <evidence>]');
    console.log(JSON.stringify(recordReviewProgress(values.home, values.task, values)));
  } catch (error: any) { console.error(error.message); process.exitCode = 1; }
}
