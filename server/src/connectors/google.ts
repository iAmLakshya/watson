import { createHash } from 'node:crypto';
import { bool, fail, hash, integer, now, opaque, str, type Principal, type Row } from '../core.ts';
import { ConnectorStorage } from './storage.ts';
import { approvedEndpoint, provider, ProviderError } from './transport.ts';
import type { Connection, Credential } from './types.ts';

const origins=['https://accounts.google.com','https://oauth2.googleapis.com','https://www.googleapis.com'];
const scope='https://www.googleapis.com/auth/calendar.readonly';
export class GoogleCalendarConnector {
  private db:ConnectorStorage;
  constructor(db:ConnectorStorage) {this.db=db;}
  private config() { const config=this.db.options.google;this.db.requireKey();if(!config?.clientId)fail(503,'google_not_configured','The server needs a Google OAuth client ID before connecting Calendar.');return config; }
  start(user:Principal,publicOrigin:string) {
    const config=this.config(),state=opaque(),verifier=opaque()+opaque(),expiresAt=this.db.time()+10*60*1000;
    const redirectUri=config.redirectUri??`${publicOrigin}/api/v1/connectors/google/callback`;
    const redirect=new URL(redirectUri);if(redirect.username||redirect.password||redirect.hash||redirect.protocol!=='https:'&&!['127.0.0.1','localhost','[::1]'].includes(redirect.hostname))fail(503,'invalid_oauth_redirect','Google OAuth redirect must use HTTPS or a loopback address.');
    const digest=hash(state);this.db.store.run('DELETE FROM connector_oauth_states WHERE expires_at<=?',this.db.time());
    this.db.store.run('INSERT INTO connector_oauth_states VALUES(?,?,?,?,?)',digest,user.id,'google',expiresAt,this.db.encrypt({verifier,redirectUri},`oauth:${digest}:${user.id}`));
    const url=approvedEndpoint(config.authorizationUrl??'https://accounts.google.com/o/oauth2/v2/auth',origins,this.db.options);
    for(const [k,v] of Object.entries({client_id:config.clientId,redirect_uri:redirectUri,response_type:'code',scope,access_type:'offline',prompt:'consent',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}))url.searchParams.set(k,v);
    return {authorizationUrl:url.href,expiresAt:new Date(expiresAt).toISOString()};
  }
  async callback(url:URL) {
    const state=str(url.searchParams.get('state'),'state',512),digest=hash(state);
    const row=this.db.store.get('SELECT * FROM connector_oauth_states WHERE state_hash=? AND provider=?',digest,'google');
    if(!row||row.expires_at<=this.db.time()){if(row)this.db.store.run('DELETE FROM connector_oauth_states WHERE state_hash=?',digest);fail(400,'oauth_state_invalid','This calendar authorization expired or was already used. Connect again.');}
    // Consume once before any network await, preventing callback replay and concurrent exchanges.
    this.db.store.run('DELETE FROM connector_oauth_states WHERE state_hash=?',digest);
    if(url.searchParams.has('error'))fail(400,'oauth_access_denied','Calendar authorization was declined.');
    const pending=this.db.decrypt<Row>(row.encrypted,`oauth:${digest}:${row.user_id}`),config=this.config();
    const code=str(url.searchParams.get('code'),'code',4096);
    const token=await this.token({grant_type:'authorization_code',code,redirect_uri:pending.redirectUri,code_verifier:pending.verifier});
    if(token.scope&&!String(token.scope).split(' ').includes(scope))fail(409,'google_scope_missing','Calendar read permission was not granted.');
    const userRow=this.db.store.get('SELECT id,email,name FROM users WHERE id=?',row.user_id);if(!userRow)fail(400,'oauth_state_invalid','This Watson account is unavailable.');
    const user={...userRow,deviceId:'',tokenHash:''} as Principal;
    const credential=this.tokenCredential(token);
    const c=this.db.create(user,'google','calendar',{label:'Google Calendar',settings:{autoSync:false,syncIntervalMinutes:5,nextSyncAt:0}});this.db.saveCredential(c.id,credential);
    // The provider may omit a refresh token if offline consent was not granted; surface it honestly.
    if(!token.refresh_token)this.db.status(c.id,'reconnect_required','offline_access_missing');
    void config;return {connected:true,connection:this.db.public(this.db.connection(user,c.id))};
  }
  private async token(params:Record<string,string>) {
    const c=this.config(),form=new URLSearchParams({...params,client_id:c.clientId});if(c.clientSecret)form.set('client_secret',c.clientSecret);
    return (await provider(approvedEndpoint(c.tokenUrl??'https://oauth2.googleapis.com/token',origins,this.db.options),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form})).data;
  }
  private tokenCredential(token:Row,previous?:Credential):Credential {
    const accessToken=str(token.access_token,'provider.access_token',16384),seconds=Number(token.expires_in??3600);
    if(!Number.isFinite(seconds)||seconds<=0)fail(502,'provider_invalid_response','Google returned an invalid token expiry.');
    return {accessToken,refreshToken:token.refresh_token?str(token.refresh_token,'provider.refresh_token',16384):previous?.refreshToken,expiresAt:this.db.time()+seconds*1000};
  }
  private async access(c:Connection,force=false) {
    const current=this.db.credential(c.id);if(!force&&current.accessToken&&(current.expiresAt??0)>this.db.time()+60000)return current.accessToken;
    if(!current.refreshToken){this.db.status(c.id,'reconnect_required','offline_access_missing');fail(409,'reconnect_required','Reconnect Google Calendar to grant offline access.');}
    try {const token=await this.token({grant_type:'refresh_token',refresh_token:current.refreshToken});const updated=this.tokenCredential(token,current);this.db.saveCredential(c.id,updated);return updated.accessToken!;}
    catch(error){if(error instanceof ProviderError&&['provider_rejected','reconnect_required'].includes(error.code)){this.db.status(c.id,'reconnect_required','refresh_token_invalid');fail(409,'reconnect_required','Google authorization expired. Connect Calendar again.');}throw error;}
  }
  private async get(c:Connection,path:string,params:Record<string,string>={}) {
    const config=this.config(),base=approvedEndpoint(config.calendarBaseUrl??'https://www.googleapis.com/calendar/v3/',origins,this.db.options);
    const url=new URL(path,base.href.endsWith('/')?base.href:base.href+'/');for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
    let token=await this.access(c);try{return (await provider(url,{headers:{Authorization:`Bearer ${token}`}})).data;}
    catch(error){if(!(error instanceof ProviderError)||error.code!=='reconnect_required')throw error;token=await this.access(c,true);return (await provider(url,{headers:{Authorization:`Bearer ${token}`}})).data;}
  }
  async calendars(c:Connection) {
    const items:Row[]=[];let pageToken='';const seen=new Set<string>();
    do {if(seen.has(pageToken)||seen.size>=100)fail(502,'provider_pagination_invalid','Google Calendar pagination did not finish.');seen.add(pageToken);const page=await this.get(c,'users/me/calendarList',{maxResults:'250',...(pageToken?{pageToken}:{}),showDeleted:'true'});if(!Array.isArray(page.items))fail(502,'provider_invalid_response','Google calendar list is invalid.');items.push(...page.items);pageToken=page.nextPageToken??'';}while(pageToken);
    this.db.store.transaction(()=>{
      const ids=new Set(items.filter(x=>!x.deleted).map(x=>str(x.id,'calendar.id',2000)));
      for(const old of this.db.store.all('SELECT calendar_id FROM connector_calendars WHERE connection_id=?',c.id))if(!ids.has(old.calendar_id)){this.db.removeRecords(c,`calendar:${old.calendar_id}`);this.db.store.run('DELETE FROM connector_calendars WHERE connection_id=? AND calendar_id=?',c.id,old.calendar_id);}
      const first=!this.db.store.get('SELECT 1 FROM connector_calendars WHERE connection_id=?',c.id);
      for(const item of items)if(!item.deleted)this.db.store.run('INSERT INTO connector_calendars(connection_id,calendar_id,summary,selected) VALUES(?,?,?,?) ON CONFLICT(connection_id,calendar_id) DO UPDATE SET summary=excluded.summary',c.id,str(item.id,'calendar.id',2000),typeof item.summary==='string'?item.summary.slice(0,1000):item.id,Number(first&&!!item.primary));
    });return this.savedCalendars(c);
  }
  savedCalendars(c:Connection) {return this.db.store.all('SELECT calendar_id AS id,summary,selected FROM connector_calendars WHERE connection_id=? ORDER BY summary',c.id).map(r=>({...r,selected:!!r.selected}));}
  select(c:Connection,input:Row) {
    if(!Array.isArray(input.calendarIds)||input.calendarIds.length>250||input.calendarIds.some((id:unknown)=>typeof id!=='string'))fail(400,'invalid_calendar_selection','calendarIds must be an array of calendar IDs.');
    const ids=new Set<string>(input.calendarIds);for(const id of ids)if(!this.db.store.get('SELECT 1 FROM connector_calendars WHERE connection_id=? AND calendar_id=?',c.id,id))fail(400,'invalid_calendar_selection','Load calendars before selecting them.');
    this.db.store.transaction(()=>{for(const old of this.db.store.all('SELECT * FROM connector_calendars WHERE connection_id=?',c.id)){const selected=ids.has(old.calendar_id);if(!selected&&old.selected)this.db.removeRecords(c,`calendar:${old.calendar_id}`);this.db.store.run('UPDATE connector_calendars SET selected=?,sync_token=CASE WHEN ?=0 THEN NULL ELSE sync_token END WHERE connection_id=? AND calendar_id=?',Number(selected),Number(selected),c.id,old.calendar_id);}});return this.savedCalendars(c);
  }
  configure(c:Connection,input:Row) {const settings={...c.settings};if(input.syncIntervalMinutes!==undefined)settings.syncIntervalMinutes=integer(input.syncIntervalMinutes,'syncIntervalMinutes',5,10080);if(input.autoSync!==undefined)settings.autoSync=bool(input.autoSync,'autoSync');this.db.saveSettings(c,settings);return this.db.public(c);}
  private event(c:Connection,calendarId:string,item:Row):Row|null {
    if(item.status==='cancelled')return null;
    const start=item.start?.dateTime??(item.start?.date?`${item.start.date}T00:00:00.000Z`:undefined),end=item.end?.dateTime??(item.end?.date?`${item.end.date}T00:00:00.000Z`:undefined);
    if(!start||!end||!Number.isFinite(Date.parse(start))||!Number.isFinite(Date.parse(end)))return null;
    const video=(item.conferenceData?.entryPoints??[]).find((p:Row)=>p.entryPointType==='video')?.uri;
    const joinRaw=item.hangoutLink??video;let joinUrl:string|undefined;try{const u=new URL(joinRaw);if(u.protocol==='https:')joinUrl=u.href;}catch{}
    return {id:this.db.resourceId(c,'calendar',`${calendarId}:${item.id}`),title:(item.summary??'Untitled event').slice(0,1000),start,end,description:(item.description??'').slice(0,100000),...(item.location?{location:String(item.location).slice(0,2000)}:{}),...(joinUrl?{joinUrl}:{}),attendees:(item.attendees??[]).filter((a:Row)=>typeof a.email==='string').map((a:Row)=>({email:a.email.slice(0,254),...(a.displayName?{name:String(a.displayName).slice(0,200)}:{})})),source:{provider:'google',connectionId:c.id,eventId:item.id,calendarId}};
  }
  async sync(c:Connection) {
    const selected=this.db.store.all('SELECT * FROM connector_calendars WHERE connection_id=? AND selected=1',c.id);let imported=0,removed=0;
    for(const calendar of selected) {
      const kind=`calendar:${calendar.calendar_id}`;let syncToken=calendar.sync_token as string|null;let reset=false;
      let items:Row[]=[],nextSync:string|undefined;
      for(let attempt=0;attempt<2;attempt++) {
        try {let pageToken='';const seen=new Set<string>();items=[];do{if(seen.has(pageToken)||seen.size>=100)fail(502,'provider_pagination_invalid','Google event pagination did not finish.');seen.add(pageToken);const page=await this.get(c,`calendars/${encodeURIComponent(calendar.calendar_id)}/events`,{maxResults:'2500',singleEvents:'true',showDeleted:'true',...(syncToken?{syncToken}:{}),...(pageToken?{pageToken}:{})});if(!Array.isArray(page.items))fail(502,'provider_invalid_response','Google events response is invalid.');items.push(...page.items);pageToken=page.nextPageToken??'';if(!pageToken)nextSync=page.nextSyncToken;}while(pageToken);break;}
        catch(error){if(error instanceof ProviderError&&error.code==='sync_expired'&&syncToken){this.db.store.transaction(()=>{this.db.removeRecords(c,kind);this.db.store.run('UPDATE connector_calendars SET sync_token=NULL WHERE connection_id=? AND calendar_id=?',c.id,calendar.calendar_id);});syncToken=null;reset=true;continue;}throw error;}
      }
      if(!nextSync)fail(502,'provider_invalid_response','Google did not return a final sync token.');
      this.db.store.transaction(()=>{
        const present=new Set(items.map(x=>String(x.id)));if(!syncToken)for(const old of this.db.records(c,kind))if(!present.has(old.remote_id)){if(old.resource_id)this.db.removeResource(c,old.resource_id);this.db.store.run('DELETE FROM connector_records WHERE connection_id=? AND kind=? AND remote_id=?',c.id,kind,old.remote_id);removed++;}
        for(const raw of items){const remoteId=str(raw.id,'event.id',2000),event=this.event(c,calendar.calendar_id,raw);if(!event){const old=this.db.store.get('SELECT resource_id FROM connector_records WHERE connection_id=? AND kind=? AND remote_id=?',c.id,kind,remoteId);if(old?.resource_id)this.db.removeResource(c,old.resource_id);this.db.store.run('DELETE FROM connector_records WHERE connection_id=? AND kind=? AND remote_id=?',c.id,kind,remoteId);removed++;continue;}
          const existing=this.db.store.get("SELECT revision,data,deleted FROM resources WHERE owner_id=? AND entity='calendar' AND id=?",c.user_id,event.id);
          if(!existing||existing.deleted||existing.data!==JSON.stringify(event))this.db.store.put(c.user_id,'calendar',event.id,event,existing?.revision??0);
          this.db.record(c,kind,remoteId,event,event.id);imported++;
        }this.db.store.run('UPDATE connector_calendars SET sync_token=? WHERE connection_id=? AND calendar_id=?',nextSync!,c.id,calendar.calendar_id);
      });void reset;
    }
    this.db.saveSettings(c,{...c.settings,nextSyncAt:this.db.time()+Number(c.settings.syncIntervalMinutes??5)*60000});this.db.store.run("UPDATE connector_connections SET last_sync=?,last_error=NULL,status='connected' WHERE id=?",now(),c.id);return {imported,removed,calendars:selected.length};
  }
  async disconnect(c:Connection) {
    let revocation='not_available';try{const credential=this.db.credential(c.id),config=this.config(),token=credential.refreshToken??credential.accessToken;if(token){await provider(approvedEndpoint(config.revokeUrl??'https://oauth2.googleapis.com/revoke',origins,this.db.options),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token})});revocation='revoked';}}
    catch{revocation='provider_unavailable';}finally{this.db.disconnect(c);}return {disconnected:true,revocation,localCredentialsDeleted:true};
  }
}
