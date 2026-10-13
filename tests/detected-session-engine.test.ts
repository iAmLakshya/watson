import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine, type EngineRuntime } from '../electron/engine';
import { Store } from '../electron/store';
import type { MeetingDetectionState } from '../shared/types';
import type { CloudStatus } from '../shared/cloud-types';
const candidate: MeetingDetectionState = { enabled: true, supported: true, status: 'candidate', message: 'Fixture active input', candidateId: 'fixture-detection-id', bundleId: 'us.zoom.xos', appName: 'Zoom' };
async function fixture({ microphone = 'granted', screen = 'granted', openai = true, deepgram = true, captureFailure = false, runtime = {} }: {microphone?:string;screen?:string;openai?:boolean;deepgram?:boolean;captureFailure?:boolean;runtime?:Partial<EngineRuntime>} = {}) {
  const directory = await mkdtemp(join(tmpdir(),'watson-detected-engine-')); const store = new Store(directory); store.data.settings = { ...store.data.settings, meetingDetectionEnabled:true, captureMicrophone:true, captureSystem:false, captureScreen:false };store.credentialStatus=()=>({openai,deepgram,secureStorage:false});store.key=provider=>provider==='openai'&&openai?'fixture-openai':provider==='deepgram'&&deepgram?'fixture-deepgram':undefined;
  const requests:string[][]=[];const starts:{requestPermissions?:boolean}[]=[];let transcriberConnects=0,transcriberCloses=0,stops=0,providerCalls=0;
  const capture:EngineRuntime['capture']={available:true,async request(args){requests.push(args);return [{type:'permissions',microphone,screen}];},async start(_settings,options){starts.push(options??{});if(captureFailure)throw new Error('Fixture capture rejected without prompting');},async stop(){stops++;},async screenshot(){throw new Error('Detected session startup must not capture a screenshot');}};
  const engine=new Engine(store,'/not-native',()=>{},{capture,version:()=> 'fixture',permissions:()=>({microphone,screen}),transcriberFactory:()=>({async connect(){transcriberConnects++;},send(){},async close(){transcriberCloses++;}}),stream:async()=>{providerCalls++;return {text:'unexpected paid request'};},...runtime});
  return {store,engine,counts:()=>({requests,starts,transcriberConnects,transcriberCloses,stops,providerCalls}),cleanup:async()=>{await engine.dispose();await rm(directory,{recursive:true,force:true});}};
}
test('detected capture refuses unavailable permission before any transcription, recording or session persistence',async()=>{
  const f=await fixture({microphone:'not-determined'});try{await assert.rejects(f.engine.startDetected(candidate),/will not open a permission prompt/);assert.equal(f.counts().starts.length,0);assert.equal(f.counts().transcriberConnects,0);assert.equal(f.counts().providerCalls,0);assert.equal(f.store.data.sessions.length,0);assert.equal(f.engine.activeSessionId,undefined);}finally{await f.cleanup();}
});
test('detected screen/system capture requires previous permission independently of microphone',async()=>{
  const f=await fixture({screen:'denied'});try{f.store.data.settings.captureSystem=true;await assert.rejects(f.engine.startDetected(candidate),/screen\/system-audio/);assert.equal(f.counts().starts.length,0);assert.equal(f.store.data.sessions.length,0);}finally{await f.cleanup();}
});
test('missing provider setup stays explicit and never turns a detected call into a demonstration',async()=>{
  for(const config of [{openai:false},{deepgram:false}]){const f=await fixture(config);try{await assert.rejects(f.engine.startDetected(candidate),/provider key|Deepgram API key/);assert.equal(f.counts().starts.length,0);assert.equal(f.counts().providerCalls,0);assert.equal(f.store.data.sessions.length,0);assert.equal(f.engine.activeSessionId,undefined);}finally{await f.cleanup();}}
});
test('a ready detected session passes a no-prompt capture option and records attribution without requesting AI',async()=>{
  const f=await fixture();try{const id=await f.engine.startDetected(candidate);const session=f.store.session(id);assert.equal(session.demo,false);assert.equal(session.meetingDetectionId,candidate.candidateId);assert.deepEqual(f.counts().starts,[{requestPermissions:false}]);assert.equal(f.counts().transcriberConnects,1);assert.equal(f.counts().providerCalls,0);await f.engine.stop();assert.equal(f.engine.activeSessionId,undefined);assert.ok(session.endedAt);}finally{await f.cleanup();}
});
test('detected startup errors close prepared transcription and remove an empty failed meeting',async()=>{
  const f=await fixture({captureFailure:true});try{await assert.rejects(f.engine.startDetected(candidate),/rejected without prompting/);assert.equal(f.counts().transcriberCloses,1);assert.equal(f.engine.activeSessionId,undefined);assert.equal(f.store.data.sessions.length,0);assert.equal(f.engine.captureState.running,false);}finally{await f.cleanup();}
});
test('personal Smart engine requests select exact chosen model/effort/token budget and keep normal model unchanged',async()=>{
  const f=await fixture();const requestOptions:Parameters<NonNullable<EngineRuntime['stream']>>[1][]=[];
  try{const store=f.store;const engine=new Engine(store,'/not-native',()=>{},{version:()=> 'fixture',permissions:()=>({microphone:'denied',screen:'denied'}),capture:{available:false,async start(){throw new Error('Unexpected capture');},async stop(){},async screenshot(){throw new Error('Unexpected screenshot');}},stream:async(_key,options,delta)=>{requestOptions.push(options);delta('Fixture answer');return {text:'Fixture answer'};}});const session=store.createSession('Saved fixture',false,'general');session.endedAt=new Date().toISOString();session.transcript=[{id:'line',source:'system',text:'Fixture question?',timestamp:session.startedAt,final:true}];store.data.settings={...store.data.settings,model:'normal-explicit',smartMode:true,smartModel:'custom-reasoning-exact',smartReasoningEffort:'high',smartWebSearch:false,smartMaxOutputTokens:36000};const answer=await engine.assist({sessionId:session.id,includeScreen:false});assert.equal(answer.status,'complete');assert.equal(requestOptions[0].model,'custom-reasoning-exact');assert.equal(requestOptions[0].reasoningEffort,'high');assert.equal(requestOptions[0].maxOutputTokens,36000);assert.equal(requestOptions[0].smart,false);store.data.settings.smartMode=false;await engine.assist({sessionId:session.id,includeScreen:false});assert.equal(requestOptions[1].model,'normal-explicit');assert.equal(requestOptions[1].reasoningEffort,undefined);await engine.dispose();}finally{await f.cleanup();}
});
test('managed automatic start checks selected Smart readiness independently of normal/research-only model availability',async()=>{
  const status:CloudStatus={endpoint:'https://fixture.example.test',signedIn:true,secureStorage:true,cursor:0,busy:false,conflicts:[],shares:[],shared:[],organizations:[],boundRecords:[],pendingUploads:0,automaticSync:false,authorizationRevision:0,assistantConfigured:false,smartConfigured:true,smartWebResearchConfigured:false};const f=await fixture({openai:false,runtime:{cloudStatus:()=>status}});
  try{f.engine.setSharedResources({knowledge:[],scorecards:[],modes:[{id:'shared:mode:managed',name:'Managed',instructions:'',noteTemplate:'',documentIds:[],inference:'server'}]});f.store.data.settings={...f.store.data.settings,activeModeId:'shared:mode:managed',smartMode:true,smartWebSearch:true};await assert.rejects(f.engine.startDetected(candidate),/Smart web research is not configured/);assert.equal(f.counts().starts.length,0);f.store.data.settings.smartWebSearch=false;status.smartConfigured=false;await assert.rejects(f.engine.startDetected(candidate),/Smart reasoning is not configured/);assert.equal(f.counts().starts.length,0);status.smartConfigured=true;await f.engine.startDetected(candidate);assert.equal(f.counts().starts.length,1);assert.equal(f.counts().providerCalls,0);}finally{await f.cleanup();}
});
