import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash,createHmac,generateKeyPairSync,randomBytes,sign } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWatsonServer } from '../src/app.ts';
import type { OidcProvider } from '../src/enterprise/sso.ts';
const dir=mkdtempSync(join(tmpdir(),'watson-enterprise-http-'));const password='Enterprise-Watson-password';const providers:OidcProvider[]=[];
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});const key={...publicKey.export({format:'jwk'}),kid:'enterprise-test-key',alg:'RS256',use:'sig'};
const codes=new Map<string,{nonce:string;challenge:string}>();const requests:{path:string;params:URLSearchParams}[]=[];
let providerOrigin:string,origin:string,app:ReturnType<typeof createWatsonServer>,admin:any,member:any,org:string,directoryToken:string,scimUser:string,scimGroup:string,customer:string;
let claimOverride:any={};
const fixture=createServer(async(req,res)=>{const path=new URL(req.url??'/',providerOrigin).pathname;const send=(json:unknown)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(json));};
  if(path==='/.well-known/openid-configuration'){send({issuer:providerOrigin,authorization_endpoint:providerOrigin+'/authorize',token_endpoint:providerOrigin+'/token',token_endpoint_auth_methods_supported:['client_secret_post'],jwks_uri:providerOrigin+'/jwks'});return;}
  if(path==='/jwks'){send({keys:[key]});return;}
  if(path==='/authorize'){const url=new URL(req.url!,providerOrigin),code=randomBytes(12).toString('hex');assert.equal(url.searchParams.get('code_challenge_method'),'S256');codes.set(code,{nonce:url.searchParams.get('nonce')!,challenge:url.searchParams.get('code_challenge')!});const back=new URL(url.searchParams.get('redirect_uri')!);back.searchParams.set('state',url.searchParams.get('state')!);back.searchParams.set('code',code);res.writeHead(302,{Location:back.toString()});res.end();return;}
  const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));const params=new URLSearchParams(Buffer.concat(chunks).toString('utf8'));requests.push({path,params});
  if(path==='/token'){const entry=codes.get(params.get('code')!);assert.ok(entry);assert.equal(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'),entry.challenge);assert.equal(params.get('client_secret'),'identity-fixture-secret');codes.delete(params.get('code')!);const header=Buffer.from(JSON.stringify({alg:'RS256',kid:key.kid})).toString('base64url');const claims=Buffer.from(JSON.stringify({iss:providerOrigin,aud:'watson-client',sub:'fixture-employee',email:'employee@corp.test',email_verified:true,name:'Enterprise Employee',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300,nonce:entry.nonce,...claimOverride})).toString('base64url');const sig=sign('sha256',Buffer.from(header+'.'+claims),privateKey).toString('base64url');send({id_token:header+'.'+claims+'.'+sig,access_token:'fixture-not-persisted'});return;}
  assert.equal(req.headers.authorization,'Bearer sk_test_fixture_only');assert.equal(req.headers['stripe-version'],'2026-09-30.endive');
  if(path==='/v1/customers'){send({id:'cus_'+params.get('metadata[watson_user_id]')});return;}
  if(path==='/v1/checkout/sessions'){send({id:'cs_fixture',url:providerOrigin+'/checkout/fixture'});return;}
  if(path==='/v1/billing_portal/sessions'){send({id:'bps_fixture',url:providerOrigin+'/portal/fixture'});return;}
  res.writeHead(404);res.end();
});
async function call(client:any,method:string,path:string,data?:unknown,status=200,extraHeaders:Record<string,string>={}){const response=await fetch(origin+'/api/v1/'+path,{method,headers:{...(client?{Authorization:'Bearer '+(typeof client==='string'?client:client.token)}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{}),...extraHeaders},body:data===undefined?undefined:JSON.stringify(data)});if(status===204){assert.equal(response.status,204);return;}const json=await response.json();assert.equal(response.status,status,JSON.stringify(json));return json;}
before(async()=>{await new Promise<void>(resolve=>fixture.listen(0,'127.0.0.1',resolve));const addr=fixture.address() as {port:number};providerOrigin='http://127.0.0.1:'+addr.port;app=createWatsonServer({dbPath:join(dir,'enterprise.sqlite'),port:0,sso:{providers,encryptionKey:randomBytes(32).toString('base64'),allowInsecureLoopback:true},billing:{secretKey:'sk_test_fixture_only',webhookSecret:'whsec_fixture_only',priceIds:['price_watson'],apiBase:providerOrigin+'/v1/',successUrl:providerOrigin+'/success',cancelUrl:providerOrigin+'/cancel',allowInsecureLoopback:true}});origin=await app.listen();admin=await call(null,'POST','auth/signup',{email:'admin@corp.test',password,name:'Enterprise Admin'},201);member=await call(null,'POST','auth/signup',{email:'member@corp.test',password,name:'Org member'},201);org=(await call(admin,'POST','organizations',{name:'Enterprise'},201)).id;await call(admin,'POST',`organizations/${org}/members`,{email:member.user.email},201);providers.push({id:'enterprise-oidc',orgId:org,issuer:providerOrigin,clientId:'watson-client',clientSecret:'identity-fixture-secret',domains:['corp.test'],autoProvision:true});});
after(async()=>{await app.close();await new Promise<void>(resolve=>fixture.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});});

