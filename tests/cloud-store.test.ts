import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCloudRecords, sharedCloudResources } from '../electron/cloud-store';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { Store } from '../electron/store';
import type { CloudApplyRecord, CloudRecord } from '../shared/cloud-types';

function fixture(failSave=false) {
  let saves=0;const data={schemaVersion:1,settings:{...structuredClone(DEFAULT_SETTINGS),contentProtection:true,microphoneDeviceId:'private-device'},sessions:[],knowledge:[],modes:[],calendar:[],people:[],scorecards:[],folders:[],encryptedKeys:{openai:'encrypted-private-key'},contextAnswers:[]};
  const store={data,save(){saves++;if(failSave)throw new Error('Disk full');}} as unknown as Pick<Store,'data'|'save'>;
  return {store,saves:()=>saves};
}
test('downloaded desktop and phone timings preserve the common request scope and refusal flag', () => {
  const f = fixture(); applyCloudRecords(f.store, [{ entity: 'meeting', id: 'timings', data: { title: 'Timing fixture', startedAt: '2026-10-12T12:00:00Z', answers: [{ id: 'answer', kind: 'chat', text: 'Declined', status: 'complete', latencyMs: 250, firstTextLatencyMs: 40, latencyScope: 'application-request', refused: true }] } }]);
  const answer = f.store.data.sessions[0].answers[0]; assert.equal(answer.firstTextLatencyMs, 40); assert.equal(answer.latencyMs, 250); assert.equal(answer.latencyScope, 'application-request'); assert.equal(answer.refused, true);
});
test('cloud store commits normalized personal collections atomically while protecting device settings and secrets',()=>{
  const f=fixture();const records:CloudApplyRecord[]=[
    {entity:'meeting',id:'meeting',data:{title:'Downloaded notes',startedAt:'2026-10-12T09:00:00Z',notes:'Readable notes',attendeeIds:['person'],commitments:[{id:'todo',text:'Follow up',personId:'person'}]}},
    {entity:'mode',id:'mode',data:{name:'Downloaded mode',instructions:'Use local context'}},
    {entity:'person',id:'person',data:{name:'Priya',email:'priya@example.com'}},
    {entity:'scorecard',id:'scorecard',data:{name:'Review',criteria:[{id:'clarity',name:'Clarity',maxScore:5,weight:1}]}},
    {entity:'folder',id:'folder',data:{name:'Product'}},
    {entity:'settings',id:'preferences',data:{theme:'dark',contentProtection:false,captureMicrophone:false,microphoneDeviceId:'remote-device',encryptedKeys:{openai:'replace-key'},model:'gpt-4.1-mini'}},
  ];applyCloudRecords(f.store,records);assert.equal(f.saves(),1);assert.equal(f.store.data.sessions[0].transcript.length,0);assert.equal(f.store.data.sessions[0].answers.length,0);assert.equal(f.store.data.sessions[0].commitments?.[0].personId,'person');assert.equal(f.store.data.modes[0].customActions?.length,0);assert.equal(f.store.data.people[0].name,'Priya');assert.equal(f.store.data.scorecards[0].criteria[0].description,'');assert.equal((f.store.data as any).folders[0].name,'Product');assert.equal(f.store.data.settings.theme,'dark');assert.equal(f.store.data.settings.contentProtection,true);assert.equal(f.store.data.settings.captureMicrophone,true);assert.equal(f.store.data.settings.microphoneDeviceId,'private-device');assert.equal(f.store.data.encryptedKeys.openai,'encrypted-private-key');
  records[0].data!.notes='Mutated caller';assert.equal(f.store.data.sessions[0].notes,'Readable notes');
});
test('invalid batches and persistence failures preserve the exact previous workspace',()=>{
  const f=fixture();const previous=f.store.data;assert.throws(()=>applyCloudRecords(f.store,[{entity:'meeting',id:'valid',data:{title:'First',startedAt:'2026-10-12T09:00:00Z'}},{entity:'scorecard',id:'bad',data:{name:'Broken',criteria:[{id:'criterion',name:'Invalid',maxScore:0,weight:1}]}}]),/maximum score/);assert.equal(f.store.data,previous);assert.equal(f.store.data.sessions.length,0);assert.equal(f.saves(),0);
  const full=fixture(true),original=full.store.data;assert.throws(()=>applyCloudRecords(full.store,[{entity:'person',id:'person',data:{name:'Priya'}}]),/Disk full/);assert.equal(full.store.data,original);assert.equal(full.store.data.people.length,0);
});
test('cloud tombstones remove personal records without clearing local credentials',()=>{
  const f=fixture();applyCloudRecords(f.store,[{entity:'knowledge',id:'doc',data:{title:'Guide',text:'Context'}},{entity:'knowledge',id:'doc',data:null}]);assert.equal(f.store.data.knowledge.length,0);assert.equal(f.store.data.encryptedKeys.openai,'encrypted-private-key');
});
test('smart answer source URLs survive import and unusable scorecards are rejected',()=>{
  const f=fixture();const sourceId='https://research.example.com/'+ 'citation/'.repeat(50);applyCloudRecords(f.store,[{entity:'meeting',id:'research',data:{title:'Research',startedAt:'2026-10-12T09:00:00Z',answers:[{id:'answer',text:'A sourced answer',sources:[{id:sourceId,title:'Evidence',kind:'web',url:sourceId}]}]}}]);assert.equal(f.store.data.sessions[0].answers[0].sources[0].id,sourceId);const previous=f.store.data;
  assert.throws(()=>applyCloudRecords(f.store,[{entity:'scorecard',id:'zero-weight',data:{name:'Broken',criteria:[{id:'one',name:'One',maxScore:5,weight:0}]}}]),/weight/);assert.equal(f.store.data,previous);
  assert.throws(()=>applyCloudRecords(f.store,[{entity:'scorecard',id:'duplicate',data:{name:'Broken',criteria:[{id:'same',name:'One',maxScore:5,weight:1},{id:'same',name:'Two',maxScore:5,weight:1}]}}]),/unique/);assert.equal(f.store.data,previous);
});
test('ACL shared context uses namespaced IDs, accessible document references and read-only metadata',()=>{
  const rows:CloudRecord[]=[{entity:'knowledge',id:'doc',revision:2,scope:'org',orgId:'org',data:{title:'Pricing',text:'Verified shared pricing.'}},{entity:'mode',id:'mode',revision:1,scope:'team',orgId:'org',teamId:'team',data:{name:'Sales',instructions:'Use pricing',documentIds:['doc','inaccessible-doc']}},{entity:'scorecard',id:'card',revision:1,scope:'org',orgId:'org',data:{name:'Discovery',criteria:[{id:'goal',name:'Goal',maxScore:5,weight:1}]}},{entity:'knowledge',id:'personal',revision:1,scope:'personal',data:{title:'Private',text:'Exclude'}},{entity:'knowledge',id:'deleted',revision:2,scope:'org',deleted:true,data:null}];
  const context=sharedCloudResources(rows);assert.equal(context.knowledge.length,1);assert.equal(context.knowledge[0].id,'shared:knowledge:doc');assert.equal((context.knowledge[0] as any).shared,true);assert.equal((context.knowledge[0] as any).revision,2);assert.deepEqual(context.modes[0].documentIds,['shared:knowledge:doc']);assert.equal(context.scorecards[0].id,'shared:scorecard:card');assert.equal(context.modes[0].builtIn,false);
});
test('server-inferred assigned mode exposes action labels while keeping hidden prompt content absent',()=>{
  const context=sharedCloudResources([{entity:'mode',id:'hidden',revision:1,scope:'team',orgId:'org',teamId:'team',inference:'server',data:{name:'Managed sales',id:'hidden',customActions:[{id:'next',name:'Next step',type:'prompt'}]}}]);assert.equal(context.modes[0].instructions,'');assert.equal((context.modes[0] as any).inference,'server');assert.equal(context.modes[0].customActions?.[0].name,'Next step');assert.equal(context.modes[0].customActions?.[0].prompt,undefined);
});
