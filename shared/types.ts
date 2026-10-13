export type AudioSource = 'system' | 'microphone';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AssistKind = 'assist' | 'say' | 'followup' | 'recap' | 'chat' | 'notes' | 'email' | 'brief' | 'custom' | 'coaching';
export type ShortcutAction = 'toggleOverlay' | 'assist' | 'toggleClickthrough' | 'moveLeft' | 'moveRight' | 'moveUp' | 'moveDown' | 'scrollUp' | 'scrollDown' | 'clearChat' | 'startStopSession';
export interface Settings {
  theme: 'dark' | 'light' | 'system'; opacity: number; contentProtection: boolean; clickthrough: boolean;
  captureSystem: boolean; captureMicrophone: boolean; captureScreen: boolean; displayId: string;
  microphoneDeviceId?: string;
  language: string; outputLanguage: string; model: string; transcriptionModel: string; instructions: string;
  smartMode: boolean; autoAssist: boolean; launchAtLogin: boolean; activeModeId: string;
  smartModel?: string; smartReasoningEffort?: ReasoningEffort; smartWebSearch?: boolean; smartMaxOutputTokens?: number;
  meetingDetectionEnabled?: boolean; meetingStartAction?: 'off' | 'alert' | 'start'; meetingEndAction?: 'off' | 'alert' | 'stop';
  meetingStartDelaySeconds?: number; meetingEndDelaySeconds?: number; meetingAppBundleIds?: string[]; meetingBrowserAlerts?: boolean; meetingBrowserAutoStart?: boolean;
  onboardingCompleted?: boolean;
  shortcuts: Record<ShortcutAction, string>;
}
export interface TranscriptLine { id: string; source: AudioSource; text: string; timestamp: string; final: boolean; speaker?: number; }
export interface Answer { id: string; kind: AssistKind; question: string; text: string; createdAt: string; status: 'streaming' | 'complete' | 'error'; sources: ContextSource[]; latencyMs?: number; firstTextLatencyMs?: number; latencyScope?: 'application-request'; error?: string; scope?: 'session' | 'history' | 'calendar'; eventId?: string; actionId?: string; coachingAssessmentId?: string; refused?: boolean; }
export interface ContextSource { id: string; title: string; kind: 'knowledge' | 'history' | 'screen' | 'transcript' | 'web' | 'calendar'; excerpt?: string; url?: string; }
export interface Session {
  id: string; title: string; startedAt: string; endedAt?: string; modeId: string; demo: boolean; pinned: boolean;
  transcript: TranscriptLine[]; answers: Answer[]; notes: string; actions: string[]; followupDraft: string; tags?: string[];
  attendeeIds?: string[]; calendarEventId?: string; commitments?: Commitment[]; coaching?: CoachingAssessment[]; usage?: SessionUsage;
  meetingDetectionId?: string; organizationId?: string;
}
export interface KnowledgeDocument { id: string; title: string; text: string; addedAt: string; size: number; fileType: string; shared?: boolean; folderId?: string; tags?: string[]; sourceUrl?: string; }
export interface KnowledgeFolder { id: string; name: string; parentId?: string; }
export interface CustomAction { id: string; name: string; type: 'prompt' | 'link'; prompt?: string; urlTemplate?: string; }
export interface Mode { id: string; name: string; instructions: string; noteTemplate: string; documentIds: string[]; builtIn?: boolean; emailTemplate?: string; customActions?: CustomAction[]; shared?: boolean; assigned?: boolean; folderId?: string; inference?: 'server'; organizationId?: string; teamId?: string; }
export interface CalendarAttendee { name?: string; email: string; }
export interface CalendarEvent { id: string; title: string; start: string; end: string; description: string; location?: string; joinUrl?: string; briefing?: string; attendees?: CalendarAttendee[]; source?: { provider: string; connectionId: string; eventId?: string; calendarId?: string }; }
export interface AudioLevel { rms: number; peak: number; dbFS: number; clipping: boolean; updatedAt?: string; }
export type AudioLevels = Record<AudioSource, AudioLevel>;
export interface AudioTestState { running: boolean; transcribing: boolean; source: 'microphone' | 'system' | 'both'; status: string; transcript: TranscriptLine[]; levels: AudioLevels; error?: string; }
export interface CaptureState { running: boolean; system: boolean; microphone: boolean; screen: boolean; helperAvailable: boolean; status: string; lastScreenAt?: string; error?: string; levels?: AudioLevels; }
export interface Person { id: string; name: string; email?: string; company?: string; role?: string; notes?: string; createdAt: string; updatedAt: string; }
export interface Commitment { id: string; text: string; personId?: string; ownerName?: string; dueAt?: string; status: 'open' | 'done'; createdAt: string; updatedAt: string; }
export interface PersonHistory { person: Person; sessions: Session[]; commitments: (Commitment & { sessionId: string; sessionTitle: string })[]; }
export interface ScorecardCriterion { id: string; name: string; description: string; maxScore: number; weight: number; }
export interface Scorecard { id: string; name: string; instructions: string; criteria: ScorecardCriterion[]; shared?: boolean; assigned?: boolean; }
export interface CoachingResult { criterionId: string; name: string; score: number | null; maxScore: number; weight: number; evidence: { lineId: string; quote: string }[]; feedback: string; missedOpportunities: string[]; }
export interface CoachingAssessment { id: string; scorecardId: string; scorecardName: string; createdAt: string; overallScore?: number; summary: string; criteria: CoachingResult[]; demo: boolean; }
export interface SessionUsage { captureMs: number; audioSamples: Record<AudioSource, number>; screenshots: number; providerRequests: number; inputTokens: number; outputTokens: number; serverRequests?: number; }
export interface AnalyticsFilter { from?: string; to?: string; modeId?: string; personId?: string; includeDemo?: boolean; }
export interface SessionAnalytics { id: string; title: string; startedAt: string; modeId: string; demo: boolean; wallSeconds: number; capturedSeconds?: number; microphoneSeconds?: number; systemSeconds?: number; answers: number; completedAnswers: number; failedAnswers: number; outputCharacters: number; averageLatencyMs?: number; averageFirstTextLatencyMs?: number; averageCompletionLatencyMs?: number; firstTextSamples?: number; completionLatencySamples?: number; inputTokens?: number; outputTokens?: number; coachingScore?: number; }
export interface AnalyticsReport { generatedAt: string; filters: AnalyticsFilter; sessions: SessionAnalytics[]; summary: { sessions: number; liveSessions: number; demoSessions: number; wallSeconds: number; capturedSeconds: number; microphoneSeconds: number; systemSeconds: number; assistantRequests: number; completedAnswers: number; failedAnswers: number; outputCharacters: number; inputTokens: number; outputTokens: number; averageLatencyMs?: number; averageFirstTextLatencyMs?: number; averageCompletionLatencyMs?: number; firstTextSamples?: number; completionLatencySamples?: number; coachingScore?: number; sessionsWithoutCaptureMetrics: number }; byDay: { date: string; sessions: number; wallSeconds: number; answers: number }[]; }
export interface PermissionState { screen: string; microphone: string; accessibility?: string; }
export interface DisplayInfo { id: string; label: string; width: number; height: number; }
export interface MicrophoneInfo { id: string; label: string; isDefault?: boolean; }
export interface AudioProcessActivity { pid: number; bundleId: string; name: string; inputActive: boolean; outputActive: boolean; }
export interface MeetingActivitySnapshot { supported: boolean; checkedAt: string; processes: AudioProcessActivity[]; error?: string; }
export interface MeetingDetectionState { enabled: boolean; supported: boolean; status: 'disabled' | 'watching' | 'candidate' | 'active' | 'possible-end' | 'setup-required' | 'error'; message: string; activity?: MeetingActivitySnapshot; candidateId?: string; appName?: string; bundleId?: string; ambiguousBrowser?: boolean; activeSince?: string; inactiveSince?: string; sessionId?: string; }
export interface CredentialsStatus { openai: boolean; deepgram: boolean; secureStorage: boolean; }
export interface AppState {
  settings: Settings; sessions: Session[]; activeSessionId?: string; knowledge: KnowledgeDocument[]; modes: Mode[];
  calendar: CalendarEvent[]; capture: CaptureState; credentials: CredentialsStatus; permissions: PermissionState;
  overlayVisible: boolean; generating: boolean; interimTranscript: TranscriptLine[]; version: string; platform: string;
  warnings: string[]; sessionPaused: boolean; contextAnswers?: Answer[];
  audioTest?: AudioTestState; people?: Person[]; scorecards?: Scorecard[];
  folders?: KnowledgeFolder[];
  meetingDetection?: MeetingDetectionState;
}
export interface AssistInput { kind?: AssistKind; question?: string; sessionId?: string; includeScreen?: boolean; eventId?: string; scope?: 'session' | 'history' | 'calendar'; actionId?: string; scorecardId?: string; }
export interface IpcCommands {
  'bootstrap': { input: undefined; output: AppState };
  'session:start': { input: { title?: string; demo?: boolean; modeId?: string; resumeId?: string; attendeeIds?: string[]; calendarEventId?: string }; output: Session };
  'session:stop': { input: undefined; output: Session | undefined };
  'session:pause': { input: undefined; output: void };
  'session:resume': { input: undefined; output: void };
  'session:update': { input: { id: string; title?: string; notes?: string; actions?: string[]; followupDraft?: string; pinned?: boolean; tags?: string[]; attendeeIds?: string[] }; output: Session };
  'session:delete': { input: { id: string }; output: void };
  'session:clear-chat': { input: { id: string }; output: void };
  'session:search': { input: { query: string }; output: Session[] };
  'session:export': { input: { id: string; format?: 'markdown' | 'json' }; output: { saved: boolean; path?: string } };
  'assist': { input: AssistInput; output: Answer };
  'assist:cancel': { input: undefined; output: void };
  'action:run': { input: { actionId: string; sessionId?: string; question?: string }; output: { answer?: Answer; openedUrl?: string } };
  'settings:update': { input: Partial<Settings>; output: Settings };
  'credentials:save': { input: { openai?: string; deepgram?: string }; output: CredentialsStatus };
  'knowledge:import': { input: undefined; output: KnowledgeDocument[] };
  'knowledge:add': { input: { title: string; text: string }; output: KnowledgeDocument };
  'knowledge:delete': { input: { id: string }; output: void };
  'mode:save': { input: Omit<Mode, 'id'> & { id?: string }; output: Mode };
  'mode:delete': { input: { id: string }; output: void };
  'calendar:import': { input: undefined; output: CalendarEvent[] };
  'calendar:delete': { input: { id: string }; output: void };
  'calendar:join': { input: { id: string }; output: void };
  'mail:compose': { input: { id: string }; output: void };
  'audio:test-start': { input: { source?: 'microphone' | 'system' | 'both'; transcribe?: boolean }; output: AudioTestState };
  'audio:test-stop': { input: undefined; output: AudioTestState };
  'audio:devices': { input: undefined; output: MicrophoneInfo[] };
  'meeting:scan': { input: undefined; output: MeetingDetectionState };
  'meeting:respond': { input: { candidateId: string; action: 'start' | 'dismiss' | 'stop' | 'keep' }; output: MeetingDetectionState };
  'person:save': { input: Omit<Person, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }; output: Person };
  'person:delete': { input: { id: string }; output: void };
  'person:search': { input: { query?: string; personId?: string }; output: PersonHistory[] };
  'commitment:save': { input: { sessionId: string; id?: string; text: string; personId?: string; ownerName?: string; dueAt?: string; status?: 'open' | 'done' }; output: Commitment };
  'commitment:delete': { input: { sessionId: string; id: string }; output: void };
  'scorecard:save': { input: Omit<Scorecard, 'id'> & { id?: string }; output: Scorecard };
  'scorecard:delete': { input: { id: string }; output: void };
  'analytics:get': { input: AnalyticsFilter; output: AnalyticsReport };
  'analytics:export': { input: AnalyticsFilter & { format?: 'csv' | 'json' }; output: { saved: boolean; path?: string } };
  'window:overlay': { input: { visible?: boolean }; output: boolean };
  'window:dashboard': { input: undefined; output: void };
  'window:minimize': { input: undefined; output: void };
  'window:resize': { input: { expanded: boolean }; output: void };
  'window:move': { input: { direction: 'left' | 'right' | 'up' | 'down' }; output: void };
  'clipboard:write': { input: { text: string }; output: void };
  'external:open': { input: { url: string }; output: void };
  'permissions:request': { input: { kind: 'screen' | 'microphone' }; output: PermissionState };
  'displays:list': { input: undefined; output: DisplayInfo[] };
  'capture:screenshot': { input: undefined; output: { captured: boolean; capturedAt?: string; imageDataURL?: string } };
}
export type IpcCommand = keyof IpcCommands;
export type AppEvent = { type: 'state'; state: AppState } | { type: 'scroll'; direction: 'up' | 'down' } | { type: 'toast'; message: string; level: 'info' | 'error' } | { type: 'calendar:reminder'; event: CalendarEvent };
export interface WatsonBridge {
  invoke<K extends IpcCommand>(command: K, ...args: IpcCommands[K]['input'] extends undefined ? [input?: undefined] : [input: IpcCommands[K]['input']]): Promise<IpcCommands[K]['output']>;
  subscribe(listener: (event: AppEvent) => void): () => void;
}
declare global { interface Window { watson?: WatsonBridge; } }
