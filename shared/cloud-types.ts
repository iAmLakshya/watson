import type { AssistKind, CalendarEvent, ContextSource, KnowledgeDocument, Mode, Person, Scorecard, Session, Settings, TranscriptLine } from './types';

export type CloudEntity = 'meeting' | 'knowledge' | 'mode' | 'calendar' | 'settings' | 'folder' | 'person' | 'scorecard';
export interface CloudRecordKey { entity: CloudEntity; id: string; }
export interface CloudRecord extends CloudRecordKey { revision: number; data: Record<string, unknown> | null; deleted?: boolean; scope?: 'personal' | 'org' | 'team'; ownerId?: string; orgId?: string | null; teamId?: string | null; updatedAt?: string; inference?: 'server'; }
export interface CloudUser { id: string; email: string; name: string; createdAt?: string; updatedAt?: string; emailVerified?:boolean;emailVerifiedAt?:string|null; }
export interface CloudAuthCapabilities {emailDeliveryConfigured:boolean;verificationRequired:boolean;passwordRecoveryConfigured:boolean;}
export interface CloudEmailActionResult {accepted:boolean;message:string;}
export interface CloudManagedSmartStatus {configured:boolean;model:string|null;reasoningEffort:string;reasoningEnabled:boolean;maxOutputTokens:number|null;webResearchEnabled:boolean;webResearchConfigured:boolean;modelSupport:'supported'|'unknown'|'unsupported'|'unconfigured';configurationError:string|null;}
export interface CloudRecordingCapabilities {configured:boolean;maxBytes:number;supportedContentTypes:string[];recordingAllowed:boolean;consentRequired:true;attachmentsPerMeeting:1;uploadTimeoutMs?:number;}
export interface CloudRecordingMetadata {id:string;contentType:string;size:number;sha256:string;filename?:string;createdAt:string;ownerOnly:true;encryptedAtRest:boolean;inline?:boolean;}
export interface CloudRecordingSelection {meetingId:string;filename:string;size:number;contentType:string;selectionRevision:number;}
export interface CloudRecordingTransfer {meetingId:string;direction:'upload'|'download';status:'uploading'|'downloading'|'complete'|'error';bytesTransferred:number;totalBytes:number;error?:string;}
export interface CloudRecordingsState {capabilities?:CloudRecordingCapabilities;selected?:CloudRecordingSelection;entries:{meetingId:string;recording:CloudRecordingMetadata|null}[];transfer?:CloudRecordingTransfer;}
export interface CloudPolicy { recordingAllowed: boolean; publicSharingAllowed: boolean; retentionDays: number; organizations?: { id: string; recordingAllowed: boolean; publicSharingAllowed: boolean; retentionDays: number }[]; }
export interface CloudConflict extends CloudRecordKey { reason: 'revision' | 'local-change' | 'account-collision'; local: Record<string, unknown> | null; remote: CloudRecord; }
export interface CloudShare { meetingId: string; url: string; apiUrl?: string; expiresAt: string; }
export interface CloudOrganization { id: string; name: string; role: 'admin' | 'manager' | 'member'; retentionDays?: number; recordingAllowed?: boolean; publicSharingAllowed?: boolean; }
export interface CloudTeam { id: string; orgId: string; name: string; role?: string; }
export interface CloudMember { id: string; name: string; email: string; role: string; }
export interface CloudStatus {
  endpoint: string; signedIn: boolean; secureStorage: boolean; user?: CloudUser; deviceId?: string;
  cursor: number; busy: boolean; lastSyncAt?: string; error?: string; errorCode?: string; expiresAt?: string;
  conflicts: CloudConflict[]; shares: CloudShare[]; shared: CloudRecord[]; organizations: CloudOrganization[]; policy?: CloudPolicy;
  boundRecords: CloudRecordKey[]; pendingUploads: number; automaticSync: false; assignedMode?: CloudRecord; connectedDocuments?: CloudConnectedDocument[]; assistantConfigured?:boolean;webResearchConfigured?:boolean;smartConfigured?:boolean;smartWebResearchConfigured?:boolean;managedSmart?:CloudManagedSmartStatus;accountCapabilities?:CloudAuthCapabilities;authorizationRevision:number;recordings?:CloudRecordingsState;
}
export interface CloudLocalData { sessions: Session[]; knowledge: KnowledgeDocument[]; modes: Mode[]; calendar: CalendarEvent[]; settings: Settings; people?: Person[]; scorecards?: Scorecard[]; folders?: {id: string; name: string; parentId?: string}[]; }
export interface CloudApplyRecord extends CloudRecordKey { data: Record<string, unknown> | null; }
export type CloudOrgAction =
  | { action: 'list' }
  | { action: 'create'; name: string }
  | { action: 'update'; orgId: string; name: string }
  | { action: 'delete'; orgId: string; confirmed: true }
  | { action: 'members'; orgId: string }
  | { action: 'add-member'; orgId: string; email: string; role: 'admin' | 'manager' | 'member' }
  | { action: 'update-member'; orgId: string; userId: string; role: 'admin' | 'manager' | 'member' }
  | { action: 'remove-member'; orgId: string; userId: string }
  | { action: 'teams'; orgId: string }
  | { action: 'create-team'; orgId: string; name: string }
  | { action: 'update-team'; orgId: string; teamId: string; name: string }
  | { action: 'delete-team'; orgId: string; teamId: string }
  | { action: 'team-members'; orgId: string; teamId: string }
  | { action: 'add-team-member' | 'update-team-member'; orgId: string; teamId: string; userId: string; role: 'manager' | 'member' }
  | { action: 'remove-team-member'; orgId: string; teamId: string; userId: string }
  | { action: 'policy'; orgId: string; policy?: Partial<CloudPolicy> }
  | { action: 'resources'; orgId: string; teamId?: string }
  | { action: 'put-resource'; orgId: string; teamId?: string; entity: 'knowledge' | 'mode' | 'folder' | 'scorecard'; id: string; expectedRevision: number; data: Record<string, unknown> }
  | { action: 'delete-resource'; entity: 'knowledge' | 'mode' | 'folder' | 'scorecard'; id: string; expectedRevision: number }
  | { action: 'audit' | 'usage'; orgId: string };
