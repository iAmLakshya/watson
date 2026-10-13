import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CloudClient, cloudData, cloudEndpoint, type CloudSecretStorage } from '../electron/cloud-client';
import { applyCloudRecords } from '../electron/cloud-store';
import type { Store } from '../electron/store';
import { createWatsonServer, type ServerOptions } from '../server/src/app.ts';
import type { OidcProvider } from '../server/src/enterprise/sso.ts';
import { createConnectorContextProvider, createConnectorExtension } from '../server/src/connectors/index.ts';
import type { ConnectorOptions } from '../server/src/connectors/types.ts';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { CloudApplyRecord, CloudLocalData } from '../shared/cloud-types';
import type { Session } from '../shared/types';

const password='Watson fixture password 2026';
const meeting=(id:string,notes='Original notes'):Session=>({id,title:`Meeting ${id}`,startedAt:new Date().toISOString(),modeId:'general',demo:false,pinned:false,transcript:[],answers:[],notes,actions:[],followupDraft:''});
function encryptedStorage():CloudSecretStorage {
  const key=randomBytes(32);
  return {isEncryptionAvailable:()=>true,encryptString(value){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),encrypted]);},decryptString(value){const decipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(12,28));return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString('utf8');}};
}
async function fixture(options:Partial<ServerOptions>={}) {
  const root=await mkdtemp(join(tmpdir(),'watson-cloud-client-'));const server=createWatsonServer({...options,dbPath:join(root,'server.sqlite'),port:0});const origin=await server.listen();const clients: {client:CloudClient;local:CloudLocalData;directory:string;storage:CloudSecretStorage}[]=[];
  async function desktop(initial:Session[]=[],fetcher?:typeof fetch) {
    const directory=join(root,`desktop-${clients.length}`);const local:CloudLocalData={sessions:initial,knowledge:[],modes:[],calendar:[],settings:structuredClone(DEFAULT_SETTINGS),people:[],scorecards:[],folders:[]};const storage=encryptedStorage();
    const adapter={data:{schemaVersion:1,...local,encryptedKeys:{},contextAnswers:[]},save(){}} as unknown as Pick<Store,'data'|'save'>;
    const applyRemote=(records:CloudApplyRecord[])=>{Object.assign(adapter.data,local);applyCloudRecords(adapter,records);Object.assign(local,adapter.data);};
    const client=new CloudClient({directory,secretStorage:storage,getLocal:()=>local,applyRemote,fetch:fetcher});await client.configure(origin);const item={client,local,directory,storage,applyRemote};clients.push(item);return item;
  }
  return {root,server,origin,desktop,close:async()=>{await server.close();await rm(root,{recursive:true,force:true});}};
}

test('cloud payload whitelist keeps provider secrets and capture/privacy preferences local',()=>{
  assert.equal(cloudEndpoint('http://127.0.0.1:4319/'),'http://127.0.0.1:4319/api/v1');
  assert.throws(()=>cloudEndpoint('http://example.com'),/HTTPS/);assert.throws(()=>cloudEndpoint('https://secret@example.com'),/origin/);
  assert.throws(()=>cloudEndpoint('https://example.com/path'),/origin/);
  const raw={...DEFAULT_SETTINGS,contentProtection:false,encryptedKeys:{openai:'never-upload'},authToken:'never-upload',microphoneDeviceId:'private-device',captureMicrophone:false};const result=cloudData('settings',raw,'preferences');
  assert.equal(result.contentProtection,undefined);assert.equal(result.microphoneDeviceId,undefined);assert.equal(result.captureMicrophone,undefined);assert.equal(result.encryptedKeys,undefined);assert.equal(result.authToken,undefined);assert.equal(result.model,DEFAULT_SETTINGS.model);
  const nested=cloudData('meeting',{...meeting('secret'),answers:[{id:'answer',text:'Retain readable answer',credentials:{openai:'never-upload'},sources:[{id:'source',token:'never-upload'}]}],encryptedKeys:{deepgram:'never-upload'}},'secret');assert.doesNotMatch(JSON.stringify(nested),/never-upload|credentials|encryptedKeys/);assert.match(JSON.stringify(nested),/Retain readable answer/);
});

test('JSON wire normalization preserves rich adapter records for sharing immediately after the first upload',async()=>{
  const f=await fixture();try{
    const record=meeting('share-after-import','Rich notes are ready to share');record.transcript=[{id:'line',source:'system',text:'The customer approved the plan.',timestamp:record.startedAt,final:true}];record.answers=[{id:'answer',kind:'assist',question:'Which plan?',text:'The customer approved the annual plan.',createdAt:record.startedAt,status:'complete',sources:[{id:'source',title:'Product guide',kind:'knowledge'}]}];
    const desktop=await f.desktop();await desktop.client.signup({email:'rich-share@example.com',password});desktop.applyRemote([{entity:'meeting',id:record.id,data:cloudData('meeting',record,record.id)}]);
    const normalized=desktop.local.sessions[0];assert.ok(Object.prototype.hasOwnProperty.call(normalized.transcript[0],'speaker'));assert.equal(normalized.transcript[0].speaker,undefined);assert.ok(Object.prototype.hasOwnProperty.call(normalized.answers[0],'latencyMs'));assert.equal(normalized.answers[0].latencyMs,undefined);assert.ok(Object.prototype.hasOwnProperty.call(normalized.answers[0].sources[0],'excerpt'));assert.equal(normalized.answers[0].sources[0].excerpt,undefined);
    const payload=cloudData('meeting',normalized,normalized.id);assert.deepEqual(payload,JSON.parse(JSON.stringify(payload)));
    await desktop.client.sync({uploads:[{entity:'meeting',id:normalized.id}],confirmedUpload:true});const link=await desktop.client.share({meetingId:normalized.id});assert.equal((await fetch(link.url)).status,200);assert.equal(desktop.client.status().conflicts.length,0);assert.equal(desktop.client.status().pendingUploads,0);
    const wire=cloudData('meeting',{...record,answers:[{id:'wire',text:'Retain answer',optional:undefined,metadata:{keep:true,missing:undefined,authorization:'provider-secret',children:[undefined,{missing:undefined,keep:'value',apiKey:'provider-secret'}]},sparse:Array(1)}]},record.id);assert.deepEqual(wire,JSON.parse(JSON.stringify(wire)));const answer=(wire.answers as Record<string,unknown>[])[0];assert.equal(Object.prototype.hasOwnProperty.call(answer,'optional'),false);assert.deepEqual(answer.metadata,{keep:true,children:[null,{keep:'value'}]});assert.deepEqual(answer.sparse,[null]);assert.doesNotMatch(JSON.stringify(wire),/provider-secret/);
  }finally{await f.close();}
});

