import type { Goal } from '../src/model.ts';
import type { Overview, Row, CaseRow } from '../src/overview.ts';
type ViewGoal = Goal & { inbox?: { requests: { requestId: string; at: string; state: string; acknowledged: boolean; reply: unknown }[]; ready?: any }; worker?: { harness: string; current?: string; reason?: string; prUrl?: string } };
type CaseTask = Pick<Goal, 'id' | 'title' | 'state' | 'actions' | 'holdKind' | 'inFlight' | 'links' | 'report' | 'review' | 'reviewProgress'> & { phase: keyof typeof phaseLabels };
