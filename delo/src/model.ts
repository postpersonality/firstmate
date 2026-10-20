import { z } from 'zod';
import { reviewInput, type Review, type ReviewProgress } from './review.ts';

export const line = z.string().max(500).refine(v => !/[\r\n]/.test(v), 'Нужна одна строка');
export const text = z.string().max(60000);
export const id = z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,120}$/u, 'Недопустимый идентификатор');
export const state = z.enum(['active', 'paused', 'done', 'dropped']);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Нужна дата ГГГГ-ММ-ДД');
export const goalInput = z.object({
  title: line.min(1), kind: z.enum(['ship', 'scout']).default('ship'), repo: line.default(''), body: text.default(''),
  blockedBy: z.union([id, z.literal('')]).default(''), holdUntil: z.union([day, z.literal('')]).default(''), personal: z.boolean().default(false),
  caseId: z.union([id, z.literal('')]).default(''), folder: line.default(''),
});
// A дело is a backlog row of kind program whose body is the managed brief after its `Источник:` lines.
export const caseInput = z.object({
  requestId: z.string().uuid().optional(), review: reviewInput.optional(),
  title: line.min(1), why: text.default(''), doneWhen: text.default(''), context: text.default(''), constraints: text.default(''), sources: text.default(''),
});
// shortcut: список повторяет AGENTS.md, раздел 4, и установленные программы; править при смене списка
export const harnesses = ['claude', 'codex', 'opencode', 'pi', 'grok', 'kimi', 'gemini', 'agy'] as const;
// «Новый агент» on an open дело; an empty harness leaves the choice to firstmate and writes no line.
export const agentInput = z.object({
  direction: text.refine(v => v.trim() !== '', 'Нужно направление'), kind: z.enum(['ship', 'scout']).default('scout'), repo: line.default(''),
  harness: z.union([z.enum(harnesses), z.literal('')]).default(''), interactive: z.boolean().default(false), folder: line.default(''),
});
export const closeCaseInput = z.object({ confirmed: z.array(id).default([]) });
export const goalPatch = z.object({ title: line.min(1).optional(), body: text.optional(), personal: z.boolean().optional(), folder: line.optional(), state: state.optional() });
export const actionInput = z.object({ reason: line.optional(), answer: z.string().max(500).refine(v => !v.includes('\t'), 'Без табуляции').optional(), until: day.optional() });
export const personalLine = 'Личное';

// Card buttons by backlog row state (plan section 5); the server refuses any action not listed here.
export type Action = 'start' | 'pause' | 'unhold' | 'close' | 'decline' | 'answer' | 'release' | 'later' | 'reopen' | 'stop';
export function actions(task: { state: string; held?: string | boolean; hold_kind?: string; kind?: string }): Action[] {
  if (task.kind === 'program') return []; // A дело has its own buttons on its page.
  if (task.state === 'in_flight') return task.hold_kind === 'captain' ? ['answer', 'stop', 'close'] : ['stop', 'close'];
  if (task.state === 'done') return task.kind === 'captain' || task.hold_kind === 'captain' ? [] : ['reopen'];
  if (task.hold_kind === 'captain') return [task.kind === 'captain' ? 'answer' : 'release', 'later', 'close'];
  if (task.held === true || task.held === 'yes') return ['unhold', 'close', 'decline'];
  return ['start', 'pause', 'close', 'decline'];
}

// Where a row stands for a дело's counters and task list.
export type Phase = 'waiting' | 'working' | 'next' | 'done';
export function phase(task: { state: string; hold_kind?: string }): Phase {
  return task.state === 'done' ? 'done' : task.hold_kind === 'captain' ? 'waiting' : task.state === 'in_flight' ? 'working' : 'next';
}

// A card is one Firstmate row; links are the row's own pr/report/doc links.
export type Goal = {
  review?: Review; reviewProgress?: ReviewProgress;
  id: string; title: string; state: z.infer<typeof state>; body: string; kind?: string; repo?: string; personal: boolean; actions: Action[];
  managedBrief?: boolean; prUrl?: string; reason?: string; blockers?: { id: string; title: string }[];
  why: string; doneWhen: string; context: string; constraints: string[]; holdKind?: string; inFlight?: boolean; links: string[]; report: boolean; folder: string; harness: string;
};
