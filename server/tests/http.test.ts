import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWatsonServer } from '../src/app.ts';

type Client={token:string;user:{id:string;email:string;name:string};device:{id:string}};
const password='Watson-test-password-42';
const dir=mkdtempSync(join(tmpdir(),'watson-cloud-http-'));
let app:ReturnType<typeof createWatsonServer>,origin:string,alice:Client,bob:Client,charlie:Client,outsider:Client;
let org:string,sales:string,engineering:string,doc:string,mode:string,aliceMeeting:string,shareToken:string;
async function call(client:Client|null,method:string,path:string,data?:unknown,status=200){const response=await fetch(origin+'/api/v1/'+path,{method,headers:{...(client?{Authorization:'Bearer '+client.token}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{})},body:data===undefined?undefined:JSON.stringify(data)});const json=await response.json();assert.equal(response.status,status,JSON.stringify(json));return json;}
const signup=async(name:string):Promise<Client>=>call(null,'POST','auth/signup',{email:name.toLowerCase()+'@watson.test',name,password,deviceName:'HTTP test '+name},201);
function meeting(id:string,title='Private discussion',startedAt=new Date().toISOString()){return {id,title,startedAt,modeId:'default',demo:false,pinned:false,transcript:[{id:'line-1',source:'system',text:'Customer renewal is private.',timestamp:startedAt,final:true}],answers:[],notes:'Private notes',actions:['Send quote'],followupDraft:'Thank you'};}
before(async()=>{app=createWatsonServer({dbPath:join(dir,'watson.sqlite'),port:0});origin=await app.listen();alice=await signup('Alice');bob=await signup('Bob');charlie=await signup('Charlie');outsider=await signup('Outsider');});
after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});

test('real HTTP signup/login hashes passwords and auth tokens, validates input and rejects browser origins',async()=>{
  await call(null,'POST','auth/signup',{email:'bad-email',password},400);
  await call(null,'POST','auth/signup',{email:'weak@watson.test',password:'short'},400);
  await call(null,'POST','auth/login',{email:alice.user.email,password:'wrong-password'},401);
  await call(null,'GET','me',undefined,401);
  const login=await call(null,'POST','auth/login',{email:alice.user.email,password,deviceName:'Second device'});
  assert.notEqual(login.token,alice.token);assert.equal(login.user.id,alice.user.id);
  const row=app.store.get('SELECT password_hash FROM users WHERE id=?',alice.user.id)!;assert.match(row.password_hash,/^scrypt\$32768\$8\$1\$/);assert.equal(row.password_hash.includes(password),false);
  const sessions=app.store.all('SELECT token_hash FROM auth_sessions');assert.ok(sessions.every(s=>!s.token_hash.includes(alice.token)&&s.token_hash.length===64));
  const res=await fetch(origin+'/api/v1/me',{headers:{Authorization:'Bearer '+alice.token,Origin:'https://untrusted.example'}});assert.equal(res.status,403);
  await call(alice,'PATCH','me',{name:'Alice Watson'});const profile=await call(alice,'GET','me');assert.equal(profile.user.name,'Alice Watson');assert.ok(profile.devices.length>=2);assert.equal('password_hash' in profile.user,false);
});

test('meeting CRUD is private to owner; public projection is explicit and shares rotate/revoke immediately',async()=>{
  aliceMeeting='alice-private-meeting';const result=await call(alice,'POST','meetings',{meeting:meeting(aliceMeeting)},201);assert.equal(result.revision,1);
  await call(bob,'GET','meetings/'+aliceMeeting,undefined,404);assert.equal((await call(bob,'GET','meetings')).meetings.length,0);
  await call(bob,'PUT','meetings/'+aliceMeeting,{expectedRevision:1,meeting:meeting(aliceMeeting,'Stolen')},404);
  await call(alice,'PUT','meetings/'+aliceMeeting,{expectedRevision:0,meeting:meeting(aliceMeeting)},409);
  const changed=meeting(aliceMeeting,'Updated title');changed.notes='Exact public notes';const updated=await call(alice,'PUT','meetings/'+aliceMeeting,{expectedRevision:1,meeting:changed});assert.equal(updated.revision,2);
  const share=await call(alice,'POST','meetings/'+aliceMeeting+'/share',{},201);shareToken=share.token;assert.ok(share.url.includes(share.token));
  const publicData=await call(null,'GET','public/shares/'+share.token);assert.equal(publicData.meeting.notes,'Exact public notes');assert.equal('answers' in publicData.meeting,false);assert.equal('id' in publicData.meeting,false);assert.equal('ownerId' in publicData.meeting,false);assert.equal('id' in publicData.meeting.transcript[0],false);
  const rotated=await call(alice,'POST','meetings/'+aliceMeeting+'/share',{},201);await call(null,'GET','public/shares/'+share.token,undefined,404);shareToken=rotated.token;
  await call(alice,'DELETE','meetings/'+aliceMeeting+'/share');await call(null,'GET','public/shares/'+shareToken,undefined,404);
});

