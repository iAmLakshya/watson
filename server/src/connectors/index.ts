import { ApiError, fail, str, type Principal, type Row, type Store } from '../core.ts';
import type { ExtensionContext, RouteExtension } from '../extensions.ts';
import { ConnectorStorage } from './storage.ts';
import { GoogleCalendarConnector } from './google.ts';
import { MergeConnector } from './merge.ts';
import { UrlKnowledgeConnector } from './urls.ts';
import type { Connection, ConnectorOptions } from './types.ts';
export type { ConnectorOptions } from './types.ts';

export class ConnectorService {
  db:ConnectorStorage;google:GoogleCalendarConnector;merge:MergeConnector;urls:UrlKnowledgeConnector;
  private active=new Set<string>();
  constructor(store:Store,options:ConnectorOptions={}) {this.db=new ConnectorStorage(store,options);this.google=new GoogleCalendarConnector(this.db);this.merge=new MergeConnector(this.db);this.urls=new UrlKnowledgeConnector(this.db);}
  busy(id:string) {return this.active.has(id);}
  async exclusive<T>(c:Connection,fn:()=>Promise<T>):Promise<T> {if(this.active.has(c.id))fail(409,'connector_busy','This connector already has a request in progress.');this.active.add(c.id);try{return await fn();}catch(error){this.db.status(c.id,error instanceof ApiError&&error.code==='reconnect_required'?'reconnect_required':'error',error instanceof ApiError?error.code:'provider_unavailable');throw error;}finally{this.active.delete(c.id);}}
  availability() {return {encryptionConfigured:this.db.configured(),googleConfigured:this.db.configured()&&!!this.db.options.google?.clientId,mergeConfigured:this.db.configured()&&!!this.db.options.merge?.apiKey,liveLinksConfigured:true};}
  context(user:Principal,query='',email?:string) {const sources:Row[]=[];const people:Row[]=[];for(const c of this.db.list(user)){if(c.provider==='merge'){for(const r of this.merge.records(c,query))sources.push({id:this.db.resourceId(c,r.kind,r.id),title:r.name,text:r.text,sourceUrl:r.sourceUrl,connectionId:c.id,provider:'merge',orgId:c.org_id,teamId:c.team_id});if(email)people.push(...this.merge.match(c,email).map(r=>({...r,connectionId:c.id})));}else if(c.provider==='url')for(const r of this.db.records(c,'knowledge'))if(!query||r.data.text.toLowerCase().includes(query.toLowerCase()))sources.push(r.data);}return {documents:sources,people};}
  async sync(c:Connection,full=false,actorId=c.user_id):Promise<Row> {return this.exclusive<Row>(c,()=>c.provider==='google'?this.google.sync(c):c.provider==='merge'?this.merge.sync(c,full):this.urls.sync(c,actorId));}
  async disconnect(c:Connection) {return this.exclusive(c,()=>c.provider==='google'?this.google.disconnect(c):c.provider==='merge'?this.merge.disconnect(c):Promise.resolve(this.urls.disconnect(c)));}
  cleanupUser(userId:string) {this.db.cleanupUser(userId);}
}

