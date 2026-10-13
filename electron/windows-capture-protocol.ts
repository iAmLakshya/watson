import type { AudioSource } from '../shared/types';

export const PCM_RATE = 16000;
export const PCM_CHANNELS = 1;
export const PCM_FRAME_SAMPLES = 320;
export const PCM_MAX_BYTES = PCM_FRAME_SAMPLES * 2;
export type WindowsCaptureEvent =
  | { type: 'ready' }
  | { type: 'started'; runId: string; system: boolean; microphone: boolean }
  | { type: 'stopped'; runId: string }
  | { type: 'error'; runId: string; message: string }
  | { type: 'overrun'; runId: string; source: AudioSource; dropped: number }
  | { type: 'audio'; runId: string; source: AudioSource; sampleRate: 16000; channels: 1; sequence: number; data: Uint8Array };

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid capture message');
  return value as Record<string, unknown>;
};
const source = (value: unknown): AudioSource => {
  if (value !== 'system' && value !== 'microphone') throw new Error('Invalid audio source');
  return value;
};

/** The main process validates every capture message before any provider receives bytes. */
export function parseWindowsCaptureEvent(raw: unknown): WindowsCaptureEvent {
  const value = record(raw);
  if (value.type === 'ready') return { type: 'ready' };
  if (typeof value.runId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.runId)) throw new Error('Invalid capture run');
  const runId = value.runId;
  switch (value.type) {
    case 'started':
      if (typeof value.system !== 'boolean' || typeof value.microphone !== 'boolean') throw new Error('Invalid capture sources');
      return { type: 'started', runId, system: value.system, microphone: value.microphone };
    case 'stopped': return { type: 'stopped', runId };
    case 'error':
      if (typeof value.message !== 'string' || !value.message || value.message.length > 2000) throw new Error('Invalid capture error');
      return { type: 'error', runId, message: value.message };
    case 'overrun':
      if (!Number.isSafeInteger(value.dropped) || (value.dropped as number) < 1 || (value.dropped as number) > 100000) throw new Error('Invalid capture overrun');
      return { type: 'overrun', runId, source: source(value.source), dropped: value.dropped as number };
    case 'audio': {
      if (value.sampleRate !== PCM_RATE || value.channels !== PCM_CHANNELS) throw new Error('Capture audio must be 16 kHz mono PCM16');
      if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) throw new Error('Invalid audio sequence');
      const data = value.data;
      // contextBridge and Electron structured clone may change the ArrayBuffer realm.
      if (!ArrayBuffer.isView(data) || !('BYTES_PER_ELEMENT' in data) || data.BYTES_PER_ELEMENT !== 1 || data.byteLength < 2 || data.byteLength > PCM_MAX_BYTES || data.byteLength % 2) throw new Error('Invalid PCM frame');
      return { type: 'audio', runId, source: source(value.source), sampleRate: PCM_RATE, channels: PCM_CHANNELS, sequence: value.sequence as number, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
    }
    default: throw new Error('Unknown capture event');
  }
}

export function captureSenderAllowed(sender: { id: number; url: string; isMainFrame: boolean }, expected: { id: number; url: string }): boolean {
  return sender.id === expected.id && sender.isMainFrame && sender.url === expected.url;
}

/** A separate limiter for each input preserves source isolation and caps malicious IPC. */
export class PCMIngress {
  private sequence = -1;
  private tokens = 12800;
  private updated: number;
  constructor(private clock = () => performance.now()) { this.updated = clock(); }
  accept(sequence: number, bytes: number): void {
    if (sequence !== this.sequence + 1) throw new Error('Capture audio arrived out of order');
    const now = this.clock();
    this.tokens = Math.min(12800, this.tokens + Math.max(0, now - this.updated) * 64);
    this.updated = now;
    if (bytes > this.tokens) throw new Error('Capture audio exceeded the PCM rate limit');
    this.tokens -= bytes; this.sequence = sequence;
  }
}

export function selectDisplaySource<T extends { display_id: string }>(sources: T[], requestedId: string, primaryId: string): T {
  const selected = sources.find(item => item.display_id === (requestedId || primaryId));
  if (!selected) throw new Error(requestedId ? 'The selected display is unavailable. Choose another display in Settings.' : 'No primary display capture source is available.');
  return selected;
}

export async function captureTimeout<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
