import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { codeReviewInput, codeReviewInstructions } from './code-review.ts';

const http = z.string().max(2000).url().refine(value => /^https?:\/\//i.test(value), 'Нужна HTTP(S) ссылка на документ');
export const reviewInput = z.discriminatedUnion('kind', [z.object({ kind: z.literal('sa'), document: http, repo: z.string().trim().min(1).max(500) }), codeReviewInput]);
export type Review = z.infer<typeof reviewInput>;
const progressInput = z.object({
  status: z.enum(['running', 'done', 'failed']), current: z.string(), startedAt: z.string(), endedAt: z.string().optional(), elapsedMs: z.number().nonnegative(),
  phases: z.array(z.object({ name: z.string(), startedAt: z.string(), endedAt: z.string().optional(), elapsedMs: z.number().nonnegative().nullable(), source: z.string() })),
  runDirectory: z.string().optional(), exitCode: z.number().optional(), result: z.string().optional(), error: z.string().optional(),
  protocol: z.string().optional(), warnings: z.array(z.string()).optional(), updatedAt: z.string().optional(),
  events: z.array(z.string()).optional(), reportedTotal: z.string().optional(), terminalFailure: z.string().optional(),
});
export type ReviewProgress = z.infer<typeof progressInput>;
export const reviewLine = (review: Review) => `Review: ${JSON.stringify(review)}`;
export function reviewOf(body: string): Review | undefined {
  const line = body.split('\n').find(line => line.startsWith('Review: '));
  try { return reviewInput.parse(JSON.parse(line?.slice(8) ?? '')); } catch { return undefined; }
}

// Registry names refer to flat projects/<name> clones, including symlinks to external checkouts.
export function reviewProjects(home: string) {
  let registry = ''; try { registry = readFileSync(join(home, 'data/projects.md'), 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  return registry.split('\n').flatMap(line => {
    const name = /^- (.+?)(?: \[| - )/.exec(line)?.[1];
    if (!name || name.includes('/') || name === '..') return [];
    try { const path = realpathSync(join(home, 'projects', name)); return statSync(path).isDirectory() ? [{ name, path }] : []; } catch { return []; }
  });
}
export function validateReview(input: Review, home: string): Review {
  const data = reviewInput.parse(input);
  if (data.kind === 'code' && !data.repo.trim()) return { ...data, repo: '' };
  const repo = reviewProjects(home).find(p => p.name === data.repo)?.path ?? data.repo;
  if (!isAbsolute(repo)) throw new Error('Проект ревью: выберите проект или укажите абсолютный путь');
  try { if (statSync(repo).isDirectory()) return { ...data, repo: realpathSync(repo) }; } catch { /* Refuse below. */ }
  throw new Error('Проект ревью: нет такой папки');
}
export function readReviewProgress(home: string, taskId: string): ReviewProgress | undefined {
  try { return progressInput.parse(JSON.parse(readFileSync(join(home, 'data', taskId, 'review-progress.json'), 'utf8'))); } catch { return undefined; }
}

export function reviewInstructions(review: Review, home: string, taskId: string) {
  if (review.kind === 'code') return [reviewLine(review), '', codeReviewInstructions(review, taskId, home)].join('\n');
  const runner = join(home, 'delo/src/review-run.ts');
  return [reviewLine(review), '',
    'Выполни ревью системной аналитики. Контекстный репозиторий указан в Review.repo; это контекст ревью, а не папка дежурства и не runtime home.',
    'Сначала через навыки confluence и jira прочитай документ, извлеки связанные эпики и задачи на системную аналитику. Найденные HTTP(S) ссылки добавь к описанию этой задачи строками «Источник: <ссылка>». Ничего не придумывай: отсутствие связей и недоступные источники отрази честно.',
    'Сохрани в описании строку Review links: с JSON {"status":"found|none|unavailable","links":["https://…"],"note":"что проверено/недоступно","startedAt":"ISO время начала поиска","endedAt":"ISO время окончания поиска"}. Для found нужны реальные ссылки. Сохрани остальные строки описания.',
    `Затем запусти внутри своего агента через execFile/spawn без shell: node с argv ${JSON.stringify([runner, '--home', home, '--task', taskId])}. Команду исполняет агент, HTTP сервер её не запускает.`,
    'Runner запускает npm run sa-review -- <document> --repo <repo> в /home/user/Projects/!researches⭐/dark-factory/3-sa-battle и мониторит реальные журналы. Дождись его завершения, читай review-progress.json, сообщай firstmate текущую фазу, начало/окончание и elapsed. Не придумывай стадии по таймеру; unknown означает отсутствие событий.',
    `Runner сохраняет data/${taskId}/report.md и статусы; после успеха прикрепи к задаче её report через существующий tasks-axi done --report data/${taskId}/report.md. При ненулевом выходе сообщи failed и не закрывай задачу как done.`,
    'Не меняй внешние Jira/PR статусы, approve или worklog и не публикуй комментарии. Не подменяй npm script отдельным навыком или старым исследованием.',
  ].join('\n');
}