/** Mount before built-in routes; callback consumes a user-bound one-time state and all other routes authenticate. */
const serviceInstances=new WeakMap<Store,ConnectorService>();
function instance(store:Store,options:ConnectorOptions) {let service=serviceInstances.get(store);if(!service){service=new ConnectorService(store,options);serviceInstances.set(store,service);}return service;}
export function createConnectorContextProvider(options:ConnectorOptions={}) {
  return async(store:Store,user:Principal,query:string):Promise<Row>=>{const context=instance(store,options).context(user,query);return {documents:context.documents.filter(d=>d.provider==='merge'),people:context.people};};
}
export function cleanupConnectorUser(store:Store,userId:string,options:ConnectorOptions={}) {instance(store,options).cleanupUser(userId);}
/** Poll only runtime-enabled syncs and explicitly authorized persisted write jobs. Stop drains a live tick before SQLite closes. */
export function createConnectorWorker(store:Store,options:ConnectorOptions={}) {
  let timer:ReturnType<typeof setInterval>|undefined,running:Promise<void>|undefined;
  const tick=()=>{
    if(running)return running;
    running=(async()=>{
      const service=instance(store,options);
      for(const raw of store.all('SELECT * FROM connector_connections')){
        const c=service.db.parse(raw);if(service.busy(c.id))continue;
        if(c.provider==='merge'&&store.get("SELECT 1 FROM connector_jobs WHERE connection_id=? AND status IN('queued','retry') AND due_at<=?",c.id,service.db.time()))try{await service.exclusive(c,()=>service.merge.runJobs(c));}catch{}
        if(c.settings.autoSync!==true||Number(c.settings.nextSyncAt??0)>service.db.time()||c.status==='reconnect_required')continue;
        const row=store.get('SELECT id,email,name FROM users WHERE id=?',c.user_id);if(!row)continue;const user={...row,deviceId:'',tokenHash:''} as Principal;
        try{service.db.can(user,c,true);await service.sync(c,false,user.id);}catch(error){service.db.status(c.id,'error',error instanceof ApiError?error.code:'provider_unavailable');service.db.saveSettings(c,{...c.settings,nextSyncAt:service.db.time()+Math.max(5,Number(c.settings.syncIntervalMinutes??60))*60000});}
      }
    })().finally(()=>{running=undefined;});return running;
  };
  return {tick,start(){if(!timer){timer=setInterval(()=>{void tick().catch(()=>{});},30000);timer.unref();}},async stop(){if(timer){clearInterval(timer);timer=undefined;}await running;}};
}
export function createConnectorExtension(options:ConnectorOptions={}):RouteExtension {
  return async(ctx:ExtensionContext)=>{
    if(ctx.segments[0]!=='connectors')return false;
    const service=instance(ctx.store,options);
    const {req,url,segments}=ctx,method=req.method??'GET',path=segments.slice(1).join('/');
    if(method==='GET'&&path==='google/callback'){
      const result=await service.google.callback(url);
      if(String(req.headers.accept??'').includes('text/html')){ctx.res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});ctx.res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google Calendar connected — Watson</title><main><h1>Google Calendar connected</h1><p>Return to Watson to choose your calendars and synchronize upcoming meetings. You can close this window.</p></main></html>');}
      else ctx.send(200,result);return true;
    }
    const user=ctx.authenticate();
    if(method==='GET'&&path==='status'){ctx.send(200,{...service.availability(),connections:service.db.list(user).map(c=>service!.db.public(c))});return true;}
    if(method==='GET'&&path==='context'){ctx.send(200,service.context(user,url.searchParams.get('q')??'',url.searchParams.get('email')??undefined));return true;}
    if(method==='POST'&&path==='google/start'){ctx.send(201,service.google.start(user,ctx.publicOrigin));return true;}
    if(method==='POST'&&path==='merge/link'){ctx.send(201,await service.merge.link(user,await ctx.readJson()));return true;}
    if(method==='POST'&&path==='merge/exchange'){ctx.send(201,await service.merge.exchange(user,await ctx.readJson()));return true;}
    if(method==='POST'&&path==='merge/connect'){ctx.send(201,{connection:await service.merge.connect(user,await ctx.readJson())});return true;}
    if(method==='POST'&&path==='urls'){ctx.send(201,{connection:service.urls.create(user,await ctx.readJson())});return true;}
    if(method==='POST'&&path==='sync-due'){const output=[];for(const c of service.db.list(user)){if(c.settings.autoSync!==true||Number(c.settings.nextSyncAt??0)>service.db.time())continue;try{service.db.can(user,c,true);output.push({connectionId:c.id,...await service.sync(c,false,user.id)});}catch(error){output.push({connectionId:c.id,error:error instanceof ApiError?error.code:'provider_unavailable'});}}ctx.send(200,{results:output});return true;}
    if(segments.length>=2){const id=segments[1];const mutating=method!=='GET',c=service.db.connection(user,id,mutating);
      if(segments.length===2&&method==='DELETE'){ctx.send(200,await service.disconnect(c));return true;}
      if(segments.length===3&&segments[2]==='sync'&&method==='POST'){const input=await ctx.readJson();ctx.send(200,await service.sync(c,input.full===true,user.id));return true;}
      if(segments.length===3&&segments[2]==='settings'&&method==='PATCH'){const input=await ctx.readJson();if(c.provider==='merge')ctx.send(200,{connection:service.merge.configure(c,input)});else if(c.provider==='url')ctx.send(200,{connection:service.urls.configure(c,input)});else ctx.send(200,{connection:service.google.configure(c,input)});return true;}
      if(c.provider==='google'&&segments.length===3&&segments[2]==='calendars'){if(method==='GET')ctx.send(200,{calendars:await service.exclusive(c,()=>service!.google.calendars(c))});else if(method==='PUT')ctx.send(200,{calendars:service.google.select(c,await ctx.readJson())});else fail(405,'method_not_allowed','Use GET or PUT.');return true;}
      if(c.provider==='merge'){
        if(method==='GET'&&segments.length===3&&segments[2]==='records'){ctx.send(200,{records:service.merge.records(c,url.searchParams.get('q')??'',url.searchParams.get('kind')??undefined)});return true;}
        if(method==='GET'&&segments.length===3&&segments[2]==='match'){ctx.send(200,{matches:service.merge.match(c,str(url.searchParams.get('email'),'email',254))});return true;}
        if(method==='GET'&&segments.length===3&&segments[2]==='health'){ctx.send(200,await service.exclusive(c,()=>service!.merge.health(c)));return true;}
        if(method==='GET'&&segments.length===3&&segments[2]==='field-mappings'){ctx.send(200,await service.exclusive(c,()=>service!.merge.fieldMappings(c)));return true;}
        if(method==='GET'&&segments.length===3&&['remote-fields','target-fields'].includes(segments[2])){ctx.send(200,await service.exclusive(c,()=>service!.merge.fields(c,segments[2] as 'remote-fields'|'target-fields')));return true;}
        if(method==='POST'&&segments.length===3&&segments[2]==='field-mappings'){const input=await ctx.readJson();ctx.send(201,await service.exclusive(c,()=>service!.merge.changeFieldMapping(c,input,'POST')));return true;}
        if(['PATCH','DELETE'].includes(method)&&segments.length===4&&segments[2]==='field-mappings'){const input=await ctx.readJson();ctx.send(200,await service.exclusive(c,()=>service!.merge.changeFieldMapping(c,input,method as 'PATCH'|'DELETE',segments[3])));return true;}
        if(method==='POST'&&segments.length===4&&segments[2]==='writeback'&&segments[3]==='preview'){ctx.send(200,service.merge.preview(user,c,await ctx.readJson()));return true;}
        if(method==='POST'&&segments.length===3&&segments[2]==='writeback'){ctx.send(202,service.merge.enqueue(user,c,await ctx.readJson()));return true;}
        if(method==='GET'&&segments.length===3&&segments[2]==='jobs'){ctx.send(200,{jobs:service.merge.jobs(c)});return true;}
        if(method==='POST'&&segments.length===4&&segments[2]==='jobs'&&segments[3]==='run'){ctx.send(200,{jobs:await service.exclusive(c,()=>service!.merge.runJobs(c))});return true;}
        if(method==='POST'&&segments.length===5&&segments[2]==='jobs'&&segments[4]==='retry'){ctx.send(200,{job:service.merge.retry(c,segments[3],await ctx.readJson())});return true;}
      }
    }fail(404,'not_found','Connector route not found.');
  };
}

export function connectorOptionsFromEnvironment():ConnectorOptions {
  return {encryptionKey:process.env.WATSON_CONNECTOR_ENCRYPTION_KEY,...(process.env.WATSON_GOOGLE_CLIENT_ID?{google:{clientId:process.env.WATSON_GOOGLE_CLIENT_ID,clientSecret:process.env.WATSON_GOOGLE_CLIENT_SECRET,redirectUri:process.env.WATSON_GOOGLE_REDIRECT_URI}}:{}),...(process.env.WATSON_MERGE_API_KEY?{merge:{apiKey:process.env.WATSON_MERGE_API_KEY,baseUrl:process.env.WATSON_MERGE_REGION==='eu'?'https://api-eu.merge.dev/':process.env.WATSON_MERGE_REGION==='apac'?'https://api-apac.merge.dev/':'https://api.merge.dev/'}}:{})};
}
