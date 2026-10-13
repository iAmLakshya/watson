import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import type { MeetingActivitySnapshot } from '../shared/types';
import { isWindowsActivityReady, parseWindowsActivityMessage, WINDOWS_BROWSER_IDENTITIES, WINDOWS_CONFERENCE_IDENTITIES, WindowsActivityLines, windowsActivityScope } from './windows-conference-protocol';

export interface WindowsConferenceActivityOptions {
  appBundleIds?: () => string[];
  includeBrowsers?: () => boolean;
  excludedPids?: () => number[];
  /** Test-only process/platform injection never establishes Windows runtime evidence. */
  platform?: NodeJS.Platform; executablePath?: string; spawn?: typeof spawn;
  startupTimeoutMs?: number; sampleTimeoutMs?: number; stopTimeoutMs?: number; clock?: () => number;
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); void promise.catch(() => {});
  return { promise, resolve, reject };
}
interface Pending {
  id: string; identities: string[]; excludedPids: number[]; result: ReturnType<typeof deferred<MeetingActivitySnapshot>>; timer: NodeJS.Timeout;
}

/** Reads Windows Core Audio metadata through the local PowerShell/C# bridge; never records audio. */
export class WindowsConferenceActivityReader {
  readonly scriptPath: string;
  private readonly platform: NodeJS.Platform; private readonly executablePath: string; private readonly spawn: typeof spawn; private readonly clock: () => number;
  private child?: ChildProcessWithoutNullStreams; private readiness?: ReturnType<typeof deferred<void>>; private startupTimer?: NodeJS.Timeout;
  private pending?: Pending; private sampleOperation?: Promise<MeetingActivitySnapshot>; private stopOperation?: Promise<void>;
  private lastError?: string; private failures = 0; private retryAt = 0; private stopping = false; private stderr = '';
  constructor(scriptPath: string | undefined = undefined, private options: WindowsConferenceActivityOptions = {}) {
    const candidates = [join(__dirname, '../../native/windows/ConferenceActivity.ps1'), join(__dirname, '../native/windows/ConferenceActivity.ps1')];
    this.scriptPath = scriptPath ?? candidates.find(path => !/\.asar(?:[\\/]|$)/i.test(path) && existsSync(path)) ?? (process.resourcesPath ? join(process.resourcesPath, 'windows/ConferenceActivity.ps1') : candidates[0]);
    this.platform = options.platform ?? process.platform;
    this.executablePath = options.executablePath ?? win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    this.spawn = options.spawn ?? spawn; this.clock = options.clock ?? Date.now;
  }
  get available() { return this.platform === 'win32' && !/\.asar(?:[\\/]|$)/i.test(this.scriptPath) && existsSync(this.executablePath) && existsSync(this.scriptPath) && existsSync(join(dirname(this.scriptPath), 'ConferenceActivity.cs')); }
  private errorSnapshot(message: string): MeetingActivitySnapshot { return { supported: this.available, checkedAt: new Date(this.clock()).toISOString(), processes: [], error: message.slice(0, 2000) }; }
  private fault(child: ChildProcessWithoutNullStreams, error: Error) {
    if (this.child !== child || this.stopping) return;
    this.lastError = error.message.slice(0, 2000); this.failures++; this.retryAt = this.clock() + Math.min(60000, 5000 * 2 ** Math.min(this.failures - 1, 4));
    if (this.startupTimer) clearTimeout(this.startupTimer); this.startupTimer = undefined;
    this.readiness?.reject(error); if (this.pending) { clearTimeout(this.pending.timer); this.pending.result.reject(error); this.pending = undefined; }
    void this.stop().catch(error => { this.lastError = error instanceof Error ? error.message : String(error); });
  }
  private receive(child: ChildProcessWithoutNullStreams, raw: unknown) {
    if (this.child !== child || this.stopping) return;
    if (isWindowsActivityReady(raw)) { if (this.startupTimer) clearTimeout(this.startupTimer); this.startupTimer = undefined; this.readiness?.resolve(); return; }
    if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'error' && 'message' in raw && typeof raw.message === 'string') throw new Error(raw.message.slice(0, 2000));
    const pending = this.pending; if (!pending) throw new Error('Windows Core Audio bridge returned an unsolicited activity response');
    const snapshot = parseWindowsActivityMessage(raw, pending.id, pending.identities, pending.excludedPids);
    clearTimeout(pending.timer); this.pending = undefined; pending.result.resolve(snapshot);
    this.failures = 0; this.retryAt = 0; this.lastError = undefined;
  }
  private async ensureStarted(): Promise<ChildProcessWithoutNullStreams> {
    if (this.stopOperation) await this.stopOperation;
    if (this.child) { await this.readiness!.promise; return this.child; }
    this.stopping = false; this.stderr = ''; const readiness = deferred<void>(); this.readiness = readiness;
    const bridgeEnvironment: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) if (process.env[name] !== undefined) bridgeEnvironment[name] = process.env[name];
    const child = this.spawn(this.executablePath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath], { stdio: 'pipe', windowsHide: true, env: bridgeEnvironment }); this.child = child;
    const lines = new WindowsActivityLines(raw => this.receive(child, raw)); child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { try { lines.push(chunk); } catch (error) { this.fault(child, error instanceof Error ? error : new Error(String(error))); } });
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-2000); });
    child.stdin.on('error', error => this.fault(child, new Error(`Windows Core Audio metadata input closed: ${error.message}`)));
    child.on('error', error => this.fault(child, new Error(`Windows Core Audio metadata helper could not start: ${error.message}`)));
    child.once('exit', (code, signal) => { if (!this.stopping) this.fault(child, new Error(this.stderr.trim() || `Windows Core Audio metadata helper exited (${code ?? signal ?? 'unknown'})`)); });
    this.startupTimer = setTimeout(() => this.fault(child, new Error('Windows Core Audio metadata helper startup timed out')), this.options.startupTimeoutMs ?? 15000);
    await readiness.promise; if (this.child !== child || this.stopping) throw new Error('Windows Core Audio metadata startup was cancelled'); return child;
  }
  sample(): Promise<MeetingActivitySnapshot> {
    if (this.sampleOperation) return this.sampleOperation;
    const operation = (async () => {
      if (!this.available) return this.errorSnapshot(this.platform !== 'win32' ? 'Windows Core Audio meeting detection requires Windows.' : 'Windows Core Audio metadata helper is unavailable in this build.');
      if (this.retryAt > this.clock()) return this.errorSnapshot(this.lastError ?? 'Windows Core Audio metadata helper is recovering.');
      try {
        const identities = windowsActivityScope(this.options.appBundleIds?.() ?? [...WINDOWS_CONFERENCE_IDENTITIES], this.options.includeBrowsers?.() ?? true);
        const excludedPids = [...new Set([process.pid, ...(this.options.excludedPids?.() ?? [])])];
        if (excludedPids.length > 256 || excludedPids.some(pid => !Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff)) throw new Error('Invalid Windows activity process exclusion scope');
        if (!identities.length) return { supported: true, checkedAt: new Date(this.clock()).toISOString(), processes: [] };
        const child = await this.ensureStarted();
        const id = randomUUID(); const result = deferred<MeetingActivitySnapshot>();
        const timer = setTimeout(() => this.fault(child, new Error('Windows Core Audio metadata scan timed out')), this.options.sampleTimeoutMs ?? 6000);
        this.pending = { id, identities, excludedPids, result, timer };
        const ownExecutable = win32.basename(process.execPath).toLowerCase();
        const excludedExecutables = ['watson.exe', 'watson-capture.exe', ...(/^[a-z0-9][a-z0-9 ._-]{0,239}\.exe$/.test(ownExecutable) ? [ownExecutable] : [])];
        child.stdin.write(JSON.stringify({ type: 'sample', requestId: id, allowedExecutables: identities.map(identity => identity.slice(4)), browserExecutables: WINDOWS_BROWSER_IDENTITIES.filter(identity => identities.includes(identity)).map(identity => identity.slice(4)), excludedPids, excludedExecutables }) + '\n', error => { if (error) this.fault(child, new Error(`Windows Core Audio metadata request failed: ${error.message}`)); });
        return await result.promise;
      } catch (error) { return this.errorSnapshot(error instanceof Error ? error.message : String(error)); }
    })();
    this.sampleOperation = operation;
    void operation.finally(() => { if (this.sampleOperation === operation) this.sampleOperation = undefined; });
    return operation;
  }
  async stop(): Promise<void> {
    if (this.stopOperation) return this.stopOperation;
    const child = this.child; if (!child) return;
    this.stopping = true;
    if (this.startupTimer) clearTimeout(this.startupTimer); this.startupTimer = undefined;
    const stopped = new Error('Windows Core Audio metadata reader stopped'); this.readiness?.reject(stopped);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.result.reject(stopped); this.pending = undefined; }
    this.stopOperation = (async () => {
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve, reject) => {
        const deadline = this.options.stopTimeoutMs ?? 2000;
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, deadline);
        const hardTimer = setTimeout(() => { clearTimeout(timer); reject(new Error('Windows Core Audio metadata helper termination was not confirmed')); }, deadline + 1000);
        child.once('close', () => { clearTimeout(timer); clearTimeout(hardTimer); resolve(); });
        child.stdin.once('error', () => { child.kill('SIGKILL'); });
        child.stdin.end(JSON.stringify({ type: 'stop' }) + '\n');
      });
      if (this.child === child) { this.child = undefined; this.readiness = undefined; }
    })();
    try { await this.stopOperation; } finally { this.stopOperation = undefined; this.stopping = false; }
  }
}