test('OIDC performs real HTTP discovery/code/PKCE/JWKS verification and encrypted one-time handoff',async()=>{
  const metadata=await call(admin,'GET',`organizations/${org}/sso`);assert.equal(metadata.configured,true);assert.equal('clientSecret' in metadata.providers[0],false);await call(member,'GET',`organizations/${org}/sso`,undefined,403);
  const start=await call(null,'POST','auth/sso/start',{providerId:'enterprise-oidc',deviceName:'SSO desktop'});await call(null,'POST','auth/sso/poll',{requestId:start.requestId,requestSecret:start.requestSecret},202);await call(null,'POST','auth/sso/poll',{requestId:start.requestId,requestSecret:'wrong'},404);
  const authorized=await fetch(start.authorizationUrl,{redirect:'manual'});assert.equal(authorized.status,302);const callback=await fetch(authorized.headers.get('Location')!);assert.equal(callback.status,200);const html=await callback.text();assert.ok(html.includes('Return to Watson'));assert.ok(!html.includes('token'));
  const result=await call(null,'POST','auth/sso/poll',{requestId:start.requestId,requestSecret:start.requestSecret});assert.equal(result.user.email,'employee@corp.test');assert.equal((await call(result,'GET','me')).organizations[0].id,org);await call(null,'POST','auth/sso/poll',{requestId:start.requestId,requestSecret:start.requestSecret},404);
  const replay=await fetch(authorized.headers.get('Location')!);assert.equal(replay.status,400);assert.ok(app.store.get('SELECT user_id FROM sso_identities WHERE subject=?','fixture-employee'));
});

test('OIDC refuses wrong nonce/unverified email/audience and accepts no arbitrary endpoint in request',async()=>{
  for(const override of [{nonce:'wrong'},{email_verified:false},{aud:'other-app'}]){claimOverride=override;const start=await call(null,'POST','auth/sso/start',{providerId:'enterprise-oidc'});const authorized=await fetch(start.authorizationUrl,{redirect:'manual'});const callback=await fetch(authorized.headers.get('Location')!);assert.equal(callback.status,401);}
  claimOverride={};await call(null,'POST','auth/sso/start',{providerId:'unknown',issuer:'http://arbitrary'},404);
  const rows=app.store.all('SELECT encrypted,result FROM sso_requests');assert.ok(rows.every(r=>!r.encrypted.includes('identity-fixture-secret')&&!r.encrypted.includes('nonce')));
});

