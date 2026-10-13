import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { AudioSource, ReasoningEffort, TranscriptLine } from '../shared/types';

export interface StreamingTextResult { text: string; responseId?: string; usage?: { inputTokens: number; outputTokens: number }; refused?: boolean; }
// SSE records can span arbitrary network chunks; the buffered parser never assumes
// one HTTP chunk is one event, and preserves multi-line data fields.
export class SseParser {
  private buffer = '';
  feed(chunk: string): unknown[] {
    this.buffer = (this.buffer + chunk).replace(/\r\n/g, '\n'); const events: unknown[] = []; let boundary: number;
    while ((boundary = this.buffer.indexOf('\n\n')) >= 0) {
      const record = this.buffer.slice(0, boundary); this.buffer = this.buffer.slice(boundary + 2);
      const payload = record.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!payload || payload === '[DONE]') continue;
      try { events.push(JSON.parse(payload)); } catch { throw new Error('The model provider sent malformed streaming data'); }
    }
    if (this.buffer.length > 2_000_000) throw new Error('The model provider sent an oversized streaming event');
    return events;
  }
}
export async function streamResponse(key: string, options: { model: string; instructions: string; text: string; image?: string; smart?: boolean; reasoningEffort?: ReasoningEffort; signal: AbortSignal; jsonSchema?: { name: string; schema: Record<string, unknown> }; maxOutputTokens?: number }, onDelta: (delta: string) => void, onSource?: (source: { title: string; url: string }) => void): Promise<StreamingTextResult> {
  const content: Record<string, unknown>[] = [{ type: 'input_text', text: options.text }];
  if (options.image) content.push({ type: 'input_image', image_url: options.image, detail: 'auto' });
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, signal: options.signal,
    body: JSON.stringify({ model: options.model, instructions: options.instructions, input: [{ role: 'user', content }], stream: true, store: false, max_output_tokens: options.maxOutputTokens ?? 1600, ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}), ...(options.smart ? { tools: [{ type: 'web_search' }] } : {}), ...(options.jsonSchema ? { text: { format: { type: 'json_schema', name: options.jsonSchema.name, schema: options.jsonSchema.schema, strict: true } } } : {}) }),
  });
  if (!response.ok) { let message = `OpenAI request failed (${response.status})`; try { const data = await response.json() as { error?: { message?: string } }; if (data.error?.message) message = data.error.message; } catch {} if (response.status === 401) message = 'OpenAI rejected the provider key. Check the key in Settings.'; else if (key) message = message.split(key).join('[redacted]'); throw new Error(message); }
  if (!response.body) throw new Error('OpenAI returned no response stream');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); const parser = new SseParser(); let text = ''; let responseId: string | undefined; let complete = false; let usage: StreamingTextResult['usage']; let refused = false;
  const refusalParts = new Set<string>();
  const redact = (message: string) => key ? message.split(key).join('[redacted]') : message;
  const accept = (record: unknown) => {
    const event = record as { type?: string; delta?: string; refusal?: string; item_id?: string; output_index?: number; content_index?: number; message?: string; annotation?: { type?: string; url?: string; title?: string }; response?: { id?: string; error?: { message?: string }; incomplete_details?: { reason?: string }; usage?: { input_tokens?: number; output_tokens?: number } } };
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') { text += event.delta; onDelta(event.delta); }
    const part = `${event.item_id ?? event.output_index ?? 0}:${event.content_index ?? 0}`;
    if (event.type === 'response.refusal.delta' && typeof event.delta === 'string') { refused = true; refusalParts.add(part); text += event.delta; onDelta(event.delta); }
    if (event.type === 'response.refusal.done') { refused = true; if (typeof event.refusal === 'string' && !refusalParts.has(part)) { refusalParts.add(part); text += event.refusal; onDelta(event.refusal); } }
    if (event.type === 'response.completed') { complete = true; responseId = event.response?.id; if (typeof event.response?.usage?.input_tokens === 'number' && typeof event.response.usage.output_tokens === 'number') usage = { inputTokens: event.response.usage.input_tokens, outputTokens: event.response.usage.output_tokens }; }
    if (event.type === 'response.output_text.annotation.added' && event.annotation?.type === 'url_citation' && event.annotation.url) onSource?.({ title: event.annotation.title ?? event.annotation.url, url: event.annotation.url });
    if (event.type === 'error' || event.type === 'response.failed') throw new Error(redact(event.message ?? event.response?.error?.message ?? 'The model could not complete the response'));
    if (event.type === 'response.incomplete') throw new Error(redact(`The model response was incomplete: ${event.response?.incomplete_details?.reason ?? 'unknown reason'}`));
  };
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; for (const record of parser.feed(decoder.decode(value, { stream: true }))) accept(record); } for (const record of parser.feed(decoder.decode())) accept(record); }
  finally { reader.releaseLock(); }
  if (!complete) throw new Error('The model response stream ended before completion');
  if (!text.trim()) throw new Error('The model returned no text');
  return { text, responseId, usage, ...(refused ? { refused: true } : {}) };
}

