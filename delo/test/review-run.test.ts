import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.ts';
import { firstmateHome } from './firstmate-home.ts';
import { runSaReview, saCommand } from '../src/review-run.ts';
import { fileURLToPath } from 'node:url';

test('agent runner executes exact npm argv/cwd, consumes real event boundaries live, and preserves terminal failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-review-run-'));
  try {
    const home = firstmateHome(root), cwd = join(root, 'sa fixture'); mkdirSync(cwd);
    const store = new Store({ firstmateHome: home });
    const fake = join(root, 'npm');
    writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs'), p = require('node:path');
fs.writeFileSync(p.join(process.cwd(), 'invocation.json'), JSON.stringify({cwd: process.cwd(), argv: process.argv.slice(2)}));
const dir = p.join(process.cwd(), 'runs', 'fixture'); fs.mkdirSync(p.join(dir, '.ralph'), {recursive:true});
console.log('Run directory: ' + dir);
const log = p.join(dir, '.ralph/events-fixture.jsonl');
fs.writeFileSync(log, JSON.stringify({ts:new Date().toISOString(),topic:'audit.start'})+'\\n');
setTimeout(() => { fs.appendFileSync(log, JSON.stringify({ts:new Date().toISOString(),topic:'audit.done'})+'\\n'); }, 150);
setTimeout(() => { fs.appendFileSync(log, '{"topic":"partial"'); fs.writeFileSync(p.join(dir,'result.json'), JSON.stringify({status:process.env.FAKE_FAIL?'blocked':'ready'})); process.exit(process.env.FAKE_FAIL?7:0); }, 450);
`, { mode: 0o755 });
    const make = () => store.createCase({ title: 'SA fixture', requestId: randomUUID(), review: { kind: 'sa', document: 'https://example.com/pages/12?x=one&y=two', repo: root } }).tasks[0].id;
    const taskId = make();
    assert.match(saCommand.cwd, /3-sa-battle$/);
    assert.equal(saCommand.command, 'npm');
    await assert.rejects(runSaReview({ home, taskId, command: fake, cwd, pollMs: 20 }), /связ/i);
    const enrich = (id: string) => {
      const old = store.firstmate.show(id);
      store.firstmate.update(id, {body: old.body + '\nИсточник: https://jira.example/browse/EXAMPLE-1\nReview links: ' + JSON.stringify({status:'found',links:['https://jira.example/browse/EXAMPLE-1'],note:'epic found; SA issue unavailable',startedAt:new Date(Date.now()-100).toISOString(),endedAt:new Date().toISOString()})});
    };
    enrich(taskId);
    const progressPath = join(home, 'data', taskId, 'review-progress.json');
    const pending = runSaReview({ home, taskId, command: fake, cwd, pollMs: 20 });
    await assert.rejects(runSaReview({ home, taskId, command: fake, cwd, pollMs: 20 }), /уже запущено/i);
    const until = async (check: () => boolean) => { for(let i=0;i<100;i++){try{if(check())return;}catch{} await new Promise(r=>setTimeout(r,10));}assert.fail('no live progress'); };
    await until(() => JSON.parse(readFileSync(progressPath,'utf8')).current === 'audit');
    const live = JSON.parse(readFileSync(progressPath,'utf8'));
    assert.equal(live.status,'running');
    assert.equal(store.get(taskId).reviewProgress?.current, 'audit');
    const result = await pending;
    assert.equal(result.status, 'done');
    assert.equal(result.exitCode,0);
    const invocation = JSON.parse(readFileSync(join(cwd,'invocation.json'),'utf8'));
    assert.deepEqual(invocation, {cwd,argv:['run','sa-review','--','https://example.com/pages/12?x=one&y=two','--repo',root]});
    const audit = result.phases.find(p=>p.name==='audit')!;
    assert.ok(audit.endedAt && audit.elapsedMs! > 0);
    assert.equal(audit.source,'ledger');
    assert.match(readFileSync(join(home,'data',taskId,'report.md'),'utf8'),/EXAMPLE-1/);
    assert.match(readFileSync(join(home,'state',taskId+'.status'),'utf8'),/audit_review.*elapsed/);
    await assert.rejects(runSaReview({home,taskId,command:fake,cwd}), /уже завершено/i);
    const failed = make(); enrich(failed);
    process.env.FAKE_FAIL = '1';
    const bad = await runSaReview({home,taskId:failed,command:fake,cwd,pollMs:20});
    delete process.env.FAKE_FAIL;
    assert.equal(bad.status,'failed'); assert.equal(bad.exitCode,7);
    assert.match(readFileSync(join(home,'state',failed+'.status'),'utf8'), /failed \[at=\d+\]/);
    assert.doesNotMatch(readFileSync(join(home,'state',failed+'.status'),'utf8'),/^done/m);
    assert.equal(store.firstmate.show(failed).state,'queued','runner never closes a failed task');
  } finally {delete process.env.FAKE_FAIL; rmSync(root, {recursive:true,force:true});}
});

test('compact stdout fixture is monitored without journals, survives large noise, and cancellation overrides ready/exit-zero', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delo-review-compact-'));
  try {
    const home = firstmateHome(root), cwd = join(root, 'команда SA'); mkdirSync(cwd);
    const store = new Store({ firstmateHome: home });
    const taskId = store.createCase({title:'Compact review',requestId:randomUUID(),review:{kind:'sa',document:'https://example.com/pages/1',repo:root}}).tasks[0].id;
    const old = store.firstmate.show(taskId);
    store.firstmate.update(taskId,{body:old.body+'\nReview links: '+JSON.stringify({status:'unavailable',links:[],note:'Fixture: source is offline',startedAt:new Date().toISOString(),endedAt:new Date().toISOString()})});
    const fixture = fileURLToPath(new URL('./fixtures/sa-review-console.log', import.meta.url));
    const fake = join(root,'npm');
    writeFileSync(fake, `#!/usr/bin/env node
const fs=require('node:fs'),p=require('node:path');
const dir=p.join(process.cwd(),'runs','compact');fs.mkdirSync(dir,{recursive:true});
console.log('x'.repeat(3*1024*1024));
console.log('Run directory: '+dir);
fs.writeFileSync(p.join(dir,'result.json'),JSON.stringify({status:'ready'}));
const text=fs.readFileSync(${JSON.stringify(fixture)},'utf8');
process.stdout.write(text.slice(0,23));setTimeout(()=>process.stdout.write(text.slice(23)),20);
`,{mode:0o755});
    const result=await runSaReview({home,taskId,command:fake,cwd,pollMs:20});
    assert.equal(result.exitCode,0);assert.equal(result.status,'failed');
    assert.equal(result.protocol,'sa-review-console/observed-2026-10-20');
    assert.equal(result.reportedTotal,'19m 59s');
    assert.equal(result.phases.find(p=>p.name==='audit_review')?.elapsedMs,500000);
    assert.equal(result.phases.find(p=>p.name==='unknown')?.elapsedMs,null);
    assert.match(result.error!,/cancelled/);
    assert.ok(readFileSync(join(home,'data',taskId,'review-console.log')).byteLength<=2*1024*1024);
    assert.match(store.report(taskId).text,/FACTORY_STOP status=failed/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