test('desktop SSO keeps one-time request secrets private through actual backend OIDC handoff',async()=>{
  const providers:OidcProvider[]=[];const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});let providerOrigin='';let entry:{nonce:string;challenge:string}|undefined;
  const oidc=createServer(async(req,res)=>{
    const url=new URL(req.url||'/',providerOrigin);const send=(data:unknown)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
    if(url.pathname==='/.well-known/openid-configuration'){send({issuer:providerOrigin,authorization_endpoint:'https://watson-identity.fixture/authorize',token_endpoint:providerOrigin+'/token',jwks_uri:providerOrigin+'/jwks'});return;}
    if(url.pathname==='/jwks'){send({keys:[{...publicKey.export({format:'jwk'}),kid:'fixture-key',alg:'RS256',use:'sig'}]});return;}
    if(url.pathname==='/authorize'){entry={nonce:url.searchParams.get('nonce')!,challenge:url.searchParams.get('code_challenge')!};const callback=new URL(url.searchParams.get('redirect_uri')!);callback.searchParams.set('state',url.searchParams.get('state')!);callback.searchParams.set('code','fixture-auth-code');res.writeHead(302,{Location:callback.href});res.end();return;}
    if(url.pathname==='/token'){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const input=new URLSearchParams(Buffer.concat(chunks).toString());assert.equal(createHash('sha256').update(input.get('code_verifier')!).digest('base64url'),entry?.challenge);const seconds=Math.floor(Date.now()/1000);const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture-key'})).toString('base64url');const claims=Buffer.from(JSON.stringify({iss:providerOrigin,aud:'desktop-fixture',sub:'employee',nonce:entry?.nonce,iat:seconds,exp:seconds+300,email:'employee@corp.test',email_verified:true,name:'SSO employee'})).toString('base64url');const value=header+'.'+claims;send({id_token:value+'.'+sign('sha256',Buffer.from(value),privateKey).toString('base64url')});return;}
    res.writeHead(404);res.end();
  });
  await new Promise<void>(resolve=>oidc.listen(0,'127.0.0.1',resolve));providerOrigin=`http://127.0.0.1:${(oidc.address() as {port:number}).port}`;
  const f=await fixture({sso:{providers,encryptionKey:randomBytes(32).toString('base64'),allowInsecureLoopback:true}});
  try {
    const admin=await f.desktop();await admin.client.signup({email:'admin@corp.test',password});const org=await admin.client.organization({action:'create',name:'Identity fixture'});providers.push({id:'fixture-oidc',orgId:String(org.id),issuer:providerOrigin,clientId:'desktop-fixture',domains:['corp.test'],autoProvision:true});
    const desktop=await f.desktop();const start=await desktop.client.startSso({providerId:'fixture-oidc'});assert.equal('requestSecret' in start,false);assert.equal(desktop.client.status().signedIn,false);assert.equal((await desktop.client.pollSso()).signedIn,false);
    const url=new URL(start.authorizationUrl);const browser=await fetch(providerOrigin+url.pathname+url.search,{redirect:'manual'});const complete=await fetch(browser.headers.get('location')!);assert.equal(complete.status,200);const status=await desktop.client.pollSso();assert.equal(status.user?.email,'employee@corp.test');assert.equal(status.signedIn,true);assert.equal('requestSecret' in status,false);const saved=await readFile(join(desktop.directory,'cloud.json'),'utf8');assert.doesNotMatch(saved,/requestSecret|fixture-auth-code/);await assert.rejects(desktop.client.pollSso(),/expired|unavailable/);
    const metadata=await admin.client.enterprise({action:'sso',orgId:String(org.id)});assert.equal(metadata.configured,true);assert.equal(JSON.stringify(metadata).includes('clientSecret'),false);
    const billing=await desktop.client.enterprise({action:'billing'});assert.equal(billing.configured,false);const directory=await admin.client.enterprise({action:'directory',orgId:String(org.id)});assert.equal(directory.configured,false);assert.equal(directory.protocol,'SCIM 2.0');
  }finally{await f.close();await new Promise<void>(resolve=>oidc.close(()=>resolve()));}
});

test('two actual desktop clients sign in, manually sync SQLite revisions, and retain local capture protection',async()=>{
  const f=await fixture();try{
    const a=await f.desktop([meeting('one')]),b=await f.desktop();await a.client.signup({email:'alice@example.com',password,name:'Alice'});await b.client.login({email:'alice@example.com',password});
    const before=await b.client.sync();assert.equal(before.cursor,0);assert.equal(b.local.sessions.length,0);assert.equal(a.client.status().boundRecords.length,0);
    await assert.rejects(a.client.sync({uploads:[{entity:'meeting',id:'one'}]}),/Confirm/);
    a.local.settings.smartModel='gpt-5.4-mini';a.local.settings.smartReasoningEffort='high';a.local.settings.smartWebSearch=false;a.local.settings.smartMaxOutputTokens=4096;
    await a.client.sync({uploads:[{entity:'meeting',id:'one'},{entity:'settings',id:'preferences'}],confirmedUpload:true});
    b.local.settings.contentProtection=false;b.local.settings.captureMicrophone=false;await b.client.sync();assert.equal(b.client.status().conflicts.find(item=>item.entity==='settings')?.remote.data?.smartReasoningEffort,'high');assert.equal(b.local.settings.smartReasoningEffort,DEFAULT_SETTINGS.smartReasoningEffort);await b.client.resolve({entity:'settings',id:'preferences',choice:'remote',confirmed:true});
    assert.equal(b.local.sessions[0].notes,'Original notes');assert.equal(b.local.settings.contentProtection,false);assert.equal(b.local.settings.captureMicrophone,false);assert.equal(b.local.settings.smartModel,'gpt-5.4-mini');assert.equal(b.local.settings.smartReasoningEffort,'high');assert.equal(b.local.settings.smartWebSearch,false);assert.equal(b.local.settings.smartMaxOutputTokens,4096);assert.equal(b.local.settings.model,DEFAULT_SETTINGS.model);
    assert.equal(a.client.status().automaticSync,false);assert.ok(b.client.status().cursor>0);
    const saved=JSON.parse(await readFile(join(a.directory,'cloud.json'),'utf8'));assert.equal(saved.auth.token,undefined);assert.equal(saved.auth.encryptedToken.includes(password),false);assert.equal(JSON.stringify(a.client.status()).includes('encryptedToken'),false);
    const token=a.storage.decryptString(Buffer.from(saved.auth.encryptedToken,'base64'));assert.equal((await readFile(join(a.directory,'cloud.json'),'utf8')).includes(token),false);
    const restored=new CloudClient({directory:a.directory,secretStorage:a.storage,getLocal:()=>a.local,applyRemote:()=>{}});assert.equal((await restored.refresh()).user?.email,'alice@example.com');
    a.local.sessions[0].notes='Updated from A';await a.client.sync({uploads:[{entity:'meeting',id:'one'}],confirmedUpload:true});await b.client.sync();assert.equal(b.local.sessions[0].notes,'Updated from A');
  }finally{await f.close();}
});

