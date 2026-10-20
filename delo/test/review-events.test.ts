import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { CompactReviewEvents } from '../src/review-events.ts';
import type { ReviewProgress } from '../src/review.ts';

test('captured compact console transcript preserves observed durations, partial first stage and cancelled exit-zero outcome', () => {
  // Provenance: actual sa-review console supplied by user 2026-10-20, replay of runs/152530202-20261019162826/.ralph/events-20261019-141119.jsonl.
  const p: ReviewProgress = {status:'running',current:'unknown',startedAt:'now',elapsedMs:0,phases:[]};
  const parser = new CompactReviewEvents(p);
  for (const line of readFileSync(new URL('./fixtures/sa-review-console.txt', import.meta.url),'utf8').trim().split('\n')) assert.equal(parser.consume(line), true);
  assert.equal(p.phases[0].elapsedMs, null, 'first incomplete stage has no invented start');
  assert.equal(p.phases.find(p=>p.name==='audit_review')?.elapsedMs, 500000);
  assert.equal(p.phases.find(p=>p.name==='audit_revision')?.elapsedMs, 421000);
  assert.equal(p.phases.find(p=>p.name==='comment_draft')?.elapsedMs, 109000);
  assert.equal(p.reportedTotal, '19m 59s');
  assert.match(p.terminalFailure!, /cancelled/);
  assert.equal(p.events?.length, 8);
  parser.consume('17:32:00  novel.transition value=1 → New agent');
  assert.equal(p.current,'unknown'); assert.match(p.events!.at(-1)!, /novel.transition/);
  assert.match(p.warnings!.at(-1)!, /Unsupported/);
});

test('console stage duration crosses midnight without inventing date or timezone', () => {
  const p: ReviewProgress = {status:'running',current:'unknown',startedAt:'now',elapsedMs:0,phases:[]}; const parser = new CompactReviewEvents(p);
  parser.consume('23:59:59  audit.start'); parser.consume('00:00:02  audit.done → Audit reviewer');
  assert.equal(p.phases[0].elapsedMs, 3000); assert.equal(p.phases[0].startedAt,'23:59:59');
});
