import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { CloudAnalyticsExport, CloudAnalyticsInput, CloudAnalyticsMetrics, CloudAnalyticsReport, CloudApplyRecord, CloudAssignedLinkInput, CloudAssignmentAction, CloudAssistantInput, CloudAssistantResult, CloudAuthCapabilities, CloudConnectedDocument, CloudConnectorAction, CloudConnectorResult, CloudConflict, CloudEmailActionResult, CloudEnterpriseAction, CloudEntity, CloudLocalData, CloudManagedSmartStatus, CloudOrgAction, CloudOrgResult, CloudPolicy, CloudRecord, CloudRecordKey, CloudRecordingCapabilities, CloudRecordingMetadata, CloudRecordingSelection, CloudRecordingsState, CloudShare, CloudStatus, CloudUser } from '../shared/cloud-types';

export interface CloudSecretStorage { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string; }
export interface CloudClientOptions {
  directory: string; secretStorage: CloudSecretStorage; getLocal: () => CloudLocalData;
  applyRemote: (records: CloudApplyRecord[]) => void | Promise<void>; onChange?: () => void; fetch?: typeof fetch;
}
interface Binding { revision: number; base: Record<string, unknown> | null; }
interface Mutation extends CloudRecordKey { expectedRevision: number; data: Record<string, unknown> | null; changeId: string; }
interface Profile { user: CloudUser; cursor: number; bindings: Record<string, Binding>; conflicts: CloudConflict[]; pending: Mutation[]; shares: CloudShare[]; shared: CloudRecord[]; organizations: CloudStatus['organizations']; policy?: CloudPolicy; lastSyncAt?: string; assignedMode?:CloudRecord;connectedDocuments?:CloudConnectedDocument[];assistantConfigured?:boolean;webResearchConfigured?:boolean;managedSmart?:CloudManagedSmartStatus; }
interface SavedCloud { schemaVersion: 1; endpoint: string; active?: string; profiles: Record<string, Profile>; auth?: { profile: string; encryptedToken: string; deviceId: string; expiresAt: string }; }
interface AuthReply { token: string; expiresAt: string; user: CloudUser; device: { id: string }; }
const fields: Record<CloudEntity, readonly string[]> = {
  meeting: ['id','title','startedAt','endedAt','modeId','demo','pinned','transcript','answers','notes','actions','followupDraft','tags','attendeeIds','calendarEventId','commitments','coaching','usage','organizationId'],
  knowledge: ['id','title','text','addedAt','size','fileType','folderId','tags','source'],
  mode: ['id','name','instructions','noteTemplate','documentIds','builtIn','emailTemplate','customActions','assigned','folderId'],
  calendar: ['id','title','start','end','description','location','joinUrl','briefing','attendees','source'],
  // Capture and privacy settings, device selection, shortcuts and credentials always stay on this device.
  settings: ['theme','language','outputLanguage','model','transcriptionModel','instructions','smartMode','activeModeId','smartModel','smartReasoningEffort','smartWebSearch','smartMaxOutputTokens'],
  folder: ['id','name','parentId'],
  person: ['id','name','email','company','role','notes','createdAt','updatedAt'],
  scorecard: ['id','name','instructions','criteria'],
};
const collection = { meeting: 'sessions', knowledge: 'knowledge', mode: 'modes', calendar: 'calendar', person:'people', scorecard:'scorecards',folder:'folders' } as const;
const keyOf = ({entity,id}:CloudRecordKey) => `${entity}:${id}`;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value,key);
const plain = (value:unknown):value is Record<string,unknown> => !!value && typeof value==='object' && !Array.isArray(value);
function key(value:unknown):CloudRecordKey {
  if(!plain(value) || typeof value.entity!=='string' || !own(fields,value.entity) || typeof value.id!=='string' || !value.id || value.id.length>128) throw new Error('Invalid cloud record.');
  return {entity:value.entity as CloudEntity,id:value.id};
}
function secretFree(value:unknown):unknown {
  if(Array.isArray(value)) return Array.from(value,item=>item===undefined?null:secretFree(item));
  if(!plain(value)) return value;
  const out:Record<string,unknown>={};
  for(const [name,item] of Object.entries(value)) {
    if(item===undefined)continue;
    const compact=name.replace(/[^a-z]/gi,'').toLowerCase();
    if(['__proto__','prototype','constructor'].includes(name) || ['apikey','openaikey','deepgramkey','credentials','credential','encryptedkeys','encryptedcredentials','password','passwordhash','accesstoken','refreshtoken','authtoken','accounttoken','publictoken','linktoken','requestsecret','encrypted','encryptedpayload','pkceverifier','codeverifier','clientsecret','authorization','token','secret','environment'].includes(compact) || compact.endsWith('apikey') || compact.endsWith('token')) continue;
    out[name]=secretFree(item);
  }
  return out;
}
export function cloudData(entity:CloudEntity, raw:unknown, id:string):Record<string,unknown> {
  if(!plain(raw)) throw new Error('Cloud records must contain an object.');
  const out:Record<string,unknown>={};
  for(const name of fields[entity]) if(own(raw,name) && raw[name]!==undefined) out[name]=secretFree(raw[name]);
  if(entity!=='settings') out.id=id;
  return out;
}
function stable(value:unknown):string {
  if(Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if(plain(value)) return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const same=(a:unknown,b:unknown)=>stable(a)===stable(b);
function cloudUser(raw:unknown):CloudUser {
  if(!plain(raw) || typeof raw.id!=='string' || typeof raw.email!=='string' || typeof raw.name!=='string')throw new Error('Invalid account response.');
  if(raw.emailVerified!==undefined && typeof raw.emailVerified!=='boolean')throw new Error('Invalid account verification status.');
  if(raw.emailVerifiedAt!==undefined && raw.emailVerifiedAt!==null && (typeof raw.emailVerifiedAt!=='string' || !Number.isFinite(Date.parse(raw.emailVerifiedAt))))throw new Error('Invalid verification timestamp.');
  return {id:raw.id,email:raw.email,name:raw.name,createdAt:typeof raw.createdAt==='string'?raw.createdAt:undefined,updatedAt:typeof raw.updatedAt==='string'?raw.updatedAt:undefined,emailVerified:typeof raw.emailVerified==='boolean'?raw.emailVerified:undefined,emailVerifiedAt:raw.emailVerifiedAt===null?null:typeof raw.emailVerifiedAt==='string'?raw.emailVerifiedAt:undefined};
}
export function cloudLanguage(value?:string):string|undefined {
  if(value===undefined)return undefined;const language=value.trim();const labels:Record<string,string>={english:'en',hindi:'hi',spanish:'es',french:'fr',german:'de',portuguese:'pt',japanese:'ja',chinese:'zh',korean:'ko',italian:'it',arabic:'ar',russian:'ru',turkish:'tr',dutch:'nl',swedish:'sv',polish:'pl',ukrainian:'uk',vietnamese:'vi',bengali:'bn',tamil:'ta',telugu:'te',urdu:'ur',marathi:'mr',punjabi:'pa',greek:'el',hebrew:'he',indonesian:'id',malay:'ms',thai:'th',danish:'da',norwegian:'no',finnish:'fi',czech:'cs',romanian:'ro',hungarian:'hu',swahili:'sw',persian:'fa',filipino:'fil','detect automatically':'auto',automatic:'auto',auto:'auto'};
  const result=labels[language.toLowerCase()]??language;if(result!=='auto'&&!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(result))throw new Error('For organization responses, use a standard language name or language tag such as en or es.');return result;
}
export function cloudAnalyticsQuery(input:CloudAnalyticsInput):string {
  if(!plain(input))throw new Error('Choose report filters.');
  if(typeof input.orgId!=='string' || !input.orgId.trim() || input.orgId.length>128)throw new Error('Choose an organization for this report.');
  const query=new URLSearchParams();
  for(const field of ['from','to'] as const){const value=input[field];if(value===undefined)continue;if(typeof value!=='string' || value.length>100 || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) || !Number.isFinite(Date.parse(value)) || (/^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value).toISOString().slice(0,10)!==value))throw new Error(`Choose a valid ${field==='from'?'start':'end'} date.`);query.set(field,value);}
  if(input.from && input.to && Date.parse(input.from)>Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(input.to)?`${input.to}T23:59:59.999Z`:input.to))throw new Error('The report end date must follow its start date.');
  for(const field of ['teamId','userId'] as const){const value=input[field];if(value===undefined)continue;if(typeof value!=='string' || !value.trim() || value.length>128)throw new Error('Choose a valid report filter.');query.set(field,value);}
  if(input.includeDemo!==undefined && typeof input.includeDemo!=='boolean')throw new Error('The demo report filter must be true or false.');query.set('includeDemo',String(input.includeDemo===true));return query.toString();
}
function analyticsReport(raw:unknown):CloudAnalyticsReport {
  const item=(value:unknown)=>{if(!plain(value))throw new Error('The server returned an invalid organization report.');return value;};
  const text=(value:unknown,max=10000)=>{if(typeof value!=='string' || value.length>max)throw new Error('The server returned an invalid report label.');return value;};
  const number=(value:unknown)=>{if(typeof value!=='number' || !Number.isFinite(value) || value<0)throw new Error('The server returned an invalid report measurement.');return value;};
  const count=(value:unknown)=>{const result=number(value);if(!Number.isSafeInteger(result))throw new Error('The server returned an invalid report count.');return result;};
  const optionalNumber=(value:unknown)=>value===null?null:number(value);
  const optionalText=(value:unknown)=>value===null?null:text(value);
  const boolean=(value:unknown)=>{if(typeof value!=='boolean')throw new Error('The server returned an invalid report scope.');return value;};
  const list=(value:unknown,max=10000)=>{if(!Array.isArray(value) || value.length>max)throw new Error('The server returned an invalid report list.');return value;};
  const metric=(raw:unknown):CloudAnalyticsMetrics=>{const m=item(raw);return {sessions:count(m.sessions),liveSessions:count(m.liveSessions),demoSessions:count(m.demoSessions),wallSeconds:optionalNumber(m.wallSeconds),capturedSeconds:optionalNumber(m.capturedSeconds),microphoneSeconds:optionalNumber(m.microphoneSeconds),systemSeconds:optionalNumber(m.systemSeconds),providerRequests:optionalNumber(m.providerRequests),inputTokens:optionalNumber(m.inputTokens),outputTokens:optionalNumber(m.outputTokens),screenshots:optionalNumber(m.screenshots),answers:optionalNumber(m.answers),completedAnswers:optionalNumber(m.completedAnswers),failedAnswers:optionalNumber(m.failedAnswers),knowledgeReferences:optionalNumber(m.knowledgeReferences),webReferences:optionalNumber(m.webReferences),averageLatencyMs:optionalNumber(m.averageLatencyMs),averageFirstTextLatencyMs:m.averageFirstTextLatencyMs===undefined?undefined:optionalNumber(m.averageFirstTextLatencyMs),averageCompletionLatencyMs:m.averageCompletionLatencyMs===undefined?undefined:optionalNumber(m.averageCompletionLatencyMs),firstTextSamples:m.firstTextSamples===undefined?undefined:count(m.firstTextSamples),completionLatencySamples:m.completionLatencySamples===undefined?undefined:count(m.completionLatencySamples),coachingScore:optionalNumber(m.coachingScore)};};
  const root=item(raw),range=item(root.dateRange),filters=item(root.filters),allowed=item(root.allowedFilters),events=item(root.usageEvents),missing=item(root.missingMeasurements),source=item(root.source),adoption=item(root.adoption);
  const totals:Record<string,number>={};for(const [kind,value] of Object.entries(item(events.totals))){if(['__proto__','prototype','constructor'].includes(kind))throw new Error('The server returned an invalid report activity.');totals[text(kind,100)]=number(value);}
  return {orgId:text(root.orgId,128),generatedAt:text(root.generatedAt,100),dateRange:{from:text(range.from,100),to:text(range.to,100)},filters:{...(filters.teamId===undefined?{}:{teamId:text(filters.teamId,128)}),...(filters.userId===undefined?{}:{userId:text(filters.userId,128)}),includeDemo:boolean(filters.includeDemo)},allowedFilters:{organizationWide:boolean(allowed.organizationWide),ownOnly:boolean(allowed.ownOnly),teams:list(allowed.teams).map(raw=>{const value=item(raw);return {id:text(value.id,128),name:text(value.name,200)};}),members:list(allowed.members).map(raw=>{const value=item(raw);return {id:text(value.id,128),name:text(value.name,200),email:text(value.email,254)};})},summary:metric(root.summary),series:list(root.series,10000).map(raw=>{const value=item(raw);return {date:text(value.date,20),metrics:metric(value.metrics),usageEventCount:count(value.usageEventCount),activeMembers:count(value.activeMembers)};}),byMember:list(root.byMember).map(raw=>{const value=item(raw);return {userId:text(value.userId,128),name:text(value.name,200),email:text(value.email,254),teamIds:list(value.teamIds).map(value=>text(value,128)),lastSeenAt:optionalText(value.lastSeenAt),lastAppOpenAt:optionalText(value.lastAppOpenAt),appVersion:optionalText(value.appVersion),metrics:metric(value.metrics),usageEventCount:count(value.usageEventCount)};}),byTeam:list(root.byTeam).map(raw=>{const value=item(raw);return {teamId:text(value.teamId,128),name:text(value.name,200),memberCount:count(value.memberCount),metrics:metric(value.metrics)};}),usageEvents:{eventCount:count(events.eventCount),totals,byKind:list(events.byKind,1000).map(raw=>{const value=item(raw);return {kind:text(value.kind,100),count:count(value.count),amount:number(value.amount)};}),source:text(events.source)},missingMeasurements:{sessionsWithoutUsage:count(missing.sessionsWithoutUsage),sessionsWithoutEnd:count(missing.sessionsWithoutEnd),sessionsWithoutLatency:count(missing.sessionsWithoutLatency),sessionsWithoutCoaching:count(missing.sessionsWithoutCoaching),unscopedSessionsExcluded:count(missing.unscopedSessionsExcluded),unscopedUsageEventsExcluded:count(missing.unscopedUsageEventsExcluded),meetingCoverage:optionalNumber(missing.meetingCoverage),reasons:list(missing.reasons,1000).map(value=>text(value))},source:{sessions:text(source.sessions),events:text(source.events),membership:text(source.membership),deduplication:text(source.deduplication),coaching:text(source.coaching),audio:text(source.audio)},adoption:{eligibleMembers:count(adoption.eligibleMembers),activeMembers:count(adoption.activeMembers),activeDefinition:text(adoption.activeDefinition)},byMode:list(root.byMode).map(raw=>{const value=item(raw);return {modeId:text(value.modeId,200),name:text(value.name,200),sessions:count(value.sessions),answers:optionalNumber(value.answers)};}),features:list(root.features,1000).map(raw=>{const value=item(raw);return {kind:text(value.kind,100),requests:count(value.requests),completedAnswers:optionalNumber(value.completedAnswers),failedAnswers:optionalNumber(value.failedAnswers)};})};
}
function record(raw:unknown):CloudRecord {
  const identity=key(raw);const value=raw as Record<string,unknown>;
  if(!Number.isSafeInteger(value.revision) || Number(value.revision)<1) throw new Error('Invalid cloud revision.');
  const data=value.deleted || value.data===null ? null : cloudData(identity.entity,value.data,identity.id);
  if(data) {
    const required = identity.entity==='meeting'?['title','startedAt']:identity.entity==='knowledge'?['title','text']:identity.entity==='mode'?['name','instructions']:identity.entity==='calendar'?['title','start','end']:['folder','person','scorecard'].includes(identity.entity)?['name']:[];
    if(required.some(name=>typeof data[name]!=='string' && !(identity.entity==='mode' && name==='instructions' && value.inference==='server'))) throw new Error('Cloud record is missing required fields.');
  }
  return {...identity,revision:Number(value.revision),data,deleted:!data,scope:['personal','org','team'].includes(String(value.scope))?value.scope as CloudRecord['scope']:undefined,ownerId:typeof value.ownerId==='string'?value.ownerId:undefined,orgId:typeof value.orgId==='string'?value.orgId:null,teamId:typeof value.teamId==='string'?value.teamId:null,updatedAt:typeof value.updatedAt==='string'?value.updatedAt:undefined,inference:value.inference==='server'?'server':undefined};
}
export function cloudEndpoint(raw:string):string {
  const url=new URL(raw.trim());
  if(url.username || url.password || url.search || url.hash || !['','/','/api/v1','/api/v1/'].includes(url.pathname)) throw new Error('Use the server origin or its /api/v1 endpoint.');
  const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if(url.protocol!=='https:' && !(url.protocol==='http:' && loopback)) throw new Error('Remote servers require HTTPS. Local HTTP is allowed on loopback only.');
  return `${url.origin}/api/v1`;
}

