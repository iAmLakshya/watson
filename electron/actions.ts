import type { CustomAction, Person, Session } from '../shared/types';
import { formatTranscript } from './context';
import { safeExternalUrl } from './validation';
const VARIABLES = new Set(['sessionTitle', 'notes', 'transcript', 'attendees', 'question', 'sessionId', 'emailDraft']);
const PLACEHOLDERS = /\{\{?([A-Za-z]+)\}?\}/g;
export function validateAction(action: CustomAction) {
  if (!action.id || !action.name.trim()) throw new Error('A custom action needs an ID and name');
  if (action.type === 'prompt') { if (!action.prompt?.trim()) throw new Error('A prompt action needs instructions'); }
  else if (action.type === 'link') {
    if (!action.urlTemplate?.trim()) throw new Error('A link action needs a URL');
    for (const match of action.urlTemplate.matchAll(PLACEHOLDERS)) if (!VARIABLES.has(match[1])) throw new Error(`Unknown action variable: ${match[1]}`);
    const authorityEnd = action.urlTemplate.slice(action.urlTemplate.indexOf('://') + 3).search(/[/?#]/); const authorityLength = authorityEnd < 0 ? action.urlTemplate.length : action.urlTemplate.indexOf('://') + 3 + authorityEnd;
    if (PLACEHOLDERS.test(action.urlTemplate.slice(0, authorityLength))) { PLACEHOLDERS.lastIndex = 0; throw new Error('Action variables may appear only in the URL path or query'); } PLACEHOLDERS.lastIndex = 0;
    safeExternalUrl(action.urlTemplate.replace(PLACEHOLDERS, 'context'));
  } else throw new Error('Choose a prompt or HTTPS link action');
  return action;
}
export function actionContext(session: Session, people: Person[], question = '') { return { sessionTitle: session.title, notes: session.notes, transcript: formatTranscript(session), attendees: people.filter(person => session.attendeeIds?.includes(person.id)).map(person => person.name).join(', '), question, sessionId: session.id, emailDraft: session.followupDraft }; }
export function renderAction(action: CustomAction, session: Session, people: Person[], question?: string) {
  validateAction(action); const values = actionContext(session, people, question);
  if (action.type === 'prompt') return { prompt: action.prompt!.replace(PLACEHOLDERS, (_match, name: string) => { if (!VARIABLES.has(name)) throw new Error(`Unknown action variable: ${name}`); return values[name as keyof typeof values]; }) };
  const url = action.urlTemplate!.replace(PLACEHOLDERS, (_match, name: string) => encodeURIComponent(values[name as keyof typeof values]));
  return { url: safeExternalUrl(url, 200000) };
}