interface DeepgramResult { type: string; is_final?: boolean; speech_final?: boolean; start?: number; description?: string; channel?: { alternatives?: { transcript?: string; words?: { speaker?: number }[] }[] }; }
export function parseDeepgramResult(message: DeepgramResult, source: AudioSource, sessionStart: number): { line?: TranscriptLine; utteranceEnd: boolean } {
  const alternative = message.channel?.alternatives?.[0]; const text = alternative?.transcript?.trim();
  return { line: message.type === 'Results' && text ? { id: randomUUID(), source, text, final: !!message.is_final, timestamp: new Date(sessionStart + (message.start ?? 0) * 1000).toISOString(), speaker: alternative?.words?.find(word => word.speaker !== undefined)?.speaker } : undefined, utteranceEnd: !!message.speech_final || message.type === 'UtteranceEnd' };
}
export class Transcriber {
  private socket?: WebSocket; private keepalive?: NodeJS.Timeout; private sessionStart = Date.now(); private closing = false; private lastFinal?: TranscriptLine;
  constructor(private source: AudioSource, private onLine: (line: TranscriptLine, utteranceEnd: boolean) => void, private onError: (message: string) => void) {}
  async connect(key: string, language: string, model: string) {
    const params = new URLSearchParams({ model, language, encoding: 'linear16', sample_rate: '16000', channels: '1', interim_results: 'true', smart_format: 'true', diarize: 'true', endpointing: '400', utterance_end_ms: '1000', vad_events: 'true' });
    this.sessionStart = Date.now(); this.closing = false;
    const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, { headers: { Authorization: `Token ${key}` }, handshakeTimeout: 15000 }); this.socket = socket;
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    this.keepalive = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'KeepAlive' })); }, 4000);
    socket.on('message', raw => { try { const message = JSON.parse(raw.toString()) as DeepgramResult; if (message.type === 'Error') { this.onError(message.description ?? 'Transcription provider returned an error'); return; } const result = parseDeepgramResult(message, this.source, this.sessionStart); if (result.line) { if (result.line.final) this.lastFinal = result.line; this.onLine(result.line, result.utteranceEnd); } else if (result.utteranceEnd && this.lastFinal) this.onLine(this.lastFinal, true); } catch (error) { this.onError(error instanceof Error ? error.message : String(error)); } });
    socket.on('error', error => this.onError(`${this.source} transcription: ${error.message}`));
    socket.on('close', (code, reason) => { if (this.keepalive) clearInterval(this.keepalive); if (!this.closing) this.onError(`${this.source} transcription disconnected (${code})${reason.toString() ? `: ${reason.toString().slice(0, 200)}` : ''}. Pause and resume to reconnect.`); });
  }
  send(audio: Buffer) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > 2_000_000) { this.onError('Transcription network is too slow; audio backlog was dropped. Pause and resume to reconnect.'); this.socket.terminate(); return; }
    this.socket.send(audio);
  }
  async close() {
    this.closing = true; if (this.keepalive) clearInterval(this.keepalive); const socket = this.socket; this.socket = undefined;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    if (socket.readyState !== WebSocket.OPEN) { socket.terminate(); return; }
    await new Promise<void>(resolve => { const timer = setTimeout(() => { socket.terminate(); resolve(); }, 2000); socket.once('close', () => { clearTimeout(timer); resolve(); }); socket.send(JSON.stringify({ type: 'CloseStream' })); });
  }
}
