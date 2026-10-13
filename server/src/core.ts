import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { schema } from './schema.ts';

export type Row = Record<string, any>;
export type Entity = 'meeting' | 'knowledge' | 'mode' | 'calendar' | 'settings' | 'folder' | 'person' | 'scorecard';
export type Principal = { id: string; email: string; name: string; deviceId: string; tokenHash: string };
export class ApiError extends Error { status:number; code:string; details?:unknown; constructor(status: number, code: string, message: string, details?: unknown) { super(message); this.status=status;this.code=code;this.details=details; } }
export function fail(status: number, code: string, message: string, details?: unknown): never { throw new ApiError(status, code, message, details); }
export function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_body', 'Expected an object.');
  return value as Row;
}
export function str(value: unknown, name: string, max = 500, required = true): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, 'invalid_field', `${name} must be ${required ? 'a nonempty' : 'a'} string, at most ${max} characters.`);
  return value as string;
}
export function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail(400, 'invalid_field', `${name} must be an integer from ${min} to ${max}.`);
  return Number(value);
}
export function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') fail(400, 'invalid_field', `${name} must be a boolean.`);
  return value;
}
export const now = () => new Date().toISOString();
export const uuid = () => randomUUID();
export const opaque = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const derive = (password:string,salt:string,length:number,options:{N:number;r:number;p:number;maxmem:number}):Promise<Buffer> => new Promise((resolve,reject)=>scrypt(password,salt,length,options,(error,key)=>error?reject(error):resolve(key)));
export async function passwordHash(password: string): Promise<string> {
  str(password, 'password', 512); if (password.length < 12) fail(400, 'weak_password', 'Use a password with at least 12 characters.');
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }) as Buffer;
  return `scrypt$32768$8$1$${salt}$${key.toString('hex')}`;
}
export async function checkPassword(password: string, encoded: string): Promise<boolean> {
  const [, n, r, p, salt, stored] = encoded.split('$');
  if (!salt || !stored) return false;
  const key = await derive(password, salt, 64, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 }) as Buffer;
  const expected = Buffer.from(stored, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}
