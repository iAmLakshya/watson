import type { CloudAssistantInput } from '../shared/cloud-types';
import type { Mode, Settings } from '../shared/types';
import type { PreparedContext, PreparationConfiguration } from './preparation';
import { renderPreparationQuestion } from './preparation';

// Managed models, effort, token budgets and private instructions are operator
// configuration. The desktop sends user intent and the web-research preference.
export function managedAssistIntent(settings: Settings, transcriptOnly = false): Pick<CloudAssistantInput, 'smart' | 'webResearch'> {
  const smart = settings.smartMode && !transcriptOnly;
  return { smart, webResearch: smart && (settings.smartWebSearch ?? true) };
}
export function managedPreparationRequest(context: PreparedContext, configuration: PreparationConfiguration, calendarBound: boolean): CloudAssistantInput {
  return { kind: 'brief', scope: 'calendar', calendarEventId: calendarBound ? context.eventId : undefined, question: renderPreparationQuestion(context), outputLanguage: configuration.outputLanguage, smart: true, webResearch: true, researchOnly: true };
}
export function preparationModeRoute(modeId:string,mode:Mode|undefined):'managed'|'personal'|'unavailable'{if(!mode&&modeId.startsWith('shared:'))return 'unavailable';return mode?.inference==='server'?'managed':'personal';}
