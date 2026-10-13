import { randomUUID } from 'node:crypto';
import type { AudioProcessActivity, MeetingActivitySnapshot, MeetingDetectionState, Settings } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/defaults';

export const MEETING_BROWSER_IDS = ['com.google.chrome', 'com.apple.safari', 'com.microsoft.edgemac', 'org.mozilla.firefox', 'com.brave.browser', 'com.operasoftware.opera', 'com.vivaldi.vivaldi', 'company.thebrowser.browser', 'exe:chrome.exe', 'exe:msedge.exe', 'exe:firefox.exe', 'exe:brave.exe', 'exe:opera.exe', 'exe:vivaldi.exe', 'exe:arc.exe', 'exe:msedgewebview2.exe'];
export interface MeetingActivityReader { sample(): Promise<MeetingActivitySnapshot>; stop(): void | Promise<void>; }
interface Options {
  reader: MeetingActivityReader; settings: () => Settings; activeSession: () => { id: string; demo: boolean } | undefined;
  startDetected: (candidate: MeetingDetectionState) => Promise<string>; stopDetected: (sessionId: string) => Promise<void>;
  changed: (state: MeetingDetectionState) => void; now?: () => number;
}
// HAL/session metadata is evidence of audio activity, never proof of a meeting.
// State remains local and no window/process title or audio is persisted.
export class MeetingDetector {
  private value: MeetingDetectionState = { enabled: false, supported: false, status: 'disabled', message: 'Meeting detection is off.' };
  private timer?: NodeJS.Timeout; private inflight?: Promise<MeetingDetectionState>; private disposed = false;
  private observed = new Map<string, number>(); private dismissed = new Set<string>(); private tracked = new Set<string>();
  private boundSessionId?: string; private inactiveSince?: number; private endKept = false; private startAttempted = false; private transitioning = false;
  constructor(private options: Options) {}
  state() { return structuredClone(this.value); }
  start() { if (this.timer || this.disposed) return; this.timer = setInterval(() => { if (this.options.settings().meetingDetectionEnabled) void this.scan(); }, 2000); this.timer.unref(); if (this.options.settings().meetingDetectionEnabled) void this.scan(); }
  private publish(patch: MeetingDetectionState) { this.value = patch; this.options.changed(this.state()); return this.state(); }
  settingsChanged() {
    this.observed.clear(); this.dismissed.clear(); this.startAttempted = false; this.inactiveSince = undefined; this.endKept = false;
    const settings = this.options.settings(), allowed = new Set((settings.meetingAppBundleIds ?? DEFAULT_SETTINGS.meetingAppBundleIds!).map(id=>id.toLowerCase()));
    if(settings.meetingBrowserAlerts??true)for(const id of MEETING_BROWSER_IDS)allowed.add(id);
    // Removing a tracked app from the enumeration scope is not end evidence.
    if([...this.tracked].some(id=>!allowed.has(id))){this.boundSessionId=undefined;this.tracked.clear();}
    if (!this.options.settings().meetingDetectionEnabled) { this.boundSessionId = undefined; this.tracked.clear(); this.publish({ enabled: false, supported: this.value.supported, status: 'disabled', message: 'Meeting detection is off.' }); void this.options.reader.stop(); }
    else void this.scan();
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private groups(snapshot: MeetingActivitySnapshot, settings: Settings) {
    const allowed = new Set((settings.meetingAppBundleIds ?? DEFAULT_SETTINGS.meetingAppBundleIds!).map(id => id.toLowerCase()));
    if (settings.meetingBrowserAlerts ?? true) for (const id of MEETING_BROWSER_IDS) allowed.add(id);
    const groups = new Map<string, AudioProcessActivity>();
    for (const row of snapshot.processes) {
      const id = row.bundleId.toLowerCase(); if (!allowed.has(id) || !Number.isInteger(row.pid) || row.pid <= 0 || row.pid === process.pid) continue;
      const prior = groups.get(id); groups.set(id, { ...row, bundleId: id, inputActive: !!row.inputActive || !!prior?.inputActive, outputActive: !!row.outputActive || !!prior?.outputActive });
    }
    return groups;
  }
  scan(): Promise<MeetingDetectionState> {
    if (this.inflight) return this.inflight;
    this.inflight = this.sample().finally(() => { this.inflight = undefined; }); return this.inflight;
  }
  private async sample() {
    const settings = this.options.settings();
    if (!settings.meetingDetectionEnabled || this.disposed) return this.state();
    let snapshot: MeetingActivitySnapshot;
    try { snapshot = await this.options.reader.sample(); } catch (error) { snapshot = { supported: false, checkedAt: new Date(this.now()).toISOString(), processes: [], error: (error as Error).message }; }
    if (this.disposed || !this.options.settings().meetingDetectionEnabled) return this.state();
    const fresh = Date.parse(snapshot.checkedAt); const now = this.now();
    if (!Number.isFinite(fresh) || Math.abs(now - fresh) > 10000) snapshot = { ...snapshot, error: 'Audio activity metadata is stale. No session will start or end from this reading.' };
    if (!snapshot.supported || snapshot.error) {
      this.observed.clear(); this.inactiveSince = undefined;
      return this.publish({ ...this.value, enabled: true, supported: snapshot.supported, status: 'error', activity: snapshot, inactiveSince: undefined, message: snapshot.error ?? 'Meeting detection is unavailable on this OS. Start and stop sessions manually.' });
    }
    const groups = this.groups(snapshot, settings); const active = this.options.activeSession();
    if (this.boundSessionId && (active?.id !== this.boundSessionId || active.demo)) { this.boundSessionId = undefined; this.tracked.clear(); this.inactiveSince = undefined; this.endKept = false; }
    for (const id of this.observed.keys()) if (!groups.get(id)?.inputActive) { this.observed.delete(id); this.dismissed.delete(id); }
    for (const id of this.dismissed) if (!groups.get(id)?.inputActive) this.dismissed.delete(id);
    if (this.boundSessionId) {
      // A switch to a second configured call app keeps this one session alive.
      for (const [id, group] of groups) if (group.inputActive) this.tracked.add(id);
      const stillActive = [...this.tracked].some(id => groups.get(id)?.inputActive || groups.get(id)?.outputActive);
      const base = { ...this.value, enabled: true, supported: true, activity: snapshot, sessionId: this.boundSessionId };
      if (stillActive) { this.inactiveSince = undefined; this.endKept = false; return this.publish({ ...base, status: 'active', inactiveSince: undefined, message: 'Detected session is active. Microphone muting or silence will not end it.' }); }
      this.inactiveSince ??= now;
      if (this.endKept || settings.meetingEndAction === 'off') return this.publish({ ...base, status: 'active', inactiveSince: new Date(this.inactiveSince).toISOString(), message: 'Audio streams are closed. You chose to keep this session running; stop it manually.' });
      if (now - this.inactiveSince < (settings.meetingEndDelaySeconds ?? 20) * 1000) return this.publish({ ...base, status: 'active', inactiveSince: new Date(this.inactiveSince).toISOString(), message: 'Call audio streams closed. Waiting before suggesting an end.' });
      this.publish({ ...base, status: 'possible-end', inactiveSince: new Date(this.inactiveSince).toISOString(), message: 'The tracked call apps have closed their input and output streams. End this session or keep it running.' });
      if (settings.meetingEndAction === 'stop') await this.finish();
      return this.state();
    }
    if (active) return this.publish({ enabled: true, supported: true, status: 'watching', activity: snapshot, message: active.demo ? 'Demo session active. Detection cannot stop a demo.' : 'A manually started session is active. Detection will not stop it.' });
    for (const [id, group] of groups) if (group.inputActive && !this.observed.has(id)) this.observed.set(id, now);
    const group = [...groups.values()].find(row => row.inputActive && !this.dismissed.has(row.bundleId) && now - this.observed.get(row.bundleId)! >= (settings.meetingStartDelaySeconds ?? 3) * 1000);
    if (!group || settings.meetingStartAction === 'off') { this.startAttempted = false; return this.publish({ enabled: true, supported: true, status: 'watching', activity: snapshot, message: 'Watching selected apps for active audio input streams. No microphone or screen capture is running.' }); }
    const same = this.value.bundleId === group.bundleId && ['candidate', 'setup-required'].includes(this.value.status);
    if (!same) this.startAttempted = false;
    const browser = MEETING_BROWSER_IDS.includes(group.bundleId);
    this.publish({ enabled: true, supported: true, status: same && this.value.status === 'setup-required' ? 'setup-required' : 'candidate', message: same && this.value.status === 'setup-required' ? this.value.message : browser ? `${group.name} is using audio input. This may be a browser call, recording, or another site; Watson cannot identify the tab.` : `${group.name} has an active audio input stream. A call is possible.`, activity: snapshot, candidateId: same ? this.value.candidateId : randomUUID(), bundleId: group.bundleId, appName: group.name, ambiguousBrowser: browser, activeSince: new Date(this.observed.get(group.bundleId)!).toISOString() });
    // Automatic start requires input AND output; a mic test is only a suggestion.
    if (settings.meetingStartAction === 'start' && (!browser || settings.meetingBrowserAutoStart === true) && group.outputActive && !this.startAttempted) await this.begin();
    return this.state();
  }
  private async begin() {
    if (this.transitioning) throw new Error('A detected session transition is in progress');
    if (!this.value.candidateId || !this.value.bundleId || this.options.activeSession()) throw new Error('This detected call is no longer available');
    this.startAttempted = true; this.transitioning = true;
    try { const candidate = this.state(); const id = await this.options.startDetected(candidate); if(this.disposed||!this.options.settings().meetingDetectionEnabled){await this.options.stopDetected(id);return;}this.bindSession(candidate.candidateId!, id); }
    catch (error) { if(!this.disposed&&this.options.settings().meetingDetectionEnabled)this.publish({ ...this.value, status: 'setup-required', message: `Detected session could not start: ${(error as Error).message}` }); }
    finally { this.transitioning = false; }
  }
  bindSession(candidateId: string, sessionId: string) {
    if (this.value.candidateId !== candidateId || !this.value.bundleId) throw new Error('This detected call is no longer available');
    this.boundSessionId = sessionId; this.tracked = new Set([this.value.bundleId]); this.inactiveSince = undefined; this.endKept = false;
    this.publish({ ...this.value, status: 'active', sessionId, message: 'Session started from detected audio activity. End detection tracks input and output streams.' });
  }
  private async finish() {
    if (this.transitioning) throw new Error('A detected session transition is in progress');
    const id = this.boundSessionId; if (!id || this.options.activeSession()?.id !== id) throw new Error('The detected session is no longer active');
    this.transitioning = true;
    try { await this.options.stopDetected(id); this.boundSessionId = undefined; this.tracked.clear(); this.dismissed.add(this.value.bundleId!); this.inactiveSince = undefined; this.publish({ enabled: true, supported: true, status: 'watching', activity: this.value.activity, message: 'Detected session ended after its audio streams closed.' }); }
    catch (error) { this.endKept = true; this.publish({ ...this.value, status: 'possible-end', message: `Session could not end automatically: ${(error as Error).message}. Stop it manually or keep it running.` }); }
    finally { this.transitioning = false; }
  }
  async respond(input: { candidateId: string; action: 'start' | 'dismiss' | 'stop' | 'keep' }) {
    await this.scan();
    if (!this.options.settings().meetingDetectionEnabled || input.candidateId !== this.value.candidateId) throw new Error('This detected call is no longer available');
    if (['start', 'dismiss'].includes(input.action)) {
      if (!['candidate', 'setup-required'].includes(this.value.status)) throw new Error('There is no call-start suggestion to respond to');
      if (input.action === 'start') await this.begin();
      else { this.dismissed.add(this.value.bundleId!); this.publish({ enabled: true, supported: true, status: 'watching', activity: this.value.activity, message: 'Suggestion dismissed until this app closes its audio input stream.' }); }
    } else {
      if (this.value.status !== 'possible-end') throw new Error('There is no call-end suggestion to respond to');
      if (input.action === 'stop') await this.finish(); else { this.endKept = true; this.publish({ ...this.value, status: 'active', message: 'Session kept running. Stop it manually, or a new activity cycle can suggest an end.' }); }
    }
    return this.state();
  }
  async dispose() { this.disposed = true; if (this.timer) clearInterval(this.timer); await this.options.reader.stop(); await this.inflight; }
}
