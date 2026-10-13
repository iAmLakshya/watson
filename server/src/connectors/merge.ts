import { ApiError, bool, fail, hash, integer, now, object, opaque, rejectSecrets, str, uuid, type Principal, type Row } from '../core.ts';
import { ConnectorStorage } from './storage.ts';
import { approvedEndpoint, provider, ProviderError } from './transport.ts';
import type { Connection } from './types.ts';

const origins=['https://api.merge.dev','https://api-eu.merge.dev','https://api-apac.merge.dev'];
const readKinds={crm:['contacts','notes','engagements','tasks','users'],ats:['candidates','activities','users']} as const;
const safeString=(value:unknown,max=100000)=>typeof value==='string'?value.slice(0,max):'';
function pathValue(raw:Row,path:string):unknown {let value:unknown=raw;for(const key of path.split('.')){if(['__proto__','constructor','prototype'].includes(key))return undefined;value=value&&typeof value==='object'?(value as Row)[key]:undefined;}return value;}
function emails(raw:Row) {return (Array.isArray(raw.email_addresses)?raw.email_addresses:[]).map((e:unknown)=>typeof e==='string'?e:(e as Row)?.email_address??(e as Row)?.value).filter((e:unknown)=>typeof e==='string').map((e:string)=>e.toLowerCase().slice(0,254));}

