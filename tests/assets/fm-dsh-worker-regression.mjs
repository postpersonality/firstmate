import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { makeDshFixture } from './fm-dsh-fixture.mjs';

const [root, lab] = process.argv.slice(2);
const worker = join(root, 'bin/fm-dsh-worker.mjs');
const fake = makeDshFixture(lab);
const herdr = join(lab, 'herdr');
writeFileSync(herdr, `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
appendFileSync(process.env.DSH_HERDR_LOG,JSON.stringify(process.argv.slice(2))+'\\n');
console.log(JSON.stringify({result:{}}));
`);
chmodSync(herdr,0o755);
function makeCase(name, extra = []) {
  const dir = join(lab, name), state = join(dir, 'state'), cwd = join(dir, 'cwd'), config = join(dir, 'config');
  for (const path of [state, cwd, config]) mkdirSync(path, { recursive: true });
  const brief = join(dir, 'brief.md');
  writeFileSync(brief, 'Runtime fixture: INITIAL_BRIEF');
  const arm = spawnSync('bash', [join(root, 'bin/fm-busy-event.sh'), 'arm', state, 'case'], { encoding: 'utf8' });
  assert.equal(arm.status, 0, arm.stderr);
  const gen = arm.stdout.trim(), log = join(dir, 'rpc.jsonl'), herdrLog=join(dir,'herdr.jsonl');
  const child = spawn(process.execPath, [worker, '--dsh-bin', fake, '--config-home', config, '--runtime-home', join(dir, 'runtime'), '--cwd', cwd, '--state', state, '--id', 'case', '--gen', gen, '--brief', brief, '--model', 'litellm/test', '--effort', 'low', '--herdr-bin',herdr,'--herdr-session','fm-lab-fixture','--herdr-pane','w1:p2', ...extra], { env: { ...process.env, DSH_FIXTURE_LOG: log, DSH_HERDR_LOG:herdrLog, CLAUDECODE:'1', FM_SUPERVISION_ACTOR:'branch', FM_SUPERVISION_PRIMARY_HARNESS:'codex' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.on('data', b => { output += b; });
  child.stderr.on('data', b => { error += b; });
  let exited = false;
  const exit = new Promise(resolve => child.on('close', code => { exited = true; resolve(code); }));
  return { child, exit, state, cwd, gen, log, herdrLog, output: () => output, error: () => error, exited: () => exited };
}
async function until(predicate, detail) {
  for (let i = 0; i < 120; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(detail);
}
const running = [];
try {
  const c = makeCase('normal'); running.push(c);
  await until(() => existsSync(join(c.state, 'case.dsh-ready')), 'DSH worker did not publish readiness');
  assert.equal(JSON.parse(readFileSync(join(c.state, 'case.dsh-ready'))).gen, c.gen);
  c.child.stdin.write('steer-one\nPERMISSION\nsteer-two\n');
  await until(() => c.output().includes('ACK steer-two'), 'queued steering was lost');
  await until(() => /state=unknown/.test(readFileSync(join(c.state, 'case.busy-state'), 'utf8')), 'last prompt did not settle');
  assert.match(readFileSync(join(c.state, 'case.busy-state'), 'utf8'), /state=unknown source=dsh-acp/);
  assert(existsSync(join(c.state, 'case.turn-ended')));
  c.child.stdin.write('/exit\n');
  assert.equal(await c.exit, 0, c.error());
  const messages = readFileSync(c.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(messages.find(m => m.method === 'session/new').params.cwd, c.cwd);
  assert.deepEqual(messages.find(m=>m.fixtureEnvironment).fixtureEnvironment,{branchPinPresent:false,claudeMarkerPresent:false});
  const prompts = messages.filter(m => m.method === 'session/prompt').map(m => m.params.prompt[0].text);
  assert.match(prompts[0], /INITIAL_BRIEF/);
  assert.deepEqual(prompts.slice(1), ['steer-one', 'PERMISSION', 'steer-two']);
  assert(messages.some(m=>m.id===9001 && m.result?.outcome?.optionId==='native-once-82'));
  assert(messages.some(m => m.method === 'session/close'));
  assert(messages.some(m => m.method === 'session/set_config_option' && m.params.configId === 'reasoning_effort' && m.params.value === 'low'));
  const reports=readFileSync(c.herdrLog,'utf8').trim().split('\n').map(JSON.parse);
  assert(reports.some(a=>a.includes('working')));
  assert(reports.some(a=>a.includes('idle')));
  assert(reports.some(a=>a.includes('release-agent')));
  assert(reports.every(a=>a.includes('dsh') && a.includes('w1:p2') && a.includes('fm-lab-fixture')));
  console.log('ok - DSH handshake, brief, serialized steering, generation-bound busy and graceful exit');

  const bad = makeCase('model', ['--model', 'litellm/missing']); running.push(bad);
  await until(() => bad.exited() || bad.output().includes('ACK '), 'model refusal was not bounded');
  assert(bad.exited(), 'unadvertised requested model was accepted as a synthetic current option');
  assert.notEqual(await bad.exit, 0);
  assert.match(bad.error(), /not advertised/);
  assert(!readFileSync(bad.log, 'utf8').includes('session/prompt'));
  console.log('ok - DSH refuses an unadvertised model before submitting a prompt');

  const crash = makeCase('crash'); running.push(crash);
  await until(() => crash.output().includes('ACK ') && existsSync(join(crash.state,'case.turn-ended')), 'first prompt did not settle');
  crash.child.stdin.write('CRASH\n');
  assert.notEqual(await crash.exit, 0);
  console.log('ok - DSH child death fails the bridge instead of leaving an idle worker');

  const cancel = makeCase('cancel'); running.push(cancel);
  await until(() => existsSync(join(cancel.state,'case.turn-ended')), 'initial turn did not finish');
  cancel.child.stdin.write('WAIT\n');
  await until(() => /event=prompt-observed|event=prompt-start/.test(readFileSync(join(cancel.state,'case.busy-state'),'utf8')) && readFileSync(cancel.log,'utf8').includes('WAIT'), 'long prompt never started');
  cancel.child.kill('SIGINT');
  await until(() => cancel.output().includes('[DSH cancelled]'), 'cancel was not acknowledged');
  assert.match(readFileSync(join(cancel.state,'case.busy-state'),'utf8'), /state=unknown.*event=cancelled/);
  cancel.child.stdin.write('after-cancel\n');
  await until(() => cancel.output().includes('ACK after-cancel'), 'post-cancel prompt did not run');
  cancel.child.stdin.write('/exit\n');
  assert.equal(await cancel.exit,0,cancel.error());
  console.log('ok - DSH cancellation settles to unknown and accepts the next prompt');

  const error = makeCase('error'); running.push(error);
  await until(() => existsSync(join(error.state,'case.turn-ended')), 'initial turn did not finish');
  error.child.stdin.write('ERROR\n');
  assert.notEqual(await error.exit,0);
  assert.match(error.error(),/code -32001/);
  assert(!error.error().includes('SECRET_VENDOR_HEADER'));
  console.log('ok - DSH vendor errors fail without copying secret-bearing diagnostics');

  const stale = makeCase('stale'); running.push(stale);
  await until(() => existsSync(join(stale.state,'case.turn-ended')), 'initial turn did not finish');
  const arm = spawnSync('bash',[join(root,'bin/fm-busy-event.sh'),'arm',stale.state,'case'],{encoding:'utf8'});
  assert.equal(arm.status,0);
  stale.child.stdin.write('stale-steer\n');
  assert.notEqual(await stale.exit,0);
  assert(!readFileSync(stale.log,'utf8').includes('stale-steer'));
  assert(!readFileSync(join(stale.state,'case.busy-state'),'utf8').includes('source=dsh-acp'));
  console.log('ok - a retired DSH generation cannot submit work or overwrite the replacement');

  const errorBrief=join(lab,'error-brief');
  writeFileSync(errorBrief,'INITIAL_ERROR');
  const initialError=makeCase('initial-error',['--brief',errorBrief]);running.push(initialError);
  assert.notEqual(await initialError.exit,0);
  assert(!existsSync(join(initialError.state,'case.dsh-ready')),'a user-message echo must not admit a failed initial prompt');
  console.log('ok - initial vendor failure after a user-message echo never publishes readiness');

  const metaPath=join(dirname(dirname(fake)),'package.json');
  const meta=JSON.parse(readFileSync(metaPath,'utf8'));
  writeFileSync(metaPath,JSON.stringify({...meta,version:'0.2.1-rc.2'}));
  const refused=spawnSync(process.execPath,[worker,'--check','--dsh-bin',fake],{encoding:'utf8'});
  assert.notEqual(refused.status,0);
  assert.match(refused.stderr,/unsupported DSH runtime/);
  console.log('ok - a newer DSH version is refused before native settings can migrate');

} finally {
  for (const c of running) if (!c.exited()) c.child.kill('SIGTERM');
}
