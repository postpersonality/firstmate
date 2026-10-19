import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

// Deterministic ACP peer for transport/terminal tests; never model evidence.
export function makeDshFixture(lab) {
const fakeRoot=join(lab,'@deepseek-ai/dsh');
mkdirSync(join(fakeRoot,'lib'),{recursive:true});
writeFileSync(join(fakeRoot,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:'0.1.5-rc.1',type:'module'}));
const fake=join(fakeRoot,'lib/bin.js');
writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('0.1.5-rc.1'); process.exit(0); }
let prompt;
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
  if(m.method==='initialize') reply(m.id,{protocolVersion:1,agentInfo:{name:'fixture'},agentCapabilities:{sessionCapabilities:{close:{}}}});
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
if(process.argv[1]?.endsWith('/fm-dsh-fixture.mjs')) console.log(makeDshFixture(process.argv[2]));