export type CloudAssignmentAction = {action:'assignments';orgId:string;teamId?:string} | {action:'assign-mode';orgId:string;userId:string;modeId:string|null};
export type CloudOrgResult = { organizations?: CloudOrganization[]; members?: CloudMember[]; teams?: CloudTeam[]; resources?: CloudRecord[]; policy?: CloudPolicy; events?: Record<string, unknown>[]; [key: string]: unknown };
export type CloudEnterpriseAction = {action:'sso'|'directory';orgId:string} | {action:'billing'} | {action:'checkout';priceId:string;seats?:number} | {action:'portal'};
export interface CloudAssistantInput {kind:AssistKind;question?:string;transcript?:TranscriptLine[];sessionId?:string;sessionContext?:{id?:string;title:string;notes?:string;actions?:string[];followupDraft?:string;attendees?:string[]};screen?:{dataUrl:string;capturedAt?:string};answers?:{role:'user'|'assistant';text:string}[];outputLanguage?:string;actionId?:string;scope?:'session'|'history'|'calendar';calendarEventId?:string;scorecardId?:string;requestId?:string;smart?:boolean;webResearch?:boolean;researchOnly?:boolean;}
export interface CloudAssistantResult {text:string;sources:ContextSource[];usage?:{inputTokens:number;outputTokens:number};latencyMs?:number;refused?:boolean;}
export interface CloudAssignedLinkInput {actionId:string;question?:string;sessionId?:string;sessionContext?:{id?:string;title:string;notes?:string;actions?:string[];followupDraft?:string;attendees?:string[]};transcript?:TranscriptLine[];}
export interface CloudConnectedDocument {id:string;title:string;text:string;sourceUrl?:string;connectionId?:string;provider?:string;orgId?:string;teamId?:string;}
export interface CloudConnection {id:string;provider:'google'|'merge'|'url';category:string;orgId?:string|null;teamId?:string|null;label:string;status:string;settings:Record<string,unknown>;lastSync?:string|null;lastError?:string|null;createdAt?:string;}
export interface CloudConnectorCalendar {id:string;summary:string;selected:boolean;}
export type CloudConnectorAction =
  | {action:'status'}
  | {action:'context';query?:string;email?:string}
  | {action:'google-start'}
  | {action:'calendars';connectionId:string}
  | {action:'select-calendars';connectionId:string;calendarIds:string[]}
  | {action:'sync';connectionId:string;full?:boolean}
  | {action:'disconnect';connectionId:string;confirmed:true}
  | {action:'settings';connectionId:string;autoSync?:boolean;syncIntervalMinutes?:number;mappings?:{name?:string;email?:string;text?:string};remoteUserId?:string}
  | {action:'merge-link';category:'crm'|'ats';orgId:string;teamId?:string}
  | {action:'merge-exchange';publicToken:string}
  | {action:'merge-connect';category:'crm'|'ats';orgId:string;teamId?:string;accountToken:string;label?:string}
  | {action:'url-create';url:string;title?:string;orgId?:string;teamId?:string;approveUrl:true;autoSync?:boolean;syncIntervalMinutes?:number}
  | {action:'records';connectionId:string;query?:string;kind?:string}
  | {action:'match';connectionId:string;email:string}
  | {action:'health'|'field-mappings'|'remote-fields'|'target-fields'|'jobs';connectionId:string}
  | {action:'create-field-mapping'|'update-field-mapping'|'delete-field-mapping';connectionId:string;mappingId?:string;mapping?:Record<string,unknown>;confirmMappingChange:true}
  | {action:'writeback-preview';connectionId:string;meetingId:string;targetId:string;notes?:string;includeActions?:boolean;remoteUserId?:string}
  | {action:'writeback';connectionId:string;meetingId:string;targetId:string;notes?:string;includeActions?:boolean;remoteUserId?:string;confirmWriteback:true;idempotencyKey:string;previewToken:string}
  | {action:'run-jobs';connectionId:string}
  | {action:'retry-job';connectionId:string;jobId:string;confirmPossibleDuplicate?:boolean}
  | {action:'import-person';connectionId:string;recordId:string};
