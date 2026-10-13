import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { AudioSource, MeetingActivitySnapshot, Settings } from '../shared/types';
export type NativeEvent = { type: 'audio'; source: AudioSource; sampleRate: number; channels: number; data: string; capturedAt?: string } | { type: 'screen'; data: string; mimeType: string; capturedAt: string } | { type: 'status'; status?: string; message?: string; running?: boolean; system?: boolean; microphone?: boolean; screen?: boolean } | { type: 'error'; message: string } | { type: 'permissions'; screen: string; microphone: string } | { type: 'displays'; displays: { id: string | number; name?: string; width: number; height: number }[] } | { type: 'microphones'; devices: { id: string; label: string; isDefault?: boolean }[] } | (MeetingActivitySnapshot & {type:'activity'});
export class CaptureManager {
  private child?: ChildProcessWithoutNullStreams; latestScreen?: Extract<NativeEvent, { type: 'screen' }>;
  constructor(readonly helperPath: string, private onEvent: (event: NativeEvent) => void, private bundleId = 'com.watson.app') {}
  get available() { return process.platform === 'darwin' && existsSync(this.helperPath); }
  async start(settings: Settings, options?: { requestPermissions?: boolean }) {
    if (!this.available) throw new Error('Native capture helper is unavailable. Run npm run build:native on macOS.');
    if (this.child) throw new Error('Capture is already running');
    this.latestScreen = undefined;
    const args = ['--capture', '--exclude-bundle-id', this.bundleId, '--exclude-pid', String(process.pid)];
    if (options?.requestPermissions === false) args.push('--no-permission-prompts');
    if (!settings.captureSystem) args.push('--no-system'); if (settings.captureMicrophone) args.push('--microphone'); if (settings.captureScreen) args.push('--screen'); if (settings.displayId) args.push('--display-id', settings.displayId);
    if (settings.captureMicrophone && settings.microphoneDeviceId) args.push('--microphone-device-id', settings.microphoneDeviceId);
    const child = spawn(this.helperPath, args, { stdio: 'pipe' }); this.child = child;
    let ready = false; let resolveReady: () => void; let rejectReady: (error: Error) => void;
    const startup = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const timeout = setTimeout(() => { if (!ready) { rejectReady(new Error('Native capture startup timed out; check Screen Recording permission')); child.kill('SIGTERM'); } }, 15000);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => { if (line.length > 12_000_000) return; try { const event = JSON.parse(line) as NativeEvent; if (event.type === 'screen') this.latestScreen = event; if (event.type === 'status' && event.status === 'capturing') { ready = true; clearTimeout(timeout); resolveReady(); } if (event.type === 'error' && !ready) { clearTimeout(timeout); rejectReady(new Error(event.message)); } this.onEvent(event); } catch { this.onEvent({ type: 'error', message: 'The native helper emitted malformed data' }); } });
    child.stderr.on('data', chunk => { const message = chunk.toString().trim().slice(0, 300); if (message) this.onEvent({ type: 'error', message }); });
    child.on('error', error => { clearTimeout(timeout); if (!ready) rejectReady(error); this.onEvent({ type: 'error', message: `Native capture: ${error.message}` }); });
    child.on('exit', code => { clearTimeout(timeout); if (!ready) rejectReady(new Error(`Native capture exited before startup (${code})`)); if (this.child === child) { this.child = undefined; this.onEvent(code && code !== 0 ? { type: 'error', message: `Native capture exited with code ${code}` } : { type: 'status', status: 'Capture stopped', running: false }); } lines.close(); });
    return startup;
  }
  async stop() { const child = this.child; this.child = undefined; if (!child) return; await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2500); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.stdin.write('stop\n'); child.kill('SIGTERM'); }); }
  async request(args: string[], timeout = 15000): Promise<NativeEvent[]> {
    if (!this.available) throw new Error('Native capture helper is unavailable');
    return new Promise((resolve, reject) => {
      const child = spawn(this.helperPath, args, { stdio: 'pipe' }); const events: NativeEvent[] = []; let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Native capture request timed out')); }, timeout);
      const lines = createInterface({ input: child.stdout }); lines.on('line', line => { try { events.push(JSON.parse(line)); } catch {} }); child.stderr.on('data', chunk => { stderr += chunk.toString().slice(0, 300); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); lines.close(); const error = events.find(event => event.type === 'error'); if (error?.type === 'error') reject(new Error(error.message)); else if (code && code !== 0) reject(new Error(stderr || `Capture exited with code ${code}`)); else resolve(events); });
    });
  }
  async screenshot(settings: Settings) {
    const args = ['--screenshot', '--exclude-bundle-id', this.bundleId, '--exclude-pid', String(process.pid)]; if (settings.displayId) args.push('--display-id', settings.displayId);
    const events = await this.request(args); const screenshot = events.find(event => event.type === 'screen');
    if (screenshot?.type !== 'screen') throw new Error('No screen frame was returned. Check Screen Recording permission.'); this.latestScreen = screenshot; return screenshot;
  }
}
