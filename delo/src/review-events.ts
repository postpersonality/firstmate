import type { ReviewProgress } from './review.ts';

// Console protocol observed in sa-review/report-run.mjs and the supplied 2026-10-20 transcript.
const phases: Record<string, string> = {
  'audit.start': 'audit', 'audit.done': 'audit_review', 'audit.revised': 'audit_review',
  'review.findings': 'audit_revision', 'review.clean': 'finalize', 'comments.prepare': 'comment_draft',
  'comments.drafted': 'finalize', 'comments.rewrite': 'comment_rewrite', 'comments.rewritten': 'finalize',
  'comments.review': 'comment_review', 'comments.reviewed': 'finalize',
};

export class CompactReviewEvents {
  private clock?: number;
  private offset = 0;
  seen = false;
  private progress: ReviewProgress;
  private changed: (detail: string) => void;
  constructor(progress: ReviewProgress, changed: (detail: string) => void = () => {}) { this.progress = progress; this.changed = changed; }

  consume(line: string) {
    const match = /^(\d{2}:\d{2}:\d{2})\s{2,}([\w.]+)(?:\s+(.*))?$/.exec(line);
    if (!match) return false;
    const [, at, topic, payload = ''] = match;
    const [h, m, s] = at.split(':').map(Number);
    if (h > 23 || m > 59 || s > 59) return false;
    const p = this.progress;
    if (!this.seen) {
      p.phases = p.phases.filter(p => p.source === 'agent');
      p.protocol = 'sa-review-console/observed-2026-10-20';
      if (topic !== 'audit.start') p.phases.push({ name: 'unknown', startedAt: 'unknown', endedAt: at, elapsedMs: null, source: 'console' });
    }
    this.seen = true;
    const raw = line.slice(0, 4096);
    p.events ??= []; if (p.events.length < 500) p.events.push(raw);
    else if (!p.warnings?.includes('Only first 500 console events retained')) (p.warnings ??= []).push('Only first 500 console events retained');
    let time = (h * 3600 + m * 60 + s) * 1000 + this.offset;
    if (this.clock !== undefined && time < this.clock - 12 * 3600000) { this.offset += 86400000; time += 86400000; }
    const backwards = this.clock !== undefined && time < this.clock;
    const previous = p.phases.at(-1);
    if (previous?.source === 'console' && !previous.endedAt) {
      previous.endedAt = at; previous.elapsedMs = backwards ? null : time - this.clock!;
      this.changed(`${previous.name} end=${at}; elapsed=${previous.elapsedMs ?? 'unknown'}ms; source=console`);
    }
    this.clock = time;
    if (backwards) (p.warnings ??= []).push('Console clock moved backwards; transition duration unknown');
    const terminal = ['FACTORY_STOP', 'loop.terminate', 'audit.blocked', 'audit_defender.exhausted'].includes(topic);
    if (terminal && /status=(?:failed|blocked|cancelled|incomplete|exhausted)|cancelled|consecutive_failures|timeout|error|failed/i.test(payload)) p.terminalFailure = raw;
    if (topic === 'loop.terminate') p.reportedTotal = /Duration:\s*(.*?)\s*(?:- Exit code:|$)/i.exec(payload)?.[1];
    p.current = terminal ? 'unknown' : phases[topic] ?? 'unknown';
    if (!terminal) {
      p.phases.push({ name: p.current, startedAt: at, elapsedMs: null, source: 'console' });
      this.changed(`${p.current} start=${at}; elapsed=unknown; event=${topic}`);
      if (!phases[topic]) (p.warnings ??= []).push(`Unsupported event ${topic}; raw transition retained, phase unknown`);
    }
    return true;
  }
}
