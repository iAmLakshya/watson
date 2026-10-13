import type { Answer, AppEvent, AppState, Session, WatsonBridge } from '../shared/types';
import { BUILTIN_MODES, DEFAULT_SETTINGS } from '../shared/defaults';

const settings = structuredClone(DEFAULT_SETTINGS);
const now = Date.now();
const examples: Session[] = [
  { id: 'demo-review', title: 'Q4 product direction', modeId: 'general', startedAt: new Date(now - 86400000).toISOString(), endedAt: new Date(now - 84480000).toISOString(), demo: true, pinned: true, tags: ['Product'], transcript: [
    { id: 't1', source: 'system', text: 'For the next release, should we focus on onboarding or expand the reporting tools?', timestamp: new Date(now - 86390000).toISOString(), final: true, speaker: 1 },
    { id: 't2', source: 'microphone', text: 'I would start with onboarding. Let’s measure time to first value before widening the scope.', timestamp: new Date(now - 86380000).toISOString(), final: true },
  ], answers: [], notes: '# Product direction\n\nThe team discussed prioritizing onboarding for the next release.\n\n## Decisions\n- Focus the next milestone on time to first value.\n- Review reporting needs after the onboarding improvements.\n\n## Next steps\n- Define a baseline and success metric.\n- Bring a proposed onboarding flow to the next review.', actions: ['Define the onboarding success metric', 'Prepare the next product review'], followupDraft: 'Thanks for the discussion. We agreed to prioritize onboarding in the next milestone and use time to first value as our measure of success. I’ll share a proposed flow before our next review.' },
  { id: 'demo-design', title: 'Design catch-up', modeId: 'general', startedAt: new Date(now - 172800000).toISOString(), endedAt: new Date(now - 171540000).toISOString(), demo: true, pinned: false, tags: ['Design'], transcript: [], answers: [], notes: 'An example of a saved session. Start a demo session to try the transcript and assistant.', actions: [], followupDraft: '' },
  { id: 'demo-planning', title: 'Weekly planning', modeId: 'general', startedAt: new Date(now - 259200000).toISOString(), endedAt: new Date(now - 257700000).toISOString(), demo: true, pinned: false, tags: ['Team'], transcript: [], answers: [], notes: 'Sample meeting notes for the browser preview.', actions: [], followupDraft: '' },
];
const initial: AppState = {
  settings, sessions: examples, sessionPaused: false, knowledge: [],
  modes: structuredClone(BUILTIN_MODES),
  calendar: [], capture: { running: false, system: false, microphone: false, screen: false, helperAvailable: false, status: 'Browser preview: capture unavailable' },
  credentials: { openai: false, deepgram: false, secureStorage: false }, permissions: { screen: 'unavailable', microphone: 'unavailable' },
  overlayVisible: false, generating: false, interimTranscript: [], version: 'preview', platform: 'browser', warnings: [], contextAnswers: [], people: [], scorecards: [],
  meetingDetection: { enabled: false, supported: false, status: 'disabled', message: 'Native meeting detection is unavailable in the browser preview.' },
  preparation: { entries: [], automatic: false, leadMinutes: 15, refreshMinutes: 60, running: false },
};

