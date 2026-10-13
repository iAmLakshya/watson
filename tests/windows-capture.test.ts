import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WindowsCaptureManager, type WindowsCaptureOptions } from '../electron/windows-capture';
import type { NativeEvent } from '../electron/capture';
import { DEFAULT_SETTINGS } from '../shared/defaults';

async function fixture(options: { ready?: boolean; started?: boolean; stopped?: boolean; wrongSources?: boolean; microphones?: unknown; contentProtection?: () => boolean; microphoneAccess?: () => string; screenAccess?: () => string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'watson-windows-capture-fixture-'));
  const pagePath = join(directory, 'index.html'); const preloadPath = join(directory, 'preload.js');
  await Promise.all([writeFile(pagePath, '<html></html>'), writeFile(preloadPath, '')]);
  const handlers = new Map<string, (event: any, raw: unknown) => Promise<unknown>>(); const events: NativeEvent[] = [];
  const displays = [{ id: 1, size: { width: 1920, height: 1080 } }, { id: 2, size: { width: 1280, height: 720 } }];
  let captures = 0; const requests: any[] = []; const partitions: string[] = []; const windows: FakeWindow[] = []; let captureSession: any;
  class FakeWindow extends EventEmitter {
    destroyed = false; protected = false; configuration: any; channel: string; webContents: any; command: any;
    static getAllWindows() { return windows; }
    constructor(configuration: any) {
      super(); this.configuration = configuration; this.channel = configuration.webPreferences?.additionalArguments?.[0]?.slice('--watson-capture-channel='.length) ?? '';
      const contents = new EventEmitter() as any;
      contents.id = windows.length + 1; contents.mainFrame = { url: '' }; contents.getURL = () => contents.mainFrame.url;
      contents.setWindowOpenHandler = (handler: unknown) => { contents.windowOpenHandler = handler; };
      contents.executeJavaScript = async (code: string, userGesture: boolean) => {
        if (code === 'window.watsonListMicrophones()') return options.microphones ?? [{ id: 'default', label: '', isDefault: true }, { id: 'real-device-id-fixture', label: 'Fixture microphone', isDefault: false }];
        assert.equal(userGesture, true); this.command = JSON.parse(code.slice(code.indexOf('(') + 1, -1));
        if (options.started !== false) await this.message({ type: 'started', runId: this.command.runId, system: options.wrongSources ? !this.command.system : this.command.system, microphone: this.command.microphone });
      };
      contents.send = (_channel: string, payload: any) => { if (options.stopped !== false) void this.message({ type: 'stopped', runId: payload.runId }); };
      this.webContents = contents; windows.push(this);
    }
    async loadFile(path: string) { this.webContents.mainFrame.url = pathToFileURL(path).href; if (options.ready !== false) await this.message({ type: 'ready' }); }
    message(raw: unknown, sender = this.webContents, main = true) { return handlers.get(this.channel)!({ sender, senderFrame: main ? sender.mainFrame : {} }, raw); }
    setContentProtection(value: boolean) { this.protected = value; }
    isContentProtected() { return this.protected; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const runtime = {
    BrowserWindow: FakeWindow,
    ipcMain: { handle: (channel: string, handler: any) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) },
    session: { fromPartition: (partition: string, settings: unknown) => {
      partitions.push(partition);
      assert.deepEqual(settings, { cache: false });
      captureSession = { webRequest: { onBeforeRequest: (handler: unknown) => { captureSession.network = handler; } }, setPermissionRequestHandler: (handler: unknown) => { captureSession.permissionRequest = handler; }, setPermissionCheckHandler: (handler: unknown) => { captureSession.permissionCheck = handler; }, setDisplayMediaRequestHandler: (handler: unknown, configuration: unknown) => { captureSession.displayMedia = handler; captureSession.pickerOptions = configuration; } }; return captureSession;
    } },
    screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0] },
    systemPreferences: { getMediaAccessStatus: (type: string) => type === 'microphone' ? options.microphoneAccess?.() ?? 'granted' : options.screenAccess?.() ?? 'granted' },
    desktopCapturer: { getSources: async (request: any) => {
      requests.push(request); captures++; if (request.thumbnailSize.width) assert.ok(windows.every(window => window.destroyed || window.protected));
      return displays.map(display => ({ id: `screen:${display.id}:0`, display_id: String(display.id), name: `Display ${display.id}`, thumbnail: { isEmpty: () => false, toJPEG: () => Buffer.from(`fresh-frame-${captures}-display-${display.id}`) } }));
    } },
  };
  const capture = new WindowsCaptureManager(event => events.push(event), { pagePath, preloadPath, platform: 'win32', runtime: runtime as unknown as NonNullable<WindowsCaptureOptions['runtime']>, startupTimeoutMs: 100, stopTimeoutMs: 10, contentProtection: options.contentProtection });
  return { capture, events, windows, FakeWindow, requests, handlers, partitions, session: () => captureSession, cleanup: async () => { await capture.stop(); await rm(directory, { recursive: true, force: true }); } };
}