test('concurrent desktop edits produce a real revision conflict without replacing either choice',async()=>{
  const f=await fixture();try{
    const a=await f.desktop([meeting('conflict')]),b=await f.desktop();await a.client.signup({email:'conflict@example.com',password});await b.client.login({email:'conflict@example.com',password});await a.client.sync({uploads:[{entity:'meeting',id:'conflict'}],confirmedUpload:true});await b.client.sync();
    a.local.sessions[0].notes='Server choice A';b.local.sessions[0].notes='Local choice B';await a.client.sync({uploads:[{entity:'meeting',id:'conflict'}],confirmedUpload:true});
    const status=await b.client.sync({uploads:[{entity:'meeting',id:'conflict'}],confirmedUpload:true});assert.equal(status.conflicts.length,1);assert.equal(b.local.sessions[0].notes,'Local choice B');assert.equal(status.conflicts[0].remote.data?.notes,'Server choice A');
    await assert.rejects(b.client.resolve({entity:'meeting',id:'conflict',choice:'both'}),/Confirm/);
    await b.client.resolve({entity:'meeting',id:'conflict',choice:'both',confirmed:true});assert.equal(b.local.sessions.find(item=>item.id==='conflict')?.notes,'Server choice A');assert.ok(b.local.sessions.some(item=>item.id!=='conflict' && item.notes==='Local choice B'));
    assert.equal(b.client.status().conflicts.length,0);
    b.local.sessions.find(item=>item.id==='conflict')!.notes='Local choice after resolution';a.local.sessions[0].notes='New server choice';await a.client.sync({uploads:[{entity:'meeting',id:'conflict'}],confirmedUpload:true});await b.client.sync();
    await b.client.resolve({entity:'meeting',id:'conflict',choice:'local',confirmed:true});assert.equal(b.client.status().pendingUploads,1);await assert.rejects(b.client.sync(),/Confirm/);await b.client.sync({confirmedUpload:true});await a.client.sync();assert.equal(a.local.sessions[0].notes,'Local choice after resolution');
  }finally{await f.close();}
});

test('account switching never implicitly uploads old account records and preserves ID collisions',async()=>{
  const f=await fixture();try{
    const a=await f.desktop([meeting('same-id','Alice local')]),bob=await f.desktop([meeting('same-id','Bob cloud')]);await a.client.signup({email:'alice-switch@example.com',password});await a.client.sync({uploads:[{entity:'meeting',id:'same-id'}],confirmedUpload:true});await bob.client.signup({email:'bob-switch@example.com',password});await bob.client.sync({uploads:[{entity:'meeting',id:'same-id'}],confirmedUpload:true});
    await assert.rejects(a.client.login({email:'bob-switch@example.com',password}),/Sign out/);await a.client.logout();await a.client.login({email:'bob-switch@example.com',password});assert.equal(a.client.status().boundRecords.length,0);await a.client.sync();
    assert.equal(a.local.sessions[0].notes,'Alice local');assert.equal(a.client.status().conflicts[0].reason,'account-collision');assert.equal(a.client.status().conflicts[0].remote.data?.notes,'Bob cloud');
    a.local.sessions.push(meeting('alice-only','Private local'));await a.client.sync();await bob.client.sync();assert.equal(bob.local.sessions.some(item=>item.id==='alice-only'),false);
  }finally{await f.close();}
});

test('queued account switch invalidates signed read/write approvals before any wrong-account HTTP request',async()=>{
  const f=await fixture({extensions:[createConnectorExtension({encryptionKey:randomBytes(32).toString('base64')})]});
  try{
    let hold=false,release!:()=>void,entered!:()=>void;const barrier=new Promise<void>(resolve=>release=resolve),waiting=new Promise<void>(resolve=>entered=resolve),requests:string[]=[];
    const fetcher:typeof fetch=async(url,input)=>{const path=new URL(String(url)).pathname;if(hold&&path.endsWith('/auth/capabilities')){entered();await barrier;}if(hold)requests.push(`${input?.method??'GET'} ${path}`);return fetch(url,input);};
    const alpha=await f.desktop([meeting('common'),meeting('alpha-private','PRIVATE_ALPHA_NOTES')],fetcher);await alpha.client.signup({email:'queued-alpha@example.com',password,name:'Alpha'});await alpha.client.sync({uploads:[{entity:'meeting',id:'common'},{entity:'meeting',id:'alpha-private'}],confirmedUpload:true});const alphaId=alpha.client.status().user!.id,alphaCopy=structuredClone(alpha.local.sessions);
    const org=await alpha.client.organization({action:'create',name:'Alpha scope'}),orgId=String(org.id);
    const beta=await f.desktop([structuredClone(alphaCopy[0])]);await beta.client.signup({email:'queued-beta@example.com',password,name:'Beta'});await beta.client.sync({uploads:[{entity:'meeting',id:'common'}],confirmedUpload:true});const betaId=beta.client.status().user!.id,betaShare=await beta.client.share({meetingId:'common'});
    await alpha.client.logout();await alpha.client.login({email:'queued-beta@example.com',password});await alpha.client.sync();for(const conflict of alpha.client.status().conflicts)await alpha.client.resolve({...conflict,choice:'remote',confirmed:true});await alpha.client.logout();await alpha.client.login({email:'queued-alpha@example.com',password});alpha.local.sessions=alphaCopy;
    hold=true;const pending=alpha.client.authCapabilities();await waiting;const logout=alpha.client.logout(),login=alpha.client.login({email:'queued-beta@example.com',password});
    const operations=[
      alpha.client.sync({uploads:[{entity:'meeting',id:'alpha-private'}],confirmedUpload:true}),alpha.client.share({meetingId:'common'}),alpha.client.revokeShare('common'),
      alpha.client.organization({action:'create',name:'Wrong actor organization'}),alpha.client.connector({action:'url-create',url:'https://example.test/approved-alpha',approveUrl:true}),alpha.client.connector({action:'status'}),
      alpha.client.updateProfile({name:'Wrong actor profile'}),alpha.client.changePassword({currentPassword:password,newPassword:password+' changed'}),alpha.client.deleteAccount({currentPassword:password,confirmed:true}),
      alpha.client.resolve({entity:'meeting',id:'common',choice:'remote',confirmed:true}),alpha.client.analytics({orgId}),alpha.client.exportAnalytics({orgId}),alpha.client.refresh(),alpha.client.cancelUploads({confirmed:true}),alpha.client.requestVerification(),alpha.client.enterprise({action:'billing'})
    ].map(promise=>promise.then(()=>({ok:true,error:''}),error=>({ok:false,error:String(error.message)})));
    release();await pending;await logout;await login;for(const outcome of await Promise.all(operations)){assert.equal(outcome.ok,false);assert.match(outcome.error,/account or server changed while this request was waiting/);}assert.deepEqual(requests,['GET /api/v1/auth/capabilities','POST /api/v1/auth/logout','POST /api/v1/auth/login']);
    assert.equal(alpha.client.status().user!.id,betaId);assert.equal(alpha.client.status().user!.name,'Beta');assert.equal(f.server.store.get("SELECT id FROM resources WHERE owner_id=? AND entity='meeting' AND id='alpha-private'",betaId),undefined);assert.equal(f.server.store.resource(alphaId,'meeting','alpha-private')!.revision,1);assert.equal((await fetch(betaShare.url)).status,200);
    hold=false;await alpha.client.sync();assert.equal((await alpha.client.connector({action:'status'})).connections?.length,0);assert.equal(alpha.client.status().pendingUploads,0);
  }finally{await f.close();}
});