export function createDemoBridge(): WatsonBridge {
  let state: AppState = structuredClone(initial);
  const listeners = new Set<(event: AppEvent) => void>();
  let tick: ReturnType<typeof setInterval> | undefined;
  const emit = () => listeners.forEach(fn => fn({ type: 'state', state: structuredClone(state) }));
  const active = () => state.sessions.find(s => s.id === state.activeSessionId);
  const demoLines = [
    'We have three priorities for this quarter. How should we choose what to tackle first?',
    'I think we should look at customer impact, effort, and what we can learn fastest.',
    'What would a small first step look like, and how would we know it worked?',
    'Let’s agree on an owner and a measurable outcome before we wrap up.',
  ];
  const beginTick = () => {
    if (tick) clearInterval(tick);
    let index = 0;
    tick = setInterval(() => {
      const session = active();
      if (!session || state.sessionPaused) return;
      session.transcript.push({ id: crypto.randomUUID(), source: index % 2 ? 'microphone' : 'system', text: demoLines[index++ % demoLines.length], timestamp: new Date().toISOString(), final: true });
      emit();
    }, 5500);
  };
  const invoke = async (command: string, input?: any): Promise<any> => {
    let result: any;
    switch (command) {
      case 'bootstrap': return structuredClone(state);
      case 'session:start': {
        if (!input?.demo) throw new Error('Live capture requires the Watson desktop app. Start an explicitly labeled demo in this browser preview.');
        if (state.activeSessionId) throw new Error('End the current demo before starting another session.');
        const resumed = input.resumeId ? state.sessions.find(session => session.id === input.resumeId) : undefined;
        const session: Session = resumed || { id: crypto.randomUUID(), title: input.title || 'Demo session', startedAt: new Date().toISOString(), modeId: input.modeId || state.settings.activeModeId, demo: true, pinned: false, tags: [], transcript: [], answers: [], notes: '', actions: [], followupDraft: '', attendeeIds: input.attendeeIds || [], calendarEventId: input.calendarEventId, commitments: [], coaching: [] };
        if (resumed) delete session.endedAt; else state.sessions.unshift(session);
        state.activeSessionId = session.id; state.sessionPaused = false;
        state.capture = { ...state.capture, running: false, status: 'Demo · simulated transcript, no audio or screen capture' };
        beginTick(); result = session; break;
      }
      case 'session:pause': state.sessionPaused = true; state.generating = false; break;
      case 'session:resume': state.sessionPaused = false; break;
      case 'session:stop': {
        const session = active(); if (session) { session.endedAt = new Date().toISOString(); session.notes ||= '## Demo summary\n\nDiscussed priorities, customer impact, and defining a small first step.\n\nThese notes are simulated demo content.'; }
        state.activeSessionId = undefined; state.sessionPaused = false; state.generating = false; if (tick) clearInterval(tick); result = session; break;
      }
      case 'session:update': { const session = state.sessions.find(s => s.id === input.id); if (!session) throw new Error('Session not found.'); Object.assign(session, input); result = session; break; }
      case 'session:delete': state.sessions = state.sessions.filter(s => s.id !== input.id); break;
      case 'session:clear-chat': { const session = state.sessions.find(s => s.id === input.id); if (session) session.answers = []; break; }
      case 'mail:compose': { const session = state.sessions.find(s => s.id === input.id); if (!session?.followupDraft) throw new Error('Write or generate a follow-up draft first.'); window.open(`https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(session.title)}&body=${encodeURIComponent(session.followupDraft)}`, '_blank', 'noopener,noreferrer'); break; }
      case 'session:search': return state.sessions.filter(s => JSON.stringify(s).toLowerCase().includes(input.query.toLowerCase()));
      case 'settings:update': state.settings = { ...state.settings, ...input }; if (input.meetingDetectionEnabled !== undefined) state.meetingDetection = { enabled: !!input.meetingDetectionEnabled, supported: false, status: input.meetingDetectionEnabled ? 'setup-required' : 'disabled', message: 'Native meeting detection is unavailable in the browser preview.' }; result = state.settings; break;
      case 'meeting:scan': return state.meetingDetection;
      case 'meeting:respond': throw new Error('Detected live meetings require the Watson desktop app. The browser preview does not monitor or start real calls.');
      case 'updates:status': case 'updates:check': case 'updates:clear': return { phase: 'unconfigured', configured: false, currentVersion: state.version, platform: 'browser', architecture: 'web', message: 'Signed desktop release updates are unavailable in the browser preview.', configurationGates: ['Use the desktop app for a configured signed release channel.'], readyToInstall: false };
      case 'updates:stage': case 'updates:install': throw new Error('The browser preview cannot stage or install a desktop release.');
      case 'calendar:prepare': {
        const event = state.calendar.find(event => event.id === input.eventId); if (!event) throw new Error('Calendar event not found.');
        const entry = { eventId: event.id, status: 'setup_required' as const, text: '', sources: [], participants: (event.attendees || []).map(person => ({ email: person.email, name: person.name, identity: 'calendar' as const, sourceIds: [event.id] })), attempts: 1, updatedAt: new Date().toISOString(), error: 'Sourced meeting preparation requires a configured provider in the desktop app. No model was called.', setupCode: 'openai_key_required' as const };
        state.preparation!.entries = [...state.preparation!.entries.filter(item => item.eventId !== event.id), entry]; result = entry; break;
      }
      case 'calendar:prepare-cancel': state.preparation!.entries.forEach(entry => { if (!input?.eventId || entry.eventId === input.eventId) entry.status = 'cancelled'; }); break;
      case 'credentials:save': throw new Error('Provider keys can only be saved in the desktop app. This browser preview does not store secrets.');
      case 'assist': {
        if (state.generating) throw new Error('A demo response is already being generated.');
        const scope = input.scope || (input.eventId ? 'calendar' : 'session');
        const session = scope === 'session' ? state.sessions.find(s => s.id === (input?.sessionId || state.activeSessionId)) : undefined;
        if (session && !session.demo) throw new Error('Live requests require the desktop app.');
        const scorecard = input.kind === 'coaching' ? state.scorecards!.find(card => card.id === input.scorecardId) : undefined;
        if (input.kind === 'coaching' && (!session || !scorecard)) throw new Error('Select a session and a scorecard for demo coaching.');
        const answer: Answer = { id: crypto.randomUUID(), kind: input.kind || 'assist', question: input.question || '', text: '', createdAt: new Date().toISOString(), status: 'streaming', sources: session?.transcript.length ? [{ id: session.id, title: session.title, kind: 'transcript' }] : [], scope, eventId: input.eventId };
        if (session) session.answers.push(answer); else if (scope !== 'session') state.contextAnswers!.push(answer);
        state.generating = true; emit();
        const content = input.kind === 'recap' || input.kind === 'notes' ? '### Demo recap\nWe discussed how to prioritize work using **customer impact, effort, and learning**.\n\n- Pick one small, measurable first step.\n- Assign an owner and agree on a success metric.\n- Review what we learned before expanding the scope.\n\n*Simulated demo response. No model was called.*' : input.kind === 'email' ? 'Hi team,\n\nThanks for today’s discussion. We agreed to start with a small, measurable change, assign an owner, and review the result before expanding our scope. Please share any additions to the plan.\n\n*Simulated demo draft.*' : input.kind === 'brief' ? '### Demo briefing\nReview the event description and your recent sessions. Prepare one goal, two questions, and a clear next step.\n\n*Simulated demo response.*' : `### ${input.kind === 'followup' ? 'A useful follow-up' : input.kind === 'say' ? 'You could say' : 'A clear next step'}\n${input.question ? 'Based on your question, ' : ''}I’d suggest we start with the option that has the clearest **customer impact** and the lowest cost to learn.\n\n“Could we pick one small experiment, name an owner, and agree on what success looks like?”\n\n*Simulated demo response. No model was called.*`;
        const chunks = content.match(/.{1,28}/gs) || [content];
        for (const chunk of chunks) { await new Promise(resolve => setTimeout(resolve, 40)); if (!state.generating) { answer.status = 'error'; answer.error = 'Demo generation cancelled'; break; } answer.text += chunk; emit(); }
        if (answer.status !== 'error') answer.status = 'complete'; state.generating = false;
        if (session && input.kind === 'notes' && answer.status === 'complete') session.notes = answer.text;
        if (session && input.kind === 'email' && answer.status === 'complete') session.followupDraft = answer.text;
        if (session && scorecard && answer.status === 'complete') {
          const assessment = { id: crypto.randomUUID(), scorecardId: scorecard.id, scorecardName: scorecard.name, createdAt: new Date().toISOString(), summary: 'Demo assessment only. No AI provider evaluated this conversation and no numeric scores are invented.', demo: true, criteria: scorecard.criteria.map(criterion => ({ criterionId: criterion.id, name: criterion.name, score: null, maxScore: criterion.maxScore, weight: criterion.weight, evidence: [], feedback: 'Demo placeholder. Run coaching on a real session with your configured provider for transcript-grounded feedback.', missedOpportunities: [] })) };
          session.coaching = [...(session.coaching || []), assessment]; answer.coachingAssessmentId = assessment.id;
        }
        result = answer; break;
      }
      case 'assist:cancel': state.generating = false; break;
      case 'knowledge:add': result = { id: crypto.randomUUID(), ...input, addedAt: new Date().toISOString(), size: input.text.length, fileType: 'text' }; state.knowledge.unshift(result); break;
      case 'knowledge:delete': state.knowledge = state.knowledge.filter(d => d.id !== input.id); break;
      case 'mode:save': { const mode = { ...input, id: input.id || crypto.randomUUID() }; state.modes = [...state.modes.filter(m => m.id !== mode.id), mode]; result = mode; break; }
      case 'mode:delete': state.modes = state.modes.filter(m => m.id !== input.id); break;
      case 'person:save': {
        const previous = state.people!.find(person => person.id === input.id);
        result = { ...input, id: input.id || crypto.randomUUID(), createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
        state.people = [...state.people!.filter(person => person.id !== result.id), result]; break;
      }
      case 'person:delete': state.people = state.people!.filter(person => person.id !== input.id); state.sessions.forEach(session => { session.attendeeIds = session.attendeeIds?.filter(id => id !== input.id); }); break;
      case 'person:search': return state.people!.map(person => ({ person, sessions: state.sessions.filter(session => session.attendeeIds?.includes(person.id)), commitments: state.sessions.flatMap(session => (session.commitments || []).filter(commitment => commitment.personId === person.id).map(commitment => ({ ...commitment, sessionId: session.id, sessionTitle: session.title }))) })).filter(item => (!input.personId || item.person.id === input.personId) && (!input.query || JSON.stringify(item).toLowerCase().includes(input.query.toLowerCase())));
      case 'commitment:save': {
        const session = state.sessions.find(session => session.id === input.sessionId); if (!session) throw new Error('Session not found.');
        const previous = session.commitments?.find(commitment => commitment.id === input.id);
        result = { ...input, id: input.id || crypto.randomUUID(), status: input.status || previous?.status || 'open', createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
        session.commitments = [...(session.commitments || []).filter(commitment => commitment.id !== result.id), result]; break;
      }
      case 'commitment:delete': { const session = state.sessions.find(session => session.id === input.sessionId); if (session) session.commitments = session.commitments?.filter(commitment => commitment.id !== input.id); break; }
      case 'scorecard:save': result = { ...input, id: input.id || crypto.randomUUID() }; state.scorecards = [...state.scorecards!.filter(card => card.id !== result.id), result]; break;
      case 'scorecard:delete': state.scorecards = state.scorecards!.filter(card => card.id !== input.id); break;
      case 'action:run': {
        const session = state.sessions.find(session => session.id === (input.sessionId || state.activeSessionId)); if (!session) throw new Error('Select a session first.');
        const action = state.modes.find(mode => mode.id === session.modeId)?.customActions?.find(action => action.id === input.actionId); if (!action) throw new Error('Action not found.');
        if (action.type === 'prompt') return { answer: await invoke('assist', { kind: 'custom', sessionId: session.id, question: `${action.prompt || ''}\n${input.question || ''}` }) };
        const values: Record<string, string> = { question: input.question || '', sessionTitle: session.title, sessionId: session.id, notes: session.notes, transcript: session.transcript.map(line => line.text).join('\n'), emailDraft: session.followupDraft, attendees: state.people!.filter(person => session.attendeeIds?.includes(person.id)).map(person => person.name).join(', ') };
        const template = action.urlTemplate || '';
        if (/^https:\/\/[^/?#]*[{}]/i.test(template)) throw new Error('Custom link variables are allowed only in the path or query, never in the hostname.');
        const url = template.replace(/\{\{(\w+)\}\}|\{(\w+)\}/g, (_match, doubleKey: string, singleKey: string) => { const key = doubleKey || singleKey; if (!(key in values)) throw new Error(`Unknown custom link variable: ${key}`); return encodeURIComponent(values[key]); });
        if (!/^https:\/\//i.test(url)) throw new Error('Custom links must use HTTPS.'); window.open(url, '_blank', 'noopener,noreferrer'); return { openedUrl: url };
      }
      case 'audio:test-start': case 'audio:test-stop': throw new Error('Real audio level tests require the desktop app. The browser preview never captures audio.');
      case 'analytics:get': {
        const sessions = state.sessions.filter(session => (input.includeDemo || !session.demo) && (!input.modeId || session.modeId === input.modeId) && (!input.personId || session.attendeeIds?.includes(input.personId)) && (!input.from || session.startedAt.slice(0, 10) >= input.from.slice(0, 10)) && (!input.to || session.startedAt.slice(0, 10) <= input.to.slice(0, 10))).map(session => ({ id: session.id, title: session.title, startedAt: session.startedAt, modeId: session.modeId, demo: session.demo, wallSeconds: Math.max(0, (new Date(session.endedAt || Date.now()).getTime() - new Date(session.startedAt).getTime()) / 1000), answers: session.answers.length, completedAnswers: session.answers.filter(answer => answer.status === 'complete').length, failedAnswers: session.answers.filter(answer => answer.status === 'error').length, outputCharacters: session.answers.reduce((sum, answer) => sum + answer.text.length, 0) }));
        const byDay: Record<string, { date: string; sessions: number; wallSeconds: number; answers: number }> = {};
        sessions.forEach(session => { const day = session.startedAt.slice(0, 10); byDay[day] ||= { date: day, sessions: 0, wallSeconds: 0, answers: 0 }; byDay[day].sessions++; byDay[day].wallSeconds += session.wallSeconds; byDay[day].answers += session.answers; });
        return { generatedAt: new Date().toISOString(), filters: input, sessions, summary: { sessions: sessions.length, liveSessions: 0, demoSessions: sessions.length, wallSeconds: sessions.reduce((sum, session) => sum + session.wallSeconds, 0), capturedSeconds: 0, microphoneSeconds: 0, systemSeconds: 0, assistantRequests: 0, completedAnswers: sessions.reduce((sum, session) => sum + session.completedAnswers, 0), failedAnswers: sessions.reduce((sum, session) => sum + session.failedAnswers, 0), outputCharacters: sessions.reduce((sum, session) => sum + session.outputCharacters, 0), inputTokens: 0, outputTokens: 0, sessionsWithoutCaptureMetrics: sessions.length }, byDay: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)) };
      }
      case 'analytics:export': {
        const report = await invoke('analytics:get', input); const data = input.format === 'json' ? JSON.stringify(report, null, 2) : 'title,date,demo,seconds,answers\n' + report.sessions.map((session: any) => [session.title, session.startedAt, session.demo, session.wallSeconds, session.answers].map(value => '"' + String(value).replaceAll('"', '""') + '"').join(',')).join('\n');
        const url = URL.createObjectURL(new Blob([data], { type: 'text/plain' })); const link = document.createElement('a'); link.href = url; link.download = `watson-demo-analytics.${input.format === 'json' ? 'json' : 'csv'}`; link.click(); URL.revokeObjectURL(url); return { saved: true };
      }
      case 'window:overlay': state.overlayVisible = input?.visible ?? !state.overlayVisible; result = state.overlayVisible; break;
      case 'window:dashboard': location.hash = '#dashboard'; break;
      case 'clipboard:write': await navigator.clipboard.writeText(input.text); break;
      case 'displays:list': case 'audio:devices': return [];
      case 'session:export': {
        const session = state.sessions.find(s => s.id === input.id); if (!session) throw new Error('Session not found.');
        const text = input.format === 'json' ? JSON.stringify(session, null, 2) : `# ${session.title}\n\nDEMO SESSION\n\n${session.notes}\n\n## Transcript\n${session.transcript.map(l => `${l.source}: ${l.text}`).join('\n\n')}`;
        const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); const a = document.createElement('a'); a.href = url; a.download = `${session.title}.${input.format === 'json' ? 'json' : 'md'}`; a.click(); URL.revokeObjectURL(url); result = { saved: true }; break;
      }
      case 'external:open': window.open(input.url, '_blank', 'noopener,noreferrer'); break;
      case 'knowledge:import': case 'calendar:import': case 'permissions:request': case 'capture:screenshot': throw new Error('This feature needs the Watson desktop app. The browser preview only runs labeled demo sessions.');
      case 'calendar:delete': state.calendar = state.calendar.filter(e => e.id !== input.id); break;
      case 'window:move': case 'window:resize': case 'window:minimize': return;
      default: throw new Error(`The browser preview does not support ${command}.`);
    }
    emit(); return structuredClone(result);
  };
  return { invoke: invoke as WatsonBridge['invoke'], subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
}
