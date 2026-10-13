import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { BoundedPCMQueue, PCM16Resampler } from '../renderer/public/windows-capture/pcm-core.js';
import { captureSenderAllowed, parseWindowsCaptureEvent, PCMIngress, selectDisplaySource } from '../electron/windows-capture-protocol';

const runId = '00000000-0000-4000-8000-000000000001';
function resample(rate: number, frequency: number, block = 128, seconds = 1) {
  const frames: Uint8Array[] = []; const resampler = new PCM16Resampler(rate);
  const count = rate * seconds;
  for (let offset = 0; offset < count; offset += block) {
    const channel = new Float32Array(Math.min(block, count - offset));
    for (let i = 0; i < channel.length; i++) channel[i] = 0.5 * Math.sin(2 * Math.PI * frequency * (offset + i) / rate);
    resampler.push([channel], (data: Uint8Array) => frames.push(data));
  }
  const bytes = Buffer.concat(frames.map(frame => Buffer.from(frame)));
  const samples = Array.from({ length: bytes.length / 2 }, (_v, index) => bytes.readInt16LE(index * 2) / 32768);
  return { frames, samples, resampler };
}
const rms = (samples: number[]) => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);

test('PCM resampling preserves speech tones at 48 kHz and 44.1 kHz and emits 20 ms PCM16 frames', () => {
  for (const rate of [48000, 44100, 16000, 96000]) {
    const result = resample(rate, 1000);
    assert.ok(result.frames.every(frame => frame.length === 640));
    const outputCount = result.samples.length + result.resampler.frameOffset / 2;
    assert.ok(16000 - outputCount <= Math.ceil(32 * 16000 / rate), `${rate}: duration drift ${16000 - outputCount}`);
    assert.ok(Math.abs(rms(result.samples.slice(100)) - Math.sqrt(0.125)) < 0.003);
  }
});
test('resampling is independent of input block boundaries and rejects high-frequency aliasing', () => {
  assert.deepEqual(resample(44100, 1300, 97).frames, resample(44100, 1300, 1024).frames);
  const audible = resample(48000, 2000).samples.slice(100); const outsideBand = resample(48000, 12000).samples.slice(100);
  assert.ok(rms(outsideBand) < rms(audible) / 100, '12 kHz must not alias into a 4 kHz speech tone');
});
test('stereo channels are averaged without doubling amplitude and nonfinite input cannot corrupt PCM', () => {
  const frames: Uint8Array[] = []; const resampler = new PCM16Resampler(48000);
  const positive = new Float32Array(4800).fill(0.75); const negative = new Float32Array(4800).fill(-0.75);
  resampler.push([positive, negative], (frame: Uint8Array) => frames.push(frame));
  assert.ok(Buffer.concat(frames.map(frame => Buffer.from(frame))).every(byte => byte === 0));
  const invalid = new PCM16Resampler(48000); const bad: Uint8Array[] = [];
  invalid.push([new Float32Array(4800).fill(NaN)], (frame: Uint8Array) => bad.push(frame));
  assert.ok(Buffer.concat(bad.map(frame => Buffer.from(frame))).every(byte => byte === 0));
  const clipped = new PCM16Resampler(48000); const clip: Uint8Array[] = [];
  clipped.push([new Float32Array(4800).fill(2)], (frame: Uint8Array) => clip.push(frame));
  const bytes = Buffer.concat(clip.map(frame => Buffer.from(frame))); assert.equal(bytes.readInt16LE(bytes.length - 2), 32767);
});
test('audio backpressure keeps one in-flight frame, a bounded queue, and recent audio after a stall', () => {
  const emitted: { value: number; sequence: number }[] = [];
  const queue = new BoundedPCMQueue((frame: Uint8Array, sequence: number) => emitted.push({ value: frame[0], sequence }), 3);
  for (let i = 0; i < 10; i++) queue.push(new Uint8Array([i]));
  assert.deepEqual(emitted, [{ value: 0, sequence: 0 }]); assert.equal(queue.pending.length, 3); assert.equal(queue.dropped, 6);
  queue.acknowledge(); assert.deepEqual(emitted[1], { value: 7, sequence: 1 }); assert.equal(queue.pending.length, 2);
  queue.clear(); queue.acknowledge(); assert.equal(emitted.length, 2);
});
test('the shipped AudioWorklet emits silent output and blocks additional messages until an acknowledgement', async () => {
  const [core, worklet] = await Promise.all([readFile(new URL('../renderer/public/windows-capture/pcm-core.js', import.meta.url), 'utf8'), readFile(new URL('../renderer/public/windows-capture/worklet.js', import.meta.url), 'utf8')]);
  const messages: { type: string; data?: Uint8Array; sequence?: number }[] = []; let Processor: any;
  const context = { sampleRate: 48000, currentTime: 0, Float32Array, Uint8Array, Math, Number, AudioWorkletProcessor: class { port = { postMessage: (message: any) => messages.push(message), onmessage: undefined as any }; }, registerProcessor: (name: string, value: unknown) => { assert.equal(name, 'watson-pcm16'); Processor = value; } };
  runInNewContext(`${core.replaceAll('export class', 'class')}\n${worklet.replace(/^import .*\n/, '')}`, context);
  const processor = new Processor(); const output = [new Float32Array(128).fill(1)];
  for (let i = 0; i < 100; i++) { context.currentTime = i * 128 / 48000; processor.process([[new Float32Array(128).fill(0.25)]], [output]); }
  assert.ok(output[0].every(value => value === 0)); assert.equal(messages.filter(message => message.type === 'audio').length, 1);
  assert.equal(messages[0].data?.length, 640); processor.port.onmessage({ data: { type: 'ack' } }); assert.equal(messages.filter(message => message.type === 'audio').length, 2);
  processor.port.onmessage({ data: { type: 'stop' } }); assert.equal(processor.process([[]], [output]), false);
});
test('capture IPC rejects alternate senders, subframes, origins, malformed PCM, and unknown events', () => {
  const expected = { id: 10, url: 'file:///trusted/windows-capture/index.html' };
  assert.ok(captureSenderAllowed({ ...expected, isMainFrame: true }, expected));
  assert.equal(captureSenderAllowed({ ...expected, id: 11, isMainFrame: true }, expected), false);
  assert.equal(captureSenderAllowed({ ...expected, isMainFrame: false }, expected), false);
  assert.equal(captureSenderAllowed({ ...expected, url: `${expected.url}?spoof`, isMainFrame: true }, expected), false);
  const audio = { type: 'audio', runId, source: 'system', sampleRate: 16000, channels: 1, sequence: 0, data: new Uint8Array(640) };
  assert.equal(parseWindowsCaptureEvent(audio).type, 'audio');
  for (const change of [{ source: 'camera' }, { sampleRate: 48000 }, { channels: 2 }, { sequence: -1 }, { data: 'base64' }, { data: new Uint8Array(641) }, { data: new Uint8Array(642) }, { data: new Int16Array(320) }, { data: new Uint8Array(0) }, { runId: 'old-run' }, { type: 'credentials' }]) assert.throws(() => parseWindowsCaptureEvent({ ...audio, ...change }));
});
test('PCM rate limiting enforces sequence and isolates input budgets', () => {
  let now = 0; const microphone = new PCMIngress(() => now); const system = new PCMIngress(() => now);
  for (let sequence = 0; sequence < 20; sequence++) microphone.accept(sequence, 640);
  assert.throws(() => microphone.accept(20, 640), /rate limit/); system.accept(0, 640);
  now = 20; microphone.accept(20, 640); assert.throws(() => microphone.accept(22, 640), /out of order/);
});
test('display selection uses exact OS display IDs and never silently substitutes a missing selection', () => {
  const sources = [{ display_id: '2', id: 'screen:a' }, { display_id: '1', id: 'screen:b' }];
  assert.equal(selectDisplaySource(sources, '', '1').id, 'screen:b'); assert.equal(selectDisplaySource(sources, '2', '1').id, 'screen:a');
  assert.throws(() => selectDisplaySource(sources, '9', '1'), /selected display is unavailable/);
});