test('a lost HTTP response retries the same durable mutation ID without duplicating the revision',async()=>{
  const f=await fixture();try{
    let lose=false;const fetcher:typeof fetch=async(input,options)=>{const response=await fetch(input,options);if(lose && String(input).endsWith('/sync')){lose=false;await response.text();throw new Error('Simulated connection loss after server commit');}return response;};
    const a=await f.desktop([meeting('retry')],fetcher);await a.client.signup({email:'retry@example.com',password});lose=true;await assert.rejects(a.client.sync({uploads:[{entity:'meeting',id:'retry'}],confirmedUpload:true}),/connection loss/);assert.equal(a.client.status().pendingUploads,1);
    await a.client.sync({confirmedUpload:true});assert.equal(a.client.status().pendingUploads,0);const row=f.server.store.get("SELECT revision FROM resources WHERE entity='meeting' AND id=?",'retry');assert.equal(row?.revision,1);
  }finally{await f.close();}
});

test('assigned-mode SSE transport buffers partial packets, keeps auth private and rejects incomplete streams',async()=>{
  const f=await fixture();try{
    let headers:Headers|undefined,body:Record<string,unknown>|undefined;let incomplete=false;
    const fetcher:typeof fetch=async(url,options)=>{if(!String(url).endsWith('/assistant'))return fetch(url,options);headers=new Headers(options?.headers);body=JSON.parse(String(options?.body));const frames='event: delta\r\ndata: {"text":"Hello "}\r\n\r\nevent: delta\r\ndata: {"text":"Watson"}\r\n\r\n'+(incomplete?'':'event: done\r\ndata: {"text":"Hello Watson","sources":[{"id":"doc","title":"Guide","kind":"knowledge"}],"usage":{"inputTokens":10,"outputTokens":3},"operatorSecret":"never-return"}\r\n\r\n');const encoder=new TextEncoder();return new Response(new ReadableStream<Uint8Array>({start(controller){for(let index=0;index<frames.length;index+=7)controller.enqueue(encoder.encode(frames.slice(index,index+7)));controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});};
    const a=await f.desktop([],fetcher);await a.client.signup({email:'stream@example.com',password});const deltas:string[]=[];const result=await a.client.streamAssistant({kind:'assist',question:'Help with this conversation',instructions:'never-send',encryptedKeys:{openai:'never-send'}} as any,delta=>deltas.push(delta));assert.equal(result.text,'Hello Watson');assert.equal(deltas.join(''),'Hello Watson');assert.deepEqual(result.usage,{inputTokens:10,outputTokens:3});assert.equal((result as any).operatorSecret,undefined);assert.equal(body?.instructions,undefined);assert.equal(body?.encryptedKeys,undefined);assert.ok(headers?.get('authorization')?.startsWith('Bearer '));assert.equal(JSON.stringify(a.client.status()).includes(headers!.get('authorization')!.slice(7)),false);
    incomplete=true;await assert.rejects(a.client.streamAssistant({kind:'assist'},()=>{}),/before completion/);
  }finally{await f.close();}
});

test('desktop assigned-mode generation traverses the real backend to an operator-owned model fixture without receiving private instructions',async()=>{
  const privatePrompt='PRIVATE_ORGANIZATION_PROMPT_99';let payload:any,providerToken:string|undefined;
  const provider=createServer(async(req,res)=>{providerToken=String(req.headers.authorization);const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));payload=JSON.parse(Buffer.concat(chunks).toString());res.writeHead(200,{'Content-Type':'text/event-stream'});const packet='data: '+JSON.stringify({choices:[{delta:{content:'A grounded reply.'}}]})+'\r\n\r\n';res.write(packet.slice(0,11));setImmediate(()=>{res.write(packet.slice(11));res.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:41,completion_tokens:5}})+'\r\n\r\n');res.end('data: [DONE]\r\n\r\n');});});
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const providerOrigin=`http://127.0.0.1:${(provider.address() as {port:number}).port}`;const f=await fixture({assistant:{apiKey:'operator-fixture-only',model:'operator-model-fixture',apiBase:providerOrigin+'/v1/',allowInsecureLoopback:true}});
  try{
    const admin=await f.desktop(),member=await f.desktop();await admin.client.signup({email:'private-admin@example.com',password});await member.client.signup({email:'private-member@example.com',password});const org=await admin.client.organization({action:'create',name:'Private prompts'});const orgId=String(org.id);await admin.client.organization({action:'add-member',orgId,email:'private-member@example.com',role:'member'});await admin.client.organization({action:'put-resource',orgId,entity:'knowledge',id:'allowed',expectedRevision:0,data:{title:'Product facts',text:'Annual plan is available.'}});await admin.client.organization({action:'put-resource',orgId,entity:'mode',id:'private-mode',expectedRevision:0,data:{name:'Managed mode',instructions:privatePrompt,noteTemplate:'Private notes template',documentIds:['allowed']}});await admin.client.organization({action:'assign-mode',orgId,userId:member.client.status().user!.id,modeId:'private-mode'});const status=await member.client.sync();assert.equal(status.assignedMode?.inference,'server');assert.equal(status.assignedMode?.data?.instructions,undefined);assert.doesNotMatch(JSON.stringify(status),new RegExp(privatePrompt));
    const deltas:string[]=[];const answer=await member.client.streamAssistant({kind:'notes',question:'What plan is available?',outputLanguage:'English',transcript:[{id:'live',source:'system',text:'Which annual plan can I choose?',timestamp:new Date().toISOString(),final:true}]},delta=>deltas.push(delta));assert.equal(answer.text,'A grounded reply.');assert.equal(deltas.join(''),'A grounded reply.');assert.deepEqual(answer.usage,{inputTokens:41,outputTokens:5});assert.equal(answer.sources.some(source=>source.id==='allowed'),true);assert.equal(providerToken,'Bearer operator-fixture-only');assert.match(JSON.stringify(payload),new RegExp(privatePrompt));assert.match(JSON.stringify(payload),/Annual plan is available/);assert.match(JSON.stringify(payload),/Respond in en/);assert.equal(payload.model,'operator-model-fixture');assert.doesNotMatch(JSON.stringify(answer),new RegExp(privatePrompt));
  }finally{await f.close();await new Promise<void>(resolve=>provider.close(()=>resolve()));}
});