export class MergeConnector {
  private db:ConnectorStorage;
  constructor(db:ConnectorStorage) {this.db=db;}
  private config() {this.db.requireKey();const config=this.db.options.merge;if(!config?.apiKey)fail(503,'merge_not_configured','The server needs WATSON_MERGE_API_KEY before connecting CRM or ATS.');return config;}
  private category(value:unknown) {if(value!=='crm'&&value!=='ats')fail(400,'invalid_category','Merge category must be crm or ats.');return value;}
  private base(category:string) {const c=this.config();const base=approvedEndpoint(c.baseUrl??'https://api.merge.dev/',origins,this.db.options);return new URL(`api/${category}/v1/`,base);}
  private async request(category:string,path:string,accountToken?:string,body?:Row,method?:string) {
    const config=this.config(),base=this.base(category),url=new URL(path,base);
    if(url.origin!==base.origin||!url.pathname.startsWith(base.pathname))fail(502,'provider_pagination_invalid','Merge pagination left its approved API path.');
    return (await provider(url,{method:method??(body?'POST':'GET'),headers:{Authorization:`Bearer ${config.apiKey}`,...(accountToken?{'X-Account-Token':accountToken}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})})).data;
  }
  async link(user:Principal,input:Row) {
    const category=this.category(input.category),orgId=str(input.orgId,'orgId',128);this.db.store.orgManage(user.id,orgId,true);if(input.teamId){const t=this.db.store.team(user.id,str(input.teamId,'teamId',128),true);if(t.org_id!==orgId)fail(400,'invalid_scope','Team belongs to another organization.');}
    const org=this.db.store.get('SELECT name FROM organizations WHERE id=?',orgId)!;const state=uuid(),digest=hash(state),expiresAt=this.db.time()+30*60*1000;
    const response=await this.request(category,'link-token',undefined,{end_user_email_address:user.email.slice(0,100),end_user_organization_name:org.name.slice(0,100),end_user_origin_id:`${orgId}:${category}:${state}`.slice(0,100),categories:[category],should_create_magic_link_url:true,link_expiry_mins:30});
    this.db.store.run('INSERT INTO connector_oauth_states VALUES(?,?,?,?,?)',digest,user.id,'merge',expiresAt,this.db.encrypt({category,orgId,teamId:input.teamId??null,label:input.label??category},`oauth:${digest}:${user.id}`));
    let hostedLinkUrl:string|undefined;if(response.magic_link_url){const url=new URL(response.magic_link_url);if(url.origin!=='https://link.merge.dev'&&!this.db.options.testNetworkOrigins?.includes(url.origin))fail(502,'provider_invalid_response','Merge returned an unapproved linking URL.');hostedLinkUrl=url.href;}
    return {linkToken:str(response.link_token,'provider.link_token',4096),...(hostedLinkUrl?{hostedLinkUrl}:{}),state,expiresAt:new Date(expiresAt).toISOString()};
  }
  async exchange(user:Principal,input:Row) {
    const digest=hash(str(input.state,'state',512)),row=this.db.store.get("SELECT * FROM connector_oauth_states WHERE state_hash=? AND provider='merge' AND user_id=?",digest,user.id);
    if(!row||row.expires_at<=this.db.time())fail(400,'oauth_state_invalid','The Merge linking flow expired. Start again.');
    const pending=this.db.decrypt<Row>(row.encrypted,`oauth:${digest}:${user.id}`);this.db.store.orgManage(user.id,pending.orgId,true);
    this.db.store.run('DELETE FROM connector_oauth_states WHERE state_hash=?',digest);
    const token=await this.request(pending.category,`account-token/${encodeURIComponent(str(input.publicToken,'publicToken',4096))}`);
    return this.connect(user,{...pending,accountToken:token.account_token,label:token.integration?.name??pending.label});
  }
  async connect(user:Principal,input:Row) {
    const category=this.category(input.category);this.config();const orgId=str(input.orgId,'orgId',128);this.db.store.orgManage(user.id,orgId,true);
    if(input.teamId){const team=this.db.store.team(user.id,str(input.teamId,'teamId',128),true);if(team.org_id!==orgId)fail(400,'invalid_scope','Team belongs to another organization.');}
    const accountToken=str(input.accountToken,'accountToken',16384);const details=await this.request(category,'account-details',accountToken);
    // An operator can enter a token copied from their Merge dashboard; no remote writes happen here.
    const c=this.db.create(user,'merge',category,{orgId,...(input.teamId?{teamId:input.teamId}:{}),label:input.label??details.integration?.name??`Merge ${category.toUpperCase()}`,settings:{autoSync:false,syncIntervalMinutes:60,nextSyncAt:0,mappings:{},...(details.id?{linkedAccountId:safeString(details.id,128)}:{})}});
    this.db.saveCredential(c.id,{accountToken});return this.db.public(c);
  }
  private normalized(c:Connection,kind:string,raw:Row):Row {
    const mappings=c.settings.mappings??{};const name=safeString(pathValue(raw,mappings.name??'name'),1000)||[raw.first_name,raw.last_name].filter(Boolean).join(' ').slice(0,1000);
    const rawEmail=mappings.email?pathValue(raw,mappings.email):undefined;
    const emailList=rawEmail?[safeString(rawEmail,254).toLowerCase()]:emails(raw);
    const content=safeString(pathValue(raw,mappings.text??(kind==='notes'||kind==='tasks'?'content':'body')));
    const nameTitle=name||safeString(raw.subject,1000)||kind;
    const contact=typeof raw.contact==='string'?raw.contact:raw.contact?.id;const candidate=typeof raw.candidate==='string'?raw.candidate:raw.candidate?.id;
    const rawUrl=raw.contact_url??raw.candidate_url??raw.note_url??raw.task_url;let sourceUrl:string|undefined;try{const u=new URL(rawUrl);if(u.protocol==='https:')sourceUrl=u.href;}catch{}
    const text=[nameTitle,...emailList,content,safeString(raw.company,1000),safeString(raw.title,1000),safeString(raw.remote_created_at,100)].filter(Boolean).join('\n');
    return {id:str(raw.id,'provider.record.id',2000),kind,name:nameTitle,emails:emailList,text,content,...(contact?{contactId:contact}:{}),...(candidate?{candidateId:candidate}:{}),...(sourceUrl?{sourceUrl}:{}),remoteId:safeString(raw.remote_id,2000),modifiedAt:safeString(raw.modified_at,100),deleted:raw.remote_was_deleted===true};
  }
  async sync(c:Connection,forceFull=false) {
    const token=this.db.credential(c.id).accountToken;if(!token)fail(409,'reconnect_required','Reconnect Merge.');
    const kinds=readKinds[this.category(c.category)];let imported=0,removed=0;
    for(const kind of kinds){const previous=this.db.store.get('SELECT watermark FROM connector_cursors WHERE connection_id=? AND kind=?',c.id,kind)?.watermark;
      const started=new Date(this.db.time()-1000).toISOString();let path=`${kind}?page_size=100&include_deleted_data=true${previous&&!forceFull?`&modified_after=${encodeURIComponent(previous)}`:''}`;const rows:Row[]=[];const seen=new Set<string>();
      while(path){if(seen.has(path)||seen.size>=200)fail(502,'provider_pagination_invalid','Merge pagination did not finish.');seen.add(path);const page=await this.request(c.category,path,token);if(!Array.isArray(page.results))fail(502,'provider_invalid_response','Merge returned an invalid record list.');rows.push(...page.results.map((raw:Row)=>this.normalized(c,kind,raw)));if(page.next!==null&&page.next!==undefined&&typeof page.next!=='string')fail(502,'provider_pagination_invalid','Merge cursor is invalid.');path=page.next??'';}
      this.db.store.transaction(()=>{const present=new Set(rows.map(r=>r.id));if(!previous||forceFull)for(const old of this.db.records(c,kind))if(!present.has(old.remote_id)){if(old.resource_id)this.db.removeResource(c,old.resource_id);this.db.store.run('DELETE FROM connector_records WHERE connection_id=? AND kind=? AND remote_id=?',c.id,kind,old.remote_id);removed++;}
        for(const row of rows){const old=this.db.store.get('SELECT resource_id FROM connector_records WHERE connection_id=? AND kind=? AND remote_id=?',c.id,kind,row.id);if(row.deleted){if(old?.resource_id)this.db.removeResource(c,old.resource_id);this.db.store.run('DELETE FROM connector_records WHERE connection_id=? AND kind=? AND remote_id=?',c.id,kind,row.id);removed++;continue;}
          // CRM people and activities are retrieved through connector scope checks, never duplicated into personal cloud knowledge.
          this.db.record(c,kind,row.id,row);imported++;
        }this.db.store.run('INSERT INTO connector_cursors VALUES(?,?,?) ON CONFLICT(connection_id,kind) DO UPDATE SET watermark=excluded.watermark',c.id,kind,started);
      });
    }this.db.saveSettings(c,{...c.settings,nextSyncAt:this.db.time()+Number(c.settings.syncIntervalMinutes??60)*60000});this.db.store.run("UPDATE connector_connections SET last_sync=?,status='connected',last_error=NULL WHERE id=?",now(),c.id);return {imported,removed};
  }
  configure(c:Connection,input:Row) {
    const settings={...c.settings};if(input.syncIntervalMinutes!==undefined)settings.syncIntervalMinutes=integer(input.syncIntervalMinutes,'syncIntervalMinutes',5,10080);
    if(input.autoSync!==undefined)settings.autoSync=bool(input.autoSync,'autoSync');
    if(input.mappings!==undefined){const mappings=object(input.mappings);for(const [key,value] of Object.entries(mappings)){if(!['name','email','text'].includes(key)||typeof value!=='string'||!/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*){0,5}$/.test(value)||value.split('.').some(p=>['__proto__','constructor','prototype'].includes(p)))fail(400,'invalid_mapping','Mappings accept name, email, and text paths from imported provider fields.');}settings.mappings=mappings;}
    if(input.remoteUserId!==undefined)settings.remoteUserId=str(input.remoteUserId,'remoteUserId',2000);
    this.db.saveSettings(c,settings);return this.db.public(c);
  }
  records(c:Connection,query:string,kind?:string) {if(kind&&!readKinds[this.category(c.category)].includes(kind as never))fail(400,'invalid_kind','Unknown Merge model.');return this.db.records(c,kind).map(r=>r.data).filter(r=>!query||r.text.toLowerCase().includes(query.toLowerCase()));}
  match(c:Connection,email:string) {
    const people=this.records(c,'',c.category==='crm'?'contacts':'candidates').filter(p=>p.emails.includes(email.toLowerCase()));
    return people.map(person=>({person,activities:this.records(c,'').filter(r=>r.contactId===person.id||r.candidateId===person.id)}));
  }
  async health(c:Connection) {const token=this.db.credential(c.id).accountToken;const status=await this.request(c.category,'sync-status',token);const issues=await this.request(c.category,'issues?page_size=100',token);return {sync:status,issues};}
  async fieldMappings(c:Connection) {return await this.request(c.category,'field-mappings',this.db.credential(c.id).accountToken);}
  async fields(c:Connection,kind:'remote-fields'|'target-fields') {return await this.request(c.category,kind,this.db.credential(c.id).accountToken);}
  async changeFieldMapping(c:Connection,input:Row,method:'POST'|'PATCH'|'DELETE',id?:string) {
    if(input.confirmMappingChange!==true)fail(400,'mapping_confirmation_required','Confirm the mapping change before modifying this linked account.');
    const raw=input.mapping===undefined?{}:object(input.mapping);rejectSecrets(raw);const fields=method==='POST'?['remote_field_traversal_path','remote_method','remote_url_path','common_model_name','target_field_name','target_field_description','jmes_path','advanced_mapping_expression']:['remote_field_traversal_path','remote_method','remote_url_path','jmes_path','advanced_mapping_expression'];
    for(const key of Object.keys(raw))if(!fields.includes(key))fail(400,'invalid_mapping','Unknown remote mapping field.');
    const mapping:Row={};for(const [key,value] of Object.entries(raw)){if(key==='remote_field_traversal_path'){if(!Array.isArray(value)||value.length>20||value.some(p=>!(typeof p==='string'&&p.length<200||Number.isSafeInteger(p))))fail(400,'invalid_mapping','Field traversal must contain at most 20 names or indexes.');mapping[key]=value;}else mapping[key]=str(value,key,4000);}
    if(method==='POST')for(const key of ['remote_field_traversal_path','remote_method','remote_url_path','common_model_name'])if(mapping[key]===undefined)fail(400,'invalid_mapping',`Remote mappings require ${key}.`);
    if(mapping.remote_url_path&&!mapping.remote_url_path.startsWith('/'))fail(400,'invalid_mapping','A remote endpoint path must start with /.');
    const response=await this.request(c.category,id?`field-mappings/${encodeURIComponent(str(id,'mappingId',128))}`:'field-mappings',this.db.credential(c.id).accountToken,method==='DELETE'?undefined:mapping,method);
    if(response.errors?.length)throw new ProviderError(502,'provider_rejected');
    // Merge remaps at its next provider sync; reset local modified_after cursors for the next full import.
    this.db.store.run('DELETE FROM connector_cursors WHERE connection_id=?',c.id);this.db.saveSettings(c,{...c.settings,nextSyncAt:0});return response;
  }
  private snapshot(user:Principal,c:Connection,input:Row) {
    const targetId=str(input.targetId,'targetId',2000),targetKind=c.category==='crm'?'contacts':'candidates';
    const target=this.db.store.get('SELECT data FROM connector_records WHERE connection_id=? AND kind=? AND remote_id=?',c.id,targetKind,targetId);if(!target)fail(404,'not_found','Import and select a contact or candidate before writeback.');
    const meetingId=str(input.meetingId,'meetingId',128),meeting=this.db.store.resource(user.id,'meeting',meetingId);const data=JSON.parse(meeting.data);
    const includeActions=input.includeActions===true;
    const content=str(input.notes??data.notes,'notes',100000);let actions:string[]=[];
    if(includeActions){if(!Array.isArray(data.actions)||data.actions.length>100)fail(400,'invalid_actions','Meeting actions are invalid.');actions=data.actions.map((x:unknown)=>typeof x==='string'?str(x,'action',4000):str(object(x).text??object(x).title,'action',4000));}
    const remoteUserId=c.category==='ats'?str(input.remoteUserId??c.settings.remoteUserId,'remoteUserId',2000):undefined;
    return {targetId,targetName:JSON.parse(target.data).name,meetingId,title:safeString(data.title,1000),content,actions,...(remoteUserId?{remoteUserId}:{})};
  }
  private fingerprint(user:Principal,c:Connection,snapshot:Row) {return hash(JSON.stringify({author:user.id,connectionId:c.id,category:c.category,orgId:c.org_id,teamId:c.team_id,snapshot}));}
  preview(user:Principal,c:Connection,input:Row) {
    return this.db.store.transaction(()=>{
      const current=this.db.connection(user,c.id,true),snapshot=this.snapshot(user,current,input);rejectSecrets(snapshot);
      const token=opaque(),tokenHash=hash(token),expiresAt=this.db.time()+10*60000;
      this.db.store.run('DELETE FROM connector_previews WHERE expires_at<=?',this.db.time());
      this.db.store.run('INSERT INTO connector_previews VALUES(?,?,?,?,?,?,NULL,?)',tokenHash,c.id,user.id,this.fingerprint(user,current,snapshot),this.db.encrypt(snapshot,`preview:${tokenHash}:${user.id}:${c.id}`),expiresAt,now());
      return {...snapshot,previewToken:token,previewExpiresAt:new Date(expiresAt).toISOString()};
    });
  }
  enqueue(user:Principal,c:Connection,input:Row) {
    if(input.confirmWriteback!==true)fail(400,'writeback_confirmation_required','Confirm the displayed notes and destination before writing to CRM or ATS.');
    if(typeof input.previewToken!=='string'||!input.previewToken)fail(400,'preview_required','Review the exact destination, notes, and actions before approving writeback.');
    const tokenHash=hash(str(input.previewToken,'previewToken',512)),key=str(input.idempotencyKey,'idempotencyKey',200);
    return this.db.store.transaction(()=>{
    // Read permissions, source data, approval, and job state under one write lock: no concurrent meeting edit can interleave.
    c=this.db.connection(user,c.id,true);
    const approved=this.db.store.get('SELECT * FROM connector_previews WHERE token_hash=? AND connection_id=? AND requested_by=?',tokenHash,c.id,user.id);
    if(!approved||approved.expires_at<=this.db.time()||approved.consumed_key&&approved.consumed_key!==key)fail(409,'preview_invalid','This approval expired or was already used. Review the writeback again.');
    const current=this.snapshot(user,c,input),fingerprint=this.fingerprint(user,c,current);
    if(fingerprint!==approved.fingerprint)fail(409,'preview_changed','The destination or meeting content changed after the preview. Review the updated notes and actions before approving.');
    const preview=this.db.decrypt<Row>(approved.encrypted,`preview:${tokenHash}:${user.id}:${c.id}`);rejectSecrets(preview);
    const previous=this.db.store.get('SELECT * FROM connector_jobs WHERE connection_id=? AND (idempotency_key=? OR idempotency_key=?)',c.id,`request:${key}`,key);if(previous){if(previous.payload_hash!==fingerprint||previous.requested_by!==user.id)fail(409,'idempotency_reused','This writeback ID was already used for different notes or an author.');const payload=this.db.decrypt<Row>(previous.encrypted,`job:${previous.id}:${c.id}`);const grouped=this.db.store.all('SELECT * FROM connector_jobs WHERE connection_id=? ORDER BY created_at',c.id).filter(row=>this.db.decrypt<Row>(row.encrypted,`job:${row.id}:${c.id}`).group===payload.group);this.db.store.run('UPDATE connector_previews SET consumed_key=? WHERE token_hash=?',key,tokenHash);return {group:payload.group,jobs:grouped.map(row=>this.job(row))};}
    if(approved.consumed_key)fail(409,'preview_invalid','This approval was already used. Review the writeback again.');
    const noteModel=c.category==='crm'?{content:preview.content,contact:preview.targetId}:{activity_type:'NOTE',subject:preview.title,body:[preview.content,...preview.actions.map((a:string)=>`Action: ${a}`)].join('\n'),candidate:preview.targetId,visibility:'PRIVATE'};
    const requests:{path:string;body:Row}[]=[{path:c.category==='crm'?'notes':'activities',body:{model:noteModel,...(preview.remoteUserId?{remote_user_id:preview.remoteUserId}:{})}}];
    if(c.category==='crm')for(const action of preview.actions)requests.push({path:'tasks',body:{model:{subject:action,content:`From Watson meeting: ${preview.title}`,contact:preview.targetId,status:'OPEN'}}});
    const group=uuid(),jobs:Row[]=[];this.db.store.run('UPDATE connector_previews SET consumed_key=? WHERE token_hash=?',key,tokenHash);for(let i=0;i<requests.length;i++){const id=i===0?group:uuid(),jobKey=i===0?`request:${key}`:`child:${id}`;this.db.store.run('INSERT INTO connector_jobs(id,connection_id,requested_by,idempotency_key,payload_hash,encrypted,status,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',id,c.id,user.id,jobKey,i===0?fingerprint:hash(JSON.stringify(requests[i])),this.db.encrypt({group,...requests[i]},`job:${id}:${c.id}`),'queued',this.db.time(),now(),now());jobs.push(this.job(this.db.store.get('SELECT * FROM connector_jobs WHERE id=?',id)!));}this.db.store.audit(c.org_id!,user.id,'connector.writeback.authorized',`${c.id}:${group}`);return {group,jobs};
    });
  }
  job(row:Row) {return {id:row.id,connectionId:row.connection_id,status:row.status,attempts:row.attempts,dueAt:new Date(row.due_at).toISOString(),remoteId:row.remote_id,lastError:row.last_error,createdAt:row.created_at,updatedAt:row.updated_at};}
  jobs(c:Connection) {return this.db.store.all('SELECT * FROM connector_jobs WHERE connection_id=? ORDER BY created_at',c.id).map(r=>this.job(r));}
  retry(c:Connection,id:string,input:Row) {const row=this.db.store.get('SELECT * FROM connector_jobs WHERE id=? AND connection_id=?',id,c.id);if(!row)fail(404,'not_found','Writeback job not found.');if(['succeeded','running'].includes(row.status))fail(409,'job_not_retryable','This job cannot be retried.');if(row.status==='uncertain'&&input.confirmPossibleDuplicate!==true)fail(400,'duplicate_confirmation_required','The previous response was lost. Confirm possible duplicate creation before retrying.');this.db.store.run("UPDATE connector_jobs SET status='queued',due_at=?,last_error=NULL,updated_at=? WHERE id=?",this.db.time(),now(),id);return this.job(this.db.store.get('SELECT * FROM connector_jobs WHERE id=?',id)!);}
  async runJobs(c:Connection) {
    const rows=this.db.store.all("SELECT * FROM connector_jobs WHERE connection_id=? AND status IN('queued','retry') AND due_at<=? ORDER BY created_at LIMIT 100",c.id,this.db.time());
    for(const row of rows){const requester=this.db.store.get('SELECT id,email,name FROM users WHERE id=?',row.requested_by);if(!requester)continue;
      try{this.db.can({...requester,deviceId:'',tokenHash:''} as Principal,c,true);}catch{this.db.store.run("UPDATE connector_jobs SET status='failed',last_error='authorization_revoked',updated_at=? WHERE id=?",now(),row.id);continue;}
      const payload=this.db.decrypt<Row>(row.encrypted,`job:${row.id}:${c.id}`);const attempts=row.attempts+1;this.db.store.run("UPDATE connector_jobs SET status='running',attempts=?,updated_at=? WHERE id=?",attempts,now(),row.id);
      try{const response=await this.request(c.category,payload.path,this.db.credential(c.id).accountToken,payload.body);if(response.errors?.length)throw new ProviderError(502,'provider_rejected');if(!response.model?.id)throw new ProviderError(502,'writeback_response_uncertain');
        this.db.store.run("UPDATE connector_jobs SET status='succeeded',remote_id=?,last_error=NULL,updated_at=? WHERE id=?",str(response.model.id,'provider.record.id',2000),now(),row.id);
      }catch(error){const code=error instanceof ApiError?error.code:'provider_unavailable';const retry=code==='provider_rate_limited'&&attempts<6;const status=retry?'retry':['provider_unavailable','writeback_response_uncertain','provider_invalid_response'].includes(code)?'uncertain':'failed';const due=this.db.time()+Math.max(error instanceof ProviderError?error.retryAfter:0,Math.min(3600000,1000*2**attempts));this.db.store.run('UPDATE connector_jobs SET status=?,due_at=?,last_error=?,updated_at=? WHERE id=?',status,due,code,now(),row.id);}
    }return this.jobs(c);
  }
  async disconnect(c:Connection) { let providerDeletion='not_requested';try{await this.request(c.category,'delete-account',this.db.credential(c.id).accountToken,{});providerDeletion='deleted';}catch{providerDeletion='provider_unavailable';}finally{this.db.disconnect(c);}return {disconnected:true,localCredentialsDeleted:true,providerDeletion}; }
}