test('two actual devices sync edits, return conflicts and tombstones, deduplicate mutations and preserve settings fields',async()=>{
  const other=await call(null,'POST','auth/login',{email:alice.user.email,password,deviceName:'Phone'});const id='sync-phone-meeting';
  const push=await call(alice,'POST','sync',{deviceId:alice.device.id,cursor:0,changes:[{entity:'meeting',id,expectedRevision:0,data:meeting(id),changeId:'upload-once'}]});assert.ok(push.cursor>0);assert.equal(push.conflicts.length,0);
  const pull=await call(other,'POST','sync',{deviceId:other.device.id,cursor:0,changes:[]});assert.equal(pull.changes.find((c:any)=>c.id===id).revision,1);
  const replay=await call(alice,'POST','sync',{deviceId:alice.device.id,cursor:push.cursor,changes:[{entity:'meeting',id,expectedRevision:0,data:meeting(id,undefined,push.applied[0].data.startedAt),changeId:'upload-once'}]});assert.equal(replay.applied[0].revision,1);
  const newer={...pull.changes.find((c:any)=>c.id===id).data,title:'Phone changes'};const advance=await call(other,'POST','sync',{deviceId:other.device.id,cursor:pull.cursor,changes:[{entity:'meeting',id,expectedRevision:1,data:newer}]});assert.equal(advance.applied[0].revision,2);
  const stale=await call(alice,'POST','sync',{deviceId:alice.device.id,cursor:push.cursor,changes:[{entity:'meeting',id,expectedRevision:1,data:meeting(id,'Stale')}]});assert.equal(stale.conflicts[0].current.data.title,'Phone changes');assert.equal(stale.conflicts[0].current.revision,2);
  const deleted=await call(other,'POST','sync',{deviceId:other.device.id,cursor:advance.cursor,changes:[{entity:'meeting',id,expectedRevision:2,data:null}]});assert.equal(deleted.changes.at(-1).deleted,true);assert.equal(deleted.changes.at(-1).data,null);
  const full=await call(alice,'POST','sync',{deviceId:alice.device.id,cursor:0,changes:[]});assert.ok(full.changes.filter((c:any)=>c.id===id).every((c:any)=>c.data===null));
  await call(alice,'POST','sync',{deviceId:bob.device.id,cursor:0,changes:[]},403);
  await call(alice,'POST','sync',{deviceId:alice.device.id,cursor:0,changes:[{entity:'settings',id:'preferences',expectedRevision:0,data:{captureScreen:true,language:'en'}}]});
  const settings=await call(other,'POST','sync',{deviceId:other.device.id,cursor:0,changes:[{entity:'settings',id:'preferences',expectedRevision:1,data:{language:'fr'}}]});assert.equal(settings.applied[0].data.captureScreen,true);assert.equal(settings.applied[0].data.language,'fr');
  const isolated=await call(bob,'POST','sync',{deviceId:bob.device.id,cursor:0,changes:[]});assert.equal(isolated.changes.length,0);
});

test('sync rejects secrets recursively and rolls back the entire request on invalid input',async()=>{
  for(const key of ['apiKey','credentials','encryptedKeys','openai_api_key','password','accessToken'])await call(alice,'POST','sync',{deviceId:alice.device.id,cursor:0,changes:[{entity:'settings',id:'preferences',expectedRevision:2,data:{[key]:'secret'}}]},400);
  const id='must-rollback';await call(alice,'POST','sync',{deviceId:alice.device.id,cursor:0,changes:[{entity:'meeting',id,expectedRevision:0,data:meeting(id)},{entity:'knowledge',id:'bad-secret',expectedRevision:0,data:{title:'Bad',text:'text',credentials:{openai:'secret'}}}]},400);
  await call(alice,'GET','meetings/'+id,undefined,404);
  const before=(await call(alice,'GET','meetings')).meetings.length;await call(alice,'POST','sync',{deviceId:alice.device.id,cursor:99999999,changes:[{entity:'meeting',id:'invalid-cursor-write',expectedRevision:0,data:meeting('invalid-cursor-write')}]},400);assert.equal((await call(alice,'GET','meetings')).meetings.length,before);
});

