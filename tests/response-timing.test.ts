import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResponseTiming } from '../electron/response-timing';
import { Engine, type EngineRuntime } from '../electron/engine';
import { Store } from '../electron/store';
import { createServer } from 'node:http';
import { streamResponse } from '../electron/providers';

test('first text ignores empty chunks, remains stable and completion never precedes it', () => {
  let now = 100;
  const timing = new ResponseTiming(() => now);
  now = 140; timing.text(' \n'); assert.equal(timing.firstTextMs, undefined);
  now = 180; timing.text('Hello'); assert.equal(timing.firstTextMs, 80);
  now = 130; timing.text(' later'); assert.equal(timing.firstTextMs, 80); assert.equal(timing.elapsed(), 80);
  now = 250; assert.equal(timing.elapsed(), 150);
});
async function fixture(stream: EngineRuntime['stream'], extra: Partial<EngineRuntime> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'watson-response-timing-')); let now = 0;
  const store = new Store(directory); store.key = () => 'fixture-not-a-provider-key'; store.credentialStatus = () => ({ openai: true, deepgram: false, secureStorage: false });
  const engine = new Engine(store, '/owned-fixture-no-helper', () => {}, {
    stream, responseClock: () => now, version: () => 'timing-fixture', permissions: () => ({ microphone: 'denied', screen: 'denied' }),
    capture: { available: false, async start() { throw new Error('No capture in timing fixtures.'); }, async stop() {}, async screenshot() { now = 100; return { mimeType: 'image/png', data: 'ZmFrZQ==', capturedAt: new Date().toISOString(), displayId: 'fixture', width: 1, height: 1 }; } }, ...extra,
  });
  const session = store.createSession('Timing fixture', false, 'general');
  return { engine, session, store, directory, clock: (value: number) => { now = value; }, cleanup: async () => { await engine.dispose(); await rm(directory, { recursive: true, force: true }); } };
}
test('engine measures screenshot preparation plus first answer text and persists both timings', async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(async (_key, options, delta) => { assert.equal(options.image, 'data:image/png;base64,ZmFrZQ=='); f.clock(120); delta(' \n'); f.clock(140); delta('Grounded'); f.clock(160); delta(' answer'); f.clock(200); return { text: 'Grounded answer' }; });
  try {
    f.engine.activeSessionId = f.session.id;
    const answer = await f.engine.assist({ sessionId: f.session.id, kind: 'chat', includeScreen: true });
    assert.equal(answer.firstTextLatencyMs, 140); assert.equal(answer.latencyMs, 200); assert.equal(answer.latencyScope, 'application-request');
    const saved = JSON.parse(await readFile(join(f.directory, 'watson.json'), 'utf8')).sessions[0].answers[0];
    assert.equal(saved.firstTextLatencyMs, 140); assert.equal(saved.latencyMs, 200);
  } finally { await f.cleanup(); }
});
test('hidden long-form summaries do not become the first visible answer text', async () => {
  let f: Awaited<ReturnType<typeof fixture>>, calls = 0;
  f = await fixture(async (_key, _options, delta) => { calls++; f.clock(calls * 20); if (calls <= 4) delta('Hidden summary'); else delta('Final summary'); return { text: 'Concise section summary' }; });
  try {
    f.session.transcript = [{ id: 'long', source: 'system', text: 'A detailed recorded fact. '.repeat(3000), final: true, timestamp: f.session.startedAt }];
    const answer = await f.engine.assist({ sessionId: f.session.id, kind: 'notes', includeScreen: false });
    assert.ok(calls > 1); assert.equal(answer.firstTextLatencyMs, calls * 20); assert.equal(answer.latencyMs, calls * 20); assert.equal(answer.status, 'complete');
  } finally { await f.cleanup(); }
});
test('managed completion without text deltas records first text when the completed text arrives', async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(undefined, { managedStream: async () => { f.clock(55); return { text: 'Managed done-only text', sources: [] }; } });
  try {
    f.engine.setSharedResources({ knowledge: [], scorecards: [], modes: [{ id: 'shared:mode:timing', name: 'Managed fixture', instructions: '', noteTemplate: '', documentIds: [], inference: 'server', shared: true }] });
    f.session.modeId = 'shared:mode:timing'; const answer = await f.engine.assist({ sessionId: f.session.id });
    assert.equal(answer.firstTextLatencyMs, 55); assert.equal(answer.latencyMs, 55); assert.equal(answer.text, 'Managed done-only text');
  } finally { await f.cleanup(); }
});
test('partial failures keep observed timing but never become successful answers', async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(async (_key, _options, delta) => { f.clock(40); delta('Partial text'); f.clock(80); throw new Error('Owned fixture disconnect'); });
  try { const answer = await f.engine.assist({ sessionId: f.session.id, includeScreen: false }); assert.equal(answer.status, 'error'); assert.equal(answer.firstTextLatencyMs, 40); assert.equal(answer.latencyMs, 80); }
  finally { await f.cleanup(); }
});
test('demo responses do not claim measured first model text', async () => {
  const f = await fixture(async () => { throw new Error('No provider for demos.'); });
  try { f.session.demo = true; const answer = await f.engine.assist({ sessionId: f.session.id }); assert.equal(answer.firstTextLatencyMs, undefined); assert.equal(answer.latencyScope, undefined); }
  finally { await f.cleanup(); }
});
test('actual delayed local Responses HTTP stream produces ordered first-text and completion observations', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('data: {"type":"response.created"}\n\n');
    setTimeout(() => response.write('data: {"type":"response.output_text.delta","delta":"Observed fixture text"}\n\n'), 10);
    setTimeout(() => response.end('data: {"type":"response.completed","response":{"id":"fixture-response"}}\n\n'), 40);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const originalFetch = globalThis.fetch; globalThis.fetch = ((_url: unknown, options: RequestInit) => originalFetch(origin, options)) as typeof fetch;
  const f = await fixture(streamResponse, { responseClock: () => performance.now() });
  try { const answer = await f.engine.assist({ sessionId: f.session.id, includeScreen: false }); assert.equal(answer.status, 'complete'); assert.equal(answer.text, 'Observed fixture text'); assert.ok(answer.firstTextLatencyMs! >= 0); assert.ok(answer.firstTextLatencyMs! < answer.latencyMs!); assert.ok(answer.latencyMs! < 10000); }
  finally { globalThis.fetch = originalFetch; await f.cleanup(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
