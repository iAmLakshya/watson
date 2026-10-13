// Runs the shipped isolated capture assets in real Electron, using synthesized audio only.
// This verifies asset loading/WebAudio on the host; it is never Windows OS capture evidence.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const root = resolve(__dirname, '../..');
const temporary = mkdtempSync(join(tmpdir(), 'watson-audio-assets-'));
app.setPath('userData', temporary);
const channel = `watson:windows-capture:${randomUUID()}`;
let window; let finished = false; let ready;
const pageReady = new Promise(resolve => { ready = resolve; });
const result = { collectedAt: new Date().toISOString(), host: { platform: process.platform, arch: process.arch, electron: process.versions.electron }, authority: 'actual-electron-synthesized-audio', windowsOSCaptureVerified: false };
function finish(error, details) {
  if (finished) return; finished = true;
  if (error) { result.status = 'failed'; result.error = String(error.message || error); } else { result.status = 'passed'; Object.assign(result, details); }
  writeFileSync(join(root, 'evidence/windows-assets-runtime.json'), JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result) + '\n');
  ipcMain.removeHandler(channel); if (window && !window.isDestroyed()) window.destroy(); app.exit(error ? 1 : 0);
}
process.on('exit', () => { try { rmSync(temporary, { recursive: true, force: true }); } catch {} });
setTimeout(() => finish(new Error('Electron capture-asset smoke timed out')), 12000).unref();
app.whenReady().then(async () => {
  const pagePath = join(root, 'dist/windows-capture/index.html'); const pageUrl = pathToFileURL(pagePath).href;
  const isolated = session.fromPartition(`watson-assets-${randomUUID()}`, { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); isolated.setPermissionCheckHandler(() => false);
  window = new BrowserWindow({ show: false, width: 1, height: 1, skipTaskbar: true, webPreferences: { preload: join(root, 'dist-electron/electron/windows-capture-preload.js'), session: isolated, additionalArguments: [`--watson-capture-channel=${channel}`], contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  ipcMain.handle(channel, (event, message) => { if (event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || event.sender.getURL() !== pageUrl) throw new Error('Unauthorized smoke IPC'); if (message.type !== 'ready') throw new Error('Smoke probe permits no capture messages'); ready(); return { accepted: true }; });
  window.webContents.on('render-process-gone', (_event, details) => finish(new Error(`Renderer exited: ${details.reason}`)));
  await window.loadFile(pagePath); await pageReady;
  const workletUrl = pathToFileURL(join(root, 'dist/windows-capture/worklet.js')).href;
  const frame = await window.webContents.executeJavaScript(`(async () => {
    const context = new AudioContext({ sampleRate: 48000 });
    await context.audioWorklet.addModule(${JSON.stringify(workletUrl)});
    const oscillator = context.createOscillator(); oscillator.frequency.value = 1000;
    const node = new AudioWorkletNode(context, 'watson-pcm16', { outputChannelCount: [1] }); oscillator.connect(node); node.connect(context.destination);
    const pending = new Promise((resolve, reject) => { let count = 0; const timer = setTimeout(() => reject(new Error('Worklet produced no PCM')), 4000); node.port.onmessage = ({ data }) => {
      if (data.type !== 'audio') return; count++; if (count === 2) { clearTimeout(timer); resolve({ bytes: Array.from(data.data), sequence: data.sequence, inputRate: context.sampleRate }); } else node.port.postMessage({ type: 'ack' });
    }; });
    oscillator.start(); await context.resume(); const value = await pending; oscillator.stop(); node.port.postMessage({ type: 'stop' }); node.disconnect(); await context.close(); return value;
  })()`, true);
  const bytes = Buffer.from(frame.bytes); let squares = 0; let peak = 0; let crossings = 0;
  for (let i = 0; i < bytes.length / 2; i++) { const value = bytes.readInt16LE(i * 2) / 32768; squares += value * value; peak = Math.max(peak, Math.abs(value)); if (i && bytes.readInt16LE((i - 1) * 2) <= 0 && value > 0) crossings++; }
  const rms = Math.sqrt(squares / (bytes.length / 2));
  if (bytes.length !== 640 || frame.sequence !== 1 || peak < 0.8 || rms < 0.6 || crossings < 18 || crossings > 21) throw new Error(`Unexpected synthesized PCM: ${JSON.stringify({ length: bytes.length, peak, rms, crossings, sequence: frame.sequence })}`);
  finish(null, { pageLoaded: true, capturePreloadReady: true, workletLoaded: true, synthesizedToneHz: 1000, pcm: { sampleRate: 16000, channels: 1, encoding: 'pcm16le', frameBytes: bytes.length, positiveCrossings: crossings, peak, rms }, limitations: ['No microphone or screen access requested', 'No Windows loopback, desktop images, provider network, or third-party screen-sharing behavior exercised'] });
}).catch(error => finish(error));
