import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

// Deterministic ACP peer for transport/terminal tests; never model evidence.
export function makeDshFixture(lab, version = '0.1.5-rc.1') {
const fakeRoot=join(lab,'@deepseek-ai/dsh');
mkdirSync(join(fakeRoot,'lib'),{recursive:true});
writeFileSync(join(fakeRoot,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version,type:'module'}));
const credentialRoot=join(fakeRoot,'../dsh-credentials-local/lib');
mkdirSync(credentialRoot,{recursive:true});
writeFileSync(join(credentialRoot,'index.js'),'export default class Credentials {}\n');
const settingsRoot=join(fakeRoot,'../dsh-settings/lib');
mkdirSync(settingsRoot,{recursive:true});
writeFileSync(join(settingsRoot,'index.js'),`import {rename} from 'node:fs/promises';
export default class Settings {
  static imported=false;
  async importLegacyDocument() {
    await new Promise(resolve=>setTimeout(resolve,200));
    await rename(process.env.DSH_HOME+'/settings.yaml',process.env.DSH_HOME+'/settings.yaml.imported');
    Settings.imported=true;
  }
}
`);
mkdirSync(join(fakeRoot,'node_modules/yaml'),{recursive:true});
writeFileSync(join(fakeRoot,'node_modules/yaml/index.js'),'exports.parse = JSON.parse;\n');
const fake=join(fakeRoot,'lib/bin.js');
writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
if (process.argv.includes('--version')) { console.log('${version}'); process.exit(0); }
// Match the verified vendor boundary; local evidence can use its real export.
const {scrubbedParentEnv} = process.env.DSH_FIXTURE_SCRUB_MODULE
  ? await import(pathToFileURL(process.env.DSH_FIXTURE_SCRUB_MODULE))
  : {scrubbedParentEnv:()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>!/KEY|PASSWORD|SECRET|TOKEN|^DSH_/i.test(key)))};
let prompt;
let migration;
if ('${version}'==='0.2.1-rc.2' && existsSync(process.env.DSH_HOME+'/settings.yaml')) {
  const {default:Settings}=await import('../../dsh-settings/lib/index.js');
  migration=new Settings();
  void migration.importLegacyDocument().catch(()=>process.exit(9));
}
if(process.env.DSH_FIXTURE_LOG) appendFileSync(process.env.DSH_FIXTURE_LOG,JSON.stringify({fixtureEnvironment:{branchPinPresent:Boolean(process.env.FM_SUPERVISION_ACTOR||process.env.FM_SUPERVISION_PRIMARY_HARNESS),claudeMarkerPresent:Boolean(process.env.CLAUDECODE)}})+'\\n');
const patch=JSON.parse(readFileSync(process.argv[process.argv.indexOf('--patch')+1],'utf8'));
const initial=patch.find(row=>row.id==='acp')?.config || {provider:'litellm',model:'test'};
const current=JSON.stringify([initial.provider,initial.model]);
const modelOptions=[{value:JSON.stringify(['litellm','test']),name:'test'}];
// Native ACP retains a configured current model even when discovery omitted it.
if(!modelOptions.some(option=>option.value===current)) modelOptions.push({value:current,name:initial.model});
const send = m => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
const reply = (id,result) => send({id,result});
createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  if(process.env.DSH_FIXTURE_LOG) appendFileSync(process.env.DSH_FIXTURE_LOG, JSON.stringify(m)+'\\n');
  if(m.id===9001 && m.result) {
    if(m.result.outcome?.optionId!=='native-once-82') process.exit(8);
    const id=prompt;prompt=undefined;reply(id,{stopReason:'end_turn'});return;
  }
  if(m.method==='initialize' && migration && !migration.constructor.imported) send({id:m.id,error:{code:-32603,message:'configuration import is still pending'}});
  else if(m.method==='initialize') reply(m.id,{protocolVersion:1,agentInfo:{name:'fixture'},agentCapabilities:{sessionCapabilities:{close:{}}}});
  else if(m.method==='session/new') reply(m.id,{sessionId:'fixture-session',configOptions:[
    {id:'model',currentValue:current,options:[{group:'litellm',options:modelOptions}]},
    {id:'reasoning_effort',currentValue:'low',options:[{value:'low'},{value:'high'}]}
  ]});
  else if(m.method==='session/set_config_option') reply(m.id,{configOptions:[{id:'reasoning_effort',currentValue:'low',options:[{value:'low'},{value:'high'}]}]});
  else if(m.method==='session/prompt') {
    const text=m.params.prompt.map(x=>x.text).join('');
    if(text.includes('INITIAL_ERROR')) {
      send({method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'user_message_chunk',content:{type:'text',text:'accepted'}}}});
      send({id:m.id,error:{code:-32001,message:'SECRET_VENDOR_HEADER'}});return;
    }
    if(text==='CRASH') process.exit(7);
    if(text==='ERROR') { send({id:m.id,error:{code:-32001,message:'SECRET_VENDOR_HEADER'}}); return; }
    if(text==='GIT_ENV') {
      const result=spawnSync('bash',[process.env.DSH_FIXTURE_GIT_SCRIPT],{env:scrubbedParentEnv(),encoding:'utf8'});
      appendFileSync(process.env.DSH_FIXTURE_LOG,JSON.stringify({fixtureGit:{status:result.status,stdout:result.stdout,stderr:result.stderr}})+'\\n');
    }
    if(prompt) { send({id:m.id,error:{code:-32602,message:'concurrent prompt'}}); return; }
    prompt=m.id;
    if(text==='PERMISSION') {
      send({id:9001,method:'session/request_permission',params:{sessionId:'fixture-session',options:[{kind:'allow_always',optionId:'native-always'},{kind:'allow_once',optionId:'native-once-82'}]}});return;
    }
    send({method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'tool_call',title:'fixture-tool',toolCallId:String(m.id),status:'in_progress'}}});
    if(text==='WAIT') return;
    setTimeout(()=>{
      if(prompt!==m.id)return;
      send({method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACK '+text}}}});
      prompt=undefined; reply(m.id,{stopReason:'end_turn'});
    },150);
  } else if(m.method==='session/cancel') { if(prompt) { const id=prompt;prompt=undefined;reply(id,{stopReason:'cancelled'}); } }
  else if(m.method==='session/close') { if(prompt) { const id=prompt;prompt=undefined;reply(id,{stopReason:'cancelled'}); } reply(m.id,{}); }
});
process.stdin.on('end',()=>process.exit(0));
`);
chmodSync(fake, 0o755);
return fake;
}
if(process.argv[1]?.endsWith('/fm-dsh-fixture.mjs')) console.log(makeDshFixture(process.argv[2], process.argv[3]));