test('SCIM organization token rotation, tenant isolation and user create/filter/PATCH/deactivation revoke workspace access',async()=>{
  await call(member,'POST',`organizations/${org}/directory/token`,{},403);const issued=await call(admin,'POST',`organizations/${org}/directory/token`,{},201);directoryToken=issued.token;const scim=`scim/v2/${org}`;
  const config=await call(directoryToken,'GET',scim+'/ServiceProviderConfig');assert.equal(config.patch.supported,true);assert.equal(config.bulk.supported,false);
  const user=await call(directoryToken,'POST',scim+'/Users',{schemas:['urn:ietf:params:scim:schemas:core:2.0:User'],userName:'directory@corp.test',displayName:'Directory User',externalId:'idp-employee-42',active:true},201);scimUser=user.id;assert.equal(user.active,true);
  const list=await call(directoryToken,'GET',scim+'/Users?filter='+encodeURIComponent('userName eq "directory@corp.test"'));assert.equal(list.totalResults,1);assert.equal(list.Resources[0].id,scimUser);await call(directoryToken,'GET',`scim/v2/not-my-org/Users`,undefined,401);
  const updated=await call(directoryToken,'PATCH',scim+'/Users/'+scimUser,{schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations:[{op:'replace',path:'displayName',value:'Renamed User'}]});assert.equal(updated.displayName,'Renamed User');
  const ownToken=app.store.issue(app.store.get('SELECT * FROM users WHERE id=?',scimUser)!,'Provisioned device');assert.ok((await call(ownToken,'GET','me')).organizations.some((o:any)=>o.id===org));
  const inactive=await call(directoryToken,'PATCH',scim+'/Users/'+scimUser,{Operations:[{op:'replace',path:'active',value:false}]});assert.equal(inactive.active,false);await call(ownToken,'GET','me',undefined,401);assert.equal(app.store.get('SELECT user_id FROM org_members WHERE org_id=? AND user_id=?',org,scimUser),undefined);
  await call(directoryToken,'PATCH',scim+'/Users/'+scimUser,{Operations:[{op:'replace',path:'active',value:true}]});const rotated=await call(admin,'POST',`organizations/${org}/directory/token`,{},201);await call(directoryToken,'GET',scim+'/Users',undefined,401);directoryToken=rotated.token;
  const stored=app.store.get('SELECT token_hash FROM directory_tokens WHERE org_id=?',org)!;assert.notEqual(stored.token_hash,directoryToken);
});

test('SCIM groups create actual teams, patch multi-user memberships and preserve last organization admin',async()=>{
  const scim=`scim/v2/${org}`;const second=await call(directoryToken,'POST',scim+'/Users',{userName:'second-directory@corp.test',displayName:'Second directory',active:true},201);
  const group=await call(directoryToken,'POST',scim+'/Groups',{displayName:'Identity provider team',members:[{value:scimUser}]},201);scimGroup=group.id;assert.equal(group.members.length,1);
  const added=await call(directoryToken,'PATCH',scim+'/Groups/'+scimGroup,{Operations:[{op:'add',path:'members',value:[{value:second.id}]}]});assert.equal(added.members.length,2);
  const removed=await call(directoryToken,'PATCH',scim+'/Groups/'+scimGroup,{Operations:[{op:'remove',path:`members[value eq "${scimUser}"]`}]});assert.equal(removed.members.length,1);assert.equal(removed.members[0].value,second.id);
  await call(directoryToken,'POST',scim+'/Users',{userName:admin.user.email,displayName:'Admin',active:true},201);await call(directoryToken,'PATCH',scim+'/Users/'+admin.user.id,{Operations:[{op:'replace',path:'active',value:false}]},409);
  await call(directoryToken,'DELETE',scim+'/Users/'+second.id,undefined,204);assert.equal((await call(directoryToken,'GET',scim+'/Groups/'+scimGroup)).members.length,0);
});

