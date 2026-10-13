let active;
const bridge = window.watsonCapture;
if (!bridge) throw new Error('Watson capture preload is unavailable');

function deviceError(source, error) {
  const prefix = source === 'system' ? 'Windows system audio' : 'Microphone';
  if (error?.name === 'NotAllowedError') return source === 'system' ? `${prefix} access was denied. Check capture access and the selected display, then retry.` : `${prefix} access was denied. Allow microphone access for desktop apps in Windows Settings and retry.`;
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') return `${prefix} device is unavailable. Reconnect it or choose another microphone.`;
  if (error?.name === 'NotReadableError') return `${prefix} could not be opened. Check device availability and Windows privacy settings.`;
  return `${prefix}: ${error?.message || 'capture failed'}`;
}
async function stop(state, report = true) {
  if (!state || state.stopped) return;
  state.stopped = true;
  for (const node of state.nodes) { node.port.postMessage({ type: 'stop' }); node.port.onmessage = null; node.disconnect(); }
  for (const stream of state.streams) for (const track of stream.getTracks()) track.stop();
  if (state.context) await Promise.race([state.context.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
  if (active === state) active = undefined;
  if (report) await bridge.send({ type: 'stopped', runId: state.runId }).catch(() => {});
}
async function fail(state, message) {
  if (state.stopped) return;
  await bridge.send({ type: 'error', runId: state.runId, message: message.slice(0, 2000) }).catch(() => {});
  await stop(state);
}
async function install(state, source, request) {
  let stream;
  try {
    stream = await request;
    if (state.stopped || active !== state) { stream.getTracks().forEach(track => track.stop()); return; }
    const tracks = stream.getAudioTracks();
    if (!tracks.length) throw new Error('The capture stream has no audio track. Check the Windows output device.');
    // System loopback requires a video grant, but the video track is never read or sent.
    for (const track of stream.getVideoTracks()) track.stop();
    const audio = new MediaStream(tracks);
    const input = state.context.createMediaStreamSource(audio);
    const node = new AudioWorkletNode(state.context, 'watson-pcm16', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCountMode: 'max' });
    state.nodes.push(node); input.connect(node); node.connect(state.context.destination);
    for (const track of tracks) track.addEventListener('ended', () => { if (!state.stopped) void fail(state, `${source === 'system' ? 'System audio' : 'Microphone'} device disconnected. Restart the session after reconnecting it.`); });
    node.onprocessorerror = () => { if (!state.stopped) void fail(state, `${source} audio processor failed. Restart the session.`); };
    node.port.onmessage = async ({ data }) => {
      if (state.stopped) return;
      try {
        if (data.type === 'audio') {
          // The worklet sends only one frame until the main process acknowledges it.
          const response = await bridge.send({ type: 'audio', runId: state.runId, source, sampleRate: 16000, channels: 1, sequence: data.sequence, data: data.data });
          if (response?.accepted === false) { await stop(state); return; }
          if (!state.stopped) node.port.postMessage({ type: 'ack' });
        } else if (data.type === 'overrun') await bridge.send({ type: 'overrun', runId: state.runId, source, dropped: data.dropped });
      } catch (error) { void fail(state, `Audio bridge failed: ${error.message}`); }
    };
  } catch (error) { if (!state.stopped) throw new Error(deviceError(source, error)); }
}

Object.defineProperty(window, 'watsonStartCapture', { value: async command => {
  if (active) throw new Error('Windows audio capture is already running');
  if (!command || !/^[a-f0-9-]{36}$/.test(command.runId)) throw new Error('Invalid capture run');
  const state = { runId: command.runId, stopped: false, streams: [], nodes: [], context: undefined }; active = state;
  try {
    // Request display media immediately while executeJavaScript's user activation is live.
    const pending = [];
    const reserve = (source, request) => {
      pending.push([source, request]);
      // Own every acquired stream immediately, including worklet-load failure and stop races.
      request.then(stream => { state.streams.push(stream); if (state.stopped) stream.getTracks().forEach(track => track.stop()); }).catch(() => {});
    };
    if (command.system) reserve('system', navigator.mediaDevices.getDisplayMedia({ video: { width: 16, height: 16, frameRate: 1 }, audio: true }));
    if (command.microphone) reserve('microphone', navigator.mediaDevices.getUserMedia({ video: false, audio: { deviceId: command.microphoneDeviceId ? { exact: command.microphoneDeviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } }));
    if (pending.length) {
      state.context = new AudioContext({ latencyHint: 'interactive' });
      await state.context.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
      if (state.stopped) { for (const [, request] of pending) request.then(stream => stream.getTracks().forEach(track => track.stop())).catch(() => {}); return; }
      const results = await Promise.allSettled(pending.map(([source, request]) => install(state, source, request)));
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      await state.context.resume();
      if (state.context.state !== 'running') throw new Error('Windows audio context did not start. Restart the session.');
    }
    if (!state.stopped) await bridge.send({ type: 'started', runId: state.runId, system: !!command.system, microphone: !!command.microphone });
  } catch (error) { await fail(state, error.message || 'Windows audio capture failed'); }
} });
Object.defineProperty(window, 'watsonListMicrophones', { value: async () => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(device => device.kind === 'audioinput' && device.deviceId).map(device => ({ id: device.deviceId, label: device.label, isDefault: device.deviceId === 'default' }));
} });
bridge.onStop(runId => { if (active?.runId === runId) void stop(active); else if (!active) void bridge.send({ type: 'stopped', runId }).catch(() => {}); });
window.addEventListener('beforeunload', () => { if (active) void stop(active, false); });
await bridge.send({ type: 'ready' });