test('managed Smart transports independent web intent and keeps canonical refusals through actual sync',async()=>{
  const privatePrompt='PRIVATE_MANAGED_SMART_INSTRUCTIONS',operatorKey='fixture-operator-smart-key';
  let refusing=false;const requests:{path:string;body:any}[]=[];
  const provider=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,`Bearer ${operatorKey}`);const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const body=JSON.parse(Buffer.concat(chunks).toString());requests.push({path:req.url!,body});res.writeHead(200,{'Content-Type':'text/event-stream'});
    const send=(value:unknown)=>res.write('data: '+JSON.stringify(value)+'\n\n');
    if(req.url==='/v1/responses'){
      if(refusing)send({type:'response.refusal.delta',delta:privatePrompt+' '+operatorKey});
      else {send({type:'response.output_text.delta',delta:'A measured response.'});if(body.tools)send({type:'response.output_text.annotation.added',annotation:{type:'url_citation',url:'https://example.test/verified',title:'Verified research'}});}
      send({type:'response.completed',response:{status:'completed',usage:{input_tokens:25,output_tokens:4},output:refusing?[{type:'message',content:[{type:'refusal',refusal:privatePrompt}]}]:[]}});res.end();
    }else{send({choices:[{delta:refusing?{refusal:privatePrompt+' '+operatorKey}:{content:'Normal response.'}}]});res.end('data: [DONE]\n\n');}
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const apiBase=`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1/`;
  const f=await fixture({assistant:{apiKey:operatorKey,model:'normal-operator-model',webModel:'gpt-4.1',smartModel:'gpt-5.4-mini',smartReasoningEffort:'high',smartMaxOutputTokens:4096,smartWebSearch:true,apiBase,allowInsecureLoopback:true}});
  try{
    const admin=await f.desktop(),member=await f.desktop();await admin.client.signup({email:'smart-admin@example.com',password});await member.client.signup({email:'smart-member@example.com',password});
    const org=await admin.client.organization({action:'create',name:'Managed Smart'}),orgId=String(org.id);await admin.client.organization({action:'add-member',orgId,email:'smart-member@example.com',role:'member'});
    await admin.client.organization({action:'put-resource',orgId,entity:'mode',id:'smart-managed-mode',expectedRevision:0,data:{name:'Managed Smart mode',instructions:privatePrompt,documentIds:[]}});await admin.client.organization({action:'assign-mode',orgId,userId:member.client.status().user!.id,modeId:'smart-managed-mode'});
    const status=await member.client.refresh();assert.equal(status.assistantConfigured,true);assert.equal(status.webResearchConfigured,true);assert.equal(status.smartConfigured,true);assert.equal(status.smartWebResearchConfigured,true);assert.deepEqual(status.managedSmart,{configured:true,model:'gpt-5.4-mini',reasoningEffort:'high',reasoningEnabled:true,maxOutputTokens:4096,webResearchEnabled:true,webResearchConfigured:true,modelSupport:'supported',configurationError:null});
    const deep=await member.client.streamAssistant({kind:'assist',smart:true,webResearch:false,model:'member-override',instructions:'member-override',apiKey:'member-override'} as any,()=>{});assert.equal(deep.refused,false);assert.equal(requests.at(-1)!.path,'/v1/responses');assert.equal(requests.at(-1)!.body.model,'gpt-5.4-mini');assert.deepEqual(requests.at(-1)!.body.reasoning,{effort:'high'});assert.equal(requests.at(-1)!.body.max_output_tokens,4096);assert.equal(requests.at(-1)!.body.tools,undefined);assert.equal(requests.at(-1)!.body.tool_choice,undefined);
    const sources:any[]=[];const brief=await member.client.streamAssistant({kind:'brief',scope:'calendar',smart:true,researchOnly:true,webResearch:true},()=>{},undefined,source=>sources.push(source));assert.equal(brief.sources[0].kind,'web');assert.equal(sources[0].url,'https://example.test/verified');assert.equal(requests.at(-1)!.body.model,'gpt-4.1');assert.equal(requests.at(-1)!.body.reasoning,undefined);assert.equal(requests.at(-1)!.body.max_output_tokens,undefined);assert.equal(requests.at(-1)!.body.tool_choice,'required');
    await member.client.streamAssistant({kind:'assist',smart:false,webResearch:true},()=>{});assert.equal(requests.at(-1)!.path,'/v1/chat/completions');assert.equal(requests.at(-1)!.body.model,'normal-operator-model');assert.equal(requests.at(-1)!.body.reasoning,undefined);assert.equal(requests.at(-1)!.body.tools,undefined);
    refusing=true;const declined=await member.client.streamAssistant({kind:'notes',smart:true,webResearch:false},()=>{});assert.equal(declined.refused,true);assert.equal(declined.text,'The model declined this request.');assert.deepEqual(declined.usage,{inputTokens:25,outputTokens:4});assert.equal((await member.client.streamAssistant({kind:'email'},()=>{})).refused,true);assert.equal((await member.client.streamAssistant({kind:'brief',scope:'calendar',researchOnly:true,webResearch:true},()=>{})).refused,true);
    const saved=meeting('refusal-history','Existing notes are retained');saved.answers=[{id:'decline',kind:'notes',question:'Draft notes',text:declined.text,createdAt:new Date().toISOString(),status:'complete',sources:declined.sources,refused:declined.refused}];member.local.sessions=[saved];await member.client.sync({uploads:[{entity:'meeting',id:saved.id}],confirmedUpload:true});
    const otherDevice=await f.desktop();await otherDevice.client.login({email:'smart-member@example.com',password});await otherDevice.client.sync();assert.equal(otherDevice.local.sessions[0].answers[0].refused,true);assert.equal(otherDevice.local.sessions[0].notes,'Existing notes are retained');
    for(const value of [status,declined,member.client.status(),JSON.parse(await readFile(join(member.directory,'cloud.json'),'utf8'))]){assert.equal(JSON.stringify(value).includes(privatePrompt),false);assert.equal(JSON.stringify(value).includes(operatorKey),false);}assert.equal(JSON.stringify(requests).includes('member-override'),false);
  }finally{await f.close();await new Promise<void>(resolve=>provider.close(()=>resolve()));}
});

