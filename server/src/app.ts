import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ApiError, Store, bool, checkPassword, cleanData, email, entity, fail, hash, integer, now, object, opaque, passwordHash, rejectSecrets, str, uuid, type Entity, type Principal, type Row } from './core.ts';

import { createRecordingService,type RecordingOptions } from './recordings.ts';
import { createEmailService, invalidateEmailActions, type EmailOptions } from './auth/email.ts';
import { createAnalyticsExtension } from './enterprise/analytics.ts';
import { assignedMetadata, createAssistantExtension, type AssistantOptions } from './enterprise/assistant.ts';
import { createSsoExtension, type SsoOptions } from './enterprise/sso.ts';
import { createDirectoryExtension } from './enterprise/directory.ts';
import { createBillingExtension, type BillingOptions } from './enterprise/billing.ts';
import type { RouteExtension } from './extensions.ts';
export interface ServerOptions { dbPath?: string; bodyTimeoutMs?:number; host?: string; port?: number; publicOrigin?: string; allowedOrigins?: string[]; extensions?: RouteExtension[]; sso?: SsoOptions; billing?: BillingOptions; assistant?:AssistantOptions; email?:EmailOptions; recordings?:RecordingOptions; contextProviders?: Array<(store:Store,user:Principal,query:string)=>Promise<Row>>; accountDeleteHooks?:Array<(store:Store,userId:string)=>void>; }
export function createWatsonServer(options: ServerOptions = {}) {
  const store=new Store(options.dbPath ?? join(fileURLToPath(new URL('../data/',import.meta.url)),'watson.sqlite'));
  const throttles=new Map<string,{count:number;until:number}>();
  const base='/api/v1';
  const recordingService=createRecordingService(store,options.recordings??{});
  const emailService=createEmailService(store,options.email??{});
  const builtinExtensions=[recordingService.extension,emailService.extension,createAnalyticsExtension(),createDirectoryExtension(),createSsoExtension(options.sso??{}),createBillingExtension(options.billing??{}),createAssistantExtension(options.assistant??{},options.contextProviders??[])];
  let publicOrigin=options.publicOrigin ?? `http://${options.host ?? '127.0.0.1'}:${options.port ?? 4319}`;
  const allowedOrigins=new Set(options.allowedOrigins ?? ['http://127.0.0.1:5173','http://localhost:5173','watson://desktop']);
  const rate=(req:IncomingMessage,kind:string,max:number) => { const key=`${req.socket.remoteAddress}:${kind}`; const old=throttles.get(key); const entry=old && old.until>Date.now()?old:{count:0,until:Date.now()+60000}; entry.count++; throttles.set(key,entry); if(entry.count>max) fail(429,'rate_limited','Too many requests. Try again in a minute.'); if(throttles.size>10000) for(const [k,v] of throttles) if(v.until<Date.now()) throttles.delete(k); };
  const bodyDeadlines=new WeakMap<IncomingMessage,(milliseconds:number)=>void>();
  const defaultBodyTimeout=options.bodyTimeoutMs??30000;if(!Number.isSafeInteger(defaultBodyTimeout)||defaultBodyTimeout<1||defaultBodyTimeout>900000)throw new Error('Body timeout must be1..900000ms.');
  const rawBodies=new WeakMap<IncomingMessage,Promise<Buffer>>();
  function rawBody(req:IncomingMessage):Promise<Buffer> {const existing=rawBodies.get(req);if(existing)return existing;const promise=(async()=>{const parts:Buffer[]=[];let size=0;for await(const chunk of req){const buffer=Buffer.from(chunk);size+=buffer.length;if(size>5*1024*1024)fail(413,'body_too_large','Request exceeds 5 MiB.');parts.push(buffer);}return Buffer.concat(parts);})();rawBodies.set(req,promise);return promise;}
  async function body(req:IncomingMessage):Promise<Row> {
    if (!/^(application\/json|application\/scim\+json)(;|$)/.test(String(req.headers['content-type'] ?? ''))) fail(415,'unsupported_media_type','Use application/json.');
    try { return object(JSON.parse((await rawBody(req)).toString('utf8')||'{}')); } catch(error) { if(error instanceof ApiError) throw error;fail(400,'invalid_json','Invalid JSON body.'); }
  }
  const auth=(req:IncomingMessage) => { const bearer=String(req.headers.authorization ?? ''); if(!bearer.startsWith('Bearer ') || bearer.length>512) fail(401,'unauthorized','Sign in to Watson.'); return store.principal(bearer.slice(7)); };
  const send=(res:ServerResponse,status:number,data:unknown) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data)); };
  const meetingEnvelope=(r:Row) => ({id:r.id,revision:r.revision,meeting:r.data,updatedAt:r.updatedAt});
  const route=async(req:IncomingMessage,res:ServerResponse) => {
    const origin=req.headers.origin;
    res.setHeader('Access-Control-Expose-Headers','Content-Length,Content-Range,Accept-Ranges');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
    if(origin) { if(origin!==publicOrigin&&!allowedOrigins.has(origin)) fail(403,'origin_denied','This browser origin is not permitted.');res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin'); }
    if(req.method==='OPTIONS') { res.writeHead(204,{'Access-Control-Allow-Methods':'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type,Range,X-Watson-Expected-Revision,X-Watson-Recording-Consent,X-Watson-Filename','Access-Control-Max-Age':'600'});res.end();return; }
    const url=new URL(req.url ?? '/',publicOrigin);const method=req.method ?? 'GET';
    if(!url.pathname.startsWith(base+'/')) fail(404,'not_found','Route not found.');
    const segments=url.pathname.slice(base.length+1).split('/').map(decodeURIComponent);const path=segments.join('/');
    rate(req,'all',600);
    if(method==='GET' && path==='health') { send(res,200,{status:'ok',name:'Watson',version:'0.1.0',storage:'sqlite'});return; }
    if(method==='POST' && ['auth/signup','auth/login'].includes(path)) {
      rate(req,'auth',20);const input=await body(req);const address=email(input.email);const password=str(input.password,'password',512);
      if(path==='auth/signup') {
        const encoded=await passwordHash(password);const id=uuid();const timestamp=now();const name=input.name===undefined?address.split('@')[0]:str(input.name,'name',200);
        if(store.get('SELECT id FROM users WHERE email=?',address)) fail(409,'email_in_use','This email is already registered.');
        store.run('INSERT INTO users VALUES(?,?,?,?,?,?)',id,address,name,encoded,timestamp,timestamp);
        send(res,201,store.issue(store.get('SELECT * FROM users WHERE id=?',id)!,input.deviceName));return;
      }
      const user=store.get('SELECT * FROM users WHERE email=?',address);
      // Fixed scrypt work for nonexistent users avoids a quick user-enumeration signal.
      const encoded=user?.password_hash ?? 'scrypt$32768$8$1$00000000000000000000000000000000$'+ '00'.repeat(64);
      if(!(await checkPassword(password,encoded)) || !user) fail(401,'invalid_credentials','Email or password is incorrect.');
      send(res,200,store.issue(user,input.deviceName));return;
    }
    if(method==='GET' && segments[0]==='public' && ['shares','view'].includes(segments[1]) && segments.length===3) {
      rate(req,'public',120);store.prune();const share=store.get('SELECT * FROM shares WHERE token_hash=? AND expires_at>?',hash(segments[2]),now());
      if(!share || !store.policy(share.owner_id).publicSharingAllowed) fail(404,'not_found','Share unavailable.');
      const row=store.get("SELECT data FROM resources WHERE owner_id=? AND entity='meeting' AND id=? AND deleted=0",share.owner_id,share.meeting_id);if(!row) fail(404,'not_found','Share unavailable.');
      const data=JSON.parse(row.data);const meeting={title:data.title,startedAt:data.startedAt,endedAt:data.endedAt,notes:data.notes ?? '',actions:data.actions ?? [],followupDraft:data.followupDraft ?? '',transcript:(data.transcript ?? []).map((line:Row)=>({text:line.text,source:line.source,timestamp:line.timestamp,speaker:line.speaker}))};
      if(segments[1]==='view'){sendSharePage(res,meeting);return;}send(res,200,{meeting,expiresAt:share.expires_at});return;
    }
    if(path.startsWith('auth/sso/'))rate(req,'sso',60);
    for(const extension of [...builtinExtensions,...(options.extensions ?? [])])if(await extension({req,res,url,segments,path,store,publicOrigin,apiBase:base,readJson:()=>body(req),readRaw:()=>rawBody(req),authenticate:()=>auth(req),setBodyTimeout:milliseconds=>bodyDeadlines.get(req)?.(milliseconds),send:(status,data)=>send(res,status,data)}))return;
    const user=auth(req);
    if(method==='POST' && path==='auth/logout') {store.run('DELETE FROM auth_sessions WHERE token_hash=?',user.tokenHash);send(res,200,{ok:true});return;}
    if(path==='me' && method==='GET') { const row=store.get('SELECT * FROM users WHERE id=?',user.id)!;send(res,200,{user:store.user(row),devices:store.all('SELECT id,name,created_at AS createdAt,last_seen_at AS lastSeenAt FROM devices WHERE user_id=?',user.id),organizations:store.all('SELECT o.id,o.name,m.role FROM organizations o JOIN org_members m ON m.org_id=o.id WHERE m.user_id=?',user.id),policy:store.policy(user.id)});return; }
    if(path==='me' && method==='PATCH') { const input=await body(req);const name=input.name===undefined?user.name:str(input.name,'name',200);const address=input.email===undefined?user.email:email(input.email);if(address!==user.email && !await checkPassword(str(input.currentPassword,'currentPassword',512),store.get('SELECT password_hash FROM users WHERE id=?',user.id)!.password_hash)) fail(401,'invalid_credentials','Current password is incorrect.');if(store.get('SELECT id FROM users WHERE email=? AND id!=?',address,user.id)) fail(409,'email_in_use','This email is already registered.');store.transaction(()=>{store.run('UPDATE users SET name=?,email=?,updated_at=? WHERE id=?',name,address,now(),user.id);if(address!==user.email)invalidateEmailActions(store,user.id,true);});send(res,200,{user:store.user(store.get('SELECT * FROM users WHERE id=?',user.id)!)});return; }
    if(path==='me/password' && method==='POST') {
      rate(req,'password',10);const input=await body(req);const row=store.get('SELECT * FROM users WHERE id=?',user.id)!;
      if(!await checkPassword(str(input.currentPassword,'currentPassword',512),row.password_hash)) fail(401,'invalid_credentials','Current password is incorrect.');
      const encoded=await passwordHash(str(input.newPassword,'newPassword',512));store.transaction(()=>{store.run('UPDATE users SET password_hash=?,updated_at=? WHERE id=?',encoded,now(),user.id);store.run('DELETE FROM auth_sessions WHERE user_id=?',user.id);invalidateEmailActions(store,user.id);});send(res,200,store.issue(store.get('SELECT * FROM users WHERE id=?',user.id)!,input.deviceName));return;
    }
    if(path==='me' && method==='DELETE') {
      const input=await body(req);const row=store.get('SELECT * FROM users WHERE id=?',user.id)!;
      if(!await checkPassword(str(input.currentPassword,'currentPassword',512),row.password_hash)) fail(401,'invalid_credentials','Current password is incorrect.');
      store.transaction(()=>{
        const orgs=store.all('SELECT DISTINCT o.* FROM organizations o LEFT JOIN org_members m ON m.org_id=o.id WHERE m.user_id=? OR o.created_by=?',user.id,user.id);
        for(const org of orgs) { const others=store.all('SELECT user_id,role FROM org_members WHERE org_id=? AND user_id!=?',org.id,user.id);if(!others.length){store.run('DELETE FROM organizations WHERE id=?',org.id);continue;}const admin=others.find(m=>m.role==='admin');if(!admin && store.get('SELECT role FROM org_members WHERE org_id=? AND user_id=?',org.id,user.id)?.role==='admin') fail(409,'last_admin','Assign another organization admin before deleting your account.');if(org.created_by===user.id)store.run('UPDATE organizations SET created_by=? WHERE id=?',admin?.user_id ?? others[0].user_id,org.id); }
        recordingService.cleanupUser(user.id);for(const cleanup of options.accountDeleteHooks??[])cleanup(store,user.id);
        // Remove immutable audit targets and actor identity that could expose the deleted account.
        store.run('UPDATE audit_events SET actor_id=NULL,target=? WHERE actor_id=?','deleted-account',user.id);
        store.run('DELETE FROM users WHERE id=?',user.id);
      });send(res,200,{deleted:true});return;
    }
    if(segments[0]==='devices' && segments.length===2 && method==='DELETE') { const id=segments[1];if(!store.get('SELECT id FROM devices WHERE id=? AND user_id=?',id,user.id))fail(404,'not_found','Device not found.');store.run('DELETE FROM devices WHERE id=?',id);send(res,200,{ok:true});return; }
    if(path==='assigned-mode' && method==='GET'){send(res,200,{mode:assignedMetadata(store,user.id)});return;}
    if(path==='policy' && method==='GET') {send(res,200,store.policy(user.id));return;}
    if(path==='sync' && method==='POST') {
      const input=await body(req);const deviceId=str(input.deviceId,'deviceId',128);if(!store.get('SELECT id FROM devices WHERE id=? AND user_id=?',deviceId,user.id))fail(403,'invalid_device','Device does not belong to this account.');
      const cursor=integer(input.cursor ?? 0,'cursor',0,Number.MAX_SAFE_INTEGER);if(!Array.isArray(input.changes)||input.changes.length>100)fail(400,'invalid_changes','changes must contain at most 100 items.');
      store.prune();const currentCursor=store.get('SELECT COALESCE(MAX(sequence),0) AS cursor FROM changes WHERE user_id=?',user.id)!.cursor;if(cursor>currentCursor)fail(400,'invalid_cursor','Sync cursor exceeds this account’s latest revision.');const conflicts:Row[]=[];const applied:Row[]=[];
      store.transaction(()=>{
        for(const raw of input.changes) {const change=object(raw);const kind=entity(change.entity);const id=str(change.id,'id',128);const expected=integer(change.expectedRevision,'expectedRevision',0,Number.MAX_SAFE_INTEGER);const fingerprint=hash(JSON.stringify({kind,id,expected,data:change.data}));
          let changeId:string|undefined;if(change.changeId!==undefined){changeId=str(change.changeId,'changeId',128);const prev=store.get('SELECT result,payload_hash FROM mutations WHERE user_id=? AND change_id=?',user.id,changeId);if(prev){if(prev.payload_hash!==fingerprint)fail(409,'mutation_reused','changeId was used for different data.');applied.push(JSON.parse(prev.result));continue;}}
          // Sync accepts personal records only. Organization sharing uses its explicit ACL endpoints.
          const existing=store.get('SELECT * FROM resources WHERE owner_id=? AND entity=? AND id=?',user.id,kind,id);if(existing && existing.scope!=='personal')fail(400,'invalid_scope','Shared resources must use the resource endpoints.');
          const foreign=store.all('SELECT * FROM resources WHERE entity=? AND id=? AND owner_id!=?',kind,id,user.id).find(r=>store.readable(user.id,r));if(!existing && foreign)fail(409,'ambiguous_resource','Use a unique ID for personal sync resources.');
          try {const result=store.put(user.id,kind,id,change.data,expected);applied.push(result);if(changeId)store.run('INSERT INTO mutations(user_id,change_id,result,payload_hash) VALUES(?,?,?,?)',user.id,changeId,JSON.stringify(result),fingerprint);}catch(error){if(error instanceof ApiError && error.code==='revision_conflict') conflicts.push({id,entity:kind,code:error.code,...object(error.details)});else throw error;}
        }
      });
      const latest=store.get('SELECT COALESCE(MAX(sequence),0) AS cursor FROM changes WHERE user_id=?',user.id)!.cursor;
      if(cursor>latest)fail(400,'invalid_cursor','Sync cursor exceeds this account’s latest revision.');
      const changes=store.all('SELECT sequence,entity,resource_id AS id,revision,data,deleted,updated_at AS updatedAt FROM changes WHERE user_id=? AND sequence>? ORDER BY sequence',user.id,cursor).map(row=>({...row,data:row.data?JSON.parse(row.data):null,deleted:!!row.deleted}));
      send(res,200,{cursor:latest,changes,conflicts,applied,shared:store.list(user.id).filter(r=>r.scope!=='personal'),assignedMode:assignedMetadata(store,user.id),policy:store.policy(user.id)});return;
    }
    if(segments[0]==='meetings') {
      store.prune();
      if(segments.length===1 && method==='GET') {let rows=store.list(user.id,'meeting');const query=url.searchParams.get('q')?.toLowerCase();if(query)rows=rows.filter(r=>JSON.stringify(r.data).toLowerCase().includes(query));send(res,200,{meetings:rows.map(meetingEnvelope)});return;}
      if(segments.length===1 && method==='POST') {const input=await body(req);const data=object(input.meeting);const id=data.id?str(data.id,'id',128):uuid();const result=store.transaction(()=>store.put(user.id,'meeting',id,data,input.expectedRevision??0));send(res,201,meetingEnvelope(result));return;}
      if(segments.length>=2){const id=segments[1];const row=store.resource(user.id,'meeting',id);
        if(segments.length===2 && method==='GET'){send(res,200,meetingEnvelope(store.project(row)));return;}
        if(segments.length===2 && method==='PUT'){const input=await body(req);const result=store.transaction(()=>store.put(user.id,'meeting',id,input.meeting,integer(input.expectedRevision,'expectedRevision',0,Number.MAX_SAFE_INTEGER)));send(res,200,meetingEnvelope(result));return;}
        if(segments.length===2 && method==='DELETE'){const input=await body(req);const result=store.transaction(()=>store.put(user.id,'meeting',id,null,integer(input.expectedRevision,'expectedRevision',0,Number.MAX_SAFE_INTEGER)));send(res,200,{id,revision:result.revision,deleted:true});return;}
        if(segments.length===3 && segments[2]==='share' && method==='POST') {
          if(row.owner_id!==user.id)fail(403,'forbidden','Only the meeting owner may share it.');if(!store.policy(user.id).publicSharingAllowed)fail(403,'sharing_disabled','Your organization disables public sharing.');
          const input=await body(req);const days=input.expiresInDays===undefined?30:integer(input.expiresInDays,'expiresInDays',1,365);const token=opaque();const expiresAt=new Date(Date.now()+days*86400000).toISOString();store.run('INSERT INTO shares VALUES(?,?,?,?,?) ON CONFLICT(owner_id,meeting_id) DO UPDATE SET token_hash=excluded.token_hash,created_at=excluded.created_at,expires_at=excluded.expires_at',hash(token),user.id,id,now(),expiresAt);send(res,201,{token,url:`${publicOrigin}${base}/public/shares/${token}`,viewerUrl:`${publicOrigin}${base}/public/view/${token}`,expiresAt});return;
        }
        if(segments.length===3 && segments[2]==='share' && method==='DELETE'){store.run('DELETE FROM shares WHERE owner_id=? AND meeting_id=?',user.id,id);send(res,200,{revoked:true});return;}
        if(segments.length===3 && segments[2]==='recording' && method==='GET'){const data=JSON.parse(row.data);if(!data.recording)fail(404,'not_found','Recording not found.');if(!store.policy(user.id).recordingAllowed)fail(403,'recording_disabled','Your organization disallows recording downloads.');const audio=Buffer.from(data.recording.base64,'base64');res.writeHead(200,{'Content-Type':data.recording.contentType,'Content-Length':audio.length,'Cache-Control':'no-store'});res.end(audio);return;}
        if(segments.length===3 && segments[2]==='export' && method==='GET'){const data=JSON.parse(row.data);send(res,200,{meeting:data,revision:row.revision});return;}
      }
    }
    if(segments[0]==='resources') {
      if(segments.length===1 && method==='GET'){const kind=url.searchParams.get('entity');let records=store.list(user.id,kind?entity(kind):undefined);const scope=url.searchParams.get('scope');const orgId=url.searchParams.get('orgId');const teamId=url.searchParams.get('teamId');if(scope)records=records.filter(r=>r.scope===scope);if(orgId)records=records.filter(r=>r.orgId===orgId);if(teamId)records=records.filter(r=>r.teamId===teamId);const query=url.searchParams.get('q')?.toLowerCase();if(query)records=records.filter(r=>JSON.stringify(r.data).toLowerCase().includes(query));send(res,200,{resources:records});return;}
      if(segments.length===2 && method==='POST'){const kind=entity(segments[1]);const input=await body(req);const data=object(input.data);const id=data.id?str(data.id,'id',128):uuid();const result=store.transaction(()=>store.put(user.id,kind,id,data,input.expectedRevision??0,input.scope,input.orgId,input.teamId));send(res,201,result);return;}
      if(segments.length===3){const kind=entity(segments[1]),id=segments[2];if(method==='GET'){send(res,200,store.project(store.resource(user.id,kind,id)));return;}if(method==='PUT'){const input=await body(req);const result=store.transaction(()=>store.put(user.id,kind,id,input.data,integer(input.expectedRevision,'expectedRevision',0,Number.MAX_SAFE_INTEGER),input.scope,input.orgId,input.teamId));send(res,200,result);return;}if(method==='DELETE'){const input=await body(req);store.resource(user.id,kind,id,true);const result=store.transaction(()=>store.put(user.id,kind,id,null,integer(input.expectedRevision,'expectedRevision',0,Number.MAX_SAFE_INTEGER)));send(res,200,result);return;}}
    }
    if(segments[0]==='organizations') {await organizations(req,res,user,segments,url,body,send,store);return;}
    if(path==='context' && method==='GET') {
      const query=(url.searchParams.get('q') ?? '').toLowerCase();const modeId=url.searchParams.get('modeId');let docs=store.list(user.id,'knowledge');let modes:Row[]=store.list(user.id,'mode');
      if(modeId){const assigned=store.assignedMode(user.id);const mode=assigned?.id===modeId?assigned:store.project(store.resource(user.id,'mode',modeId));modes=[assigned?.id===modeId&&!store.readable(user.id,store.get("SELECT * FROM resources WHERE owner_id=? AND entity='mode' AND id=?",assigned.ownerId,assigned.id)!)?assignedMetadata(store,user.id)!:mode];const ids=new Set(mode.data.documentIds ?? []);docs=docs.filter(d=>ids.has(d.id));}
      if(query)docs=docs.filter(d=>JSON.stringify(d.data).toLowerCase().includes(query));
      const connected:Row[]=[];for(const provider of options.contextProviders??[])connected.push(await provider(store,user,query));send(res,200,{documents:docs,connectedDocuments:connected.flatMap(c=>c.documents??[]),people:connected.flatMap(c=>c.people??[]),modes,assignedMode:assignedMetadata(store,user.id),folders:store.list(user.id,'folder')});return;
    }
    if(path==='usage' && method==='POST') {
      const input=await body(req);rejectSecrets(input);const kind=str(input.kind,'kind',100);if(!['assist','transcription_seconds','meeting_seconds','screen_capture','import','export'].includes(kind))fail(400,'invalid_field','Unsupported usage event kind.');const amount=Number(input.amount);if(!Number.isFinite(amount)||amount<0||amount>86400)fail(400,'invalid_field','amount must be from 0 to 86400.');const orgId=input.orgId?str(input.orgId,'orgId',128):null;if(orgId)store.orgRole(user.id,orgId);const id=input.id?str(input.id,'id',128):uuid();const existing=store.get('SELECT user_id FROM usage_events WHERE id=?',id);if(existing && existing.user_id!==user.id)fail(409,'id_conflict','Event ID already exists.');const metadata=input.metadata===undefined?{}:object(input.metadata);if(metadata.teamId!==undefined){if(!orgId)fail(400,'invalid_scope','A team event requires orgId.');const team=store.team(user.id,str(metadata.teamId,'teamId',128));if(team.org_id!==orgId)fail(400,'invalid_scope','Usage team does not belong to this organization.');}if(Buffer.byteLength(JSON.stringify(metadata))>4000)fail(400,'invalid_field','metadata is too large.');store.run('INSERT OR IGNORE INTO usage_events VALUES(?,?,?,?,?,?,?)',id,user.id,orgId,kind,amount,now(),JSON.stringify(metadata));send(res,201,{id,recorded:!existing});return;
    }
    if(path==='usage' && method==='GET') {send(res,200,usage(store,user.id,null,url));return;}
    if(path==='export' && method==='GET') {store.prune();send(res,200,{user:store.user(store.get('SELECT * FROM users WHERE id=?',user.id)!),resources:store.list(user.id),usage:store.all('SELECT id,kind,amount,occurred_at AS occurredAt,metadata FROM usage_events WHERE user_id=?',user.id).map(r=>({...r,metadata:JSON.parse(r.metadata)})),exportedAt:now()});return;}
    fail(404,'not_found','Route not found.');
  };
  const server=createServer((req,res)=>{
    const receivedAt=Date.now();let deadline:ReturnType<typeof setTimeout>|undefined;
    const clear=()=>{if(deadline)clearTimeout(deadline);deadline=undefined;bodyDeadlines.delete(req);};
    const arm=(milliseconds:number)=>{if(!Number.isSafeInteger(milliseconds)||milliseconds<1||milliseconds>900000)throw new Error('Invalid body deadline.');if(deadline)clearTimeout(deadline);if(req.complete||req.destroyed){clear();return;}deadline=setTimeout(()=>{clear();if(req.complete||req.destroyed)return;const error=new ApiError(408,'request_timeout','Request body exceeded its allowed transfer time.');if(!res.headersSent){res.setHeader('Connection','close');res.writeHead(408,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({error:{code:error.code,message:error.message}}),()=>req.destroy(error));}else req.destroy(error);},Math.max(1,milliseconds-(Date.now()-receivedAt)));deadline.unref();};
    bodyDeadlines.set(req,arm);req.on('error',()=>{});req.once('end',clear);req.once('close',clear);req.once('aborted',clear);arm(defaultBodyTimeout);
    void route(req,res).catch(error=>{if(res.headersSent){res.end();return;}if(error instanceof ApiError)send(res,error.status,{error:{code:error.code,message:error.message,details:error.details}});else {console.error('Watson API request failed:',error instanceof Error?error.message:'unknown');send(res,500,{error:{code:'internal_error',message:'An unexpected server error occurred.'}});}});
  });
  // Node's requestTimeout is server-wide; route deadlines above preserve30s ordinarily and allow authenticated media300s.
  server.requestTimeout=0;server.headersTimeout=10000;
  const retentionTimer=setInterval(()=>{try{store.prune();}catch(error){console.error('Watson retention sweep failed:',error instanceof Error?error.message:'unknown');}},60000);retentionTimer.unref();
  return {store,server,async listen(){await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??4319,options.host??'127.0.0.1',resolve);});const address=server.address();if(typeof address==='object'&&address&&!options.publicOrigin)publicOrigin=`http://${options.host??'127.0.0.1'}:${address.port}`;emailService.start();return publicOrigin;},async close(){clearInterval(retentionTimer);await emailService.stop();await new Promise<void>((resolve,reject)=>{server.close(err=>err?reject(err):resolve());server.closeAllConnections();});store.db.close();}};
}
function usage(store:Store,userId:string|null,orgId:string|null,url:URL) {
  const from=url.searchParams.get('from') ?? new Date(Date.now()-30*86400000).toISOString();const to=url.searchParams.get('to') ?? now();if(!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to))||Date.parse(to)<Date.parse(from))fail(400,'invalid_date','Invalid analytics date range.');
  const predicate=orgId?'org_id=?':'user_id=?';const id=orgId??userId!;
  const events:Row[]=store.all(`SELECT id,user_id AS userId,kind,amount,occurred_at AS occurredAt,metadata FROM usage_events WHERE ${predicate} AND occurred_at>=? AND occurred_at<=? ORDER BY occurred_at`,id,from,to).map(r=>({...r,metadata:JSON.parse(r.metadata)}));
  const totals:Row={};for(const event of events)totals[event.kind]=(totals[event.kind]??0)+event.amount;
  return {from,to,totals,eventCount:events.length,events,source:'Client-reported events recorded by this server; not billing or provider invoices.'};
}
async function organizations(req:IncomingMessage,res:ServerResponse,user:Principal,parts:string[],url:URL,body:(req:IncomingMessage)=>Promise<Row>,send:(res:ServerResponse,status:number,data:unknown)=>void,store:Store) {
  const method=req.method;
  if(parts.length===1 && method==='GET') {send(res,200,{organizations:store.all('SELECT o.id,o.name,o.retention_days AS retentionDays,o.recording_allowed AS recordingAllowed,o.public_sharing_allowed AS publicSharingAllowed,m.role FROM organizations o JOIN org_members m ON m.org_id=o.id WHERE m.user_id=?',user.id).map(o=>({...o,recordingAllowed:!!o.recordingAllowed,publicSharingAllowed:!!o.publicSharingAllowed}))});return;}
  if(parts.length===1 && method==='POST') {const input=await body(req);const id=uuid(),name=str(input.name,'name',200);store.transaction(()=>{store.run('INSERT INTO organizations(id,name,created_by,created_at) VALUES(?,?,?,?)',id,name,user.id,now());store.run('INSERT INTO org_members VALUES(?,?,?,?)',id,user.id,'admin',now());store.audit(id,user.id,'organization.create',id);});send(res,201,{id,name,role:'admin'});return;}
  const orgId=str(parts[1],'orgId',128);const role=store.orgRole(user.id,orgId);const org=store.get('SELECT * FROM organizations WHERE id=?',orgId)!;
  if(parts.length===2 && method==='GET') {send(res,200,{id:org.id,name:org.name,role,policy:{retentionDays:org.retention_days,recordingAllowed:!!org.recording_allowed,publicSharingAllowed:!!org.public_sharing_allowed}});return;}
  if(parts.length===2 && method==='PATCH') {store.orgManage(user.id,orgId,true);const input=await body(req);const name=input.name===undefined?org.name:str(input.name,'name',200);store.run('UPDATE organizations SET name=? WHERE id=?',name,orgId);store.audit(orgId,user.id,'organization.update',orgId);send(res,200,{id:orgId,name});return;}
  if(parts.length===2 && method==='DELETE') {store.orgManage(user.id,orgId,true);store.run('DELETE FROM organizations WHERE id=?',orgId);send(res,200,{deleted:true});return;}
  if(parts[2]==='policy' && parts.length===3) {
    if(method==='GET'){send(res,200,{retentionDays:org.retention_days,recordingAllowed:!!org.recording_allowed,publicSharingAllowed:!!org.public_sharing_allowed});return;}
    if(method==='PUT'){store.orgManage(user.id,orgId,true);const input=await body(req);const retention=input.retentionDays===undefined?org.retention_days:integer(input.retentionDays,'retentionDays',1,3650);const recording=input.recordingAllowed===undefined?!!org.recording_allowed:bool(input.recordingAllowed,'recordingAllowed');const sharing=input.publicSharingAllowed===undefined?!!org.public_sharing_allowed:bool(input.publicSharingAllowed,'publicSharingAllowed');store.transaction(()=>{store.run('UPDATE organizations SET retention_days=?,recording_allowed=?,public_sharing_allowed=? WHERE id=?',retention,Number(recording),Number(sharing),orgId);store.audit(orgId,user.id,'policy.update',orgId);});store.prune();send(res,200,{retentionDays:retention,recordingAllowed:recording,publicSharingAllowed:sharing});return;}
  }
  if(parts[2]==='members') {
    if(parts.length===3 && method==='GET'){send(res,200,{members:store.all('SELECT u.id,u.email,u.name,m.role,m.joined_at AS joinedAt FROM org_members m JOIN users u ON u.id=m.user_id WHERE m.org_id=?',orgId)});return;}
    if(parts.length===3 && method==='POST') {store.orgManage(user.id,orgId,true);const input=await body(req);const member=store.get('SELECT id FROM users WHERE email=?',email(input.email));if(!member)fail(404,'not_found','The user must create a Watson account first.');const newRole=input.role??'member';if(!['admin','manager','member'].includes(newRole))fail(400,'invalid_role','Unknown organization role.');if(store.get('SELECT role FROM org_members WHERE org_id=? AND user_id=?',orgId,member.id))fail(409,'already_member','User is already an organization member.');store.transaction(()=>{store.run('INSERT INTO org_members VALUES(?,?,?,?)',orgId,member.id,newRole,now());store.audit(orgId,user.id,'member.add',member.id);});store.prune();send(res,201,{userId:member.id,role:newRole});return;}
    if(parts.length===4 && ['PATCH','DELETE'].includes(method??'')) {store.orgManage(user.id,orgId,true);const target=parts[3];const member=store.get('SELECT role FROM org_members WHERE org_id=? AND user_id=?',orgId,target);if(!member)fail(404,'not_found','Member not found.');const input=method==='PATCH'?await body(req):{};const newRole=input.role;if(method==='PATCH'&&!['admin','manager','member'].includes(newRole))fail(400,'invalid_role','Unknown organization role.');if(member.role==='admin' && (method==='DELETE'||newRole!=='admin') && !store.get("SELECT 1 FROM org_members WHERE org_id=? AND user_id!=? AND role='admin'",orgId,target))fail(409,'last_admin','An organization must retain at least one admin.');store.transaction(()=>{if(method==='PATCH')store.run('UPDATE org_members SET role=? WHERE org_id=? AND user_id=?',newRole,orgId,target);else{store.run('DELETE FROM team_members WHERE user_id=? AND team_id IN(SELECT id FROM teams WHERE org_id=?)',target,orgId);store.run('DELETE FROM prompt_assignments WHERE org_id=? AND user_id=?',orgId,target);store.run('DELETE FROM org_members WHERE org_id=? AND user_id=?',orgId,target);if(org.created_by===target){const admin=store.get("SELECT user_id FROM org_members WHERE org_id=? AND role='admin' LIMIT 1",orgId)!;store.run('UPDATE organizations SET created_by=? WHERE id=?',admin.user_id,orgId);}}store.audit(orgId,user.id,method==='PATCH'?'member.role':'member.remove',target);});send(res,200,{userId:target,role:newRole,deleted:method==='DELETE'});return;}
  }
  if(parts[2]==='teams') {
    if(parts.length===3 && method==='GET') {const teams=role==='admin'?store.all('SELECT * FROM teams WHERE org_id=?',orgId):store.all('SELECT t.*,m.role FROM teams t JOIN team_members m ON m.team_id=t.id WHERE t.org_id=? AND m.user_id=?',orgId,user.id);send(res,200,{teams:teams.map(t=>({id:t.id,orgId:t.org_id,name:t.name,role:t.role??'admin',createdAt:t.created_at}))});return;}
    if(parts.length===3 && method==='POST') {store.orgManage(user.id,orgId);const input=await body(req);const id=uuid(),name=str(input.name,'name',200);store.transaction(()=>{store.run('INSERT INTO teams VALUES(?,?,?,?)',id,orgId,name,now());store.run('INSERT INTO team_members VALUES(?,?,?)',id,user.id,'manager');store.audit(orgId,user.id,'team.create',id);});send(res,201,{id,orgId,name,role:'manager'});return;}
    const teamId=str(parts[3],'teamId',128);const team=store.team(user.id,teamId,['PATCH','POST','PUT','DELETE'].includes(method??''));if(team.org_id!==orgId)fail(404,'not_found','Team not found.');
    if(parts.length===4 && method==='PATCH'){const input=await body(req);const name=str(input.name,'name',200);store.run('UPDATE teams SET name=? WHERE id=?',name,teamId);store.audit(orgId,user.id,'team.update',teamId);send(res,200,{id:teamId,name,orgId});return;}
    if(parts.length===4 && method==='DELETE'){store.orgManage(user.id,orgId);store.transaction(()=>{store.run('DELETE FROM teams WHERE id=?',teamId);store.audit(orgId,user.id,'team.delete',teamId);});send(res,200,{deleted:true});return;}
    if(parts[4]==='members') {
      if(parts.length===5 && method==='GET'){send(res,200,{members:store.all('SELECT u.id,u.email,u.name,m.role FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=?',teamId)});return;}
      if(parts.length===5 && method==='POST'){const input=await body(req);const target=str(input.userId,'userId',128);store.orgRole(target,orgId);const teamRole=input.role??'member';if(!['manager','member'].includes(teamRole))fail(400,'invalid_role','Unknown team role.');if(store.get('SELECT role FROM team_members WHERE team_id=? AND user_id=?',teamId,target))fail(409,'already_member','User is already a team member.');store.transaction(()=>{store.run('INSERT INTO team_members VALUES(?,?,?)',teamId,target,teamRole);store.audit(orgId,user.id,'team.member.add',`${teamId}:${target}`);});send(res,201,{userId:target,role:teamRole});return;}
      if(parts.length===6 && ['PATCH','DELETE'].includes(method??'')){const target=parts[5];if(!store.get('SELECT role FROM team_members WHERE team_id=? AND user_id=?',teamId,target))fail(404,'not_found','Team member not found.');const input=method==='PATCH'?await body(req):{};if(method==='PATCH'&&!['manager','member'].includes(input.role))fail(400,'invalid_role','Unknown team role.');store.transaction(()=>{if(method==='PATCH')store.run('UPDATE team_members SET role=? WHERE team_id=? AND user_id=?',input.role,teamId,target);else {store.run("DELETE FROM prompt_assignments WHERE user_id=? AND mode_id IN(SELECT id FROM resources WHERE entity='mode' AND team_id=?)",target,teamId);store.run('DELETE FROM team_members WHERE team_id=? AND user_id=?',teamId,target);}store.audit(orgId,user.id,method==='PATCH'?'team.member.role':'team.member.remove',`${teamId}:${target}`);});send(res,200,{userId:target,role:input.role,deleted:method==='DELETE'});return;}
    }
  }
  if(parts[2]==='assignments') {
    const teamId=url.searchParams.get('teamId');
    if(parts.length===3&&method==='GET'){if(teamId){const team=store.team(user.id,teamId,true);if(team.org_id!==orgId)fail(404,'not_found','Team not found.');const members=store.all('SELECT user_id FROM team_members WHERE team_id=?',teamId);send(res,200,{assignments:members.map(member=>{const assigned=store.assignedMode(member.user_id);return {userId:member.user_id,modeId:assigned?.teamId===teamId?assigned.id:null};})});}else{store.orgManage(user.id,orgId,true);send(res,200,{assignments:store.all('SELECT m.user_id AS userId,a.mode_id AS modeId FROM org_members m LEFT JOIN prompt_assignments a ON a.user_id=m.user_id AND a.org_id=m.org_id WHERE m.org_id=?',orgId)});}return;}
    if(parts.length===4&&method==='PUT'){const target=str(parts[3],'userId',128);store.orgRole(target,orgId);const input=await body(req);if(input.modeId===null){const existing=store.assignedMode(target);if(role!=='admin'){if(!existing||existing.orgId!==orgId||existing.scope!=='team')fail(403,'forbidden','Only this prompt team manager or org admin may clear the assignment.');store.team(user.id,existing.teamId,true);}store.run('DELETE FROM prompt_assignments WHERE user_id=? AND org_id=?',target,orgId);store.audit(orgId,user.id,'prompt.unassign',target);send(res,200,{userId:target,modeId:null});return;}
      const modeId=str(input.modeId,'modeId',128),prompt=store.resource(user.id,'mode',modeId,true);if(prompt.scope==='personal'||prompt.org_id!==orgId)fail(400,'invalid_assignment','Prompt must belong to this organization.');if(prompt.scope==='team'){store.team(user.id,prompt.team_id,true);if(!store.get('SELECT 1 FROM team_members WHERE team_id=? AND user_id=?',prompt.team_id,target))fail(400,'invalid_assignment','Team prompt can be assigned only to that team’s members.');}else store.orgManage(user.id,orgId,true);
      store.transaction(()=>{store.run("INSERT INTO prompt_assignments(user_id,org_id,owner_id,entity,mode_id,assigned_by,assigned_at) VALUES(?,?,?,'mode',?,?,?) ON CONFLICT(user_id) DO UPDATE SET org_id=excluded.org_id,owner_id=excluded.owner_id,mode_id=excluded.mode_id,assigned_by=excluded.assigned_by,assigned_at=excluded.assigned_at",target,orgId,prompt.owner_id,modeId,user.id,now());store.audit(orgId,user.id,'prompt.assign',`${target}:${modeId}`);});send(res,200,{userId:target,modeId});return;
    }
  }
  if(parts[2]==='usage' && parts.length===3 && method==='GET'){store.orgManage(user.id,orgId,true);const report=usage(store,null,orgId,url);report.events=report.events.map(event=>({...event,metadata:Object.fromEntries(Object.entries(event.metadata).filter(([key])=>['source','kind','model','teamId','modeId','inputTokens','outputTokens','latencyMs','smart'].includes(key)))}));send(res,200,report);return;}
  if(parts[2]==='audit' && parts.length===3 && method==='GET'){store.orgManage(user.id,orgId,true);send(res,200,{events:store.all('SELECT id,actor_id AS actorId,action,target,occurred_at AS occurredAt FROM audit_events WHERE org_id=? ORDER BY id DESC LIMIT 1000',orgId)});return;}
  fail(404,'not_found','Organization route not found.');
}

