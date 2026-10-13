import type { CalendarEvent, ContextSource, Person, Session } from './types';

export interface PreparationSettings {
  automaticPreparation: boolean;
  preparationLeadMinutes: number;
  preparationRefreshMinutes: number;
  preparationModel?: string;
}
export const DEFAULT_PREPARATION_SETTINGS: PreparationSettings = {
  automaticPreparation: false, preparationLeadMinutes: 15, preparationRefreshMinutes: 60,
};
export type PreparationStatus = 'idle'|'queued'|'researching'|'ready'|'setup_required'|'error'|'cancelled';
export interface PreparationParticipant {
  email: string; name?: string; company?: string; role?: string; personId?: string;
  emailDomain?: string; identity: 'calendar'|'saved_person'|'ambiguous'; sourceIds: string[];
}
export interface PreparationEntry {
  eventId: string; status: PreparationStatus; text: string; sources: ContextSource[];
  participants: PreparationParticipant[]; attempts: number; updatedAt: string;
  generatedAt?: string; expiresAt?: string; retryAt?: string; error?: string;
  errorCode?: string; setupCode?: 'openai_key_required'|'model_required'|'participant_details_required';
}
export interface PreparationState {
  entries: PreparationEntry[]; automatic: boolean; leadMinutes: number;
  refreshMinutes: number; running: boolean;
}
export interface PreparationReference {
  id: string; title: string; text: string; sourceUrl?: string; connectionId?: string;
  provider?: string; orgId?: string; teamId?: string;
}
export interface PreparationSnapshot {
  events: CalendarEvent[]; people?: Person[]; sessions?: Session[];
  connectedDocuments?: PreparationReference[];
  /** Stable account/access-scope identity supplied by Engine; never a credential. */
  contextScope?: string;
}
declare module './types' {
  interface Settings {
    automaticPreparation?: boolean; preparationLeadMinutes?: number;
    preparationRefreshMinutes?: number; preparationModel?: string;
  }
  interface AppState { preparation?: PreparationState; }
  interface IpcCommands {
    'calendar:prepare': {input:{eventId:string;force?:boolean};output:PreparationEntry};
    'calendar:prepare-cancel': {input:{eventId?:string};output:void};
  }
}
