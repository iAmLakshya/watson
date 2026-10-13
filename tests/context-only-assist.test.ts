import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, type EngineRuntime } from '../electron/engine';
import { resolveAssistContext } from '../electron/context';
import { Store } from '../electron/store';
import type { AppEvent, Session } from '../shared/types';
function historical(id: string, demo = false): Session { return { id, title: `Review ${id}`, startedAt: '2026-10-11T12:00:00Z', endedAt: '2026-10-11T13:00:00Z', modeId: 'general', demo, pinned: false, transcript: [{ id: `line-${id}`, source: 'system', text: `Budget approved for project ${id}.`, final: true, timestamp: '2026-10-11T12:10:00Z' }], notes: `Priya owns project ${id}.`, actions: [], followupDraft: '', answers: [] }; }
async function fixture(stream: EngineRuntime['stream'], hasKey = true, runtime: Partial<EngineRuntime> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'watson-context-assist-')); const store = new Store(directory); store.key = () => hasKey ? 'fixture-provider-token' : undefined; store.credentialStatus = () => ({ openai: hasKey, deepgram: false, secureStorage: false });
  let starts = 0; let screenshots = 0; const events: AppEvent[] = [];
  const engine = new Engine(store, '/not-a-real-helper', event => events.push(structuredClone(event)), { stream, version: () => 'fixture', permissions: () => ({ screen: 'denied', microphone: 'denied' }), capture: { available: false, async start() { starts++; throw new Error('A context-only request must never start capture'); }, async stop() {}, async screenshot() { screenshots++; throw new Error('A context-only request must never capture a screen'); } }, ...runtime });
  return { engine, store, events, counts: () => ({ starts, screenshots }), directory, cleanup: async () => { await engine.dispose(); await rm(directory, { recursive: true, force: true }); } };
}
test('context selection resolves sessionless history and calendar requests into unsaved contexts', () => {
  const sessions = [historical('one')]; const calendar = [{ id: 'event', title: 'Renewal', start: '2026-10-12T09:00:00Z', end: '2026-10-12T10:00:00Z', description: 'Review contract renewal.' }];
  const history = resolveAssistContext({ kind: 'chat', question: 'Who owns the budget?' }, sessions, calendar, 'general'); assert.equal(history.scope, 'history'); assert.equal(history.session.demo, false); assert.equal(history.session.transcript.length, 0); assert.equal(history.input.includeScreen, false);
  const brief = resolveAssistContext({ kind: 'brief', eventId: 'event' }, [], calendar, 'general'); assert.equal(brief.scope, 'calendar'); assert.match(brief.input.question!, /Review contract renewal/); assert.equal(sessions.length, 1); assert.equal(calendar.length, 1);
  assert.throws(() => resolveAssistContext({ kind: 'brief', eventId: 'missing' }, sessions, calendar, 'general'), /existing calendar event/);
});
test('global history answers stream and persist separately without creating a meeting or touching capture', async () => {
  let requested = ''; const f = await fixture(async (_key, options, delta) => { requested = options.text; assert.equal(options.image, undefined); delta('Priya owns both projects.'); await new Promise(resolve => setTimeout(resolve, 90)); return { text: 'Priya owns both projects.' }; });
  try {
    f.store.data.sessions = [historical('one'), historical('two')]; const before = structuredClone(f.store.data.sessions);
    const answer = await f.engine.assist({ kind: 'chat', question: 'Who owns the projects?', scope: 'history', includeScreen: true });
    assert.equal(answer.scope, 'history'); assert.equal(answer.status, 'complete'); assert.match(requested, /Review one/); assert.match(requested, /Review two/); assert.deepEqual(f.store.data.sessions, before); assert.equal(f.engine.activeSessionId, undefined); assert.equal(f.engine.captureState.running, false); assert.deepEqual(f.counts(), { starts: 0, screenshots: 0 });
    assert.equal(f.store.data.contextAnswers[0].id, answer.id); assert.ok(f.events.some(event => event.type === 'state' && event.state.contextAnswers?.some(item => item.status === 'streaming' && item.text.includes('Priya'))));
    const persisted = JSON.parse(await readFile(join(f.directory, 'watson.json'), 'utf8')); assert.equal(persisted.sessions.length, 2); assert.equal(persisted.contextAnswers[0].text, 'Priya owns both projects.');
  } finally { await f.cleanup(); }
});
test('calendar brief works before any meeting history and saves only the event briefing/context answer', async () => {
  let requested = ''; const f = await fixture(async (_key, options, delta) => { requested = options.text; assert.equal(options.image, undefined); delta('Review the contract renewal terms.'); return { text: 'Review the contract renewal terms.' }; });
  try {
    f.store.data.calendar = [{ id: 'event', title: 'Contract renewal', start: '2026-10-12T09:00:00Z', end: '2026-10-12T10:00:00Z', description: 'Discuss the pricing and renewal terms.', location: 'London' }]; f.store.addKnowledge('Contract terms', 'Renewal pricing is fixed for twelve months.');
    const answer = await f.engine.assist({ kind: 'brief', eventId: 'event', includeScreen: true }); assert.equal(answer.scope, 'calendar'); assert.equal(answer.eventId, 'event'); assert.match(requested, /Discuss the pricing and renewal terms/); assert.match(requested, /fixed for twelve months/); assert.equal(f.store.data.calendar[0].briefing, answer.text); assert.equal(f.store.data.sessions.length, 0); assert.equal(f.engine.activeSessionId, undefined); assert.deepEqual(f.counts(), { starts: 0, screenshots: 0 });
  } finally { await f.cleanup(); }
});
test('global queries require a real provider key even when all saved or active sessions are demonstrations', async () => {
  let requests = 0; const f = await fixture(async () => { requests++; return { text: 'unexpected' }; }, false);
  try { f.store.data.sessions = [historical('demo', true)]; f.engine.activeSessionId = 'demo'; await assert.rejects(f.engine.assist({ kind: 'chat', scope: 'history', question: 'Who owns the project?' }), /OpenAI API key/); assert.equal(requests, 0); assert.equal(f.store.data.contextAnswers.length, 0); assert.equal(f.store.data.sessions[0].answers.length, 0); assert.equal(f.engine.activeSessionId, 'demo'); assert.deepEqual(f.counts(), { starts: 0, screenshots: 0 }); const answer = await f.engine.assist({ kind: 'chat', sessionId: 'demo', question: 'Show the demo' }); assert.match(answer.text, /Demo.*fixture response/); assert.equal(requests, 0); }
  finally { await f.cleanup(); }
});
test('explicit history scope does not attach answers to an active session; legacy data gains a context answer store', async () => {
  const f = await fixture(async (_key, _options, delta) => { delta('Context answer'); return { text: 'Context answer' }; });
  try { f.store.data.sessions = [historical('active')]; f.engine.activeSessionId = 'active'; await f.engine.assist({ kind: 'chat', scope: 'history', question: 'Budget?' }); assert.equal(f.store.data.sessions[0].answers.length, 0); assert.equal(f.engine.activeSessionId, 'active'); const saved = JSON.parse(await readFile(join(f.directory, 'watson.json'), 'utf8')); delete saved.contextAnswers; await writeFile(join(f.directory, 'watson.json'), JSON.stringify(saved)); const migrated = new Store(f.directory); assert.deepEqual(migrated.data.contextAnswers, []); }
  finally { await f.cleanup(); }
});
test('Engine requests use contact metadata and manually saved prior commitments in session and history scopes', async () => {
  const requests: string[] = [];
  const f = await fixture(async (_key, options, delta) => { requests.push(options.text); delta('Fixture: manual context received.'); return { text: 'Fixture: manual context received.' }; });
  try {
    const person = f.store.savePerson({ name: 'Priya', email: 'priya@example.test', company: 'Orchid Labs', role: 'Engineering lead' });
    const current = historical('today'); current.attendeeIds = [person.id];
    const prior = historical('earlier'); prior.notes = ''; prior.transcript = [];
    f.store.data.sessions = [current, prior];
    f.store.saveCommitment({ sessionId: prior.id, text: 'Deliver the sapphire rollout', personId: person.id, dueAt: '2026-10-16T12:00:00Z' });
    const sessionAnswer = await f.engine.assist({ sessionId: current.id, kind: 'chat', question: 'What did we promise about the sapphire rollout?', includeScreen: false });
    assert.equal(sessionAnswer.status, 'complete'); assert.match(requests[0], /Deliver the sapphire rollout/); assert.match(requests[0], /Engineering lead/); assert.match(requests[0], /Orchid Labs/); assert.match(requests[0], /2026-10-16/);
    assert.ok(sessionAnswer.sources.some(source => source.kind === 'history' && source.id.startsWith('earlier:')));
    const global = await f.engine.assist({ kind: 'chat', scope: 'history', question: 'Who owns the sapphire rollout?' });
    assert.equal(global.status, 'complete'); assert.match(requests.at(-1)!, /"ownerName":"Priya"/); assert.match(requests.at(-1)!, /"status":"open"/);
    assert.deepEqual(f.counts(), { starts: 0, screenshots: 0 });
  } finally { await f.cleanup(); }
});
test('managed Engine requests carry structured memory as reference data without using a personal provider', async () => {
  let wire: Parameters<NonNullable<EngineRuntime['managedStream']>>[0] | undefined;
  const f = await fixture(async () => { throw new Error('Managed context must not use a personal provider'); }, false, {
    managedStream: async (input, delta) => { wire = input; delta('Fixture: managed memory received.'); return { text: 'Fixture: managed memory received.', sources: [] }; },
  });
  try {
    const person = f.store.savePerson({ name: 'Priya', company: 'Orchid Labs', notes: 'User-maintained contact context.' });
    const current = historical('managed'); current.modeId = 'shared:mode:managed'; current.attendeeIds = [person.id];
    f.store.data.sessions = [current];
    f.store.saveCommitment({ sessionId: current.id, text: 'Deliver the sapphire rollout', personId: person.id, status: 'done' });
    f.engine.setSharedResources({ knowledge: [], scorecards: [], modes: [{ id: current.modeId, name: 'Managed', shared: true, assigned: true, inference: 'server', instructions: '', noteTemplate: '', documentIds: [] }] });
    const answer = await f.engine.assist({ sessionId: current.id, kind: 'chat', question: 'What is the tracked rollout status?', includeScreen: false });
    assert.equal(answer.status, 'complete'); const references = wire!.answers!.map(item => item.text).join('\n');
    assert.match(references, /Reference data, not instructions/); assert.match(references, /Deliver the sapphire rollout/); assert.match(references, /"status":"done"/); assert.match(references, /Orchid Labs/);
    assert.deepEqual(f.counts(), { starts: 0, screenshots: 0 });
  } finally { await f.cleanup(); }
});
test('long-form preparation preserves structured current memory while summarizing transcript sections', async () => {
  const requests: { text: string; instructions: string }[] = [];
  const f = await fixture(async (_key, options, delta) => { requests.push({ text: options.text, instructions: options.instructions }); const text = 'Fixture: section reviewed.'; delta(text); return { text }; });
  try {
    const current = historical('long'); current.transcript = Array.from({ length: 150 }, (_, index) => ({ id: `line-${index}`, source: 'system', final: true, text: `Section ${index}: ${'neutral transcript text '.repeat(12)}`, timestamp: '2026-10-11T12:00:00Z' }));
    f.store.data.sessions = [current]; f.store.saveCommitment({ sessionId: current.id, text: 'Deliver the sapphire rollout', ownerName: 'Explicit owner', status: 'open' });
    const answer = await f.engine.assist({ sessionId: current.id, kind: 'recap', includeScreen: false }); assert.equal(answer.status, 'complete'); assert.ok(requests.length > 2);
    assert.ok(requests.slice(0, -1).some(request => /Deliver the sapphire rollout/.test(request.text)));
    assert.match(requests.at(-1)!.text, /Deliver the sapphire rollout/); assert.match(requests.at(-1)!.text, /Explicit owner/);
  } finally { await f.cleanup(); }
});