function sendSharePage(res:ServerResponse,meeting:Row) {
  const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  const paragraphs=(value:unknown)=>escape(value).split('\n').map(line=>`<p>${line||'&nbsp;'}</p>`).join('');
  const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(meeting.title)} · Watson</title><style>body{margin:0;background:#f5f6fa;color:#18202c;font:16px/1.6 system-ui,sans-serif}main{max-width:840px;margin:48px auto;padding:32px;background:white;border-radius:18px;box-shadow:0 8px 32px #15233a10}h1{font-size:32px;line-height:1.25}h2{margin-top:32px;font-size:20px}p{white-space:pre-wrap;margin:10px 0}.brand{color:#606d83;font-weight:600}.time{font-size:14px;color:#64748b}details{border-top:1px solid #e2e8f0;padding-top:24px;margin-top:32px}li{margin:8px 0}.transcript{margin:16px 0;padding:12px 16px;background:#f8fafc;border-radius:10px}@media(max-width:700px){main{margin:12px;padding:24px}} </style><main><div class="brand">Watson · Shared meeting</div><h1>${escape(meeting.title)}</h1><div class="time">${escape(meeting.startedAt)}${meeting.endedAt?' – '+escape(meeting.endedAt):''}</div><h2>Notes</h2>${paragraphs(meeting.notes||'No notes yet.')}<h2>Action items</h2><ul>${(meeting.actions??[]).map((action:unknown)=>`<li>${escape(action)}</li>`).join('')}</ul>${meeting.followupDraft?'<h2>Follow-up draft</h2>'+paragraphs(meeting.followupDraft):''}<details><summary>Meeting transcript</summary>${(meeting.transcript??[]).map((line:Row)=>`<div class="transcript"><div class="time">${escape(line.timestamp)} · ${escape(line.speaker===undefined?line.source:'Speaker '+line.speaker)}</div>${paragraphs(line.text)}</div>`).join('')}</details></main></html>`;
  res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);
}