test('organizations enforce admin roles and multi-team membership with exact shared retrieval scopes',async()=>{
  const created=await call(alice,'POST','organizations',{name:'Watson Customer Success'},201);org=created.id;
  await call(alice,'POST','organizations/'+org+'/members',{email:bob.user.email,role:'manager'},201);await call(alice,'POST','organizations/'+org+'/members',{email:charlie.user.email,role:'member'},201);
  await call(charlie,'POST','organizations/'+org+'/teams',{name:'Forbidden team'},403);await call(bob,'POST','organizations/'+org+'/members',{email:outsider.user.email},403);await call(outsider,'GET','organizations/'+org,undefined,404);
  sales=(await call(alice,'POST','organizations/'+org+'/teams',{name:'Sales'},201)).id;engineering=(await call(alice,'POST','organizations/'+org+'/teams',{name:'Engineering'},201)).id;
  await call(alice,'POST',`organizations/${org}/teams/${sales}/members`,{userId:bob.user.id,role:'manager'},201);await call(alice,'POST',`organizations/${org}/teams/${engineering}/members`,{userId:bob.user.id,role:'member'},201);await call(alice,'POST',`organizations/${org}/teams/${engineering}/members`,{userId:charlie.user.id,role:'member'},201);
  assert.equal((await call(bob,'GET',`organizations/${org}/teams`)).teams.length,2);assert.equal((await call(charlie,'GET',`organizations/${org}/teams`)).teams.length,1);
  doc='sales-playbook';const saved=await call(bob,'POST','resources/knowledge',{data:{id:doc,title:'Sales playbook',text:'Use an annual plan for enterprise.'},scope:'team',orgId:org,teamId:sales},201);assert.equal(saved.scope,'team');
  await call(charlie,'GET','resources/knowledge/'+doc,undefined,404);await call(outsider,'GET','resources/knowledge/'+doc,undefined,404);await call(bob,'POST','resources/knowledge',{data:{id:'engineer-forbidden',title:'Forbidden',text:'Private'},scope:'team',orgId:org,teamId:engineering},403);
  const orgDoc=await call(bob,'POST','resources/knowledge',{data:{id:'org-doc',title:'Organization guide',text:'Across the organization'},scope:'org',orgId:org},201);assert.equal((await call(charlie,'GET','resources/knowledge/'+orgDoc.id)).data.text,'Across the organization');
  await call(charlie,'PUT','resources/knowledge/'+orgDoc.id,{expectedRevision:1,data:{title:'Changed',text:'text'}},403);
  await call(alice,'PATCH',`organizations/${org}/members/${alice.user.id}`,{role:'member'},409);
});

test('shared folders and assigned modes respect document ACLs and immediately disappear from revoked clients',async()=>{
  const folder='sales-folder';await call(bob,'POST','resources/folder',{data:{id:folder,name:'Sales knowledge'},scope:'team',orgId:org,teamId:sales},201);
  await call(bob,'PUT','resources/knowledge/'+doc,{expectedRevision:1,data:{title:'Sales playbook',text:'Use an annual plan for enterprise.',folderId:folder}});
  mode='sales-assigned-mode';await call(bob,'POST','resources/mode',{data:{id:mode,name:'Sales coach',instructions:'Use the playbook',noteTemplate:'Summary',documentIds:[doc],assigned:true},scope:'team',orgId:org,teamId:sales},201);
  const context=await call(bob,'GET','context?modeId='+mode);assert.equal(context.documents.length,1);assert.equal(context.documents[0].id,doc);assert.equal(context.modes[0].data.assigned,true);
  await call(charlie,'GET','context?modeId='+mode,undefined,404);
  await call(alice,'POST','resources/mode',{data:{id:'bad-shared-reference',name:'Wrong scope',instructions:'text',documentIds:[doc]},scope:'org',orgId:org},400);
  await call(alice,'DELETE',`organizations/${org}/teams/${sales}/members/${bob.user.id}`);
  const synced=await call(bob,'POST','sync',{deviceId:bob.device.id,cursor:0,changes:[]});assert.ok(!synced.shared.some((r:any)=>r.id===doc||r.id===mode));await call(bob,'GET','resources/knowledge/'+doc,undefined,404);
  await call(alice,'POST',`organizations/${org}/teams/${sales}/members`,{userId:bob.user.id,role:'manager'},201);
});