async function webhook(event:any,secret='whsec_fixture_only',timestamp=Math.floor(Date.now()/1000),status=200){const raw=JSON.stringify(event),sig=createHmac('sha256',secret).update(timestamp+'.'+raw).digest('hex');const response=await fetch(origin+'/api/v1/billing/webhook',{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':`t=${timestamp},v1=${sig}`},body:raw});const json=await response.json();assert.equal(response.status,status,JSON.stringify(json));return json;}
test('Stripe checkout/portal requests use configured prices and own customer; entitlement uses verified webhooks only',async()=>{
  const before=await call(member,'GET','billing');assert.equal(before.entitled,false);await call(member,'POST','billing/checkout',{priceId:'arbitrary-price'},400);
  const checkout=await call(member,'POST','billing/checkout',{priceId:'price_watson',seats:2},201);assert.ok(checkout.url.includes('/checkout/'));const submitted=requests.find(r=>r.path==='/v1/checkout/sessions')!;assert.equal(submitted.params.get('line_items[0][price]'),'price_watson');assert.equal(submitted.params.get('line_items[0][quantity]'),'2');assert.equal(submitted.params.get('client_reference_id'),member.user.id);customer=submitted.params.get('customer')!;
  const event={id:'evt_subscription',type:'customer.subscription.updated',data:{object:{id:'sub_fixture',customer,status:'active',items:{data:[{price:{id:'price_watson'},quantity:2}]},current_period_end:Math.floor(Date.now()/1000)+86400}}};await webhook(event,'bad-signature',undefined,401);assert.equal((await call(member,'GET','billing')).entitled,false);await webhook(event);const paid=await call(member,'GET','billing');assert.equal(paid.entitled,true);assert.equal(paid.subscription.seats,2);assert.equal((await call(admin,'GET','billing')).entitled,false);assert.equal((await webhook(event)).duplicate,true);
  await webhook({id:'evt_invoice',type:'invoice.paid',data:{object:{id:'in_fixture',customer,amount_paid:5000,currency:'usd'}}});assert.equal((await call(member,'GET','billing')).invoices[0].amount,5000);const portal=await call(member,'POST','billing/portal',{},201);assert.ok(portal.url.includes('/portal/'));
  await webhook({id:'evt_cancel',type:'customer.subscription.deleted',data:{object:{id:'sub_fixture',customer,status:'canceled',items:{data:[{price:{id:'price_watson'},quantity:2}]}}}});assert.equal((await call(member,'GET','billing')).entitled,false);
  await webhook({id:'evt_stale',type:'invoice.paid',data:{object:{id:'in_stale',customer}}},'whsec_fixture_only',Math.floor(Date.now()/1000)-301,401);
});

test('Readable public share HTML escapes user markup and shares exact revocation with JSON endpoint',async()=>{
  const id='html-meeting';const meeting={id,title:'<script>window.evil=1</script>',startedAt:new Date().toISOString(),notes:'<img src=x onerror=alert(1)>',transcript:[],answers:[],actions:['Call customer'],followupDraft:'Thanks'};await call(admin,'POST','meetings',{meeting},201);const shared=await call(admin,'POST','meetings/'+id+'/share',{},201);const page=await fetch(shared.viewerUrl);assert.equal(page.status,200);assert.match(page.headers.get('Content-Type')!,/^text\/html/);const html=await page.text();assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;img'));assert.ok(html.includes('Call customer'));await call(admin,'DELETE','meetings/'+id+'/share');assert.equal((await fetch(shared.viewerUrl)).status,404);
});

test('OIDC cannot silently link an existing password account by email; authenticated link is required',async()=>{
  claimOverride={sub:'member-link-subject',email:member.user.email};const begin=async(client:any)=>{const start=await call(client,'POST','auth/sso/start',{providerId:'enterprise-oidc'});const authorized=await fetch(start.authorizationUrl,{redirect:'manual'});return {start,callback:authorized.headers.get('Location')!};};
  const unauthenticated=await begin(null);assert.equal((await fetch(unauthenticated.callback)).status,403);
  const authenticated=await begin(member);assert.equal((await fetch(authenticated.callback)).status,200);const signed=await call(null,'POST','auth/sso/poll',{requestId:authenticated.start.requestId,requestSecret:authenticated.start.requestSecret});assert.equal(signed.user.id,member.user.id);claimOverride={};
});

test('configured SSO user role maps to a default team/prompt once and preserves later manual assignments',async()=>{
  const team=(await call(admin,'POST',`organizations/${org}/teams`,{name:'Default Sales'},201)).id,other=(await call(admin,'POST',`organizations/${org}/teams`,{name:'Custom Team'},201)).id;
  const prompt='default-role-prompt',custom='custom-manual-prompt';await call(admin,'POST','resources/mode',{data:{id:prompt,name:'Default sales',instructions:'Default coaching'},scope:'team',orgId:org,teamId:team},201);await call(admin,'POST','resources/mode',{data:{id:custom,name:'Custom sales',instructions:'Custom coaching'},scope:'team',orgId:org,teamId:other},201);
  providers[0].roleClaim='user_role';providers[0].roleTeams={sales_rep:{teamId:team,modeId:prompt}};claimOverride={sub:'role-default-user',email:'role-default@corp.test',user_role:'sales_rep'};
  const login=async()=>{const started=await call(null,'POST','auth/sso/start',{providerId:'enterprise-oidc'});const authorization=await fetch(started.authorizationUrl,{redirect:'manual'});assert.equal((await fetch(authorization.headers.get('Location')!)).status,200);return call(null,'POST','auth/sso/poll',{requestId:started.requestId,requestSecret:started.requestSecret});};
  const first=await login();assert.equal((await call(first,'GET','assigned-mode')).mode.id,prompt);await call(admin,'POST',`organizations/${org}/teams/${other}/members`,{userId:first.user.id},201);await call(admin,'PUT',`organizations/${org}/assignments/${first.user.id}`,{modeId:custom});const again=await login();assert.equal((await call(again,'GET','assigned-mode')).mode.id,custom);assert.equal((await call(again,'GET',`organizations/${org}/teams`)).teams.length,2);claimOverride={};
});
