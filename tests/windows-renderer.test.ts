import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function renderer(options: { moduleFailure?: boolean; modulePending?: boolean } = {}) {
  const messages: any[] = []; const requests: { source: string; constraints: any }[] = []; const streams: Stream[] = []; const nodes: Node[] = [];
  let onStop!: (runId: string) => void; let release!: () => void;
  class Track {
    stopped = false; callbacks = new Map<string, () => void>();
    constructor(readonly kind: string) {}
    stop() { this.stopped = true; }
    addEventListener(type: string, callback: () => void) { this.callbacks.set(type, callback); }
    end() { this.callbacks.get('ended')?.(); }
  }
  class Stream {
    constructor(readonly tracks: Track[]) {}
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
  }
  class Context {
    state = 'suspended'; destination = {};
    audioWorklet = { addModule: async () => {
      if (options.moduleFailure) throw new Error('Worklet module failed fixture');
      if (options.modulePending) await new Promise<void>(resolve => { release = resolve; });
    } };
    createMediaStreamSource(_stream: unknown) { return { connect: () => {} }; }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
  }
  class Node {
    acknowledgements: any[] = []; disconnected = false;
    port = { postMessage: (message: unknown) => this.acknowledgements.push(message), onmessage: undefined as any };
    constructor(..._args: unknown[]) { nodes.push(this); }
    connect() {} disconnect() { this.disconnected = true; }
  }
  const capture = async (source: string, constraints: unknown) => { requests.push({ source, constraints }); const stream = new Stream([new Track('audio'), ...(source === 'system' ? [new Track('video')] : [])]); streams.push(stream); return stream; };
  const window: any = { watsonCapture: { send: async (message: unknown) => { messages.push(message); return { accepted: true }; }, onStop: (callback: (runId: string) => void) => { onStop = callback; } }, addEventListener: () => {} };
  const script = await readFile(new URL('../renderer/public/windows-capture/capture.js', import.meta.url), 'utf8');
  await runInNewContext(`(async () => { ${script.replaceAll('import.meta.url', JSON.stringify('file:///watson/windows-capture/capture.js'))} })()`, { window, navigator: { mediaDevices: { getDisplayMedia: (constraints: unknown) => capture('system', constraints), getUserMedia: (constraints: unknown) => capture('microphone', constraints), enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'default', label: '' }, { kind: 'audioinput', deviceId: 'hardware-id-fixture', label: 'Hardware fixture' }, { kind: 'audioinput', deviceId: '', label: '' }, { kind: 'audiooutput', deviceId: 'speaker-fixture', label: 'Speaker' }] } }, AudioContext: Context, AudioWorkletNode: Node, MediaStream: Stream, URL, setTimeout, clearTimeout, Promise, Error, Object });
  const command = { runId: '00000000-0000-4000-8000-000000000001', microphone: true, system: false, microphoneDeviceId: 'chosen-input' };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  return { window, command, messages, requests, streams, nodes, stop: () => onStop(command.runId), release: () => release(), settle };
}
test('the shipped capture renderer requests only microphone input and forwards acknowledged PCM on its source channel', async () => {
  const f = await renderer(); await f.window.watsonStartCapture(f.command);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].source, 'microphone'); assert.equal(f.requests[0].constraints.video, false);
  assert.equal(f.requests[0].constraints.audio.deviceId.exact, 'chosen-input'); assert.equal(f.requests[0].constraints.audio.echoCancellation, false);
  const bytes = new Uint8Array([1, 2, 3, 4]); await f.nodes[0].port.onmessage({ data: { type: 'audio', sequence: 0, data: bytes } });
  const audio = f.messages.find(message => message.type === 'audio'); assert.equal(audio.source, 'microphone'); assert.equal(audio.data, bytes); assert.equal(audio.sampleRate, 16000); assert.equal(audio.channels, 1);
  assert.equal(f.nodes[0].acknowledgements[0].type, 'ack'); f.stop(); await f.settle(); assert.ok(f.streams.every(stream => stream.getTracks().every(track => track.stopped)));
});
test('the shipped renderer separates simultaneous mic and loopback PCM and stops unused video tracks', async () => {
  const f = await renderer(); await f.window.watsonStartCapture({ ...f.command, system: true });
  assert.deepEqual(f.requests.map(request => request.source), ['system', 'microphone']); assert.equal(f.requests[0].constraints.audio, true);
  assert.equal(f.streams[0].getVideoTracks()[0].stopped, true); assert.equal(f.streams[0].getAudioTracks()[0].stopped, false);
  for (const node of f.nodes) await node.port.onmessage({ data: { type: 'audio', sequence: 0, data: new Uint8Array([1, 2]) } });
  assert.deepEqual(f.messages.filter(message => message.type === 'audio').map(message => message.source).sort(), ['microphone', 'system']);
  f.stop(); await f.settle(); assert.ok(f.nodes.every(node => node.disconnected));
});
test('worklet startup failure releases already-acquired microphone and system streams', async () => {
  const f = await renderer({ moduleFailure: true }); await f.window.watsonStartCapture({ ...f.command, system: true });
  assert.ok(f.messages.some(message => message.type === 'error' && /Worklet module failed/.test(message.message)));
  assert.ok(f.streams.every(stream => stream.getTracks().every(track => track.stopped))); assert.equal(f.nodes.length, 0);
});
test('stopping during worklet startup cancels source installation and prevents a late ready status', async () => {
  const f = await renderer({ modulePending: true }); const operation = f.window.watsonStartCapture({ ...f.command, system: true });
  await f.settle(); f.stop(); await f.settle(); f.release(); await operation;
  assert.ok(f.streams.every(stream => stream.getTracks().every(track => track.stopped))); assert.equal(f.nodes.length, 0); assert.equal(f.messages.some(message => message.type === 'started'), false);
});
test('a disconnected audio track reports a device error and releases the other input', async () => {
  const f = await renderer(); await f.window.watsonStartCapture({ ...f.command, system: true });
  f.streams[0].getAudioTracks()[0].end(); await f.settle();
  assert.ok(f.messages.some(message => message.type === 'error' && /device disconnected/.test(message.message)));
  assert.ok(f.streams.every(stream => stream.getTracks().every(track => track.stopped)));
});
test('the shipped renderer enumerates microphones without opening input streams or inventing labels', async () => {
  const f = await renderer(); const devices = await f.window.watsonListMicrophones();
  assert.equal(devices.length, 2); assert.equal(devices[0].id, 'default'); assert.equal(devices[0].label, ''); assert.equal(devices[1].id, 'hardware-id-fixture'); assert.equal(devices[1].label, 'Hardware fixture'); assert.equal(f.requests.length, 0);
});
