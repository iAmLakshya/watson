import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { fail, hash, now, object, str, uuid, type Principal, type Row, type Store } from '../core.ts';
import type { Connection, ConnectorOptions, Credential } from './types.ts';

const schema = `
CREATE TABLE IF NOT EXISTS connector_connections (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider TEXT NOT NULL,category TEXT NOT NULL,org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
 team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,label TEXT NOT NULL,status TEXT NOT NULL,
 settings TEXT NOT NULL,last_sync TEXT,last_error TEXT,created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS connector_credentials (
 connection_id TEXT PRIMARY KEY REFERENCES connector_connections(id) ON DELETE CASCADE, encrypted TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS connector_oauth_states (
 state_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider TEXT NOT NULL,expires_at INTEGER NOT NULL,encrypted TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS connector_calendars (
 connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,calendar_id TEXT NOT NULL,
 summary TEXT NOT NULL,selected INTEGER NOT NULL DEFAULT 0,sync_token TEXT,PRIMARY KEY(connection_id,calendar_id)
) STRICT;
CREATE TABLE IF NOT EXISTS connector_records (
 connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,kind TEXT NOT NULL,
 remote_id TEXT NOT NULL,data TEXT NOT NULL,resource_id TEXT,updated_at TEXT NOT NULL,
 PRIMARY KEY(connection_id,kind,remote_id)
) STRICT;
CREATE TABLE IF NOT EXISTS connector_cursors (
 connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,kind TEXT NOT NULL,
 watermark TEXT NOT NULL,PRIMARY KEY(connection_id,kind)
) STRICT;
CREATE TABLE IF NOT EXISTS connector_jobs (
 id TEXT PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
 requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,idempotency_key TEXT NOT NULL,
 payload_hash TEXT NOT NULL,encrypted TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
 due_at INTEGER NOT NULL,remote_id TEXT,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(connection_id,idempotency_key)
) STRICT;
CREATE TABLE IF NOT EXISTS connector_previews (
 token_hash TEXT PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
 requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,fingerprint TEXT NOT NULL,encrypted TEXT NOT NULL,
 expires_at INTEGER NOT NULL,consumed_key TEXT,created_at TEXT NOT NULL
) STRICT;`;