export interface CloudConnectorResult {connections?:CloudConnection[];connection?:CloudConnection;calendars?:CloudConnectorCalendar[];documents?:CloudConnectedDocument[];people?:Record<string,unknown>[];records?:Record<string,unknown>[];matches?:Record<string,unknown>[];jobs?:Record<string,unknown>[];authorizationUrl?:string;hostedLinkUrl?:string;expiresAt?:string;previewToken?:string;previewExpiresAt?:string;[key:string]:unknown;}

export interface CloudAnalyticsInput {orgId:string;from?:string;to?:string;teamId?:string;userId?:string;includeDemo?:boolean;}
export interface CloudAnalyticsMetrics {
  sessions:number;liveSessions:number;demoSessions:number;wallSeconds:number|null;capturedSeconds:number|null;
  microphoneSeconds:number|null;systemSeconds:number|null;providerRequests:number|null;inputTokens:number|null;
  outputTokens:number|null;screenshots:number|null;answers:number|null;completedAnswers:number|null;failedAnswers:number|null;
  knowledgeReferences:number|null;webReferences:number|null;averageLatencyMs:number|null;averageFirstTextLatencyMs?:number|null;averageCompletionLatencyMs?:number|null;firstTextSamples?:number;completionLatencySamples?:number;coachingScore:number|null;
}
export interface CloudAnalyticsReport {
  orgId:string;generatedAt:string;dateRange:{from:string;to:string};filters:{teamId?:string;userId?:string;includeDemo:boolean};
  allowedFilters:{organizationWide:boolean;ownOnly:boolean;teams:{id:string;name:string}[];members:{id:string;name:string;email:string}[]};
  summary:CloudAnalyticsMetrics;series:{date:string;metrics:CloudAnalyticsMetrics;usageEventCount:number;activeMembers:number}[];
  byMember:{userId:string;name:string;email:string;teamIds:string[];lastSeenAt:string|null;lastAppOpenAt:string|null;appVersion:string|null;metrics:CloudAnalyticsMetrics;usageEventCount:number}[];
  byTeam:{teamId:string;name:string;memberCount:number;metrics:CloudAnalyticsMetrics}[];
  usageEvents:{eventCount:number;totals:Record<string,number>;byKind:{kind:string;count:number;amount:number}[];source:string};
  missingMeasurements:{sessionsWithoutUsage:number;sessionsWithoutEnd:number;sessionsWithoutLatency:number;sessionsWithoutCoaching:number;unscopedSessionsExcluded:number;unscopedUsageEventsExcluded:number;meetingCoverage:number|null;reasons:string[]};
  source:{sessions:string;events:string;membership:string;deduplication:string;coaching:string;audio:string};
  adoption:{eligibleMembers:number;activeMembers:number;activeDefinition:string};
  byMode:{modeId:string;name:string;sessions:number;answers:number|null}[];
  features:{kind:string;requests:number;completedAnswers:number|null;failedAnswers:number|null}[];
}
export interface CloudAnalyticsExport {filename:string;csv:string;}

