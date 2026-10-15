import { z } from 'zod';

export const line = z.string().max(500).refine(v => !/[\r\n]/.test(v), 'Нужна одна строка');
export const text = z.string().max(60000);
export const id = z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,120}$/u, 'Недопустимый идентификатор');
export const state = z.enum(['active', 'paused', 'done', 'dropped']);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Нужна дата ГГГГ-ММ-ДД');
export const goalInput = z.object({
  title: line.min(1), kind: z.enum(['ship', 'scout']).default('ship'), repo: line.default(''), body: text.default(''),
  blockedBy: z.union([id, z.literal('')]).default(''), holdUntil: z.union([day, z.literal('')]).default(''), personal: z.boolean().default(false),
});
export const goalPatch = z.object({ title: line.min(1).optional(), body: text.optional(), personal: z.boolean().optional(), state: state.optional() });
export const actionInput = z.object({ reason: line.optional(), answer: line.refine(v => !v.includes('\t'), 'Без табуляции').optional(), until: day.optional() });
export const personalLine = 'Личное';

// Card buttons by backlog row state (plan section 5); the server refuses any action not listed here.
export type Action = 'start' | 'pause' | 'unhold' | 'close' | 'decline' | 'answer' | 'release' | 'later' | 'reopen';
export function actions(task: { state: string; held?: string | boolean; hold_kind?: string; kind?: string }): Action[] {
  if (task.state === 'in_flight') return ['close'];
  if (task.state === 'done') return task.kind === 'captain' || task.hold_kind === 'captain' ? [] : ['reopen'];
  if (task.hold_kind === 'captain') return [task.kind === 'captain' ? 'answer' : 'release', 'later'];
  if (task.held === true || task.held === 'yes') return ['unhold', 'close', 'decline'];
  return ['start', 'pause', 'close', 'decline'];
}

// A card is one Firstmate row; links are the row's own pr/report/doc links.
export type Goal = {
  id: string; title: string; state: z.infer<typeof state>; body: string; kind?: string; repo?: string; personal: boolean; actions: Action[];
  why: string; doneWhen: string; context: string; constraints: string[]; holdKind?: string; inFlight?: boolean; links: string[];
};
