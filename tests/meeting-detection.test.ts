import test from 'node:test';
import assert from 'node:assert/strict';
import { MeetingDetector } from '../electron/meeting-detection';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { AudioProcessActivity, MeetingActivitySnapshot, MeetingDetectionState, Settings } from '../shared/types';

const zoom = (inputActive = true, outputActive = true, pid = 900001): AudioProcessActivity => ({ pid, bundleId: 'us.zoom.xos', name: 'Zoom', inputActive, outputActive });
function fixture(patch: Partial<Settings> = {}) {
  let now = Date.parse('2026-10-12T12:00:00Z'); let rows: AudioProcessActivity[] = []; let error: string | undefined; let supported = true;
  let active: { id: string; demo: boolean } | undefined; let failStart: string | undefined; let starts = 0; let stops = 0; let scans = 0; let disposed = false;
  const settings: Settings = { ...structuredClone(DEFAULT_SETTINGS), meetingDetectionEnabled: true, ...patch }; const states: MeetingDetectionState[] = [];
  const detector = new MeetingDetector({ settings: () => settings, now: () => now, activeSession: () => active, reader: { async sample() { scans++; return { supported, checkedAt: new Date(now).toISOString(), processes: rows, error }; }, stop() { disposed = true; } }, async startDetected(candidate) { starts++; assert.ok(candidate.candidateId); if (failStart) throw new Error(failStart); active = { id: 'detected-session', demo: false }; return active.id; }, async stopDetected(id) { assert.equal(active?.id, id); stops++; active = undefined; }, changed: state => states.push(state) });
  return { detector, settings, states, rows(value: AudioProcessActivity[]) { rows = value; }, advance(seconds: number) { now += seconds * 1000; }, error(value?: string) { error = value; }, supported(value: boolean) { supported = value; }, active(value?: { id: string; demo: boolean }) { active = value; }, failStart(value?: string) { failStart = value; }, counts: () => ({ starts, stops, scans, disposed }) };
}
test('launch and output-only playback cannot trigger a meeting; real input requires sustained debounce', async () => {
  const f = fixture(); f.rows([zoom(false, false)]); await f.detector.scan(); f.advance(30); f.rows([zoom(false, true)]); assert.equal((await f.detector.scan()).status, 'watching');
  f.rows([zoom(true, false)]); await f.detector.scan(); f.advance(2); assert.equal((await f.detector.scan()).status, 'watching'); f.advance(1); const state = await f.detector.scan(); assert.equal(state.status, 'candidate'); assert.match(state.message, /active audio input stream/); assert.equal(f.counts().starts, 0); await f.detector.dispose();
});
test('automatic dedicated-app start needs input plus output, groups PID replacements and binds only created session', async () => {
  const f = fixture({ meetingStartAction: 'start' }); f.rows([zoom(true, false)]); await f.detector.scan(); f.advance(3); const candidate = await f.detector.scan(); assert.equal(f.counts().starts, 0);
  f.rows([zoom(true, false, 900002), zoom(false, true, 900003)]); const state = await f.detector.scan(); assert.equal(state.status, 'active'); assert.equal(state.candidateId, candidate.candidateId); assert.equal(state.sessionId, 'detected-session'); assert.equal(f.counts().starts, 1); await f.detector.scan(); assert.equal(f.counts().starts, 1); await f.detector.dispose();
});
test('browser ambiguity is always visible and automatic start requires separate explicit opt-in', async () => {
  const f = fixture({ meetingStartAction: 'start' }); f.rows([{ ...zoom(), bundleId: 'com.google.chrome', name: 'Chrome' }]); await f.detector.scan(); f.advance(3); const state = await f.detector.scan(); assert.equal(state.status, 'candidate'); assert.equal(state.ambiguousBrowser, true); assert.match(state.message, /cannot identify the tab/); assert.equal(f.counts().starts, 0);
  f.settings.meetingBrowserAutoStart = true; await f.detector.scan(); assert.equal(f.counts().starts, 1); await f.detector.dispose();
});
test('dismiss persists across PID changes until input closes; it never repeats every poll', async () => {
  const f = fixture(); f.rows([zoom()]); await f.detector.scan(); f.advance(3); const candidate = await f.detector.scan(); await f.detector.respond({ candidateId: candidate.candidateId!, action: 'dismiss' }); f.rows([zoom(true, true, 900005)]); f.advance(90); assert.equal((await f.detector.scan()).status, 'watching');
  f.rows([zoom(false, true)]); await f.detector.scan(); f.rows([zoom()]); await f.detector.scan(); f.advance(3); assert.notEqual((await f.detector.scan()).candidateId, candidate.candidateId); await f.detector.dispose();
});
test('end waits for both streams, not muted input or silence, and defaults to explicit confirmation', async () => {
  const f = fixture({ meetingStartAction: 'start' }); f.rows([zoom()]); await f.detector.scan(); f.advance(3); await f.detector.scan();
  f.rows([zoom(false, true)]); f.advance(500); assert.equal((await f.detector.scan()).status, 'active'); assert.equal(f.counts().stops, 0);
  f.rows([]); await f.detector.scan(); f.advance(19); assert.equal((await f.detector.scan()).status, 'active'); f.advance(1); const state = await f.detector.scan(); assert.equal(state.status, 'possible-end'); assert.equal(f.counts().stops, 0); await f.detector.respond({ candidateId: state.candidateId!, action: 'stop' }); assert.equal(f.counts().stops, 1); await f.detector.dispose();
});
test('metadata errors/unsupported results reset end evidence and cannot auto-stop', async () => {
  const f = fixture({ meetingStartAction: 'start', meetingEndAction: 'stop' }); f.rows([zoom()]); await f.detector.scan(); f.advance(3); await f.detector.scan(); f.rows([]); await f.detector.scan(); f.advance(19); f.error('Restricted process metadata'); assert.equal((await f.detector.scan()).status, 'error'); f.advance(300); assert.equal(f.counts().stops, 0);
  f.error(); await f.detector.scan(); f.advance(19); await f.detector.scan(); assert.equal(f.counts().stops, 0); f.advance(1); await f.detector.scan(); assert.equal(f.counts().stops, 1); await f.detector.dispose();
});
test('manual and demo sessions never become automatic end targets', async () => {
  for (const demo of [false, true]) { const f = fixture({ meetingStartAction: 'start', meetingEndAction: 'stop' }); f.active({ id: 'manual', demo }); f.rows([zoom()]); await f.detector.scan(); f.advance(100); f.rows([]); const state = await f.detector.scan(); assert.equal(state.status, 'watching'); assert.equal(f.counts().starts, 0); assert.equal(f.counts().stops, 0); await f.detector.dispose(); }
});
test('a switch to another selected call app preserves session; keep suppresses end until a new activity cycle', async () => {
  const f = fixture({ meetingStartAction: 'start' }); f.rows([zoom()]); await f.detector.scan(); f.advance(3); await f.detector.scan(); f.rows([{ ...zoom(), bundleId: 'com.microsoft.teams2', name: 'Teams' }]); await f.detector.scan(); f.rows([]); await f.detector.scan(); f.advance(20); const state = await f.detector.scan(); await f.detector.respond({ candidateId: state.candidateId!, action: 'keep' }); f.advance(100); assert.equal((await f.detector.scan()).status, 'active'); assert.equal(f.counts().stops, 0); f.rows([zoom(false, true)]); await f.detector.scan(); f.rows([]); await f.detector.scan(); f.advance(20); assert.equal((await f.detector.scan()).status, 'possible-end'); await f.detector.dispose();
});
test('setup failure is visible and automatic polling does not retry provider/capture every two seconds', async () => {
  const f = fixture({ meetingStartAction: 'start' }); f.failStart('Microphone permission was not previously granted'); f.rows([zoom()]); await f.detector.scan(); f.advance(3); const state = await f.detector.scan(); assert.equal(state.status, 'setup-required'); assert.match(state.message, /Microphone permission/); f.advance(60); await f.detector.scan(); assert.equal(f.counts().starts, 1); f.failStart(); await f.detector.respond({ candidateId: state.candidateId!, action: 'start' }); assert.equal(f.counts().starts, 2); assert.equal(f.detector.state().status, 'active'); await f.detector.dispose();
});
test('disabled detection never samples OS metadata; unknown and own processes cannot create suggestions', async () => {
  const f = fixture({ meetingDetectionEnabled: false }); await f.detector.scan(); assert.equal(f.counts().scans, 0); f.settings.meetingDetectionEnabled = true; f.rows([zoom(true, true, process.pid), { ...zoom(), bundleId: 'com.example.recorder' }]); await f.detector.scan(); f.advance(100); assert.equal((await f.detector.scan()).status, 'watching'); await assert.rejects(f.detector.respond({ candidateId: 'stale', action: 'start' }), /no longer available/); await f.detector.dispose(); assert.equal(f.counts().disposed, true);
});
test('stale snapshots are not end evidence and polling coalesces concurrent readers', async () => {
  let samples = 0; let resolve: (value: MeetingActivitySnapshot) => void = () => {}; const now = Date.parse('2026-10-12T12:00:00Z');
  const detector = new MeetingDetector({ reader: { sample() { samples++; return new Promise(done => { resolve = done; }); }, stop() {} }, now: () => now, settings: () => ({ ...DEFAULT_SETTINGS, meetingDetectionEnabled: true }), activeSession: () => undefined, async startDetected() { throw new Error('unexpected capture'); }, async stopDetected() { throw new Error('unexpected stop'); }, changed() {} });
  const a = detector.scan(), b = detector.scan(); assert.equal(samples, 1); resolve({ supported: true, checkedAt: '2026-10-12T10:00:00Z', processes: [zoom()] }); assert.equal((await a).status, 'error'); assert.match((await b).message, /stale/); await detector.dispose();
});
test('removing a tracked app from allowed discovery disarms end detection instead of treating missing scope as closure',async()=>{
  const f=fixture({meetingStartAction:'start',meetingEndAction:'stop'});f.rows([zoom()]);await f.detector.scan();f.advance(3);await f.detector.scan();f.settings.meetingAppBundleIds=['com.microsoft.teams2'];f.detector.settingsChanged();await f.detector.scan();f.rows([]);f.advance(500);const state=await f.detector.scan();assert.equal(f.counts().stops,0);assert.equal(state.status,'watching');assert.match(state.message,/manually started/);await f.detector.dispose();
});