export function email(value: unknown): string {
  const result = str(value, 'email', 254).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail(400, 'invalid_email', 'Enter a valid email address.');
  return result;
}
export function rejectSecrets(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(rejectSecrets); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    const compact = key.replace(/[^a-z]/gi, '').toLowerCase();
    if (['apikey', 'openaikey', 'deepgramkey', 'credentials', 'credential', 'encryptedkeys', 'encryptedcredentials', 'password', 'passwordhash', 'accesstoken', 'refreshtoken', 'clientsecret', 'authorization', 'token', 'secret'].includes(compact) || compact.endsWith('apikey') || compact.endsWith('secret') || compact.endsWith('token') || compact.endsWith('password')) {
      fail(400, 'secret_not_syncable', `Provider credentials and secret fields cannot be uploaded (${key}).`);
    }
    rejectSecrets(item);
  }
}
export function entity(value: unknown): Entity {
  if (!['meeting', 'knowledge', 'mode', 'calendar', 'settings', 'folder', 'person', 'scorecard'].includes(String(value))) fail(400, 'invalid_entity', 'Unknown resource entity.');
  return value as Entity;
}
const fields: Record<Entity, string[]> = {
  meeting: ['id','title','startedAt','endedAt','modeId','demo','pinned','transcript','answers','notes','actions','followupDraft','tags','recording','organizationId','consentConfirmed','attendeeIds','calendarEventId','commitments','coaching','usage'],
  knowledge: ['id','title','text','addedAt','size','fileType','folderId','tags','source'],
  mode: ['id','name','instructions','noteTemplate','documentIds','builtIn','assigned','folderId','emailTemplate','customActions'],
  calendar: ['id','title','start','end','description','location','joinUrl','briefing','attendees','source'],
  folder: ['id','name','parentId'],
  person: ['id','name','email','company','role','notes','createdAt','updatedAt'],
  scorecard: ['id','name','instructions','criteria'],
  settings: ['theme','opacity','contentProtection','clickthrough','captureSystem','captureMicrophone','captureScreen','displayId','microphoneDeviceId','language','outputLanguage','model','transcriptionModel','instructions','smartMode','smartModel','smartReasoningEffort','smartWebSearch','smartMaxOutputTokens','autoAssist','launchAtLogin','activeModeId','shortcuts','recordingEnabled','autoNotes','notesTemplate']
};
export function cleanData(kind: Entity, raw: unknown, id: string): Row {
  rejectSecrets(raw); const input = object(raw); const data: Row = {};
  for (const key of Object.keys(input)) if (!fields[kind].includes(key)) fail(400, 'unknown_field', `Unsupported ${kind} field: ${key}.`);
  for (const key of fields[kind]) if (input[key] !== undefined) data[key] = input[key];
  if (kind !== 'settings') data.id = id;
  if (kind === 'meeting') {
    str(data.title,'title',1000); str(data.startedAt,'startedAt',100);
    if (!Number.isFinite(Date.parse(data.startedAt))) fail(400,'invalid_date','startedAt must be an ISO date.');
    if (data.endedAt && (!Number.isFinite(Date.parse(data.endedAt)) || Date.parse(data.endedAt) < Date.parse(data.startedAt))) fail(400,'invalid_date','endedAt must not precede startedAt.');
    for (const key of ['transcript','answers','actions','tags','attendeeIds','commitments','coaching']) if (data[key] !== undefined && !Array.isArray(data[key])) fail(400,'invalid_field',`${key} must be an array.`);
    if (data.transcript) for (const line of data.transcript) { object(line); str(line.id,'transcript.id',128); str(line.text,'transcript.text',100000,false); str(line.timestamp,'transcript.timestamp',100); if (!['system','microphone'].includes(line.source)) fail(400,'invalid_field','Unknown transcript source.'); }
    if (data.recording) { const recording=object(data.recording); if(data.consentConfirmed!==true) fail(400,'consent_required','Confirm recording consent before uploading audio.'); if(!['audio/wav','audio/webm','audio/mp4','audio/mpeg','audio/ogg','audio/x-caf','audio/caf'].includes(recording.contentType)) fail(400,'invalid_recording','Unsupported audio MIME type.'); str(recording.base64,'recording.base64',3_000_000); if(!/^[A-Za-z0-9+/]*={0,2}$/.test(recording.base64) || recording.base64.length%4!==0) fail(400,'invalid_recording','Recording must be base64 audio.'); for(const key of Object.keys(recording)) if(!['contentType','base64','filename'].includes(key)) fail(400,'invalid_recording','Unknown recording field.'); if(recording.filename!==undefined) str(recording.filename,'recording.filename',200); }
    if (data.answers) for (const answer of data.answers) { object(answer); str(answer.id,'answer.id',128); str(answer.text,'answer.text',100000,false); }
  } else if (kind === 'knowledge') { str(data.title,'title',1000); str(data.text,'text',2_000_000,false); }
  else if (kind === 'mode') { if(data.customActions!==undefined){if(!Array.isArray(data.customActions)||data.customActions.length>30)fail(400,'invalid_action','At most 30 custom actions are allowed.');const ids=new Set<string>();for(const raw of data.customActions){const action=object(raw);str(action.id,'action.id',128);str(action.name,'action.name',200);if(ids.has(action.id))fail(400,'invalid_action','Custom action IDs must be unique.');ids.add(action.id);for(const key of Object.keys(action))if(!['id','name','type','prompt','urlTemplate'].includes(key))fail(400,'invalid_action','Unknown custom action field.');if(action.type==='prompt')str(action.prompt,'action.prompt',20000);else if(action.type==='link'){const template=str(action.urlTemplate,'action.urlTemplate',4000);const authority=/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(template)?.[0]??'';if(/\{\{?[A-Za-z]+\}?\}/.test(authority))fail(400,'invalid_action','Action variables cannot change URL authority.');let url:URL;try{url=new URL(template.replace(/\{\{?([A-Za-z]+)\}?\}/g,(_m,name)=>{if(!['sessionTitle','notes','transcript','attendees','question','sessionId','emailDraft'].includes(name))fail(400,'invalid_action','Unknown action variable.');return 'context';}));}catch(error){if(error instanceof ApiError)throw error;fail(400,'invalid_action','Invalid action URL.');}if(url.protocol!=='https:'||url.username||url.password)fail(400,'invalid_action','Action URL requires HTTPS without credentials.');}else fail(400,'invalid_action','Unknown custom action type.');}} str(data.name,'name',200); str(data.instructions,'instructions',100000,false); if (data.documentIds !== undefined && (!Array.isArray(data.documentIds) || !data.documentIds.every((x: unknown) => typeof x === 'string'))) fail(400,'invalid_field','documentIds must be an array of resource IDs.'); }
  else if (kind === 'folder' || kind === 'person') { str(data.name,'name',200);if(kind==='person'&&data.email!==undefined)email(data.email); }
  else if (kind === 'scorecard') {str(data.name,'name',200);str(data.instructions??'','instructions',100000,false);if(!Array.isArray(data.criteria)||data.criteria.length>100)fail(400,'invalid_field','Scorecard criteria must be an array with at most 100 items.');for(const raw of data.criteria){const criterion=object(raw);str(criterion.id,'criterion.id',128);str(criterion.name,'criterion.name',200);str(criterion.description??'','criterion.description',10000,false);if(!Number.isFinite(criterion.maxScore)||criterion.maxScore<=0||criterion.maxScore>1000||!Number.isFinite(criterion.weight)||criterion.weight<0||criterion.weight>1000)fail(400,'invalid_field','Criterion maxScore/weight is out of range.');}}
  else if (kind === 'calendar') { str(data.title,'title',1000); str(data.start,'start',100); str(data.end,'end',100); if (!Number.isFinite(Date.parse(data.start)) || !Number.isFinite(Date.parse(data.end)) || Date.parse(data.end) < Date.parse(data.start)) fail(400,'invalid_date','Invalid calendar date range.'); }
  if(kind==='settings'){if(data.smartModel!==undefined)str(data.smartModel,'smartModel',200);if(data.smartReasoningEffort!==undefined&&!['none','minimal','low','medium','high','xhigh','max'].includes(data.smartReasoningEffort))fail(400,'invalid_field','Unknown Smart reasoning effort.');if(data.smartWebSearch!==undefined)bool(data.smartWebSearch,'smartWebSearch');if(data.smartMaxOutputTokens!==undefined)integer(data.smartMaxOutputTokens,'smartMaxOutputTokens',1024,128000);}
  if(data.source){const source=object(data.source);if(!['google','merge','url'].includes(source.provider))fail(400,'invalid_source','Unknown source provider.');for(const key of Object.keys(source))if(!['provider','connectionId','eventId','calendarId','url','recordId'].includes(key))fail(400,'invalid_source','Unknown source metadata field.');for(const key of Object.keys(source))str(source[key],'source.'+key,2000);}
  if (Buffer.byteLength(JSON.stringify(data)) > 4 * 1024 * 1024) fail(413,'resource_too_large','A resource may not exceed 4 MiB.');
  return data;
}
export class Store {
  db: DatabaseSync;
  resourceHooks:Array<(change:{ownerId:string;entity:Entity;id:string;deleted:boolean;data:Row|null})=>void>=[];pruneHooks:Array<()=>void>=[];private commitEffects:Array<()=>void>|null=null;
  afterCommit(effect:()=>void){if(this.commitEffects)this.commitEffects.push(effect);else effect();}
  constructor(path: string) { if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true }); this.db = new DatabaseSync(path); this.db.exec(schema); }
  get(sql: string, ...args: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...args) as Row | undefined; }
  all(sql: string, ...args: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...args) as Row[]; }
  run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE');this.commitEffects=[];let out:T;try {out=fn();this.db.exec('COMMIT');}catch(error){this.commitEffects=null;this.db.exec('ROLLBACK');throw error;}const effects=this.commitEffects;this.commitEffects=null;for(const effect of effects)effect();return out; }
  user(row: Row) { const verification=this.get('SELECT verified_at FROM verified_emails WHERE user_id=? AND email=?',row.id,row.email);return { emailVerified:!!verification,emailVerifiedAt:verification?.verified_at??null,id: row.id, email: row.email, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at }; }
  principal(token: string): Principal {
    const tokenHash = hash(token);
    const row = this.get('SELECT u.id,u.email,u.name,s.device_id FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?',tokenHash,now());
    if (!row) fail(401,'unauthorized','Sign in to Watson.');
    this.run('UPDATE devices SET last_seen_at=? WHERE id=?',now(),row.device_id);
    return { id:row.id,email:row.email,name:row.name,deviceId:row.device_id,tokenHash };
  }
  issue(user: Row, deviceName: unknown) {
    const device = { id:uuid(), name:typeof deviceName === 'string' ? str(deviceName,'deviceName',200) : 'Watson client',createdAt:now() };
    const token = opaque(); const expiresAt = new Date(Date.now()+30*86400000).toISOString();
    this.transaction(() => { this.run('INSERT INTO devices VALUES(?,?,?,?,?)',device.id,user.id,device.name,device.createdAt,device.createdAt); this.run('INSERT INTO auth_sessions VALUES(?,?,?,?,?)',hash(token),user.id,device.id,expiresAt,now()); });
    return { token,expiresAt,user:this.user(user),device };
  }
  orgRole(userId: string, orgId: string): string {
    const row = this.get('SELECT role FROM org_members WHERE org_id=? AND user_id=?',orgId,userId);
    if (!row) fail(404,'not_found','Organization not found.'); return row.role;
  }
  orgManage(userId: string, orgId: string, adminOnly = false) { const role=this.orgRole(userId,orgId); if (role !== 'admin' && (adminOnly || role !== 'manager')) fail(403,'forbidden',adminOnly ? 'An organization admin is required.' : 'An organization admin or manager is required.'); return role; }
  team(userId: string, teamId: string, write = false): Row {
    const row=this.get('SELECT * FROM teams WHERE id=?',teamId); if (!row) fail(404,'not_found','Team not found.');
    const orgRole=this.orgRole(userId,row.org_id); const member=this.get('SELECT role FROM team_members WHERE team_id=? AND user_id=?',teamId,userId);
    if (orgRole !== 'admin' && (!member || (write && member.role !== 'manager'))) fail(403,'forbidden',write ? 'A team manager or organization admin is required.' : 'Team membership is required.');
    return row;
  }
  scope(userId: string, scopeRaw: unknown, orgRaw: unknown, teamRaw: unknown, write = false) {
    const scope=scopeRaw ?? 'personal'; if (!['personal','org','team'].includes(String(scope))) fail(400,'invalid_scope','Unknown resource scope.');
    if (scope === 'personal') { if (orgRaw || teamRaw) fail(400,'invalid_scope','Personal resources cannot reference an organization or team.'); return {scope:'personal',orgId:null,teamId:null}; }
    const orgId=str(orgRaw,'orgId',128); if (scope === 'org') { if (teamRaw) fail(400,'invalid_scope','Organization resource cannot reference a team.'); write ? this.orgManage(userId,orgId) : this.orgRole(userId,orgId); return {scope:'org',orgId,teamId:null}; }
    const teamId=str(teamRaw,'teamId',128); const team=this.team(userId,teamId,write); if(team.org_id !== orgId) fail(400,'invalid_scope','Team is not in this organization.'); return {scope:'team',orgId,teamId};
  }
  readable(userId: string, row: Row): boolean {
    if (row.scope === 'personal') return row.owner_id === userId;
    const role=this.get('SELECT role FROM org_members WHERE org_id=? AND user_id=?',row.org_id,userId)?.role;
    if(row.entity==='mode')return role==='admin'||(row.scope==='team'&&this.get("SELECT role FROM team_members WHERE team_id=? AND user_id=?",row.team_id,userId)?.role==='manager');
    return !!role && (row.scope === 'org' || role === 'admin' || !!this.get('SELECT 1 FROM team_members WHERE team_id=? AND user_id=?',row.team_id,userId));
  }
  writable(userId: string,row: Row): boolean {
    if (row.scope === 'personal') return row.owner_id === userId;
    const role=this.get('SELECT role FROM org_members WHERE org_id=? AND user_id=?',row.org_id,userId)?.role;
    if(row.entity==='mode')return role==='admin'||(row.scope==='team'&&this.get("SELECT role FROM team_members WHERE team_id=? AND user_id=?",row.team_id,userId)?.role==='manager');
    return role === 'admin' || (row.scope === 'org' ? role === 'manager' : !!this.get("SELECT 1 FROM team_members WHERE team_id=? AND user_id=? AND role='manager'",row.team_id,userId));
  }
  assignedMode(userId:string):Row|null {const row=this.get("SELECT r.* FROM prompt_assignments a JOIN resources r ON r.owner_id=a.owner_id AND r.entity='mode' AND r.id=a.mode_id WHERE a.user_id=? AND r.deleted=0",userId);if(!row)return null;const member=this.get('SELECT 1 FROM org_members WHERE org_id=? AND user_id=?',row.org_id,userId);const teamMember=row.scope!=='team'||this.get('SELECT 1 FROM team_members WHERE team_id=? AND user_id=?',row.team_id,userId);if(!member||!teamMember){this.run('DELETE FROM prompt_assignments WHERE user_id=?',userId);return null;}return this.project(row);}
  resource(userId: string,kind: Entity,id: string,write = false): Row {
    const rows=this.all('SELECT * FROM resources WHERE entity=? AND id=? AND deleted=0',kind,id);
    const row=rows.find(r => this.readable(userId,r)); if (!row) fail(404,'not_found','Resource not found.');
    if (write && !this.writable(userId,row)) fail(403,'forbidden','You cannot change this resource.'); return row;
  }
  project(row: Row) { return {id:row.id,entity:row.entity,ownerId:row.owner_id,revision:row.revision,scope:row.scope,orgId:row.org_id,teamId:row.team_id,updatedAt:row.updated_at,deleted:!!row.deleted,data:row.data ? JSON.parse(row.data) : null}; }
  list(userId: string, kind?: Entity) { return this.all(`SELECT * FROM resources WHERE deleted=0${kind ? ' AND entity=?' : ''} ORDER BY updated_at DESC`,...(kind ? [kind] : [])).filter(row => this.readable(userId,row)).map(row=>this.project(row)); }
  policy(userId: string) {
    const orgs=this.all('SELECT o.id,o.retention_days,o.recording_allowed,o.public_sharing_allowed FROM organizations o JOIN org_members m ON m.org_id=o.id WHERE m.user_id=?',userId);
    return { recordingAllowed:orgs.every(o=>!!o.recording_allowed),publicSharingAllowed:orgs.every(o=>!!o.public_sharing_allowed),retentionDays:orgs.length ? Math.min(...orgs.map(o=>o.retention_days)) : 365,organizations:orgs.map(o=>({id:o.id,retentionDays:o.retention_days,recordingAllowed:!!o.recording_allowed,publicSharingAllowed:!!o.public_sharing_allowed})) };
  }
  validateReferences(userId: string,kind: Entity,data: Row,scope: Row) {
    const refs: {entity:Entity;id:string}[]=[];
    if (data.folderId) refs.push({entity:'folder',id:str(data.folderId,'folderId',128)});
    if (kind === 'folder' && data.parentId) { if(data.parentId===data.id) fail(400,'invalid_reference','Folder cannot be its own parent.'); refs.push({entity:'folder',id:str(data.parentId,'parentId',128)}); }
    if (kind === 'mode') for(const id of data.documentIds ?? []) refs.push({entity:'knowledge',id:str(id,'documentId',128)});
    for(const ref of refs) { const target=this.resource(userId,ref.entity,ref.id); if(scope.scope !== 'personal' && (target.scope === 'personal' || target.org_id !== scope.orgId || (target.scope === 'team' && target.team_id !== scope.teamId))) fail(400,'invalid_reference','Shared resources may reference only documents in their accessible shared scope.'); }
  }
  put(userId: string,kind: Entity,id: string,dataRaw: unknown,expected: number,scopeRaw?: unknown,orgRaw?: unknown,teamRaw?: unknown) {
    str(id,'id',128); integer(expected,'expectedRevision',0,Number.MAX_SAFE_INTEGER);
    let row=this.get('SELECT * FROM resources WHERE owner_id=? AND entity=? AND id=?',userId,kind,id);
    if (!row) { const accessible=this.all('SELECT * FROM resources WHERE entity=? AND id=?',kind,id).find(r=>this.readable(userId,r)); if(accessible) row=accessible; }
    if(row && !this.writable(userId,row)) fail(403,'forbidden','You cannot change this resource.');
    if ((row?.revision ?? 0) !== expected) fail(409,'revision_conflict','Resource has changed on another client.',{current:row ? this.project(row) : null});
    const deleting=dataRaw===null;
    if(deleting && !row) fail(404,'not_found','Resource not found.');
    const requestedScope=scopeRaw ?? row?.scope ?? 'personal';
    const scope=this.scope(userId,requestedScope,orgRaw ?? row?.org_id,teamRaw ?? row?.team_id,true);
    if(row && (scope.scope !== row.scope || scope.orgId !== row.org_id || scope.teamId !== row.team_id)) fail(400,'immutable_scope','Create a new resource to change its sharing scope.');
    if(kind==='mode'&&scope.scope==='org')this.orgManage(userId,scope.orgId!,true);
    if((kind==='meeting'||kind==='calendar'||kind==='settings'||kind==='person') && scope.scope!=='personal') fail(400,'invalid_scope','Only knowledge, folders, and modes may be shared with an organization or team.');
    const source=kind==='settings' && row?.data && dataRaw!==null ? {...JSON.parse(row.data),...object(dataRaw)} : dataRaw;
    const data=deleting ? null : cleanData(kind,source,id);
    if(data) this.validateReferences(userId,kind,data,scope);
    if(kind==='meeting' && data) {
      const policy=this.policy(userId);if(data.organizationId!==undefined)this.orgRole(userId,str(data.organizationId,'organizationId',128));
      if(!policy.recordingAllowed && data.recording) fail(403,'recording_disabled','Your organization disallows recording uploads.');
      if(Date.parse(data.startedAt) < Date.now()-policy.retentionDays*86400000) fail(400,'retention_expired','This meeting is beyond your retention period.');
    }
    const revision=expected+1,updated=now(),owner=row?.owner_id ?? userId;
    this.run('INSERT INTO resources(owner_id,entity,id,revision,data,deleted,updated_at,scope,org_id,team_id) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,entity,id) DO UPDATE SET revision=excluded.revision,data=excluded.data,deleted=excluded.deleted,updated_at=excluded.updated_at',owner,kind,id,revision,data ? JSON.stringify(data) : null,Number(deleting),updated,scope.scope,scope.orgId,scope.teamId);
    if(scope.scope==='personal') this.run('INSERT INTO changes(user_id,entity,resource_id,revision,data,deleted,updated_at) VALUES(?,?,?,?,?,?,?)',owner,kind,id,revision,data ? JSON.stringify(data):null,Number(deleting),updated);
    if(kind==='meeting'&&row?.data&&JSON.parse(row.data).recording&&!data?.recording){this.run("UPDATE changes SET data=json_remove(data,'$.recording') WHERE user_id=? AND entity='meeting' AND resource_id=? AND data IS NOT NULL",owner,id);this.run("DELETE FROM mutations WHERE user_id=? AND json_extract(result,'$.entity')='meeting' AND json_extract(result,'$.id')=?",owner,id);}
    if(deleting) {if(kind==='mode')this.run('DELETE FROM prompt_assignments WHERE owner_id=? AND mode_id=?',owner,id); if(kind==='meeting')this.run('DELETE FROM shares WHERE owner_id=? AND meeting_id=?',owner,id); this.run('UPDATE changes SET data=NULL,deleted=1 WHERE user_id=? AND entity=? AND resource_id=?',owner,kind,id); this.run("DELETE FROM mutations WHERE user_id=? AND json_extract(result,'$.entity')=? AND json_extract(result,'$.id')=?",owner,kind,id); }
    for(const hook of this.resourceHooks)hook({ownerId:owner,entity:kind,id,deleted:deleting,data});
    if(scope.orgId) this.audit(scope.orgId,userId,deleting?'resource.delete':'resource.write',`${kind}:${id}`);
    return this.project(this.get('SELECT * FROM resources WHERE owner_id=? AND entity=? AND id=?',owner,kind,id)!);
  }
  audit(orgId: string, actorId: string,action: string,target: string) { this.run('INSERT INTO audit_events(org_id,actor_id,action,target,occurred_at) VALUES(?,?,?,?,?)',orgId,actorId,action,target,now()); }
  prune() {
    this.transaction(() => {
      this.run('DELETE FROM auth_sessions WHERE expires_at<=?',now()); this.run('DELETE FROM shares WHERE expires_at<=?',now());
      for(const row of this.all("SELECT * FROM resources WHERE entity='meeting' AND deleted=0")) {
        const data=JSON.parse(row.data); const policy=this.policy(row.owner_id);if(!policy.recordingAllowed){this.run("UPDATE changes SET data=json_remove(data,'$.recording') WHERE user_id=? AND entity='meeting' AND resource_id=? AND data IS NOT NULL",row.owner_id,row.id);this.run("DELETE FROM mutations WHERE user_id=? AND json_extract(result,'$.entity')='meeting' AND json_extract(result,'$.id')=? AND json_extract(result,'$.data.recording') IS NOT NULL",row.owner_id,row.id);}
        if(Date.parse(data.startedAt) < Date.now()-policy.retentionDays*86400000) this.put(row.owner_id,'meeting',row.id,null,row.revision);
        else if(!policy.recordingAllowed && data.recording) { this.run("DELETE FROM mutations WHERE user_id=? AND json_extract(result,'$.entity')='meeting' AND json_extract(result,'$.id')=?",row.owner_id,row.id); delete data.recording; this.put(row.owner_id,'meeting',row.id,data,row.revision); for(const change of this.all("SELECT sequence,data FROM changes WHERE user_id=? AND entity='meeting' AND resource_id=? AND data IS NOT NULL",row.owner_id,row.id)) { const historical=JSON.parse(change.data); delete historical.recording; this.run('UPDATE changes SET data=? WHERE sequence=?',JSON.stringify(historical),change.sequence); } }
      }
      for(const share of this.all('SELECT * FROM shares')) if(!this.policy(share.owner_id).publicSharingAllowed) this.run('DELETE FROM shares WHERE token_hash=?',share.token_hash);
    });for(const hook of this.pruneHooks)hook();
  }
}