export class CloudClient {
  private readonly path:string;
  private saved:SavedCloud;
  private busy=false;
  private error?:string;
  private errorCode?:string;
  private capabilities?:CloudAuthCapabilities;
  private authorizationRevision=0;
  private recordingSelectionRevision=0;
  private recordings?:{profile:string;state:CloudRecordingsState;file?:{path:string;size:number;mtimeMs:number;dev:number;ino:number;selection:CloudRecordingSelection}};
  private sso?:{requestId:string;requestSecret:string;expiresAt:string};
  private mergeLink?:{profile:string;state:string;expiresAt:string};
  private chain:Promise<unknown>=Promise.resolve();
  constructor(private readonly options:CloudClientOptions) {
    mkdirSync(options.directory,{recursive:true,mode:0o700});this.path=join(options.directory,'cloud.json');
    this.saved={schemaVersion:1,endpoint:'http://127.0.0.1:4319/api/v1',profiles:{}};
    if(existsSync(this.path)) {
      const saved=JSON.parse(readFileSync(this.path,'utf8')) as SavedCloud;
      if(saved.schemaVersion!==1 || !plain(saved.profiles)) throw new Error('Unsupported Watson cloud metadata. The original file is preserved.');
      saved.endpoint=cloudEndpoint(saved.endpoint);this.saved=saved;
    }
  }
  private persist() {const temporary=`${this.path}.tmp`;writeFileSync(temporary,JSON.stringify(this.saved,null,2),{mode:0o600});renameSync(temporary,this.path);}
  private changed(){this.options.onChange?.();}
  private profile():Profile {const profile=this.saved.active && this.saved.profiles[this.saved.active];if(!profile || !this.saved.auth || this.saved.auth.profile!==this.saved.active) throw new Error('Sign in to a Watson server first.');return profile;}
  status():CloudStatus {
    const profile=this.saved.active?this.saved.profiles[this.saved.active]:undefined;
    return structuredClone({endpoint:this.saved.endpoint,signedIn:!!this.saved.auth,secureStorage:this.options.secretStorage.isEncryptionAvailable(),user:this.saved.auth?profile?.user:undefined,deviceId:this.saved.auth?.deviceId,expiresAt:this.saved.auth?.expiresAt,cursor:this.saved.auth?profile?.cursor??0:0,busy:this.busy,error:this.error,errorCode:this.errorCode,lastSyncAt:this.saved.auth?profile?.lastSyncAt:undefined,conflicts:this.saved.auth?profile?.conflicts??[]:[],shares:this.saved.auth?profile?.shares??[]:[],shared:this.saved.auth?profile?.shared??[]:[],organizations:this.saved.auth?profile?.organizations??[]:[],policy:this.saved.auth?profile?.policy:undefined,boundRecords:this.saved.auth?Object.keys(profile?.bindings??{}).map(identity=>{const split=identity.indexOf(':');return {entity:identity.slice(0,split) as CloudEntity,id:identity.slice(split+1)};}):[],pendingUploads:this.saved.auth?profile?.pending.length??0:0,automaticSync:false,assignedMode:this.saved.auth?profile?.assignedMode:undefined,connectedDocuments:this.saved.auth?profile?.connectedDocuments??[]:[],assistantConfigured:this.saved.auth?profile?.assistantConfigured:undefined,webResearchConfigured:this.saved.auth?profile?.webResearchConfigured:undefined,smartConfigured:this.saved.auth?profile?.managedSmart?.configured:undefined,smartWebResearchConfigured:this.saved.auth?profile?.managedSmart?.webResearchConfigured:undefined,managedSmart:this.saved.auth?profile?.managedSmart:undefined,accountCapabilities:this.capabilities,authorizationRevision:this.authorizationRevision,recordings:this.saved.auth&&this.recordings&&this.recordings.profile===this.saved.active?this.recordings.state:undefined});
  }
  supports(command:string){return ['cloud:configure','cloud:signup','cloud:login','cloud:logout','cloud:refresh','cloud:profile','cloud:password','cloud:delete-account','cloud:sync','cloud:cancel-uploads','cloud:resolve','cloud:share','cloud:revoke-share','cloud:organization','cloud:sso-start','cloud:sso-poll','cloud:enterprise','cloud:connector','cloud:analytics','cloud:auth-capabilities','cloud:request-verification','cloud:request-password-reset','cloud:recording-capabilities','cloud:recording-info','cloud:recording-upload','cloud:recording-delete','cloud:recording-clear-selection'].includes(command);}
  async handle(command:string,input:any):Promise<unknown> {
    switch(command) {
      case 'cloud:configure': return this.configure(input.endpoint);
      case 'cloud:signup': return this.signup(input);
      case 'cloud:login': return this.login(input);
      case 'cloud:logout': return this.logout();
      case 'cloud:refresh': return this.refresh();
      case 'cloud:profile': return this.updateProfile(input);
      case 'cloud:password': return this.changePassword(input);
      case 'cloud:delete-account': return this.deleteAccount(input);
      case 'cloud:sync': return this.sync(input);
      case 'cloud:cancel-uploads':return this.cancelUploads(input);
      case 'cloud:resolve': return this.resolve(input);
      case 'cloud:share': return this.share(input);
      case 'cloud:revoke-share': return this.revokeShare(input.meetingId);
      case 'cloud:organization': return this.organization(input);
      case 'cloud:sso-start':return this.startSso(input);
      case 'cloud:sso-poll':return this.pollSso();
      case 'cloud:enterprise':return this.enterprise(input);
      case 'cloud:connector':return this.connector(input);
      case 'cloud:analytics':return this.analytics(input);
      case 'cloud:auth-capabilities':return this.authCapabilities();
      case 'cloud:request-verification':return this.requestVerification();
      case 'cloud:request-password-reset':return this.requestPasswordReset(input);
      case 'cloud:recording-capabilities':return this.recordingCapabilities();
      case 'cloud:recording-info':return this.recordingInfo(input.meetingId);
      case 'cloud:recording-upload':return this.uploadRecording(input);
      case 'cloud:recording-delete':return this.deleteRecording(input);
      case 'cloud:recording-clear-selection':return this.clearRecordingSelection();
      default:throw new Error('Unknown cloud command.');
    }
  }
  private run<T>(task:()=>Promise<T>):Promise<T> {
    const current=this.chain.then(async()=>{this.busy=true;this.error=undefined;this.errorCode=undefined;this.changed();try{return await task();}catch(error){this.error=error instanceof Error?error.message:'Cloud request failed.';const code=(error as {code?:unknown})?.code;this.errorCode=typeof code==='string'?code.slice(0,100):undefined;throw error;}finally{this.busy=false;this.changed();}});
    this.chain=current.catch(()=>{});return current;
  }
  private actorKey(){return `${this.saved.endpoint}|${this.saved.auth?.profile??'signed-out'}|${this.saved.auth?.deviceId??''}`;}
  private runForActor<T>(task:()=>Promise<T>):Promise<T>{const actor=this.actorKey();return this.run(async()=>{if(actor!==this.actorKey())throw new Error('The account or server changed while this request was waiting. Review the action and try again.');return task();});}
  private async request(path:string,method='GET',body?:unknown,authenticated=true):Promise<any> {
    const headers:Record<string,string>={'Accept':'application/json'};
    if(body!==undefined)headers['Content-Type']='application/json';
    if(authenticated) {this.profile();if(!this.options.secretStorage.isEncryptionAvailable())throw new Error('OS credential encryption is unavailable.');const auth=this.saved.auth!;headers.Authorization=`Bearer ${this.options.secretStorage.decryptString(Buffer.from(auth.encryptedToken,'base64'))}`;}
    const response=await (this.options.fetch??fetch)(`${this.saved.endpoint}/${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});
    const text=await response.text();if(text.length>16*1024*1024)throw new Error('Cloud response exceeds the supported size.');
    let data:any;try{data=JSON.parse(text);}catch{throw new Error(`Watson server returned an invalid response (${response.status}).`);}
    if(!response.ok){const message=typeof data.error?.message==='string'?data.error.message:typeof data.message==='string'?data.message:`Watson server request failed (${response.status}).`;const error=new Error(message.slice(0,500)) as Error & { code?:string };error.code=data.error?.code??data.code;if(authenticated && response.status===401 && error.code==='unauthorized'){this.saved.auth=undefined;this.saved.active=undefined;this.persist();}throw error;}
    return data;
  }
  private acceptAuth(reply:AuthReply) {
    if(!this.options.secretStorage.isEncryptionAvailable())throw new Error('OS credential encryption is required to sign in.');
    if(!reply || typeof reply.token!=='string' || typeof reply.user?.id!=='string' || typeof reply.user.email!=='string' || typeof reply.user.name!=='string' || typeof reply.device?.id!=='string')throw new Error('Invalid sign-in response.');
    const identity=`${this.saved.endpoint}|${reply.user.id}`;
    const profile=this.saved.profiles[identity]??{user:reply.user,cursor:0,bindings:{},conflicts:[],pending:[],shares:[],shared:[],organizations:[]};
    profile.user=cloudUser(reply.user);
    this.saved.profiles[identity]=profile;this.saved.active=identity;this.saved.auth={profile:identity,encryptedToken:this.options.secretStorage.encryptString(reply.token).toString('base64'),deviceId:reply.device.id,expiresAt:reply.expiresAt};this.persist();
  }
  configure(endpoint:string) {return this.run(async()=>{if(this.saved.auth)throw new Error('Sign out before changing servers.');this.saved.endpoint=cloudEndpoint(endpoint);this.saved.active=undefined;this.sso=undefined;this.capabilities=undefined;this.persist();return this.status();});}
  signup(input:{email:string;password:string;name?:string}) {return this.authenticate('signup',input);}
  login(input:{email:string;password:string}) {return this.authenticate('login',input);}
  private authenticate(action:'signup'|'login',input:{email:string;password:string;name?:string}) {
    return this.run(async()=>{if(this.saved.auth)throw new Error('Sign out before switching accounts.');if(!this.options.secretStorage.isEncryptionAvailable())throw new Error('OS credential encryption is required to sign in.');const reply=await this.request(`auth/${action}`,'POST',{...input,deviceName:'Watson desktop'},false);this.acceptAuth(reply);return this.status();});
  }
  logout() {return this.run(async()=>{let revokeFailed=false;if(this.saved.auth)try{await this.request('auth/logout','POST',{});}catch{revokeFailed=true;}this.saved.auth=undefined;this.saved.active=undefined;this.sso=undefined;this.persist();if(revokeFailed)this.error='Signed out locally. The server could not be reached to revoke this device session.';return this.status();});}
  refresh() {return this.runForActor(async()=>{const data=await this.request('me');const resources=await this.request('resources');const assignment=await this.request('assigned-mode');const profile=this.profile();profile.user=cloudUser(data.user);profile.policy=data.policy;profile.organizations=data.organizations;profile.shared=resources.resources.map(record).filter((item:CloudRecord)=>item.scope!=='personal');profile.assignedMode=assignment.mode?record(assignment.mode):undefined;await this.refreshConnected(profile);const assistant=await this.request('assistant/status');profile.assistantConfigured=assistant.configured===true;profile.webResearchConfigured=assistant.webResearchConfigured===true;if(typeof assistant.smartConfigured==='boolean'){profile.managedSmart={configured:assistant.smartConfigured,model:typeof assistant.smartModel==='string'?assistant.smartModel:null,reasoningEffort:typeof assistant.smartReasoningEffort==='string'?assistant.smartReasoningEffort:'unknown',reasoningEnabled:assistant.smartReasoningEnabled===true,maxOutputTokens:Number.isSafeInteger(assistant.smartMaxOutputTokens)&&assistant.smartMaxOutputTokens>0?assistant.smartMaxOutputTokens:null,webResearchEnabled:assistant.smartWebResearchEnabled===true,webResearchConfigured:assistant.smartWebResearchConfigured===true,modelSupport:['supported','unknown','unsupported','unconfigured'].includes(assistant.smartModelSupport)?assistant.smartModelSupport:'unknown',configurationError:typeof assistant.smartConfigurationError==='string'?assistant.smartConfigurationError:null};}else profile.managedSmart=undefined;await this.readAuthCapabilities();this.authorizationRevision++;this.persist();return this.status();});}
  updateProfile(input:{name?:string;email?:string;currentPassword?:string}) {return this.runForActor(async()=>{const data=await this.request('me','PATCH',input);this.profile().user=cloudUser(data.user);this.persist();return this.status();});}
  changePassword(input:{currentPassword:string;newPassword:string}) {return this.runForActor(async()=>{this.acceptAuth(await this.request('me/password','POST',{...input,deviceName:'Watson desktop'}));return this.status();});}
  deleteAccount(input:{currentPassword:string;confirmed:true}) {return this.runForActor(async()=>{if(input.confirmed!==true)throw new Error('Confirm account deletion first.');await this.request('me','DELETE',{currentPassword:input.currentPassword});delete this.saved.profiles[this.saved.active!];this.saved.active=undefined;this.saved.auth=undefined;this.persist();return this.status();});}
  private local(identity:CloudRecordKey):Record<string,unknown>|null {
    const local=this.options.getLocal();if(identity.entity==='settings')return cloudData('settings',local.settings,'preferences');
    const items=local[collection[identity.entity]]??[];const found=items.find(item=>item.id===identity.id);if(!found)return null;const data=cloudData(identity.entity,found,identity.id);
    if(identity.entity==='mode' && Array.isArray(data.documentIds))data.documentIds=data.documentIds.map(value=>typeof value==='string' && value.startsWith('shared:knowledge:')?value.slice('shared:knowledge:'.length):value);
    return data;
  }
  private desktopRecords(records:CloudApplyRecord[],shared:CloudRecord[]):CloudApplyRecord[] {
    const docs=new Set(shared.filter(item=>item.entity==='knowledge' && item.data && !item.deleted).map(item=>item.id));
    return structuredClone(records).map(item=>{if(item.entity==='mode' && item.data && Array.isArray(item.data.documentIds))item.data.documentIds=item.data.documentIds.map(value=>typeof value==='string' && docs.has(value)?`shared:knowledge:${value}`:value);return item;});
  }
  sync(input:{uploads?:CloudRecordKey[];confirmedUpload?:boolean}={}) {return this.runForActor(async()=>{
    const profile=this.profile();const pending=structuredClone(profile.pending);const uploads=(input.uploads??[]).map(key);
    if((uploads.length || profile.pending.length) && input.confirmedUpload!==true)throw new Error('Confirm the selected uploads for this account before syncing.');
    if(uploads.length>1000)throw new Error('Select at most 1,000 records per sync.');
    const selected=new Set<string>();
    for(const identity of uploads) {
      const identityKey=keyOf(identity);if(selected.has(identityKey))continue;selected.add(identityKey);
      if(profile.conflicts.some(conflict=>keyOf(conflict)===identityKey))throw new Error('Resolve conflicts before uploading those records.');
      if(pending.some(mutation=>keyOf(mutation)===identityKey))continue;
      if(identity.entity==='settings' && identity.id!=='preferences')throw new Error('Settings use the preferences record.');
      const data=this.local(identity);const binding=profile.bindings[identityKey];
      if(!data && !binding)throw new Error('The selected local record no longer exists.');
      if(binding && same(data,binding.base))continue;
      pending.push({...identity,expectedRevision:binding?.revision??0,data,changeId:randomUUID()});
    }
    const priority:Record<CloudEntity,number>={folder:0,knowledge:1,mode:2,calendar:3,person:4,scorecard:5,meeting:6,settings:7};pending.sort((a,b)=>priority[a.entity]-priority[b.entity]);
    const folderMutations=new Map(pending.filter(item=>item.entity==='folder' && item.data).map(item=>[item.id,item]));const orderedFolders:Mutation[]=[];const visiting=new Set<string>(),visited=new Set<string>();
    const visitFolder=(item:Mutation)=>{if(visited.has(item.id))return;if(visiting.has(item.id))throw new Error('Folder parents form a cycle. Fix the local folders before uploading.');visiting.add(item.id);const parent=typeof item.data?.parentId==='string'?folderMutations.get(item.data.parentId):undefined;if(parent)visitFolder(parent);visiting.delete(item.id);visited.add(item.id);orderedFolders.push(item);};for(const item of folderMutations.values())visitFolder(item);
    profile.pending=[...orderedFolders,...pending.filter(item=>!folderMutations.has(item.id) || item.entity!=='folder')];
    this.persist();
    do {await this.syncBatch(profile,profile.pending.slice(0,100));}while(profile.pending.length);
    profile.lastSyncAt=new Date().toISOString();this.persist();return this.status();
  });}
  cancelUploads(input:{confirmed:true}) {return this.runForActor(async()=>{if(input.confirmed!==true)throw new Error('Confirm discarding queued uploads.');this.profile().pending=[];this.persist();return this.status();});}
  private invalidateAnalytics(error:unknown,input:CloudAnalyticsInput) {const code=(error as {code?:unknown})?.code;if(['analytics_scope_denied','not_found','unauthorized','forbidden'].includes(String(code))){this.authorizationRevision++;if(code==='not_found' && this.saved.auth){const profile=this.profile();profile.organizations=profile.organizations.filter(org=>org.id!==input.orgId);this.persist();}}}
  analytics(input:CloudAnalyticsInput):Promise<CloudAnalyticsReport> {return this.runForActor(async()=>{const query=cloudAnalyticsQuery(input);try{const report=analyticsReport(await this.request(`organizations/${encodeURIComponent(input.orgId)}/analytics?${query}`));if(report.orgId!==input.orgId)throw new Error('The server returned a report for another organization.');return report;}catch(error){this.invalidateAnalytics(error,input);throw error;}});}
  exportAnalytics(input:CloudAnalyticsInput):Promise<CloudAnalyticsExport> {return this.runForActor(async()=>{const query=cloudAnalyticsQuery(input);try{const result=await this.request(`organizations/${encodeURIComponent(input.orgId)}/analytics/export?${query}`);if(typeof result.filename!=='string' || result.filename.length>200 || !/^[a-zA-Z0-9_.-]+\.csv$/.test(result.filename) || typeof result.csv!=='string' || result.csv.length>16*1024*1024)throw new Error('The server returned an invalid analytics export.');return {filename:result.filename,csv:result.csv};}catch(error){this.invalidateAnalytics(error,input);throw error;}});}
  private async readAuthCapabilities():Promise<CloudAuthCapabilities> {const result=await this.request('auth/capabilities','GET',undefined,false);if(!plain(result) || typeof result.emailDeliveryConfigured!=='boolean' || typeof result.verificationRequired!=='boolean' || typeof result.passwordRecoveryConfigured!=='boolean')throw new Error('The server returned invalid email service capabilities.');this.capabilities={emailDeliveryConfigured:result.emailDeliveryConfigured,verificationRequired:result.verificationRequired,passwordRecoveryConfigured:result.passwordRecoveryConfigured};return structuredClone(this.capabilities);}
  authCapabilities():Promise<CloudAuthCapabilities>{return this.run(()=>this.readAuthCapabilities());}
  private emailResult(raw:unknown):CloudEmailActionResult {if(!plain(raw) || raw.accepted!==true || typeof raw.message!=='string' || raw.message.length>2000)throw new Error('The server returned an invalid email action response.');return {accepted:true,message:raw.message};}
  requestVerification():Promise<CloudEmailActionResult>{return this.runForActor(async()=>this.emailResult(await this.request('me/email-verification','POST',{})));}
  requestPasswordReset(input:{email:string}):Promise<CloudEmailActionResult>{return this.run(async()=>{if(typeof input.email!=='string' || input.email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()))throw new Error('Enter the account email address.');return this.emailResult(await this.request('auth/password-reset/request','POST',{email:input.email.trim()},false));});}
  private recordingState(){this.profile();if(this.recordings?.profile!==this.saved.active)this.recordings={profile:this.saved.active!,state:{entries:[]}};return this.recordings!;}
  private recordingBinding(meetingId:string){key({entity:'meeting',id:meetingId});const profile=this.profile(),identity=`meeting:${meetingId}`,binding=profile.bindings[identity];if(!binding?.base)throw new Error('Sync this owned session before attaching or exporting audio.');if(profile.conflicts.some(item=>keyOf(item)===identity) || profile.pending.some(item=>keyOf(item)===identity))throw new Error('Resolve or finish this session’s pending sync before changing its audio.');return binding;}
  private async openAudioFile(path:string,flags:'r'|'wx'){try{return await open(path,flags,0o600);}catch{throw new Error(flags==='r'?'The chosen audio file could not be opened. Choose it again.':'The selected audio export destination could not be opened. Choose another destination.');}}
  private recordingMetadata(raw:unknown):CloudRecordingMetadata {if(!plain(raw)||typeof raw.id!=='string'||typeof raw.contentType!=='string'||!raw.contentType.startsWith('audio/')||!Number.isSafeInteger(raw.size)||Number(raw.size)<0||typeof raw.sha256!=='string'||!/^[a-f0-9]{64}$/.test(raw.sha256)||typeof raw.createdAt!=='string'||!Number.isFinite(Date.parse(raw.createdAt))||raw.ownerOnly!==true||typeof raw.encryptedAtRest!=='boolean')throw new Error('The server returned invalid private audio metadata.');return {id:raw.id,contentType:raw.contentType,size:Number(raw.size),sha256:raw.sha256,filename:typeof raw.filename==='string'?raw.filename.slice(0,200):undefined,createdAt:raw.createdAt,ownerOnly:true,encryptedAtRest:raw.encryptedAtRest,inline:raw.inline===true?true:undefined};}
  private cacheRecording(meetingId:string,recording:CloudRecordingMetadata|null){const state=this.recordingState().state;state.entries=state.entries.filter(item=>item.meetingId!==meetingId);state.entries.push({meetingId,recording});}
  private async readRecordingCapabilities():Promise<CloudRecordingCapabilities>{const raw=await this.request('recordings/capabilities');if(!plain(raw)||typeof raw.configured!=='boolean'||typeof raw.recordingAllowed!=='boolean'||!Number.isSafeInteger(raw.maxBytes)||Number(raw.maxBytes)<1||!Array.isArray(raw.supportedContentTypes)||!raw.supportedContentTypes.every(type=>typeof type==='string'&&type.startsWith('audio/'))||raw.consentRequired!==true||raw.attachmentsPerMeeting!==1||(raw.uploadTimeoutMs!==undefined&&(!Number.isSafeInteger(raw.uploadTimeoutMs)||Number(raw.uploadTimeoutMs)<1||Number(raw.uploadTimeoutMs)>900000)))throw new Error('The server returned invalid private audio capabilities.');const result:CloudRecordingCapabilities={configured:raw.configured,maxBytes:Number(raw.maxBytes),supportedContentTypes:[...raw.supportedContentTypes] as string[],recordingAllowed:raw.recordingAllowed,consentRequired:true,attachmentsPerMeeting:1,uploadTimeoutMs:raw.uploadTimeoutMs===undefined?undefined:Number(raw.uploadTimeoutMs)};this.recordingState().state.capabilities=result;return structuredClone(result);}
  recordingCapabilities():Promise<CloudRecordingCapabilities>{return this.runForActor(()=>this.readRecordingCapabilities());}
  private async readRecordingInfo(meetingId:string):Promise<{recording:CloudRecordingMetadata|null}>{this.recordingBinding(meetingId);try{const raw=await this.request(`meetings/${encodeURIComponent(meetingId)}/recording/info`);const recording=this.recordingMetadata(raw.recording);this.cacheRecording(meetingId,recording);return {recording};}catch(error){if((error as {code?:string}).code==='not_found'){this.cacheRecording(meetingId,null);return {recording:null};}throw error;}}
  recordingInfo(meetingId:string):Promise<{recording:CloudRecordingMetadata|null}>{return this.runForActor(()=>this.readRecordingInfo(meetingId));}
  /** Native chooser calls this directly. Paths are never accepted from renderer IPC. */
  selectRecordingFile(input:{meetingId:string;path:string;contentType?:string}):Promise<CloudRecordingSelection>{return this.runForActor(async()=>{this.recordingBinding(input.meetingId);const caps=await this.readRecordingCapabilities();if(!caps.configured)throw new Error('The server operator must configure private audio storage first.');if(!caps.recordingAllowed)throw new Error('Your organization disables audio attachments.');const handle=await this.openAudioFile(input.path,'r');try{const file=await handle.stat();if(!file.isFile()||file.size<1)throw new Error('Choose a nonempty audio file.');if(file.size>caps.maxBytes)throw new Error(`The file exceeds this server’s ${caps.maxBytes} byte limit.`);const formats:Record<string,string>={'.wav':'audio/wav','.webm':'audio/webm','.mp4':'audio/mp4','.m4a':'audio/mp4','.m4b':'audio/mp4','.mp3':'audio/mpeg','.ogg':'audio/ogg','.oga':'audio/ogg','.caf':'audio/x-caf'};const contentType=input.contentType??formats[extname(input.path).toLowerCase()];if(!contentType||!caps.supportedContentTypes.includes(contentType))throw new Error('Choose an audio format supported by this server.');const filename=basename(input.path);if(!filename||filename.length>200)throw new Error('The audio filename must be at most 200 characters.');const selection={meetingId:input.meetingId,filename,size:file.size,contentType,selectionRevision:++this.recordingSelectionRevision};const state=this.recordingState();state.file={path:input.path,size:file.size,mtimeMs:file.mtimeMs,dev:file.dev,ino:file.ino,selection};state.state.selected=selection;state.state.transfer=undefined;return structuredClone(selection);}finally{await handle.close();}});}
  clearRecordingSelection():Promise<CloudStatus>{return this.runForActor(async()=>{const state=this.recordingState();state.file=undefined;state.state.selected=undefined;return this.status();});}
  private recordingHeaders():Record<string,string>{this.profile();if(!this.options.secretStorage.isEncryptionAvailable())throw new Error('OS credential encryption is unavailable.');return {Authorization:`Bearer ${this.options.secretStorage.decryptString(Buffer.from(this.saved.auth!.encryptedToken,'base64'))}`};}
  private async binaryError(response:Response):Promise<never>{let data:any;try{data=await response.json();}catch{}const error=new Error(typeof data?.error?.message==='string'?data.error.message.slice(0,500):`Private audio request failed (${response.status}).`) as Error&{code?:string};error.code=data?.error?.code;if(response.status===401&&error.code==='unauthorized'){this.saved.auth=undefined;this.saved.active=undefined;this.persist();}throw error;}
  uploadRecording(input:{meetingId:string;consentConfirmed:true;selectionRevision:number}):Promise<{recording:CloudRecordingMetadata;revision:number}>{return this.runForActor(async()=>{if(input.consentConfirmed!==true)throw new Error('Confirm permission from the participants before uploading audio.');const binding=this.recordingBinding(input.meetingId);if(!same(this.local({entity:'meeting',id:input.meetingId}),binding.base))throw new Error('Sync this session’s local changes before uploading audio.');const state=this.recordingState(),selected=state.file;if(!selected||selected.selection.meetingId!==input.meetingId)throw new Error('Choose an audio file for this account and session first.');if(input.selectionRevision!==selected.selection.selectionRevision)throw new Error('The audio selection changed. Review the current file and confirm permission again.');const caps=await this.readRecordingCapabilities();if(!caps.configured||!caps.recordingAllowed)throw new Error(caps.configured?'Your organization disables audio attachments.':'The server operator must configure private audio storage first.');const handle=await this.openAudioFile(selected.path,'r');const transfer={meetingId:input.meetingId,direction:'upload' as const,status:'uploading' as const,bytesTransferred:0,totalBytes:selected.size};state.state.transfer=transfer;this.changed();let body:Readable|undefined;try{const file=await handle.stat();if(file.size!==selected.size||file.mtimeMs!==selected.mtimeMs||file.dev!==selected.dev||file.ino!==selected.ino)throw new Error('The selected audio file changed. Choose it again before approving upload.');if(file.size>caps.maxBytes)throw new Error('The selected audio exceeds the server limit.');const update=this.changed.bind(this);let lastUpdate=0;body=Readable.from((async function*(){for await(const chunk of handle.createReadStream({highWaterMark:65536,autoClose:false})){transfer.bytesTransferred+=chunk.length;if(Date.now()-lastUpdate>100){lastUpdate=Date.now();update();}yield chunk;}})());const response=await (this.options.fetch??fetch)(`${this.saved.endpoint}/meetings/${encodeURIComponent(input.meetingId)}/recording`,{method:'PUT',headers:{...this.recordingHeaders(),'Content-Type':selected.selection.contentType,'Content-Length':String(selected.size),'X-Watson-Expected-Revision':String(binding.revision),'X-Watson-Recording-Consent':'true','X-Watson-Filename':encodeURIComponent(selected.selection.filename)},body:body as unknown as BodyInit,duplex:'half',redirect:'error',signal:AbortSignal.timeout((caps.uploadTimeoutMs??300000)+30000)} as RequestInit&{duplex:'half'});if(!response.ok)await this.binaryError(response);const raw=await response.json() as any,recording=this.recordingMetadata(raw.recording);if(!Number.isSafeInteger(raw.revision)||raw.revision<=binding.revision)throw new Error('Invalid audio revision response.');await this.syncBatch(this.profile(),[]);this.cacheRecording(input.meetingId,recording);state.file=undefined;state.state.selected=undefined;state.state.transfer={...transfer,bytesTransferred:recording.size,status:'complete'};return {recording,revision:raw.revision};}catch(error){state.state.transfer={...transfer,status:'error',error:error instanceof Error?error.message:'Audio upload failed.'};throw error;}finally{body?.destroy();await handle.close().catch(()=>{});}});}
  /** Native save dialog supplies the destination. No audio bytes or URLs cross renderer IPC. */
  downloadRecording(input:{meetingId:string;destination:string}):Promise<{saved:true;path:string}>{return this.runForActor(async()=>{const info=await this.readRecordingInfo(input.meetingId);if(!info.recording)throw new Error('This session has no audio attachment.');const recording=info.recording,state=this.recordingState(),temporary=`${input.destination}.watson-${randomUUID()}.partial`,handle=await this.openAudioFile(temporary,'wx'),digest=createHash('sha256');const transfer={meetingId:input.meetingId,direction:'download' as const,status:'downloading' as const,bytesTransferred:0,totalBytes:recording.size};state.state.transfer=transfer;this.changed();try{const response=await (this.options.fetch??fetch)(`${this.saved.endpoint}/meetings/${encodeURIComponent(input.meetingId)}/recording`,{headers:this.recordingHeaders(),redirect:'error',signal:AbortSignal.timeout(300000)});if(!response.ok)await this.binaryError(response);if(!response.body)throw new Error('The server returned no audio stream.');let lastUpdate=0;for await(const raw of response.body as unknown as AsyncIterable<Uint8Array>){const bytes=Buffer.from(raw);transfer.bytesTransferred+=bytes.length;if(transfer.bytesTransferred>recording.size)throw new Error('Audio changed during download. Refresh the attachment and try again.');digest.update(bytes);let offset=0;while(offset<bytes.length){const written=await handle.write(bytes,offset,bytes.length-offset,null);if(!written.bytesWritten)throw new Error('Audio could not be written to the selected destination.');offset+=written.bytesWritten;}if(Date.now()-lastUpdate>100){lastUpdate=Date.now();this.changed();}}if(transfer.bytesTransferred!==recording.size||digest.digest('hex')!==recording.sha256)throw new Error('Audio integrity check failed. The selected destination was not replaced.');await handle.close();try{await rename(temporary,input.destination);}catch{throw new Error('The verified audio export could not replace the selected destination. Choose another destination.');}state.state.transfer={...transfer,status:'complete'};return {saved:true,path:input.destination};}catch(error){state.state.transfer={...transfer,status:'error',error:error instanceof Error?error.message:'Audio download failed.'};throw error;}finally{await handle.close().catch(()=>{});await unlink(temporary).catch(()=>{});}});}
  deleteRecording(input:{meetingId:string;confirmed:true}):Promise<{deleted:boolean;revision:number}>{return this.runForActor(async()=>{if(input.confirmed!==true)throw new Error('Confirm deleting this session’s audio attachment.');const binding=this.recordingBinding(input.meetingId);const result=await this.request(`meetings/${encodeURIComponent(input.meetingId)}/recording`,'DELETE',{expectedRevision:binding.revision});if(result.deleted!==true||!Number.isSafeInteger(result.revision)||result.revision<=binding.revision)throw new Error('The server returned an invalid audio deletion.');await this.syncBatch(this.profile(),[]);this.cacheRecording(input.meetingId,null);const state=this.recordingState();if(state.file?.selection.meetingId===input.meetingId){state.file=undefined;state.state.selected=undefined;}return {deleted:true,revision:result.revision};});}
  private conflict(profile:Profile, remote:CloudRecord, reason:CloudConflict['reason']) {const identity=keyOf(remote);const conflict:CloudConflict={entity:remote.entity,id:remote.id,reason,local:this.local(remote),remote};profile.conflicts=profile.conflicts.filter(item=>keyOf(item)!==identity);profile.conflicts.push(conflict);}
  private async syncBatch(profile:Profile,mutations:Mutation[]) {
    const reply=await this.request('sync','POST',{deviceId:this.saved.auth!.deviceId,cursor:profile.cursor,changes:mutations});
    if(!Number.isSafeInteger(reply.cursor) || reply.cursor<profile.cursor || !Array.isArray(reply.changes) || !Array.isArray(reply.conflicts) || !Array.isArray(reply.applied) || !Array.isArray(reply.shared))throw new Error('Invalid sync response.');
    const nextBindings={...profile.bindings};const apply:CloudApplyRecord[]=[];
    const handled=new Set<string>();const outgoing=new Map(mutations.map(mutation=>[keyOf(mutation),mutation]));
    for(const raw of reply.applied) {const remote=record(raw);const identity=keyOf(remote);if(!outgoing.has(identity))throw new Error('Sync acknowledged an unrequested upload.');nextBindings[identity]={revision:remote.revision,base:remote.data};handled.add(identity);}
    for(const raw of reply.conflicts) {const identity=key(raw);if(!plain(raw.current))throw new Error('Invalid sync conflict.');const remote=record(raw.current);if(keyOf(remote)!==keyOf(identity))throw new Error('Invalid sync conflict identity.');this.conflict(profile,remote,'revision');handled.add(keyOf(identity));}
    const latest=new Map<string,CloudRecord>();
    for(const raw of reply.changes) {const remote=record(raw);const identity=keyOf(remote);const previous=latest.get(identity);if(!previous || previous.revision<remote.revision)latest.set(identity,remote);}
    for(const [identity,remote] of latest) {
      const existingConflict=profile.conflicts.find(item=>keyOf(item)===identity);
      if(existingConflict){this.conflict(profile,remote,existingConflict.reason);continue;}
      const binding=nextBindings[identity];
      if(binding && remote.revision<=binding.revision)continue;
      const local=this.local(remote);
      if(binding && !same(local,binding.base) && !same(local,remote.data)){this.conflict(profile,remote,'local-change');continue;}
      if(!binding && local!==null && remote.entity!=='settings'){this.conflict(profile,remote,'account-collision');continue;}
      if(remote.entity==='settings' && !binding && local!==null && !same(local,remote.data)){this.conflict(profile,remote,'local-change');continue;}
      apply.push({entity:remote.entity,id:remote.id,data:remote.data});nextBindings[identity]={revision:remote.revision,base:remote.data};
    }
    // Apply only after the entire response passes validation. The engine callback must save atomically.
    const shared=reply.shared.map(record);const assignedMode=reply.assignedMode?record(reply.assignedMode):undefined;await this.options.applyRemote(this.desktopRecords(apply,shared));
    // Normalization may add local defaults. Compare future edits with the actually saved copy.
    for(const applied of apply)nextBindings[keyOf(applied)].base=this.local(applied);
    profile.bindings=nextBindings;profile.pending=profile.pending.filter(mutation=>!handled.has(keyOf(mutation)));profile.cursor=reply.cursor;profile.shared=shared;profile.assignedMode=assignedMode;profile.policy=reply.policy;if(Array.isArray(profile.policy?.organizations)){const current=new Set(profile.policy.organizations.map(org=>org.id));profile.organizations=profile.organizations.filter(org=>current.has(org.id));}this.authorizationRevision++;this.persist();
    if(mutations.length && handled.size!==mutations.length)throw new Error('Server did not acknowledge every upload. Retry will preserve the original mutation IDs.');
  }
  resolve(input:CloudRecordKey & {choice:'local'|'remote'|'both';confirmed?:boolean}) {return this.runForActor(async()=>{
    const profile=this.profile();const identity=key(input);const identityKey=keyOf(identity);const conflict=profile.conflicts.find(item=>keyOf(item)===identityKey);if(!conflict)throw new Error('This conflict is no longer pending.');
    if(input.confirmed!==true)throw new Error('Confirm the conflict resolution first.');
    const local=this.local(identity);const remote=conflict.remote;
    if(input.choice==='local') {if(!local && !remote.data)throw new Error('Both copies were deleted. Choose the server version.');profile.pending=profile.pending.filter(item=>keyOf(item)!==identityKey);profile.pending.push({...identity,data:local,expectedRevision:remote.revision,changeId:randomUUID()});}
    else if(input.choice==='remote' || input.choice==='both') {
      const apply:CloudApplyRecord[]=[];
      if(input.choice==='both') {if(identity.entity==='settings' || !local)throw new Error('Keep both requires an existing non-settings local record.');const copyId=randomUUID();const copy=cloudData(identity.entity,local,copyId);if(typeof copy.title==='string')copy.title=`${copy.title} (local copy)`;if(typeof copy.name==='string')copy.name=`${copy.name} (local copy)`;apply.push({entity:identity.entity,id:copyId,data:copy});}
      apply.push({...identity,data:remote.data});await this.options.applyRemote(this.desktopRecords(apply,profile.shared));
    } else throw new Error('Choose a valid conflict resolution.');
    profile.bindings[identityKey]={revision:remote.revision,base:input.choice==='local'?remote.data:this.local(identity)};profile.conflicts=profile.conflicts.filter(item=>keyOf(item)!==identityKey);this.persist();return this.status();
  });}
  share(input:{meetingId:string;expiresInDays?:number}) {return this.runForActor(async()=>{
    const profile=this.profile();const identity={entity:'meeting' as const,id:input.meetingId};const binding=profile.bindings[keyOf(identity)];
    if(!binding?.base || profile.conflicts.some(item=>keyOf(item)===keyOf(identity)) || !same(this.local(identity),binding.base))throw new Error('Sync this session and resolve its changes before sharing.');
    const reply=await this.request(`meetings/${encodeURIComponent(input.meetingId)}/share`,'POST',{expiresInDays:input.expiresInDays});
    const url=String(reply.viewerUrl??reply.url);const apiUrl=String(reply.url);if(!['http:','https:'].includes(new URL(url).protocol))throw new Error('Invalid share URL.');
    const share={meetingId:input.meetingId,url,apiUrl,expiresAt:String(reply.expiresAt)};profile.shares=profile.shares.filter(item=>item.meetingId!==input.meetingId);profile.shares.push(share);this.persist();return share;
  });}
  revokeShare(meetingId:string) {return this.runForActor(async()=>{await this.request(`meetings/${encodeURIComponent(meetingId)}/share`,'DELETE');this.profile().shares=this.profile().shares.filter(item=>item.meetingId!==meetingId);this.persist();return this.status();});}
  organization(input:CloudOrgAction|CloudAssignmentAction):Promise<CloudOrgResult> {return this.runForActor(async()=>{
    let path='organizations',method='GET',body:unknown;
    const org='orgId' in input?encodeURIComponent(input.orgId):'';
    const team='teamId' in input && input.teamId?encodeURIComponent(input.teamId):'';
    switch(input.action) {
      case 'list':break;
      case 'create':method='POST';body={name:input.name};break;
      case 'update':path+=`/${org}`;method='PATCH';body={name:input.name};break;
      case 'delete':if(input.confirmed!==true)throw new Error('Confirm organization deletion.');path+=`/${org}`;method='DELETE';break;
      case 'members':path+=`/${org}/members`;break;
      case 'add-member':path+=`/${org}/members`;method='POST';body={email:input.email,role:input.role};break;
      case 'update-member':path+=`/${org}/members/${encodeURIComponent(input.userId)}`;method='PATCH';body={role:input.role};break;
      case 'remove-member':path+=`/${org}/members/${encodeURIComponent(input.userId)}`;method='DELETE';break;
      case 'teams':path+=`/${org}/teams`;break;
      case 'create-team':path+=`/${org}/teams`;method='POST';body={name:input.name};break;
      case 'update-team':path+=`/${org}/teams/${team}`;method='PATCH';body={name:input.name};break;
      case 'delete-team':path+=`/${org}/teams/${team}`;method='DELETE';break;
      case 'team-members':path+=`/${org}/teams/${team}/members`;break;
      case 'add-team-member':path+=`/${org}/teams/${team}/members`;method='POST';body={userId:input.userId,role:input.role};break;
      case 'update-team-member':path+=`/${org}/teams/${team}/members/${encodeURIComponent(input.userId)}`;method='PATCH';body={role:input.role};break;
      case 'remove-team-member':path+=`/${org}/teams/${team}/members/${encodeURIComponent(input.userId)}`;method='DELETE';break;
      case 'policy':path+=`/${org}/policy`;if(input.policy){method='PUT';body={recordingAllowed:input.policy.recordingAllowed,publicSharingAllowed:input.policy.publicSharingAllowed,retentionDays:input.policy.retentionDays};}break;
      case 'resources':path=`resources?orgId=${org}${team?`&teamId=${team}`:''}`;break;
      case 'put-resource':path=`resources/${input.entity}${input.expectedRevision?`/${encodeURIComponent(input.id)}`:''}`;method=input.expectedRevision?'PUT':'POST';body={data:cloudData(input.entity,input.data,input.id),expectedRevision:input.expectedRevision,scope:team?'team':'org',orgId:input.orgId,teamId:input.teamId};break;
      case 'delete-resource':path=`resources/${input.entity}/${encodeURIComponent(input.id)}`;method='DELETE';body={expectedRevision:input.expectedRevision};break;
      case 'audit':case 'usage':path+=`/${org}/${input.action}`;break;
      case 'assignments':path+=`/${org}/assignments${team?`?teamId=${team}`:''}`;break;
      case 'assign-mode':path+=`/${org}/assignments/${encodeURIComponent(input.userId)}`;method='PUT';body={modeId:input.modeId};break;
      default:throw new Error('Unknown organization action.');
    }
    const result=await this.request(path,method,body);const profile=this.profile();
    if(input.action==='list')profile.organizations=result.organizations;
    if(['create','update','delete'].includes(input.action)){const list=await this.request('organizations');profile.organizations=list.organizations;}
    if(['put-resource','delete-resource','policy','assign-mode'].includes(input.action)){const list=await this.request('resources');profile.shared=list.resources.map(record).filter((item:CloudRecord)=>item.scope!=='personal');const me=await this.request('me');profile.policy=me.policy;if(input.action==='assign-mode'){const assigned=await this.request('assigned-mode');profile.assignedMode=assigned.mode?record(assigned.mode):undefined;}}
    if(method!=='GET')this.authorizationRevision++;this.persist();return result;
  });}
  startSso(input:{providerId:string;linkAccount?:boolean}) {return this.run(async()=>{
    if(!this.options.secretStorage.isEncryptionAvailable())throw new Error('OS credential encryption is required to sign in.');
    if(this.saved.auth && !input.linkAccount)throw new Error('Sign out first, or explicitly link SSO to this account.');
    const reply=await this.request('auth/sso/start','POST',{providerId:input.providerId,deviceName:'Watson desktop'},!!this.saved.auth);
    if(typeof reply.requestId!=='string' || typeof reply.requestSecret!=='string' || typeof reply.expiresAt!=='string')throw new Error('Invalid SSO response.');
    const authorizationUrl=new URL(String(reply.authorizationUrl));if(authorizationUrl.protocol!=='https:')throw new Error('SSO authorization requires HTTPS.');
    this.sso={requestId:reply.requestId,requestSecret:reply.requestSecret,expiresAt:reply.expiresAt};return {authorizationUrl:authorizationUrl.href,expiresAt:reply.expiresAt as string};
  });}
  pollSso() {return this.run(async()=>{
    if(!this.sso || Date.parse(this.sso.expiresAt)<=Date.now())throw new Error('Start SSO sign-in again. This request expired or is unavailable.');
    const result=await this.request('auth/sso/poll','POST',{requestId:this.sso.requestId,requestSecret:this.sso.requestSecret},false);
    if(result.pending)return this.status();
    if(this.saved.auth && this.profile().user.id!==result.user?.id)throw new Error('SSO returned another account. Sign out before switching accounts.');
    this.acceptAuth(result);this.sso=undefined;return this.status();
  });}
  enterprise(input:CloudEnterpriseAction):Promise<CloudOrgResult> {return this.runForActor(async()=>{
    let path:string,method='GET',body:unknown;
    switch(input.action){case 'sso':case 'directory':path=`organizations/${encodeURIComponent(input.orgId)}/${input.action}`;break;case 'billing':path='billing';break;case 'checkout':path='billing/checkout';method='POST';body={priceId:input.priceId,seats:input.seats};break;case 'portal':path='billing/portal';method='POST';body={};break;default:throw new Error('Unknown enterprise action.');}
    const result=await this.request(path,method,body);
    if(['checkout','portal'].includes(input.action) && new URL(String(result.url)).protocol!=='https:')throw new Error('Billing pages require HTTPS.');
    return secretFree(result) as CloudOrgResult;
  });}
  private connected(raw:unknown):CloudConnectedDocument[] {
    if(!Array.isArray(raw) || raw.length>10000)throw new Error('Invalid connected context response.');
    return raw.map(value=>{if(!plain(value) || typeof value.id!=='string' || !value.id || value.id.length>4000 || typeof value.title!=='string' || value.title.length>1000 || typeof value.text!=='string' || value.text.length>2_000_000)throw new Error('Invalid connected document.');const source=plain(value.source)?value.source:{};return {id:value.id,title:value.title,text:value.text,sourceUrl:typeof value.sourceUrl==='string'?value.sourceUrl:typeof source.url==='string'?source.url:undefined,connectionId:typeof value.connectionId==='string'?value.connectionId:typeof source.connectionId==='string'?source.connectionId:undefined,provider:typeof value.provider==='string'?value.provider:typeof source.provider==='string'?source.provider:undefined,orgId:typeof value.orgId==='string'?value.orgId:undefined,teamId:typeof value.teamId==='string'?value.teamId:undefined};});
  }
  private async refreshConnected(profile:Profile) {
    try{const context=await this.request('connectors/context');profile.connectedDocuments=this.connected(context.documents);}catch(error){if((error as Error&{code?:string}).code==='not_found')profile.connectedDocuments=[];else throw error;}
  }
  connector(input:CloudConnectorAction):Promise<CloudConnectorResult> {return this.runForActor(async()=>{
    const profile=this.profile();let path='connectors',method='GET',body:unknown;const connection='connectionId' in input?encodeURIComponent(input.connectionId):'';
    switch(input.action){
      case 'status':path+='/status';break;
      case 'context':path+=`/context?${new URLSearchParams({...(input.query?{q:input.query}:{}),...(input.email?{email:input.email}:{})})}`;break;
      case 'google-start':path+='/google/start';method='POST';body={};break;
      case 'calendars':path+=`/${connection}/calendars`;break;
      case 'select-calendars':path+=`/${connection}/calendars`;method='PUT';body={calendarIds:input.calendarIds};break;
      case 'sync':path+=`/${connection}/sync`;method='POST';body={full:input.full===true};break;
      case 'disconnect':if(input.confirmed!==true)throw new Error('Confirm disconnecting this integration.');path+=`/${connection}`;method='DELETE';break;
      case 'settings':path+=`/${connection}/settings`;method='PATCH';body={autoSync:input.autoSync,syncIntervalMinutes:input.syncIntervalMinutes,mappings:input.mappings,remoteUserId:input.remoteUserId};break;
      case 'merge-link':path+='/merge/link';method='POST';body={category:input.category,orgId:input.orgId,teamId:input.teamId};break;
      case 'merge-exchange':if(!this.mergeLink || this.mergeLink.profile!==this.saved.active || Date.parse(this.mergeLink.expiresAt)<=Date.now())throw new Error('Start Merge linking again. This request expired or belongs to another account.');path+='/merge/exchange';method='POST';body={state:this.mergeLink.state,publicToken:input.publicToken};break;
      case 'merge-connect':path+='/merge/connect';method='POST';body={category:input.category,orgId:input.orgId,teamId:input.teamId,accountToken:input.accountToken,label:input.label};break;
      case 'url-create':if(input.approveUrl!==true)throw new Error('Approve the public URL before connecting it.');path+='/urls';method='POST';body={url:input.url,title:input.title,orgId:input.orgId,teamId:input.teamId,approveUrl:true,autoSync:input.autoSync,syncIntervalMinutes:input.syncIntervalMinutes};break;
      case 'records':path+=`/${connection}/records?${new URLSearchParams({...(input.query?{q:input.query}:{}),...(input.kind?{kind:input.kind}:{})})}`;break;
      case 'match':path+=`/${connection}/match?${new URLSearchParams({email:input.email})}`;break;
      case 'health':case 'field-mappings':case 'remote-fields':case 'target-fields':case 'jobs':path+=`/${connection}/${input.action}`;break;
      case 'create-field-mapping':case 'update-field-mapping':case 'delete-field-mapping':if(input.confirmMappingChange!==true)throw new Error('Confirm the field mapping change first.');if(input.action!=='create-field-mapping' && !input.mappingId)throw new Error('Choose the mapping to change.');path+=`/${connection}/field-mappings${input.mappingId?`/${encodeURIComponent(input.mappingId)}`:''}`;method=input.action==='create-field-mapping'?'POST':input.action==='update-field-mapping'?'PATCH':'DELETE';body={mapping:secretFree(input.mapping),confirmMappingChange:true};break;
      case 'writeback-preview':case 'writeback':if(!profile.bindings[`meeting:${input.meetingId}`]?.base)throw new Error('Sync this session before preparing a CRM or ATS writeback.');if(input.action==='writeback' && input.confirmWriteback!==true)throw new Error('Confirm the reviewed writeback first.');if(input.action==='writeback' && (typeof input.previewToken!=='string' || !input.previewToken.trim() || input.previewToken.length>1024))throw new Error('Preview the exact writeback before approving it.');path+=`/${connection}/writeback${input.action==='writeback-preview'?'/preview':''}`;method='POST';body={meetingId:input.meetingId,targetId:input.targetId,notes:input.notes,includeActions:input.includeActions,remoteUserId:input.remoteUserId,...(input.action==='writeback'?{confirmWriteback:true,idempotencyKey:input.idempotencyKey,previewToken:input.previewToken}:{})};break;
      case 'run-jobs':path+=`/${connection}/jobs/run`;method='POST';body={};break;
      case 'retry-job':path+=`/${connection}/jobs/${encodeURIComponent(input.jobId)}/retry`;method='POST';body={confirmPossibleDuplicate:input.confirmPossibleDuplicate};break;
      case 'import-person':{
        const result=await this.request(`connectors/${connection}/records`);const selected=result.records?.find((record:Record<string,unknown>)=>record.id===input.recordId && ['contacts','candidates'].includes(String(record.kind)));if(!selected || typeof selected.name!=='string' || !selected.name.trim())throw new Error('Select an imported contact or candidate.');const email=Array.isArray(selected.emails)?selected.emails.find((value:unknown)=>typeof value==='string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) as string|undefined:undefined;const existing=email?this.options.getLocal().people?.find(person=>person.email?.toLowerCase()===email.toLowerCase()):undefined;const personId=existing?.id??randomUUID();const timestamp=new Date().toISOString();const importedNotes=typeof selected.text==='string'?selected.text.slice(0,100000):'';const notes=existing?.notes?.includes(importedNotes)?existing.notes:[existing?.notes,importedNotes].filter(Boolean).join('\n\n').slice(0,100000);await this.options.applyRemote([{entity:'person',id:personId,data:{...existing,id:personId,name:existing?.name||selected.name,email:email?.toLowerCase(),notes,createdAt:existing?.createdAt??timestamp,updatedAt:timestamp}}]);return {personId,imported:true};
      }
      default:throw new Error('Unknown integration action.');
    }
    const result=await this.request(path,method,body);
    if(input.action==='merge-link'){if(typeof result.state!=='string' || typeof result.expiresAt!=='string')throw new Error('Invalid Merge linking response.');this.mergeLink={profile:this.saved.active!,state:result.state,expiresAt:result.expiresAt};const url=result.hostedLinkUrl?new URL(String(result.hostedLinkUrl)):undefined;if(url && url.protocol!=='https:')throw new Error('Merge linking requires HTTPS.');return {hostedLinkUrl:url?.href,expiresAt:result.expiresAt};}
    if(input.action==='merge-exchange')this.mergeLink=undefined;
    if(input.action==='google-start'){const url=new URL(String(result.authorizationUrl));if(url.protocol!=='https:')throw new Error('Google authorization requires HTTPS.');return {authorizationUrl:url.href,expiresAt:result.expiresAt};}
    if(input.action==='context')profile.connectedDocuments=this.connected(result.documents);
    if(['sync','select-calendars','disconnect'].includes(input.action)){await this.syncBatch(profile,[]);await this.refreshConnected(profile);}
    if(input.action==='status'){await this.refreshConnected(profile);}
    this.persist();const safeResult=secretFree(result) as CloudConnectorResult;
    if(input.action==='writeback-preview'){if(typeof result.previewToken!=='string' || !result.previewToken || result.previewToken.length>1024 || typeof result.previewExpiresAt!=='string' || !Number.isFinite(Date.parse(result.previewExpiresAt)))throw new Error('The server returned an invalid writeback review.');safeResult.previewToken=result.previewToken;safeResult.previewExpiresAt=result.previewExpiresAt;}
    return safeResult;
  });}
  /** Resolve a managed link without sending its hidden URL template to the desktop. */
  async resolveAssignedLink(input:CloudAssignedLinkInput):Promise<{url:string}> {
    const result=await this.request('assistant/action-link','POST',secretFree({actionId:input.actionId,question:input.question,sessionId:input.sessionId,sessionContext:input.sessionContext,transcript:input.transcript}));const url=new URL(String(result.url));if(!['http:','https:'].includes(url.protocol) || url.username || url.password)throw new Error('The assigned action returned an invalid link.');return {url:url.href};
  }
  resolveActionLink(input:CloudAssignedLinkInput):Promise<{url:string}>{return this.resolveAssignedLink(input);}
  /** Main-process transport for assigned prompts whose instructions remain on the server. */
  async streamAssistant(input:CloudAssistantInput,onDelta:(text:string)=>void,signal?:AbortSignal,onSource?:(source:CloudAssistantResult['sources'][number])=>void):Promise<CloudAssistantResult> {
    const profile=this.profile();if(!this.options.secretStorage.isEncryptionAvailable())throw new Error('OS credential encryption is unavailable.');
    const scorecardId=input.scorecardId?.startsWith('shared:scorecard:')?input.scorecardId.slice('shared:scorecard:'.length):input.scorecardId;
    if(scorecardId && !profile.bindings[`scorecard:${scorecardId}`]?.base && !profile.shared.some(record=>record.entity==='scorecard' && record.id===scorecardId && record.data))throw new Error('Sync this scorecard to your account before using organization coaching.');
    const sessionId=input.sessionId && profile.bindings[`meeting:${input.sessionId}`]?.base?input.sessionId:undefined;
    const calendarEventId=input.calendarEventId && profile.bindings[`calendar:${input.calendarEventId}`]?.base?input.calendarEventId:undefined;
    const payload={kind:input.kind,question:input.question,transcript:input.transcript,sessionId,sessionContext:input.sessionContext,screen:input.screen,answers:input.answers,outputLanguage:cloudLanguage(input.outputLanguage),actionId:input.actionId,scope:input.scope,calendarEventId,scorecardId,requestId:input.requestId,smart:input.smart,webResearch:input.webResearch,researchOnly:input.researchOnly};
    const auth=this.saved.auth!;const response=await (this.options.fetch??fetch)(`${this.saved.endpoint}/assistant`,{method:'POST',headers:{'Content-Type':'application/json','Accept':'text/event-stream','Authorization':`Bearer ${this.options.secretStorage.decryptString(Buffer.from(auth.encryptedToken,'base64'))}`},body:JSON.stringify(secretFree(payload)),redirect:'error',signal:signal??AbortSignal.timeout(120000)});
    if(!response.ok){let error:{code?:string;message?:string}={};try{const data=await response.json() as any;error=data.error??data;}catch{}if(response.status===401 && error.code==='unauthorized'){this.saved.auth=undefined;this.saved.active=undefined;this.persist();this.changed();}throw new Error(error.message?.slice(0,500)??`Server assistant request failed (${response.status}).`);}
    if(!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))throw new Error('Server assistant returned no event stream.');
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',text='',result:CloudAssistantResult|undefined;
    const feed=(chunk:string)=>{buffer+=chunk;buffer=buffer.replace(/\r\n/g,'\n');if(buffer.length>2_000_000)throw new Error('Server assistant sent an oversized event.');let boundary:number;
      while((boundary=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const lines=event.split('\n');const kind=lines.find(line=>line.startsWith('event:'))?.slice(6).trim()??'message';const payload=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!payload)continue;let data:any;try{data=JSON.parse(payload);}catch{throw new Error('Server assistant sent malformed streaming data.');}
        if(kind==='delta'){if(result)throw new Error('Server assistant continued after completion.');if(typeof data.text!=='string')throw new Error('Invalid assistant text delta.');text+=data.text;if(text.length>2_000_000)throw new Error('Server assistant response is too large.');onDelta(data.text);}
        else if(kind==='source'){if(typeof data.id!=='string' || typeof data.title!=='string' || data.kind!=='web' || typeof data.url!=='string' || data.url.length>4000 || !['https:','http:'].includes(new URL(data.url).protocol))throw new Error('Invalid assistant citation.');onSource?.({id:data.id,title:data.title,kind:'web',url:data.url});}
        else if(kind==='done'){if(result || typeof data.text!=='string' || data.text.length>2_000_000 || !Array.isArray(data.sources) || data.sources.length>1000 || (text && data.text!==text))throw new Error('Invalid completed assistant response.');const sources=data.sources.map((source:unknown)=>{if(!plain(source) || typeof source.id!=='string' || source.id.length>4000 || typeof source.title!=='string' || source.title.length>10000 || !['knowledge','history','screen','transcript','web','calendar'].includes(String(source.kind)))throw new Error('Invalid assistant source.');return {id:source.id,title:source.title,kind:source.kind as CloudAssistantResult['sources'][number]['kind'],excerpt:typeof source.excerpt==='string'?source.excerpt.slice(0,100000):undefined,url:typeof source.url==='string'?source.url.slice(0,4000):undefined};});let usage:CloudAssistantResult['usage'];if(plain(data.usage)){const {inputTokens,outputTokens}=data.usage;if(!Number.isSafeInteger(inputTokens) || Number(inputTokens)<0 || !Number.isSafeInteger(outputTokens) || Number(outputTokens)<0)throw new Error('Invalid assistant usage.');usage={inputTokens:Number(inputTokens),outputTokens:Number(outputTokens)};}if(data.refused!==undefined&&typeof data.refused!=='boolean')throw new Error('Invalid assistant refusal state.');result={text:data.text,sources,usage,refused:typeof data.refused==='boolean'?data.refused:undefined,latencyMs:typeof data.latencyMs==='number' && Number.isFinite(data.latencyMs) && data.latencyMs>=0?data.latencyMs:undefined};}
        else if(kind==='error')throw new Error(typeof data.message==='string'?data.message.slice(0,500):'Server assistant could not complete the response.');
      }
    };
    try{for(;;){const chunk=await reader.read();if(chunk.done)break;feed(decoder.decode(chunk.value,{stream:true}));}feed(decoder.decode());if(buffer.trim())throw new Error('Server assistant ended with an incomplete event.');if(!result || !result.text.trim())throw new Error('Server assistant stream ended before completion.');return result;}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
}
