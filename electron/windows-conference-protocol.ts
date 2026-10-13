import type { AudioProcessActivity, MeetingActivitySnapshot } from '../shared/types';

export const WINDOWS_CONFERENCE_IDENTITIES = ['exe:zoom.exe', 'exe:ms-teams.exe', 'exe:teams.exe', 'exe:webex.exe', 'exe:ciscowebexstart.exe', 'exe:atmgr.exe', 'exe:ciscocollabhost.exe', 'exe:discord.exe', 'exe:slack.exe', 'exe:skype.exe'] as const;
export const WINDOWS_BROWSER_IDENTITIES = ['exe:chrome.exe', 'exe:msedge.exe', 'exe:firefox.exe', 'exe:brave.exe', 'exe:opera.exe', 'exe:vivaldi.exe', 'exe:arc.exe', 'exe:msedgewebview2.exe'] as const;
const SELF_IDENTITIES = new Set(['exe:watson.exe', 'exe:watson-capture.exe']);
const requestPattern = /^[a-f0-9-]{36}$/;

export function windowsExecutableIdentity(executable: string): string {
  if (typeof executable !== 'string' || !/^[a-z0-9][a-z0-9 ._-]{0,239}\.exe$/i.test(executable)) throw new Error('Invalid Windows executable identity');
  return `exe:${executable.toLowerCase()}`;
}

/** Mac bundle IDs may share the settings array, but never turn into Windows process matches. */
export function windowsActivityScope(appIdentities: readonly string[], includeBrowsers: boolean): string[] {
  const identities = appIdentities.filter(identity => identity.startsWith('exe:')).map(identity => windowsExecutableIdentity(identity.slice(4)));
  if (includeBrowsers) identities.push(...WINDOWS_BROWSER_IDENTITIES);
  const unique = [...new Set(identities.filter(identity => !SELF_IDENTITIES.has(identity)))];
  if (unique.length > 128) throw new Error('Choose at most 128 Windows meeting application identities');
  return unique;
}

function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Windows audio activity message');
  return raw as Record<string, unknown>;
}
const pid = (raw: unknown): number => {
  if (!Number.isSafeInteger(raw) || (raw as number) < 1 || (raw as number) > 0xffffffff) throw new Error('Invalid Windows audio process ID');
  return raw as number;
};
export function parseWindowsActivityMessage(raw: unknown, expectedRequestId: string, allowedIdentities: readonly string[], excludedPids: readonly number[] = []): MeetingActivitySnapshot {
  const value = object(raw);
  if (value.protocol !== 1 || value.type !== 'activity' || value.requestId !== expectedRequestId || !requestPattern.test(expectedRequestId)) throw new Error('Windows audio activity response does not match its request');
  if (typeof value.checkedAt !== 'string' || value.checkedAt.length > 64 || !Number.isFinite(Date.parse(value.checkedAt)) || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value.checkedAt)) throw new Error('Windows audio activity response has an invalid timestamp');
  if (!Array.isArray(value.sessions) || value.sessions.length > 4096 || !Array.isArray(value.errors) || value.errors.length > 64) throw new Error('Windows audio activity response exceeds its bounds');
  const errors: string[] = value.errors.map(error => { if (typeof error !== 'string' || !error || error.length > 2000) throw new Error('Invalid Windows audio activity error'); return error; });
  const allowed = new Set(allowedIdentities); const excluded = new Set(excludedPids); const processes = new Map<number, AudioProcessActivity>();
  for (const rawSession of value.sessions) {
    const row = object(rawSession); const audioPid = pid(row.pid); const ownerPid = pid(row.ownerPid);
    if (typeof row.ownerExecutable !== 'string' || typeof row.executable !== 'string') throw new Error('Windows audio activity is missing process identity');
    const identity = windowsExecutableIdentity(row.ownerExecutable); const leafIdentity = windowsExecutableIdentity(row.executable);
    if (row.flow !== 'capture' && row.flow !== 'render') throw new Error('Invalid Windows audio endpoint flow');
    if (row.state !== 'active' && row.state !== 'inactive' && row.state !== 'expired') throw new Error('Invalid Windows audio session state');
    if (typeof row.singleProcess !== 'boolean') throw new Error('Windows audio activity is missing PID attribution');
    if (excluded.has(audioPid) || excluded.has(ownerPid) || SELF_IDENTITIES.has(identity) || SELF_IDENTITIES.has(leafIdentity)) continue;
    if (!allowed.has(identity)) throw new Error('Windows audio activity contains an unconfigured process identity');
    if (!row.singleProcess) { errors.push('A Windows audio session spans several processes; its meeting identity is ambiguous.'); continue; }
    if (row.state === 'expired') continue;
    const previous = processes.get(audioPid);
    if (previous && previous.bundleId !== identity) throw new Error('Windows audio process identity changed during the scan');
    const process = previous ?? { pid: audioPid, bundleId: identity, name: row.ownerExecutable, inputActive: false, outputActive: false };
    // Running stream state comes from Core Audio; amplitude, packets, and app focus are irrelevant.
    if (row.state === 'active') { if (row.flow === 'capture') process.inputActive = true; else process.outputActive = true; }
    processes.set(audioPid, process);
  }
  return { supported: true, checkedAt: value.checkedAt, processes: [...processes.values()], ...(errors.length ? { error: [...new Set(errors)].join(' ').slice(0, 2000) } : {}) };
}

export function isWindowsActivityReady(raw: unknown): boolean {
  const value = object(raw); return value.type === 'ready' && value.protocol === 1;
}

/** Bound stdout before creating lines so a corrupt helper cannot queue an unlimited payload. */
export class WindowsActivityLines {
  private pending = '';
  constructor(private receive: (value: unknown) => void, private limit = 1_000_000) {}
  push(chunk: string): void {
    this.pending += chunk;
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      if (newline > this.limit) throw new Error('Windows audio activity response is too large');
      const line = this.pending.slice(0, newline).replace(/\r$/, ''); this.pending = this.pending.slice(newline + 1);
      if (!line.trim()) continue;
      this.receive(JSON.parse(line));
    }
    if (this.pending.length > this.limit) throw new Error('Windows audio activity response is too large');
  }
}