test('desktop account controls update profile, rotate password sessions and delete cloud account without deleting local notes',async()=>{
  const f=await fixture();try{
    const a=await f.desktop([meeting('local-account-note')]),other=await f.desktop();await a.client.signup({email:'account@example.com',password,name:'Original'});await other.client.login({email:'account@example.com',password});
    await assert.rejects(a.client.updateProfile({email:'renamed@example.com',currentPassword:'incorrect'}),/password/i);assert.equal(a.client.status().signedIn,true);await a.client.updateProfile({name:'Renamed',email:'renamed@example.com',currentPassword:password});assert.equal(a.client.status().user?.email,'renamed@example.com');
    const newPassword=password+' changed';await a.client.changePassword({currentPassword:password,newPassword});assert.equal(a.client.status().signedIn,true);await assert.rejects(other.client.refresh(),/sign in/i);assert.equal(other.client.status().signedIn,false);await other.client.login({email:'renamed@example.com',password:newPassword});
    await assert.rejects(a.client.deleteAccount({currentPassword:'incorrect',confirmed:true}),/password/i);await a.client.deleteAccount({currentPassword:newPassword,confirmed:true});assert.equal(a.client.status().signedIn,false);assert.equal(a.local.sessions[0].id,'local-account-note');await assert.rejects(other.client.refresh(),/sign in/i);assert.equal(other.client.status().signedIn,false);
  }finally{await f.close();}
});

test('selective sync orders folder/document dependencies and recovers from a rejected upload queue',async()=>{
  const f=await fixture();try{
    const a=await f.desktop([meeting('complete-record')]),b=await f.desktop();await a.client.signup({email:'collections@example.com',password});await b.client.login({email:'collections@example.com',password});const now=new Date().toISOString();
    a.local.folders=[{id:'child',name:'Child',parentId:'parent'},{id:'parent',name:'Parent'}];a.local.knowledge=[{id:'guide',title:'Product guide',text:'Context',addedAt:now,size:7,fileType:'text',folderId:'child'}];a.local.modes=[{id:'work-mode',name:'Work mode',instructions:'Use product context',noteTemplate:'Summary',emailTemplate:'Next steps',customActions:[{id:'follow-up',name:'Follow up',type:'prompt',prompt:'Draft next steps'}],documentIds:['guide']}];a.local.people=[{id:'person',name:'Priya',email:'priya@example.com',createdAt:now,updatedAt:now}];a.local.scorecards=[{id:'card',name:'Discovery',instructions:'Evaluate evidence',criteria:[{id:'goal',name:'Goal',description:'Clarify the goal',maxScore:5,weight:1}]}];a.local.calendar=[{id:'event',title:'Renewal',start:now,end:now,description:'Discuss renewal',attendees:[{email:'priya@example.com'}]}];a.local.sessions[0].attendeeIds=['person'];a.local.sessions[0].commitments=[{id:'todo',text:'Follow up',personId:'person',status:'open',createdAt:now,updatedAt:now}];
    await assert.rejects(a.client.sync({uploads:[{entity:'mode',id:'work-mode'}],confirmedUpload:true}),/not found/i);assert.equal(a.client.status().pendingUploads,1);await a.client.cancelUploads({confirmed:true});assert.equal(a.client.status().pendingUploads,0);assert.equal(a.local.modes[0].customActions?.[0].prompt,'Draft next steps');
    await a.client.sync({uploads:[{entity:'meeting',id:'complete-record'},{entity:'mode',id:'work-mode'},{entity:'knowledge',id:'guide'},{entity:'folder',id:'child'},{entity:'folder',id:'parent'},{entity:'person',id:'person'},{entity:'scorecard',id:'card'},{entity:'calendar',id:'event'}],confirmedUpload:true});await b.client.sync();assert.equal(b.local.knowledge[0].folderId,'child');assert.equal(b.local.people?.[0].name,'Priya');assert.equal(b.local.scorecards?.[0].criteria[0].name,'Goal');assert.equal(b.local.calendar[0].attendees?.[0].email,'priya@example.com');assert.equal(b.local.sessions[0].commitments?.[0].personId,'person');assert.equal(b.local.modes[0].emailTemplate,'Next steps');assert.equal(b.local.modes[0].customActions?.[0].prompt,'Draft next steps');
  }finally{await f.close();}
});