export class ConnectorStorage {
  private key?: Buffer;
  store:Store; options:ConnectorOptions;
  constructor(store: Store, options: ConnectorOptions) {
    this.store=store;this.options=options;
    store.db.exec(schema);
    if (options.encryptionKey) { this.key=Buffer.from(options.encryptionKey,'base64'); if(this.key.length!==32) throw new Error('Connector encryption key must be 32 bytes in base64.'); }
    // A terminated process cannot know whether a remote write completed. Never resend it automatically.
    store.run("UPDATE connector_jobs SET status='uncertain',last_error='process_interrupted' WHERE status='running'");
  }
  time() { return this.options.clock?.() ?? Date.now(); }
  configured() { return !!this.key; }
  requireKey() { if(!this.key) fail(503,'connector_not_configured','The server needs WATSON_CONNECTOR_ENCRYPTION_KEY before connecting accounts.'); return this.key; }
  encrypt(value: unknown, binding: string) {
    const iv=randomBytes(12); const actual=createCipheriv('aes-256-gcm',this.requireKey(),iv);
    actual.setAAD(Buffer.from(binding)); const content=Buffer.concat([actual.update(JSON.stringify(value),'utf8'),actual.final()]);
    return [iv,actual.getAuthTag(),content].map(b=>b.toString('base64url')).join('.');
  }
  decrypt<T=Row>(value: string,binding: string): T {
    try { const [iv,tag,content]=value.split('.').map(b=>Buffer.from(b,'base64url'));const cipher=createDecipheriv('aes-256-gcm',this.requireKey(),iv);cipher.setAAD(Buffer.from(binding));cipher.setAuthTag(tag);return JSON.parse(Buffer.concat([cipher.update(content),cipher.final()]).toString('utf8')) as T; }
    catch { fail(503,'credential_unavailable','Stored connector credentials cannot be decrypted with this server key.'); }
  }
  saveCredential(id: string,value: Credential) { this.store.run('INSERT INTO connector_credentials VALUES(?,?) ON CONFLICT(connection_id) DO UPDATE SET encrypted=excluded.encrypted',id,this.encrypt(value,`credential:${id}`)); }
  credential(id: string) { const row=this.store.get('SELECT encrypted FROM connector_credentials WHERE connection_id=?',id);if(!row)fail(409,'reconnect_required','Reconnect this account.');return this.decrypt<Credential>(row.encrypted,`credential:${id}`); }
  create(user: Principal,provider: Connection['provider'],category: string,input: Row={}) {
    let orgId:string|null=null,teamId:string|null=null;
    if(input.orgId!==undefined) { orgId=str(input.orgId,'orgId',128);this.store.orgManage(user.id,orgId,true); }
    if(input.teamId!==undefined) { if(!orgId)fail(400,'invalid_scope','A team connector requires its organization.');teamId=str(input.teamId,'teamId',128);const team=this.store.team(user.id,teamId,true);if(team.org_id!==orgId)fail(400,'invalid_scope','Team belongs to another organization.'); }
    if(provider==='merge'&&!orgId)fail(400,'organization_required','CRM and ATS connectors require an organization admin.');
    const id=uuid();this.store.run('INSERT INTO connector_connections VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,user.id,provider,category,orgId,teamId,input.label?str(input.label,'label',200):provider,'connected',JSON.stringify(input.settings??{}),null,null,now());
    return this.connection(user,id,true);
  }
  parse(row:Row):Connection { return {...row,settings:JSON.parse(row.settings)} as Connection; }
  can(user: Principal,c: Connection,write=false) {
    if(!c.org_id) { if(c.user_id!==user.id)fail(404,'not_found','Connector not found.');return; }
    if(write) { this.store.orgManage(user.id,c.org_id,true);if(c.team_id)this.store.team(user.id,c.team_id,true); }
    else { this.store.orgRole(user.id,c.org_id);if(c.team_id)this.store.team(user.id,c.team_id); }
  }
  connection(user: Principal,id:string,write=false) { const row=this.store.get('SELECT * FROM connector_connections WHERE id=?',str(id,'connectionId',128));if(!row)fail(404,'not_found','Connector not found.');const c=this.parse(row);this.can(user,c,write);return c; }
  list(user:Principal) { return this.store.all('SELECT * FROM connector_connections ORDER BY created_at').map(r=>this.parse(r)).filter(c=>{try{this.can(user,c);return true;}catch{return false;}}); }
  public(c:Connection) { return {id:c.id,provider:c.provider,category:c.category,orgId:c.org_id,teamId:c.team_id,label:c.label,status:c.status,settings:c.settings,lastSync:c.last_sync,lastError:c.last_error,createdAt:c.created_at}; }
  status(id:string,status:string,error:string|null=null) {this.store.run('UPDATE connector_connections SET status=?,last_error=? WHERE id=?',status,error,id);}
  record(c:Connection,kind:string,remoteId:string,data:Row,resourceId?:string) {this.store.run('INSERT INTO connector_records VALUES(?,?,?,?,?,?) ON CONFLICT(connection_id,kind,remote_id) DO UPDATE SET data=excluded.data,resource_id=excluded.resource_id,updated_at=excluded.updated_at',c.id,kind,remoteId,JSON.stringify(data),resourceId??null,now());}
  records(c:Connection,kind?:string):Row[] {return this.store.all(`SELECT * FROM connector_records WHERE connection_id=?${kind?' AND kind=?':''}`,c.id,...(kind?[kind]:[])).map((r):Row=>({...r,data:JSON.parse(r.data)}));}
  removeResource(c:Connection,id:string) {
    const row=this.store.get("SELECT * FROM resources WHERE id=? AND deleted=0 AND json_extract(data,'$.source.connectionId')=?",id,c.id);if(!row)return;
    // Provenance-bound internal cleanup must remain possible after the original importer loses membership.
    const updated=now(),revision=row.revision+1;
    this.store.run('UPDATE resources SET data=NULL,deleted=1,revision=?,updated_at=? WHERE owner_id=? AND entity=? AND id=?',revision,updated,row.owner_id,row.entity,id);
    if(row.scope==='personal')this.store.run('INSERT INTO changes(user_id,entity,resource_id,revision,data,deleted,updated_at) VALUES(?,?,?,?,NULL,1,?)',row.owner_id,row.entity,id,revision,updated);
    this.store.run('UPDATE changes SET data=NULL,deleted=1 WHERE user_id=? AND entity=? AND resource_id=?',row.owner_id,row.entity,id);
    this.store.run("DELETE FROM mutations WHERE user_id=? AND json_extract(result,'$.entity')=? AND json_extract(result,'$.id')=?",row.owner_id,row.entity,id);
  }
  removeRecords(c:Connection,kind?:string) { for(const r of this.records(c,kind))if(r.resource_id)this.removeResource(c,r.resource_id);this.store.run(`DELETE FROM connector_records WHERE connection_id=?${kind?' AND kind=?':''}`,c.id,...(kind?[kind]:[])); }
  disconnect(c:Connection) { const remove=()=>{this.removeRecords(c);this.store.run('DELETE FROM connector_connections WHERE id=?',c.id);this.store.run('DELETE FROM connector_oauth_states WHERE user_id=? AND provider=?',c.user_id,c.provider);};if(this.store.db.isTransaction)remove();else this.store.transaction(remove); }
  cleanupUser(userId:string) { for(const row of this.store.all('SELECT * FROM connector_connections WHERE user_id=?',userId))this.disconnect(this.parse(row));this.store.run('DELETE FROM connector_oauth_states WHERE user_id=?',userId); }
  saveSettings(c:Connection,settings:Row) { this.store.run('UPDATE connector_connections SET settings=? WHERE id=?',JSON.stringify(object(settings)),c.id);c.settings=settings; }
  resourceId(c:Connection,kind:string,id:string) {return `connector-${hash(`${c.id}:${kind}:${id}`).slice(0,48)}`;}
}
