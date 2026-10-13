import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { WindowsConferenceActivityReader } from '../electron/windows-conference';
import { parseWindowsActivityMessage, WINDOWS_BROWSER_IDENTITIES, WindowsActivityLines, windowsActivityScope, windowsExecutableIdentity } from '../electron/windows-conference-protocol';

const requestId = '00000000-0000-4000-8000-000000000001';
const checkedAt = '2026-10-12T12:00:00.000Z';
const row = (patch: Record<string, unknown> = {}) => ({ pid: 800, ownerPid: 800, executable: 'Zoom.exe', ownerExecutable: 'Zoom.exe', flow: 'capture', state: 'active', singleProcess: true, ...patch });
const response = (sessions: unknown[], errors: string[] = []) => ({ type: 'activity', protocol: 1, requestId, checkedAt, sessions, errors });

test('Windows activity projects actual capture/render session states independently and preserves inactive metadata', () => {
  const snapshot = parseWindowsActivityMessage(response([row(), row({ flow: 'render', state: 'inactive' }), row({ pid: 900, ownerPid: 900, flow: 'render', state: 'active' })]), requestId, ['exe:zoom.exe']);
  assert.deepEqual(snapshot.processes, [{ pid: 800, bundleId: 'exe:zoom.exe', name: 'Zoom.exe', inputActive: true, outputActive: false }, { pid: 900, bundleId: 'exe:zoom.exe', name: 'Zoom.exe', inputActive: false, outputActive: true }]);
  const inactive = parseWindowsActivityMessage(response([row({ state: 'inactive' }), row({ flow: 'render', state: 'inactive' })]), requestId, ['exe:zoom.exe']);
  assert.equal(inactive.processes[0].inputActive, false); assert.equal(inactive.processes[0].outputActive, false);
  assert.equal(parseWindowsActivityMessage(response([row({ state: 'expired' })]), requestId, ['exe:zoom.exe']).processes.length, 0);
});
test('quiet audio cannot turn an active Core Audio stream into an inactive meeting signal', () => {
  const snapshot = parseWindowsActivityMessage(response([row({ rms: 0, peak: 0, packets: 0, focused: false, windowTitle: 'Idle', runningApp: false })]), requestId, ['exe:zoom.exe']);
  assert.equal(snapshot.processes[0].inputActive, true); assert.equal(snapshot.error, undefined);
});
test('browser audio-service identity stays ambiguous, while verified Teams ownership retains the audio-session PID', () => {
  const browser = parseWindowsActivityMessage(response([row({ executable: 'chrome.exe', ownerExecutable: 'chrome.exe', ownerPid: 700 })]), requestId, [...WINDOWS_BROWSER_IDENTITIES]);
  assert.equal(browser.processes[0].bundleId, 'exe:chrome.exe'); assert.equal(browser.processes[0].pid, 800);
  const teams = parseWindowsActivityMessage(response([row({ executable: 'msedgewebview2.exe', ownerExecutable: 'ms-teams.exe', ownerPid: 700 })]), requestId, ['exe:ms-teams.exe']);
  assert.equal(teams.processes[0].bundleId, 'exe:ms-teams.exe'); assert.equal(teams.processes[0].pid, 800);
});
test('failed or shared-process metadata remains an error instead of supplying quiet-audio or meeting-end evidence', () => {
  const partial = parseWindowsActivityMessage(response([row()], ['Core Audio endpoint enumeration failed']), requestId, ['exe:zoom.exe']);
  assert.match(partial.error!, /enumeration failed/); assert.equal(partial.processes[0].inputActive, true);
  const shared = parseWindowsActivityMessage(response([row({ singleProcess: false })]), requestId, ['exe:zoom.exe']);
  assert.equal(shared.processes.length, 0); assert.match(shared.error!, /several processes/);
});
test('Windows metadata scope excludes Watson/current PID, accepts exact executable identities, and rejects unrelated or malformed data', () => {
  assert.equal(parseWindowsActivityMessage(response([row()]), requestId, ['exe:zoom.exe'], [800]).processes.length, 0);
  assert.equal(parseWindowsActivityMessage(response([row({ executable: 'Watson.exe' })]), requestId, ['exe:zoom.exe']).processes.length, 0);
  assert.equal(parseWindowsActivityMessage(response([row({ ownerExecutable: 'Watson.exe' })]), requestId, []).processes.length, 0);
  assert.deepEqual(windowsActivityScope(['us.zoom.xos', 'exe:Zoom.exe', 'exe:watson.exe'], false), ['exe:zoom.exe']);
  assert.ok(windowsActivityScope([], true).includes('exe:chrome.exe')); assert.equal(windowsExecutableIdentity('MS-Teams.EXE'), 'exe:ms-teams.exe');
  assert.throws(() => windowsActivityScope(['exe:../zoom.exe'], false));
  assert.throws(() => parseWindowsActivityMessage(response([row({ ownerExecutable: 'other.exe' })]), requestId, ['exe:zoom.exe']), /unconfigured/);
  for (const patch of [{ pid: -1 }, { flow: 'microphone' }, { state: 'quiet' }, { singleProcess: undefined }, { executable: 'C:\\Zoom.exe' }]) assert.throws(() => parseWindowsActivityMessage(response([row(patch)]), requestId, ['exe:zoom.exe']));
  assert.throws(() => parseWindowsActivityMessage({ ...response([]), requestId: '00000000-0000-4000-8000-000000000002' }, requestId, []), /match/);
  assert.throws(() => parseWindowsActivityMessage({ ...response([]), checkedAt: 'tomorrow' }, requestId, []));
});
test('Windows metadata stdout handles decoded chunk boundaries and rejects malformed or oversized lines', () => {
  const values: unknown[] = []; const lines = new WindowsActivityLines(value => values.push(value), 40);
  lines.push('{"name":"Zü'); lines.push('rich"}\r\n\n{"ready":true}\n'); assert.deepEqual(values, [{ name: 'Zürich' }, { ready: true }]);
  assert.throws(() => new WindowsActivityLines(() => {}, 5).push('123456'), /too large/);
  assert.throws(() => new WindowsActivityLines(() => {}).push('invalid\n'));
});