test('actual public note links render escaped HTML and are revoked on the server',async()=>{
  const f=await fixture();try{
    const a=await f.desktop([meeting('share','Notes <script>alert("x")</script>')]);await a.client.signup({email:'share@example.com',password});await assert.rejects(a.client.share({meetingId:'share'}),/Sync/);await a.client.sync({uploads:[{entity:'meeting',id:'share'}],confirmedUpload:true});
    const link=await a.client.share({meetingId:'share',expiresInDays:1});assert.match(link.url,/public\/view\//);const html=await fetch(link.url);assert.match(html.headers.get('content-type')||'',/text\/html/);const text=await html.text();assert.match(text,/Notes/);assert.doesNotMatch(text,/<script>alert/);
    await a.client.revokeShare('share');assert.equal((await fetch(link.url)).status,404);assert.equal(a.client.status().shares.length,0);
  }finally{await f.close();}
});

test('desktop organization controls use real server ACLs, shared context and policy enforcement',async()=>{
  const f=await fixture();try{
    const admin=await f.desktop(),member=await f.desktop(),outsider=await f.desktop();await admin.client.signup({email:'admin@example.com',password});await member.client.signup({email:'member@example.com',password});await outsider.client.signup({email:'outsider@example.com',password});
    const org=await admin.client.organization({action:'create',name:'Watson Research'});const orgId=String(org.id);await admin.client.organization({action:'add-member',orgId,email:'member@example.com',role:'member'});
    await admin.client.organization({action:'put-resource',orgId,entity:'knowledge',id:'shared-doc',expectedRevision:0,data:{title:'Product guide',text:'Shared context contains verified pricing.'}});
    await admin.client.organization({action:'put-resource',orgId,entity:'mode',id:'assigned-mode',expectedRevision:0,data:{name:'Account team',instructions:'Use shared product context.',documentIds:['shared-doc'],noteTemplate:'Summary',assigned:true}});
    await admin.client.organization({action:'assign-mode',orgId,userId:member.client.status().user!.id,modeId:'assigned-mode'});const status=await member.client.sync();assert.equal(status.shared.length,1);assert.equal(status.assignedMode?.id,'assigned-mode');assert.equal(member.local.knowledge.length,0);assert.equal(member.local.modes.length,0);
    await assert.rejects(member.client.organization({action:'put-resource',orgId,entity:'knowledge',id:'forbidden-doc',expectedRevision:0,data:{title:'Denied',text:'No write permission.'}}),/admin|manager/);
    await assert.rejects(outsider.client.organization({action:'members',orgId}),/not found/i);
    const result=await member.client.organization({action:'resources',orgId});assert.equal(result.resources?.length,1);
    member.local.modes.push({id:'personal-mode',name:'Personal mode',instructions:'Use authorized shared context.',noteTemplate:'Summary',documentIds:['shared:knowledge:shared-doc']});await member.client.sync({uploads:[{entity:'mode',id:'personal-mode'}],confirmedUpload:true});const canonical=f.server.store.get("SELECT data FROM resources WHERE owner_id=? AND entity='mode' AND id='personal-mode'",member.client.status().user!.id);assert.deepEqual(JSON.parse(canonical!.data).documentIds,['shared-doc']);const otherMember=await f.desktop();await otherMember.client.login({email:'member@example.com',password});await otherMember.client.sync();assert.deepEqual(otherMember.local.modes.find(mode=>mode.id==='personal-mode')?.documentIds,['shared:knowledge:shared-doc']);
    await admin.client.organization({action:'policy',orgId,policy:{publicSharingAllowed:false,recordingAllowed:false,retentionDays:30}});await member.client.refresh();assert.equal(member.client.status().policy?.publicSharingAllowed,false);
    const team=await admin.client.organization({action:'create-team',orgId,name:'Renewals'});await admin.client.organization({action:'add-team-member',orgId,teamId:String(team.id),userId:member.client.status().user!.id,role:'member'});assert.equal((await member.client.organization({action:'teams',orgId})).teams?.length,1);
    await admin.client.organization({action:'remove-member',orgId,userId:member.client.status().user!.id});await member.client.refresh();assert.equal(member.client.status().shared.length,0);assert.equal(member.client.status().assignedMode,undefined);assert.equal(member.client.status().organizations.length,0);
  }finally{await f.close();}
});

test('desktop Google and Merge connector dispatch imports real HTTP fixture data, preserves secrets and confirms writeback',async()=>{
  let challenge='';let wrote=0;
  const provider=createServer(async(req,res)=>{const url=new URL(req.url||'/','http://fixture.invalid');const send=(value:unknown)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
    if(url.pathname==='/authorize'){challenge=url.searchParams.get('code_challenge')!;const callback=new URL(url.searchParams.get('redirect_uri')!);callback.searchParams.set('state',url.searchParams.get('state')!);callback.searchParams.set('code','google-code-fixture');res.writeHead(302,{Location:callback.href});res.end();return;}
    if(url.pathname==='/token'){const chunks:Buffer[]=[];for await(const part of req)chunks.push(Buffer.from(part));const params=new URLSearchParams(Buffer.concat(chunks).toString());assert.equal(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'),challenge);send({access_token:'google-access-secret',refresh_token:'google-refresh-secret',expires_in:3600,scope:'https://www.googleapis.com/auth/calendar.readonly'});return;}
    if(url.pathname==='/revoke'){send({});return;}
    if(url.pathname==='/calendar/v3/users/me/calendarList'){send({items:[{id:'primary',summary:'Work calendar',primary:true}]});return;}
    if(url.pathname==='/calendar/v3/calendars/primary/events'){send({items:[{id:'google-event',summary:'Customer renewal',start:{dateTime:'2026-10-20T09:00:00Z'},end:{dateTime:'2026-10-20T10:00:00Z'},attendees:[{email:'priya@example.com',displayName:'Priya'}],hangoutLink:'https://meet.google.com/fixture-call'}],nextSyncToken:'google-cursor'});return;}
    if(url.pathname==='/api/crm/v1/link-token'){send({link_token:'merge-link-secret',magic_link_url:'https://link.merge.dev/fixture'});return;}
    if(url.pathname==='/api/crm/v1/account-token/public-fixture'){send({account_token:'merge-account-secret',integration:{name:'CRM fixture'}});return;}
    if(url.pathname==='/api/crm/v1/account-details'){assert.equal(req.headers['x-account-token'],'merge-account-secret');send({id:'fixture-linked-account',integration:{name:'CRM fixture'}});return;}
    if(url.pathname==='/api/crm/v1/contacts'){send({results:[{id:'contact',name:'Priya',email_addresses:[{email_address:'priya@example.com'}],contact_url:'https://crm.example.com/contact/priya'}],next:null});return;}
    if(url.pathname==='/api/crm/v1/notes' && req.method==='POST'){wrote++;send({model:{id:'provider-note'}});return;}
    if(['/api/crm/v1/notes','/api/crm/v1/tasks','/api/crm/v1/engagements','/api/crm/v1/users'].includes(url.pathname)){send({results:[],next:null});return;}
    res.writeHead(404);res.end();
  });await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const providerOrigin=`http://127.0.0.1:${(provider.address() as {port:number}).port}`;const options:ConnectorOptions={encryptionKey:randomBytes(32).toString('base64'),testNetworkOrigins:[providerOrigin],google:{clientId:'google-client-fixture',tokenUrl:providerOrigin+'/token',revokeUrl:providerOrigin+'/revoke',calendarBaseUrl:providerOrigin+'/calendar/v3/'},merge:{apiKey:'merge-operator-fixture',baseUrl:providerOrigin+'/'}};const f=await fixture({extensions:[createConnectorExtension(options)],contextProviders:[createConnectorContextProvider(options)]});
  try{
    const desktop=await f.desktop([meeting('writeback','Reviewed meeting notes')]);await desktop.client.signup({email:'connector-admin@example.com',password});await assert.rejects(desktop.client.connector({action:'route-anywhere'} as any),/Unknown integration action/);const availability=await desktop.client.connector({action:'status'});assert.equal(availability.googleConfigured,true);const start=await desktop.client.connector({action:'google-start'});const authorization=new URL(start.authorizationUrl!);const browser=await fetch(providerOrigin+'/authorize'+authorization.search,{redirect:'manual'});const callback=await fetch(browser.headers.get('location')!);assert.equal(callback.status,200);const callbackData=await callback.json() as {connection:{id:string}};const googleId=callbackData.connection.id;await desktop.client.connector({action:'calendars',connectionId:googleId});await desktop.client.connector({action:'sync',connectionId:googleId});assert.equal(desktop.local.calendar.length,1);assert.equal(desktop.local.calendar[0].source?.provider,'google');assert.equal(desktop.local.calendar[0].attendees?.[0].email,'priya@example.com');assert.equal(desktop.local.sessions[0].id,'writeback');assert.equal(f.server.store.all("SELECT * FROM resources WHERE entity='meeting'").length,0);
    await desktop.client.connector({action:'select-calendars',connectionId:googleId,calendarIds:[]});assert.equal(desktop.local.calendar.length,0);await desktop.client.connector({action:'disconnect',connectionId:googleId,confirmed:true});
    const org=await desktop.client.organization({action:'create',name:'Connector organization'});const link=await desktop.client.connector({action:'merge-link',category:'crm',orgId:String(org.id)});assert.equal(link.hostedLinkUrl,'https://link.merge.dev/fixture');assert.equal('state' in link,false);assert.equal('linkToken' in link,false);const exchanged=await desktop.client.connector({action:'merge-exchange',publicToken:'public-fixture'});const mergeId=typeof exchanged.id==='string'?exchanged.id:exchanged.connection!.id;await desktop.client.connector({action:'sync',connectionId:mergeId});const matched=await desktop.client.connector({action:'match',connectionId:mergeId,email:'priya@example.com'});assert.equal(matched.matches?.length,1);assert.equal(desktop.client.status().connectedDocuments?.[0].sourceUrl,'https://crm.example.com/contact/priya');await desktop.client.connector({action:'import-person',connectionId:mergeId,recordId:'contact'});assert.equal(desktop.local.people?.[0].email,'priya@example.com');
    await assert.rejects(desktop.client.connector({action:'writeback-preview',connectionId:mergeId,meetingId:'writeback',targetId:'contact'}),/Sync this session/);await desktop.client.sync({uploads:[{entity:'meeting',id:'writeback'}],confirmedUpload:true});const stalePreview=await desktop.client.connector({action:'writeback-preview',connectionId:mergeId,meetingId:'writeback',targetId:'contact',includeActions:true});assert.equal(typeof stalePreview.previewToken,'string');desktop.local.sessions[0].actions=['An action added after preview'];await desktop.client.sync({uploads:[{entity:'meeting',id:'writeback'}],confirmedUpload:true});await assert.rejects(desktop.client.connector({action:'writeback',connectionId:mergeId,meetingId:'writeback',targetId:'contact',includeActions:true,confirmWriteback:true,idempotencyKey:'stale-preview',previewToken:stalePreview.previewToken!}),/preview|review|changed/i);assert.equal(desktop.client.status().errorCode,'preview_changed');assert.equal(wrote,0);assert.equal(f.server.store.all('SELECT * FROM connector_jobs').length,0);desktop.local.sessions[0].actions=[];await desktop.client.sync({uploads:[{entity:'meeting',id:'writeback'}],confirmedUpload:true});const preview=await desktop.client.connector({action:'writeback-preview',connectionId:mergeId,meetingId:'writeback',targetId:'contact'});assert.equal(preview.content,'Reviewed meeting notes');assert.equal(typeof preview.previewToken,'string');assert.equal(typeof preview.previewExpiresAt,'string');assert.equal(wrote,0);await assert.rejects(desktop.client.connector({action:'writeback',connectionId:mergeId,meetingId:'writeback',targetId:'contact',confirmWriteback:true,idempotencyKey:'no-preview',previewToken:''}),/Preview/i);const approvedWrite={action:'writeback' as const,connectionId:mergeId,meetingId:'writeback',targetId:'contact',confirmWriteback:true as const,idempotencyKey:'reviewed-writeback',previewToken:preview.previewToken!};const queued=await desktop.client.connector(approvedWrite);const repeated=await desktop.client.connector(approvedWrite);assert.equal(queued.group,repeated.group);assert.equal(f.server.store.all('SELECT * FROM connector_jobs').length,1);assert.equal(wrote,0);await desktop.client.connector({action:'run-jobs',connectionId:mergeId});assert.equal(wrote,1);const saved=await readFile(join(desktop.directory,'cloud.json'),'utf8');assert.equal(saved.includes(preview.previewToken!),false);assert.doesNotMatch(saved,/google-access-secret|google-refresh-secret|merge-link-secret|merge-account-secret/);assert.doesNotMatch(JSON.stringify(desktop.client.status()),/google-access-secret|google-refresh-secret|merge-link-secret|merge-account-secret/);await desktop.client.connector({action:'disconnect',connectionId:mergeId,confirmed:true});assert.equal(desktop.client.status().connectedDocuments?.length,0);
  }finally{await f.close();await new Promise<void>(resolve=>provider.close(()=>resolve()));}
});
