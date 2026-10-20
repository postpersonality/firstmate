import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.ts';
import { run } from '../src/process.ts';
import { firstmateHome } from './firstmate-home.ts';

test('shared progress CLI records agent-observed boundaries and failure report without running a review', () => {
  const root = mkdtempSync(join(tmpdir(),'delo-progress-'));
  try {
    const store = new Store({firstmateHome:firstmateHome(root)});
    const taskId = store.createCase({title:'Observed review',requestId:randomUUID(),review:{kind:'sa',document:'https://example.com/pages/1',repo:root}}).tasks[0].id;
    const cli = (...args:string[]) => run(process.execPath, [new URL('../src/review-progress.ts',import.meta.url).pathname,'--home',store.firstmate.home,'--task',taskId,...args]);
    cli('--event','start','--phase','metadata','--detail','Sources actually read');
    assert.equal(store.get(taskId).reviewProgress?.current,'metadata');
    cli('--event','end','--phase','metadata');
    cli('--event','start','--phase','review');
    cli('--event','failed','--phase','review','--detail','Source unavailable');
    const g = store.get(taskId);
    assert.equal(g.reviewProgress?.status,'failed');
    assert.ok(g.reviewProgress?.phases[0].endedAt);
    assert.equal(g.report,true);
    assert.match(store.report(taskId).text,/Source unavailable/);
    assert.match(readFileSync(join(store.firstmate.home,'state',taskId+'.status'),'utf8'),/^failed \[at=\d+\]/m);
    assert.throws(()=>cli('--event','done','--phase','review'),/заверш/);
    assert.equal(store.firstmate.show(taskId).state,'queued');
  } finally {rmSync(root,{recursive:true,force:true});}
});