test('recording requires confirmed consent and org policies remove stored audio/revoke shares/enforce retention',async()=>{
  const id='recording-test';const data={...meeting(id),recording:{contentType:'audio/wav',base64:Buffer.from('RIFF-Watson-audio-test').toString('base64'),filename:'audio.wav'},consentConfirmed:false};await call(charlie,'POST','meetings',{meeting:data},400);data.consentConfirmed=true;await call(charlie,'POST','meetings',{meeting:data},201);
  const res=await fetch(origin+'/api/v1/meetings/'+id+'/recording',{headers:{Authorization:'Bearer '+charlie.token}});assert.equal(res.status,200);assert.equal(await res.text(),'RIFF-Watson-audio-test');
  const share=await call(charlie,'POST','meetings/'+id+'/share',{},201);assert.equal('recording' in (await call(null,'GET','public/shares/'+share.token)).meeting,false);
  const oldId='expire-by-policy';const old=meeting(oldId,'Old private meeting',new Date(Date.now()-5*86400000).toISOString());await call(charlie,'POST','meetings',{meeting:old},201);
  await call(bob,'PUT','organizations/'+org+'/policy',{retentionDays:1},403);
  await call(alice,'PUT','organizations/'+org+'/policy',{retentionDays:1,recordingAllowed:false,publicSharingAllowed:false});
  const policy=await call(charlie,'GET','policy');assert.equal(policy.recordingAllowed,false);assert.equal(policy.retentionDays,1);
  await call(charlie,'GET','meetings/'+oldId,undefined,404);await call(charlie,'GET','meetings/'+id+'/recording',undefined,404);await call(null,'GET','public/shares/'+share.token,undefined,404);await call(charlie,'POST','meetings/'+id+'/share',{},403);
  await call(charlie,'PUT','meetings/'+id,{expectedRevision:2,meeting:data},403);
  const synced=await call(charlie,'POST','sync',{deviceId:charlie.device.id,cursor:0,changes:[]});assert.ok(synced.changes.filter((c:any)=>c.id===oldId).every((c:any)=>c.data===null));assert.ok(synced.changes.filter((c:any)=>c.id===id).every((c:any)=>!c.data?.recording));
  await call(alice,'PUT','organizations/'+org+'/policy',{retentionDays:365,recordingAllowed:true,publicSharingAllowed:true});
});

test('usage analytics/export aggregate only recorded events and manager/admin scopes; audit is admin-only',async()=>{
  await call(bob,'POST','usage',{id:'assist-event',kind:'assist',amount:1,orgId:org,metadata:{model:'gpt-4.1'}},201);await call(bob,'POST','usage',{id:'assist-event',kind:'assist',amount:1,orgId:org},201);await call(charlie,'POST','usage',{id:'seconds-event',kind:'meeting_seconds',amount:30,orgId:org},201);
  const personal=await call(bob,'GET','usage');assert.equal(personal.totals.assist,1);assert.equal(personal.eventCount,1);assert.equal(personal.totals.meeting_seconds,undefined);
  await call(bob,'GET','organizations/'+org+'/usage',undefined,403);const organization=await call(alice,'GET','organizations/'+org+'/usage');assert.equal(organization.totals.meeting_seconds,30);assert.equal(organization.eventCount,2);
  await call(charlie,'GET','organizations/'+org+'/usage',undefined,403);await call(outsider,'GET','organizations/'+org+'/usage',undefined,404);await call(bob,'GET','organizations/'+org+'/audit',undefined,403);
  const audit=await call(alice,'GET','organizations/'+org+'/audit');assert.ok(audit.events.some((e:any)=>e.action==='policy.update'));
  const exported=await call(bob,'GET','export');assert.equal(exported.user.id,bob.user.id);assert.ok(!exported.resources.some((r:any)=>r.id===aliceMeeting));assert.ok(!JSON.stringify(exported).includes('password_hash'));
});

test('password change revokes every old session and device revocation invalidates its token',async()=>{
  const temp=await signup('Password');const second=await call(null,'POST','auth/login',{email:temp.user.email,password});const changed=await call(temp,'POST','me/password',{currentPassword:password,newPassword:'Changed-Watson-password-123'});await call(temp,'GET','me',undefined,401);await call(second,'GET','me',undefined,401);await call(changed,'GET','me');await call(null,'POST','auth/login',{email:temp.user.email,password},401);
  await call(changed,'DELETE','devices/'+changed.device.id);await call(changed,'GET','me',undefined,401);
});