test('Windows microphone-only capture stays isolated, honors device preference, and rejects disabled sources', async () => {
  const f = await fixture();
  try {
    await f.capture.start({ ...DEFAULT_SETTINGS, captureSystem: false, captureScreen: false, captureMicrophone: true, microphoneDeviceId: 'selected-mic' });
    const window = f.windows[0]; const preferences = window.configuration.webPreferences;
    assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.backgroundThrottling, false);
    assert.deepEqual(window.command, { runId: window.command.runId, system: false, microphone: true, microphoneDeviceId: 'selected-mic' });
    assert.ok(window.configuration.show === false && window.configuration.skipTaskbar); assert.equal(f.requests.length, 0);
    const data = { type: 'audio', runId: window.command.runId, source: 'microphone', sampleRate: 16000, channels: 1, sequence: 0, data: new Uint8Array([255, 127, 0, 128]) };
    await window.message(data); const audio = f.events.find(event => event.type === 'audio'); assert.ok(audio?.type === 'audio'); assert.deepEqual(Buffer.from(audio.data, 'base64'), Buffer.from(data.data));
    await assert.rejects(window.message({ ...data, source: 'system' }), /source is disabled/);
    await assert.rejects(window.message({ ...data, sequence: 1 }, { ...window.webContents, id: 999 }), /Unauthorized/);
    await assert.rejects(window.message({ ...data, sequence: 1 }, window.webContents, false), /Unauthorized/);
    assert.deepEqual(await window.message({ ...data, runId: '00000000-0000-4000-8000-000000000099' }), { accepted: false });
    await f.capture.stop(); assert.equal(window.destroyed, true); assert.equal(f.handlers.size, 0);
  } finally { await f.cleanup(); }
});
test('capture permissions allow only the selected inputs from the isolated main frame and deny external requests', async () => {
  const f = await fixture();
  try {
    await f.capture.start({ ...DEFAULT_SETTINGS, captureSystem: false, captureScreen: false });
    const window = f.windows[0]; const ses = f.session(); const details = { isMainFrame: true, requestingUrl: window.webContents.getURL(), mediaTypes: ['audio'] };
    const permission = (type: string, value: any = details, sender = window.webContents) => { let result: boolean | undefined; ses.permissionRequest(sender, type, (allowed: boolean) => { result = allowed; }, value); return result; };
    assert.equal(permission('media'), true); assert.equal(permission('media', { ...details, mediaTypes: ['video'] }), false);
    assert.equal(permission('media', { ...details, isMainFrame: false }), false); assert.equal(permission('media', { ...details, requestingUrl: 'https://untrusted.test' }), false);
    assert.equal(permission('display-capture'), false); assert.equal(permission('notifications'), false);
    assert.equal(ses.permissionCheck(window.webContents, 'media', '', { isMainFrame: true, mediaType: 'audio' }), true);
    assert.equal(ses.permissionCheck(window.webContents, 'media', '', { isMainFrame: true, mediaType: 'video' }), false);
    assert.equal(ses.permissionCheck(null, 'media', '', { isMainFrame: true, mediaType: 'audio' }), false);
    for (const [url, expected] of [[pathToFileURL(join(window.configuration.webPreferences.preload, '..', 'capture.js')).href, false], ['https://example.com', true], ['file:///other/index.html', true]]) {
      let result: any; ses.network({ url }, (value: unknown) => { result = value; }); assert.equal(result.cancel, expected);
    }
  } finally { await f.cleanup(); }
});
test('Windows system-only capture grants loopback for the selected display and never microphone access', async () => {
  const f = await fixture();
  try {
    await f.capture.start({ ...DEFAULT_SETTINGS, displayId: '2', captureSystem: true, captureMicrophone: false, captureScreen: false });
    const window = f.windows[0]; const ses = f.session(); let streams: any;
    await new Promise<void>(resolve => ses.displayMedia({ frame: window.webContents.mainFrame, audioRequested: true, videoRequested: true }, (value: unknown) => { streams = value; resolve(); }));
    assert.equal(streams.audio, 'loopback'); assert.equal(streams.video.display_id, '2'); assert.equal(f.requests[0].thumbnailSize.width, 0);
    let permission: unknown; ses.permissionRequest(window.webContents, 'media', (allowed: boolean) => { permission = allowed; }, { isMainFrame: true, mediaTypes: ['audio'] }); assert.equal(permission, false);
    ses.displayMedia({ frame: { url: window.webContents.getURL() }, audioRequested: true }, (value: unknown) => { streams = value; }); assert.deepEqual(streams, {});
  } finally { await f.cleanup(); }
});
test('each Windows screenshot retrieves a fresh selected-display image and restores Watson window protection', async () => {
  const f = await fixture();
  try {
    const plain = new f.FakeWindow({ webPreferences: {} }); const protectedWindow = new f.FakeWindow({ webPreferences: {} }); protectedWindow.setContentProtection(true);
    const settings = { ...DEFAULT_SETTINGS, displayId: '2' };
    const first = await f.capture.screenshot(settings); const second = await f.capture.screenshot(settings);
    assert.notEqual(first.data, second.data); assert.match(Buffer.from(second.data, 'base64').toString(), /display-2/);
    assert.equal(plain.isContentProtected(), false); assert.equal(protectedWindow.isContentProtected(), true); assert.equal(f.capture.latestScreen, second);
    await assert.rejects(f.capture.screenshot({ ...settings, displayId: '9' }), /selected display is unavailable/); assert.equal(plain.isContentProtected(), false);
  } finally { await f.cleanup(); }
});
test('screen-only capture performs no microphone or loopback request and does not create an audio window', async () => {
  const f = await fixture();
  try { await f.capture.start({ ...DEFAULT_SETTINGS, captureScreen: true, captureSystem: false, captureMicrophone: false }); assert.equal(f.windows.length, 0); assert.equal(f.events.filter(event => event.type === 'screen').length, 1); const ready = f.events.find(event => event.type === 'status' && event.status === 'capturing'); assert.ok(ready?.type === 'status'); assert.equal(ready.microphone, false); assert.equal(ready.system, false); assert.equal(ready.screen, true); }
  finally { await f.cleanup(); }
});
test('a missing readiness acknowledgement times out and destroys the capture window and IPC handler', async () => {
  const f = await fixture({ ready: false, stopped: false });
  try { await assert.rejects(f.capture.start({ ...DEFAULT_SETTINGS, captureScreen: false }), /startup timed out/); assert.equal(f.windows[0].destroyed, true); assert.equal(f.handlers.size, 0); }
  finally { await f.cleanup(); }
});
test('a stalled stop acknowledgement is bounded, and unexpected source readiness fails startup', async () => {
  const f = await fixture({ stopped: false });
  try { await f.capture.start({ ...DEFAULT_SETTINGS, captureScreen: false }); const before = Date.now(); await f.capture.stop(); assert.ok(Date.now() - before < 500); assert.equal(f.windows[0].destroyed, true); }
  finally { await f.cleanup(); }
  const bad = await fixture({ wrongSources: true });
  try { await assert.rejects(bad.capture.start({ ...DEFAULT_SETTINGS, captureScreen: false }), /unexpected sources/); assert.equal(bad.windows[0].destroyed, true); }
  finally { await bad.cleanup(); }
});
test('an audio device error stops all enabled inputs instead of leaving a partial capture running', async () => {
  const f = await fixture();
  try { await f.capture.start({ ...DEFAULT_SETTINGS, captureScreen: false }); const window = f.windows[0]; await window.message({ type: 'error', runId: window.command.runId, message: 'Microphone device disconnected' }); await f.capture.stop(); assert.equal(window.destroyed, true); assert.ok(f.events.some(event => event.type === 'error' && /disconnected/.test(event.message))); assert.ok(f.events.some(event => event.type === 'status' && event.status === 'stopped' && event.running === false)); }
  finally { await f.cleanup(); }
});
test('the production platform guard never reports Windows capture available on macOS', () => {
  const capture = new WindowsCaptureManager(() => {}, { pagePath: join(process.cwd(), 'renderer/public/windows-capture/index.html'), preloadPath: join(process.cwd(), 'electron/windows-capture-preload.ts') });
  if (process.platform !== 'win32') assert.equal(capture.available, false);
});
test('microphone enumeration returns actual API records without fabricated labels and preserves the device-ID session', async () => {
  const f = await fixture();
  try {
    const first = await f.capture.listMicrophones(); assert.equal(first[0].id, 'default'); assert.equal(first[0].label, ''); assert.equal(first[1].id, 'real-device-id-fixture');
    assert.equal(f.windows[0].destroyed, true); assert.equal(f.handlers.size, 0); assert.equal(f.events.some(event => event.type === 'audio'), false);
    await f.capture.start({ ...DEFAULT_SETTINGS, captureScreen: false }); const second = await f.capture.listMicrophones(); assert.deepEqual(first, second); assert.equal(f.windows.length, 2);
    assert.deepEqual(f.partitions, ['persist:watson-capture', 'persist:watson-capture']); assert.equal(f.windows[1].destroyed, false);
  } finally { await f.cleanup(); }
});
test('malformed device lists reject and release their temporary utility window', async () => {
  const f = await fixture({ microphones: [{ id: 'device', label: 42 }] });
  try { await assert.rejects(f.capture.listMicrophones(), /invalid microphone device/); assert.equal(f.windows[0].destroyed, true); assert.equal(f.handlers.size, 0); }
  finally { await f.cleanup(); }
});
test('screenshot cleanup honors a privacy preference changed while the image request was in flight', async () => {
  let privacy = false; const f = await fixture({ contentProtection: () => privacy });
  try { const window = new f.FakeWindow({ webPreferences: {} }); const operation = f.capture.screenshot(DEFAULT_SETTINGS); privacy = true; await operation; assert.equal(window.isContentProtected(), true); }
  finally { await f.cleanup(); }
});
test('automatic Windows capture rejects unknown or denied microphone access before creating a window', async () => {
  for (const access of ['unknown', 'not-determined', 'denied']) {
    const f = await fixture({ microphoneAccess: () => access });
    try { await assert.rejects(f.capture.start({ ...DEFAULT_SETTINGS, captureSystem: false, captureScreen: false }, { requestPermissions: false }), /granted Windows microphone access/); assert.equal(f.windows.length, 0); assert.equal(f.requests.length, 0); }
    finally { await f.cleanup(); }
  }
});
test('automatic system capture validates the selected display without images and disables native pickers', async () => {
  const f = await fixture(); const settings = { ...DEFAULT_SETTINGS, captureMicrophone: false, captureScreen: false };
  try {
    await f.capture.start(settings, { requestPermissions: false }); assert.deepEqual(f.session().pickerOptions, { useSystemPicker: false }); assert.equal(f.requests[0].thumbnailSize.width, 0); await f.capture.stop();
    const windowsBefore = f.windows.length; await assert.rejects(f.capture.start({ ...settings, displayId: '9' }, { requestPermissions: false }), /selected display is unavailable/); assert.equal(f.windows.length, windowsBefore);
  } finally { await f.cleanup(); }
});
test('automatic screen capture refuses unknown access before capture and uses a valid source without audio requests', async () => {
  let access = 'unknown'; const f = await fixture({ screenAccess: () => access }); const settings = { ...DEFAULT_SETTINGS, displayId: '2', captureMicrophone: false, captureSystem: false, captureScreen: true };
  try { await assert.rejects(f.capture.start(settings, { requestPermissions: false }), /granted Windows capture access/); assert.equal(f.requests.length, 0); assert.equal(f.windows.length, 0); access = 'granted'; await f.capture.start(settings, { requestPermissions: false }); assert.equal(f.windows.length, 0); assert.equal(f.requests[0].thumbnailSize.width, 0); }
  finally { await f.cleanup(); }
});
test('automatic capture refuses an unavailable source before opening its audio window', async () => {
  const f = await fixture(); const settings = { ...DEFAULT_SETTINGS, displayId: '2', captureMicrophone: false, captureSystem: false, captureScreen: true };
  try { await assert.rejects(f.capture.start({ ...settings, displayId: '9', captureSystem: true }, { requestPermissions: false }), /selected display is unavailable/); assert.equal(f.windows.length, 0); }
  finally { await f.cleanup(); }
});
test('automatic microphone requests recheck access if privacy permission is revoked after preflight', async () => {
  let access = 'granted'; const f = await fixture({ microphoneAccess: () => access });
  try {
    await f.capture.start({ ...DEFAULT_SETTINGS, captureSystem: false, captureScreen: false }, { requestPermissions: false }); access = 'denied';
    const window = f.windows[0], ses = f.session(); assert.equal(ses.permissionCheck(window.webContents, 'media', '', { isMainFrame: true, mediaType: 'audio' }), false);
    let result: unknown; ses.permissionRequest(window.webContents, 'media', (allowed: boolean) => { result = allowed; }, { isMainFrame: true, mediaTypes: ['audio'] }); assert.equal(result, false);
  } finally { await f.cleanup(); }
});
test('concurrent automatic starts cannot replace the active capture window during asynchronous preflight', async () => {
  const f = await fixture(); const settings = { ...DEFAULT_SETTINGS, captureMicrophone: false, captureScreen: false };
  try {
    const results = await Promise.allSettled([f.capture.start(settings, { requestPermissions: false }), f.capture.start(settings, { requestPermissions: false })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.filter(result => result.status === 'rejected').length, 1); assert.equal(f.windows.length, 1);
  } finally { await f.cleanup(); }
});
