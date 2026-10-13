import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { parseDeepgramResult, SseParser, streamResponse } from '../electron/providers';
test('SSE parser preserves events with every CRLF and JSON character split', () => {
  const parser = new SseParser(); const events: unknown[] = []; const text = ': comment\r\ndata: {"type":"response.output_text.delta","delta":"hello"}\r\n\r\ndata: {"type":"response.completed"}\r\n\r\n';
  for (const character of text) events.push(...parser.feed(character));
  assert.deepEqual(events, [{ type: 'response.output_text.delta', delta: 'hello' }, { type: 'response.completed' }]);
});
test('Deepgram interim and finalized segments remain distinct, with source/timestamps/diarization', () => {
  const source = { type: 'Results', start: 2.5, channel: { alternatives: [{ transcript: '  Hello  ', words: [{ speaker: 2 }] }] } };
  const interim = parseDeepgramResult(source, 'system', 0); assert.equal(interim.line?.text, 'Hello'); assert.equal(interim.line?.final, false); assert.equal(interim.line?.source, 'system'); assert.equal(interim.line?.timestamp, '1970-01-01T00:00:02.500Z'); assert.equal(interim.line?.speaker, 2);
  const final = parseDeepgramResult({ ...source, is_final: true, speech_final: true }, 'microphone', 0); assert.equal(final.line?.final, true); assert.equal(final.utteranceEnd, true); assert.equal(parseDeepgramResult({ type: 'UtteranceEnd' }, 'system', 0).utteranceEnd, true);
});
test('Responses request uses stateless streaming and real image/tool schemas; UTF-8 deltas and citations survive chunks', async () => {
  const previousFetch = globalThis.fetch; const encoder = new TextEncoder(); let body: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: unknown, options?: RequestInit) => { body = JSON.parse(String(options?.body)); const wire = [{ type: 'response.output_text.delta', delta: 'Hi 👋' }, { type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: 'https://example.org/evidence', title: 'Evidence' } }, { type: 'response.completed', response: { id: 'response-1' } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''); const bytes = encoder.encode(wire); return new Response(new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index += 3) controller.enqueue(bytes.slice(index, index + 3)); controller.close(); } }), { status: 200 }); }) as typeof fetch;
  try { const deltas: string[] = []; const sources: unknown[] = []; const result = await streamResponse('fixture-not-a-key', { model: 'configured-model', text: 'Question', instructions: 'Instructions', image: 'data:image/jpeg;base64,ZmFrZQ==', smart: true, signal: new AbortController().signal }, delta => deltas.push(delta), source => sources.push(source)); assert.equal(result.text, 'Hi 👋'); assert.equal(result.responseId, 'response-1'); assert.equal(deltas.join(''), result.text); assert.equal(body?.store, false); assert.equal(body?.stream, true); assert.deepEqual(body?.tools, [{ type: 'web_search' }]); assert.equal((body?.input as { content: { type: string }[] }[])[0].content[1].type, 'input_image'); assert.deepEqual(sources, [{ url: 'https://example.org/evidence', title: 'Evidence' }]); }
  finally { globalThis.fetch = previousFetch; }
});
test('a disconnected or incomplete response never becomes a completed answer', async () => {
  const previousFetch = globalThis.fetch;
  try { globalThis.fetch = (async () => new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n')) as typeof fetch; await assert.rejects(streamResponse('fixture', { model: 'model', text: '', instructions: '', signal: new AbortController().signal }, () => {}), /before completion/); globalThis.fetch = (async () => new Response('data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n')) as typeof fetch; await assert.rejects(streamResponse('fixture', { model: 'model', text: '', instructions: '', signal: new AbortController().signal }, () => {}), /max_output_tokens/); }
  finally { globalThis.fetch = previousFetch; }
});
test('structured provider requests use Responses text.format and record actual returned token usage', async () => {
  const previousFetch = globalThis.fetch; let body: any;
  globalThis.fetch = (async (_url: unknown, options?: RequestInit) => { body = JSON.parse(String(options?.body)); return new Response('data: {"type":"response.output_text.delta","delta":"{\\"summary\\":\\"Grounded\\"}"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":123,"output_tokens":45}}}\n\n'); }) as typeof fetch;
  try { const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false }; const result = await streamResponse('fixture-not-a-real-key', { model: 'configured-model', instructions: 'Evaluate evidence', text: 'Transcript fixture', signal: new AbortController().signal, jsonSchema: { name: 'watson_coaching', schema }, maxOutputTokens: 8192 }, () => {}); assert.deepEqual(body.text.format, { type: 'json_schema', name: 'watson_coaching', schema, strict: true }); assert.equal(body.max_output_tokens, 8192); assert.deepEqual(result.usage, { inputTokens: 123, outputTokens: 45 }); }
  finally { globalThis.fetch = previousFetch; }
});
test('provider authentication errors never expose the configured credential', async () => { const previous = globalThis.fetch; const fixtureKey = 'fixture-sensitive-provider-token'; globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: `Bad provider key: ${fixtureKey}` } }), { status: 401 })) as typeof fetch; try { await assert.rejects(streamResponse(fixtureKey, { model: 'configured-model', text: '', instructions: '', signal: new AbortController().signal }, () => {}), error => error instanceof Error && !error.message.includes(fixtureKey) && /provider key/.test(error.message)); } finally { globalThis.fetch = previous; } });
test('canonical refusal events from an actual local HTTP stream preserve text without duplicating final content', async () => {
  const previousFetch = globalThis.fetch;
  const refusal = 'Fixture: I cannot complete that request.';
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Consume the fixture request, never relay it. */ }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of [
      { type: 'response.refusal.delta', item_id: 'msg_fixture', content_index: 0, delta: refusal.slice(0, 12) },
      { type: 'response.refusal.delta', item_id: 'msg_fixture', content_index: 0, delta: refusal.slice(12) },
      { type: 'response.refusal.done', item_id: 'msg_fixture', content_index: 0, refusal },
      { type: 'response.completed', response: { id: 'refusal_fixture', usage: { input_tokens: 20, output_tokens: 9 } } },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  globalThis.fetch = ((_url, options) => previousFetch(origin, options)) as typeof fetch;
  try { const deltas: string[] = []; const result = await streamResponse('fixture-token', { model: 'fixture-model', text: 'Synthetic request', instructions: 'Fixture only', signal: new AbortController().signal }, delta => deltas.push(delta)); assert.equal(result.text, refusal); assert.equal(deltas.join(''), refusal); assert.equal(result.refused, true); assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 9 }); }
  finally { globalThis.fetch = previousFetch; await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('a finalized refusal without delta is retained and stream errors redact provider credentials', async () => {
  const previousFetch = globalThis.fetch; const key = 'fixture-secret-only';
  try {
    globalThis.fetch = (async () => new Response('data: {"type":"response.refusal.done","refusal":"Fixture refusal"}\n\ndata: {"type":"response.completed"}\n\n')) as typeof fetch;
    const result = await streamResponse(key, { model: 'fixture-model', text: '', instructions: '', signal: new AbortController().signal }, () => {}); assert.equal(result.refused, true); assert.equal(result.text, 'Fixture refusal');
    globalThis.fetch = (async () => new Response(`data: ${JSON.stringify({ type: 'response.failed', response: { error: { message: 'Rejected credential '+key } } })}\n\n`)) as typeof fetch;
    await assert.rejects(streamResponse(key, { model: 'fixture-model', text: '', instructions: '', signal: new AbortController().signal }, () => {}), error => error instanceof Error && !error.message.includes(key) && error.message.includes('[redacted]'));
  } finally { globalThis.fetch = previousFetch; }
});