test('account deletion reauthenticates, removes owned data/shares/sync/auth and protects last organization admin',async()=>{
  await call(alice,'DELETE','me',{currentPassword:password},409);
  const doomed=await signup('Delete');const id='deleted-account-meeting';await call(doomed,'POST','meetings',{meeting:meeting(id)},201);const share=await call(doomed,'POST','meetings/'+id+'/share',{},201);await call(doomed,'POST','organizations',{name:'Solo organization'},201);
  await call(doomed,'DELETE','me',{currentPassword:'wrong'},401);await call(doomed,'DELETE','me',{currentPassword:password});await call(doomed,'GET','me',undefined,401);await call(null,'GET','public/shares/'+share.token,undefined,404);await call(null,'POST','auth/login',{email:doomed.user.email,password},401);
  for(const table of ['resources','changes','devices','auth_sessions','shares','mutations','usage_events']) {const column=['resources','shares'].includes(table)?'owner_id':'user_id';assert.equal(app.store.get(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`,doomed.user.id)!.count,0);}
});

test('SQLite persists real account and resource data after closing and reopening server',async()=>{
  await app.close();app=createWatsonServer({dbPath:join(dir,'watson.sqlite'),port:0});origin=await app.listen();const restored=await call(alice,'GET','meetings/'+aliceMeeting);assert.equal(restored.meeting.title,'Updated title');assert.equal(restored.revision,2);assert.ok((await call(bob,'GET','context?modeId='+mode)).documents.some((d:any)=>d.id===doc));
  assert.ok(readFileSync(join(dir,'watson.sqlite')).length>0);
});

test('people/scorecards and full desktop Session/Mode/Calendar fields survive actual sync without leaking tenants',async()=>{
  const person={id:'synced-person',name:'Customer contact',email:'contact@example.test',company:'Example',role:'Buyer',notes:'Prefers annual renewal',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  const scorecard={id:'synced-scorecard',name:'Discovery review',instructions:'Cite transcript evidence',criteria:[{id:'criterion',name:'Discovery',description:'Ask needs',maxScore:5,weight:1}]};
  const fullMeeting={...meeting('full-desktop-meeting'),attendeeIds:[person.id],calendarEventId:'synced-calendar',commitments:[{id:'commitment',text:'Send proposal',personId:person.id,status:'open'}],coaching:[{id:'assessment',scorecardId:scorecard.id,scorecardName:scorecard.name,createdAt:new Date().toISOString(),summary:'Asked discovery',criteria:[],demo:false}],usage:{captureMs:1000,audioSamples:{microphone:16000,system:16000},screenshots:1,providerRequests:2,inputTokens:300,outputTokens:100}};
  const result=await call(alice,'POST','sync',{deviceId:alice.device.id,cursor:0,changes:[{entity:'person',id:person.id,expectedRevision:0,data:person},{entity:'scorecard',id:scorecard.id,expectedRevision:0,data:scorecard},{entity:'calendar',id:'synced-calendar',expectedRevision:0,data:{id:'synced-calendar',title:'Calendar event',start:new Date().toISOString(),end:new Date(Date.now()+3600000).toISOString(),description:'Call',attendees:[{email:person.email,name:person.name}],source:{provider:'google',connectionId:'calendar-connection',eventId:'event-id',calendarId:'primary'}}},{entity:'mode',id:'synced-mode',expectedRevision:0,data:{id:'synced-mode',name:'Meeting mode',instructions:'Assist',documentIds:[],noteTemplate:'Summary',emailTemplate:'Thanks',customActions:[{id:'action',name:'Say thanks',type:'prompt',prompt:'Thank them'}]}},{entity:'meeting',id:fullMeeting.id,expectedRevision:0,data:fullMeeting}]});
  assert.equal(result.applied.length,5);assert.equal(result.applied.find((r:any)=>r.entity==='meeting').data.coaching[0].scorecardId,scorecard.id);assert.equal(result.applied.find((r:any)=>r.entity==='mode').data.customActions[0].prompt,'Thank them');
  const anotherDevice=await call(null,'POST','auth/login',{email:alice.user.email,password});const pulled=await call(anotherDevice,'POST','sync',{deviceId:anotherDevice.device.id,cursor:0,changes:[]});assert.equal(pulled.changes.find((c:any)=>c.entity==='person').data.name,person.name);assert.equal(pulled.changes.find((c:any)=>c.entity==='scorecard').data.criteria[0].weight,1);await call(bob,'GET','resources/person/'+person.id,undefined,404);
});

test('prompt management and one-per-user assignments match org/team roles without exposing other-team assignments',async()=>{
  await call(bob,'POST','resources/mode',{data:{id:'manager-cannot-create-org-prompt',name:'Forbidden',instructions:'text'},scope:'org',orgId:org},403);
  const orgMode='organization-managed-prompt';await call(alice,'POST','resources/mode',{data:{id:orgMode,name:'Organization prompt',instructions:'Organization-wide behavior',documentIds:[]},scope:'org',orgId:org},201);await call(bob,'GET','resources/mode/'+orgMode,undefined,404);
  const engineeringMode='engineering-managed-prompt';await call(alice,'POST','resources/mode',{data:{id:engineeringMode,name:'Engineering prompt',instructions:'Technical behavior',documentIds:[]},scope:'team',orgId:org,teamId:engineering},201);await call(bob,'GET','resources/mode/'+engineeringMode,undefined,404);
  await call(bob,'PUT',`organizations/${org}/assignments/${bob.user.id}`,{modeId:mode});assert.equal((await call(bob,'GET','assigned-mode')).mode.id,mode);
  await call(alice,'PUT',`organizations/${org}/assignments/${bob.user.id}`,{modeId:engineeringMode});const salesView=await call(bob,'GET',`organizations/${org}/assignments?teamId=${sales}`);assert.equal(salesView.assignments.find((a:any)=>a.userId===bob.user.id).modeId,null);assert.equal((await call(bob,'GET','assigned-mode')).mode.id,engineeringMode);assert.equal(app.store.get('SELECT COUNT(*) AS count FROM prompt_assignments WHERE user_id=?',bob.user.id)!.count,1);
  await call(bob,'PUT',`organizations/${org}/assignments/${charlie.user.id}`,{modeId:mode},400);await call(bob,'GET',`organizations/${org}/assignments?teamId=${engineering}`,undefined,403);
  await call(alice,'POST',`organizations/${org}/teams/${sales}/members`,{userId:charlie.user.id,role:'member'},201);await call(bob,'PUT',`organizations/${org}/assignments/${charlie.user.id}`,{modeId:mode});await call(charlie,'GET','resources/mode/'+mode,undefined,404);assert.equal((await call(charlie,'GET','context?modeId='+mode)).documents[0].id,doc);
  const synced=await call(charlie,'POST','sync',{deviceId:charlie.device.id,cursor:0,changes:[]});assert.equal(synced.assignedMode.id,mode);assert.ok(!synced.shared.some((r:any)=>r.entity==='mode'));
  await call(alice,'DELETE',`organizations/${org}/teams/${sales}/members/${charlie.user.id}`);assert.equal((await call(charlie,'GET','assigned-mode')).mode,null);await call(charlie,'GET','context?modeId='+mode,undefined,404);
});

test('safe Smart preferences roundtrip independently of normal model and reject invalid budgets/efforts',async()=>{
 const before=await call(alice,'POST','sync',{deviceId:alice.device.id,cursor:0,changes:[]});const current=before.changes.filter((c:any)=>c.entity==='settings'&&c.id==='preferences').at(-1);const revision=current?.revision??0;const initial=await call(alice,'POST','sync',{deviceId:alice.device.id,cursor:before.cursor,changes:[{entity:'settings',id:'preferences',expectedRevision:revision,data:{model:'ordinary-model',smartModel:'reasoning-model',smartReasoningEffort:'max',smartWebSearch:false,smartMaxOutputTokens:25000}}]});assert.equal(initial.applied[0].data.model,'ordinary-model');assert.equal(initial.applied[0].data.smartModel,'reasoning-model');const next=await call(alice,'POST','sync',{deviceId:alice.device.id,cursor:initial.cursor,changes:[{entity:'settings',id:'preferences',expectedRevision:revision+1,data:{smartWebSearch:true}}]});assert.equal(next.applied[0].data.model,'ordinary-model');assert.equal(next.applied[0].data.smartWebSearch,true);for(const invalid of [{smartMaxOutputTokens:1},{smartReasoningEffort:'invented'},{smartWebSearch:'true'},{smartModel:''}])await call(alice,'POST','sync',{deviceId:alice.device.id,cursor:next.cursor,changes:[{entity:'settings',id:'preferences',expectedRevision:revision+2,data:invalid}]},400);
});