declare module './types' {
  interface AppState { cloud?: CloudStatus; }
  interface IpcCommands {
    'cloud:configure': { input: { endpoint: string }; output: CloudStatus };
    'cloud:signup': { input: { email: string; password: string; name?: string }; output: CloudStatus };
    'cloud:login': { input: { email: string; password: string }; output: CloudStatus };
    'cloud:logout': { input: undefined; output: CloudStatus };
    'cloud:refresh': { input: undefined; output: CloudStatus };
    'cloud:profile': { input: { name?: string; email?: string; currentPassword?: string }; output: CloudStatus };
    'cloud:password': { input: { currentPassword: string; newPassword: string }; output: CloudStatus };
    'cloud:delete-account': { input: { currentPassword: string; confirmed: true }; output: CloudStatus };
    'cloud:sync': { input: { uploads?: CloudRecordKey[]; confirmedUpload?: boolean }; output: CloudStatus };
    'cloud:cancel-uploads': { input: { confirmed: true }; output: CloudStatus };
    'cloud:resolve': { input: CloudRecordKey & { choice: 'local' | 'remote' | 'both'; confirmed?: boolean }; output: CloudStatus };
    'cloud:share': { input: { meetingId: string; expiresInDays?: number }; output: CloudShare };
    'cloud:open-share': { input: { meetingId: string }; output: void };
    'cloud:revoke-share': { input: { meetingId: string }; output: CloudStatus };
    'cloud:organization': { input: CloudOrgAction | CloudAssignmentAction; output: CloudOrgResult };
    'cloud:sso-start': { input: { providerId: string; linkAccount?: boolean }; output: { authorizationUrl: string; expiresAt: string } };
    'cloud:sso-poll': { input: undefined; output: CloudStatus };
    'cloud:enterprise': { input: CloudEnterpriseAction; output: CloudOrgResult };
    'cloud:connector': { input: CloudConnectorAction; output: CloudConnectorResult };
    'cloud:analytics': { input: CloudAnalyticsInput; output: CloudAnalyticsReport };
    'cloud:analytics-export': { input: CloudAnalyticsInput; output: {saved:boolean;path?:string} };
    'cloud:auth-capabilities': { input: undefined; output: CloudAuthCapabilities };
    'cloud:request-verification': { input: undefined; output: CloudEmailActionResult };
    'cloud:request-password-reset': { input: {email:string}; output: CloudEmailActionResult };
    'cloud:recording-capabilities': { input: undefined; output: CloudRecordingCapabilities };
    'cloud:recording-info': { input: {meetingId:string}; output: {recording:CloudRecordingMetadata|null} };
    'cloud:recording-pick': { input: {meetingId:string}; output: {selected:boolean;selection?:CloudRecordingSelection} };
    'cloud:recording-upload': { input: {meetingId:string;consentConfirmed:true;selectionRevision:number}; output: {recording:CloudRecordingMetadata;revision:number} };
    'cloud:recording-download': { input: {meetingId:string}; output: {saved:boolean;path?:string} };
    'cloud:recording-delete': { input: {meetingId:string;confirmed:true}; output: {deleted:boolean;revision:number} };
    'cloud:recording-clear-selection': { input: undefined; output: CloudStatus };
  }
}