function readerFixture(mode = 'normal', settings: { appBundleIds?: () => string[]; includeBrowsers?: () => boolean; clock?: () => number } = {}) {
  const children: ChildProcessWithoutNullStreams[] = []; const launches: { path: string; args: readonly string[]; options: unknown }[] = [];
  const create: typeof spawn = ((path: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    launches.push({ path, args, options }); const child = spawn(process.execPath, [join(process.cwd(), 'tests/fixtures/windows-activity-helper.mjs'), mode], { ...options, stdio: 'pipe' }) as ChildProcessWithoutNullStreams; children.push(child); return child;
  }) as typeof spawn;
  const reader = new WindowsConferenceActivityReader(join(process.cwd(), 'native/windows/ConferenceActivity.ps1'), { platform: 'win32', executablePath: process.execPath, spawn: create, startupTimeoutMs: 1500, sampleTimeoutMs: 80, stopTimeoutMs: 80, ...settings });
  return { reader, children, launches };
}
test('the Windows adapter coalesces concurrent scans, scopes the local helper, and cleans up the persistent process', async () => {
  let apps = ['exe:zoom.exe']; const f = readerFixture('normal', { appBundleIds: () => apps, includeBrowsers: () => false });
  try {
    const first = f.reader.sample(); const same = f.reader.sample(); assert.equal(first, same); const snapshot = await first;
    assert.equal(snapshot.processes[0].inputActive, true); assert.equal(f.children.length, 1);
    const launch = f.launches[0]; assert.ok(launch.args.includes('-NonInteractive')); assert.ok(launch.args.includes('-NoProfile')); assert.equal((launch.options as any).windowsHide, true); assert.equal(Object.hasOwn((launch.options as any).env, 'OPENAI_API_KEY'), false);
    apps = []; const empty = await f.reader.sample(); assert.equal(empty.processes.length, 0); assert.equal(f.children.length, 1);
  } finally { await f.reader.stop(); }
  assert.notEqual(f.children[0].exitCode, null);
});
test('metadata errors and corrupt helper output cannot be mistaken for a completed inactive scan', async () => {
  for (const mode of ['partial', 'invalid', 'exit']) {
    const f = readerFixture(mode);
    try { const result = await f.reader.sample(); assert.equal(result.supported, true); assert.ok(result.error); if (mode === 'partial') assert.equal(result.processes[0].inputActive, true); else assert.equal(result.processes.length, 0); }
    finally { await f.reader.stop(); }
  }
});
test('metadata scan/start deadlines terminate stalled helpers and retries obey backoff', async () => {
  let now = Date.now(); const f = readerFixture('hang', { clock: () => now });
  try {
    const result = await f.reader.sample(); assert.match(result.error!, /scan timed out/); await f.reader.stop();
    await f.reader.sample(); assert.equal(f.children.length, 1); now += 6000; await f.reader.sample(); await f.reader.stop(); assert.equal(f.children.length, 2);
  } finally { await f.reader.stop(); }
  const startup = readerFixture('no-ready');
  try { const result = await startup.reader.sample(); assert.match(result.error!, /startup timed out/); }
  finally { await startup.reader.stop(); }
});
test('metadata stop is bounded when a helper ignores shutdown, and the production reader is unavailable off Windows', async () => {
  const f = readerFixture('no-stop');
  try { await f.reader.sample(); const started = Date.now(); await f.reader.stop(); assert.ok(Date.now() - started < 1000); assert.ok(f.children[0].exitCode !== null || f.children[0].signalCode !== null); }
  finally { await f.reader.stop(); }
  const real = new WindowsConferenceActivityReader();
  if (process.platform !== 'win32') { assert.equal(real.available, false); const result = await real.sample(); assert.equal(result.supported, false); assert.ok(result.error); }
});
