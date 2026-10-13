import { app, BrowserWindow, desktopCapturer, ipcMain, screen, session, systemPreferences } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AudioSource, Settings } from '../shared/types';
import type { NativeEvent } from './capture';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { captureSenderAllowed, captureTimeout, parseWindowsCaptureEvent, PCMIngress, selectDisplaySource } from './windows-capture-protocol';

type ElectronCaptureRuntime = { BrowserWindow: typeof BrowserWindow; desktopCapturer: typeof desktopCapturer; ipcMain: typeof ipcMain; screen: typeof screen; session: typeof session; systemPreferences?: Pick<typeof systemPreferences, 'getMediaAccessStatus'> };
export interface WindowsCaptureStartOptions { requestPermissions?: boolean; }
export interface WindowsCaptureOptions {
  pagePath?: string; preloadPath?: string;
  contentProtection?: () => boolean;
  /** Dependency injection is only for lifecycle tests; production always uses the host platform. */
  runtime?: ElectronCaptureRuntime; platform?: NodeJS.Platform; startupTimeoutMs?: number; stopTimeoutMs?: number;
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Startup can fail before a caller starts awaiting the renderer acknowledgement.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
interface Run {
  id: string; settings: Settings; started: ReturnType<typeof deferred<void>>; stopped: ReturnType<typeof deferred<void>>;
  sources: Map<AudioSource, PCMIngress>; failed: boolean; stopping: boolean; enumerating?: boolean; requestPermissions?: boolean;
}
export interface WindowsMicrophoneInfo { id: string; label: string; isDefault?: boolean; }

/** Windows uses Chromium's microphone and WASAPI loopback through a dedicated capture renderer. */
export class WindowsCaptureManager {
  latestScreen?: Extract<NativeEvent, { type: 'screen' }>;
  private window?: BrowserWindow; private captureSession?: Electron.Session; private run?: Run;
  private readonly runtime: ElectronCaptureRuntime; private readonly platform: NodeJS.Platform;
  private readonly pagePath: string; private readonly preloadPath: string; private readonly pageUrl: string;
  private readonly channel = `watson:windows-capture:${randomUUID()}`;
  private ready = deferred<void>(); private stopOperation?: Promise<void>; private screenshotTail: Promise<unknown> = Promise.resolve();
  private microphoneListTail: Promise<unknown> = Promise.resolve();
  private screenTimer?: NodeJS.Timeout; private screenBusy = false; private lastOverrunAt = 0;
  constructor(private onEvent: (event: NativeEvent) => void, private options: WindowsCaptureOptions = {}) {
    this.runtime = options.runtime ?? { BrowserWindow, desktopCapturer, ipcMain, screen, session };
    this.platform = options.platform ?? process.platform;
    this.pagePath = options.pagePath ?? join(app.getAppPath(), app.isPackaged ? 'dist' : 'renderer/public', 'windows-capture/index.html');
    this.preloadPath = options.preloadPath ?? join(__dirname, 'windows-capture-preload.js');
    this.pageUrl = pathToFileURL(this.pagePath).href;
  }
  get available() { return this.platform === 'win32' && existsSync(this.pagePath) && existsSync(this.preloadPath); }
  private mediaGranted(type: 'microphone' | 'screen') { try { return (this.runtime.systemPreferences ?? systemPreferences).getMediaAccessStatus(type) === 'granted'; } catch { return false; } }
  private microphoneGranted() { return this.mediaGranted('microphone'); }
  private async preflightWithoutPrompts(settings: Settings) {
    if (settings.captureMicrophone && !this.microphoneGranted()) throw new Error('Automatic microphone capture needs granted Windows microphone access. Run a manual microphone test and check Windows privacy settings first.');
    if (!settings.captureSystem && !settings.captureScreen) return;
    if (!this.mediaGranted('screen')) throw new Error('Automatic screen/system capture needs granted Windows capture access. Complete capture setup manually first.');
    // Windows has no per-app screen consent; validate a real source without a chooser or image.
    const sources = await captureTimeout(this.runtime.desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }), 8000, 'Automatic screen/system capture preflight timed out. Complete capture setup manually first.');
    selectDisplaySource(sources, settings.displayId, String(this.runtime.screen.getPrimaryDisplay().id));
  }
  private authorized(event: Electron.IpcMainInvokeEvent) {
    const window = this.window;
    return !!window && !window.isDestroyed() && captureSenderAllowed({ id: event.sender.id, url: event.sender.getURL(), isMainFrame: event.senderFrame === event.sender.mainFrame }, { id: window.webContents.id, url: this.pageUrl });
  }
  private fail(run: Run, message: string) {
    if (this.run !== run || run.stopping || run.failed) return;
    run.failed = true; run.started.reject(new Error(message)); this.ready.reject(new Error(message));
    this.onEvent({ type: 'error', message }); void this.stop();
  }
  private createCaptureWindow(run: Run) {
    const runtime = this.runtime;
    // Chromium salts deviceId per Session. This isolated stable profile preserves saved input IDs.
    const captureSession = runtime.session.fromPartition('persist:watson-capture', { cache: false });
    this.captureSession = captureSession; this.ready = deferred<void>();
    const window = new runtime.BrowserWindow({ show: false, width: 1, height: 1, frame: false, skipTaskbar: true, focusable: false, webPreferences: { preload: this.preloadPath, session: captureSession, additionalArguments: [`--watson-capture-channel=${this.channel}`], contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
    this.window = window; window.setContentProtection(true);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-frame-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('render-process-gone', (_event, details) => this.fail(run, `Windows capture renderer exited (${details.reason}). Restart the session.`));
    window.webContents.on('unresponsive', () => this.fail(run, 'Windows capture renderer stopped responding. Restart the session.'));
    window.once('closed', () => { if (this.window === window) this.window = undefined; this.fail(run, 'Windows capture window closed unexpectedly. Restart the session.'); });
    // No network, navigation, cameras, or external permission requests in this Session.
    captureSession.webRequest.onBeforeRequest((details, callback) => {
      const url = details.url;
      const allowed = ['index.html', 'capture.js', 'worklet.js', 'pcm-core.js'].some(name => url === pathToFileURL(join(this.pagePath, '..', name)).href);
      callback({ cancel: !allowed });
    });
    captureSession.setPermissionCheckHandler((contents, permission, _origin, details) => {
      return !!contents && contents === window.webContents && contents.getURL() === this.pageUrl && details.isMainFrame && (details.requestingUrl === undefined || details.requestingUrl === this.pageUrl) && permission === 'media' && details.mediaType === 'audio' && (run.settings.captureMicrophone || !!run.enumerating) && !run.stopping && (run.requestPermissions !== false || this.microphoneGranted());
    });
    captureSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const media = details as Electron.MediaAccessPermissionRequest;
      const trusted = contents === window.webContents && contents.getURL() === this.pageUrl && details.isMainFrame && (details.requestingUrl === undefined || details.requestingUrl === this.pageUrl) && !run.stopping;
      const allowed = permission === 'media' && run.settings.captureMicrophone && !!media.mediaTypes?.length && media.mediaTypes.every(type => type === 'audio') && (run.requestPermissions !== false || this.microphoneGranted());
      callback(trusted && (allowed || (permission === 'display-capture' && run.settings.captureSystem && (run.requestPermissions !== false || this.mediaGranted('screen')))));
    });
    captureSession.setDisplayMediaRequestHandler((request, callback) => {
      const trusted = request.frame === window.webContents.mainFrame && request.frame?.url === this.pageUrl && request.audioRequested && run.settings.captureSystem && !run.stopping && this.run === run && (run.requestPermissions !== false || this.mediaGranted('screen'));
      if (!trusted) { callback({}); return; }
      void captureTimeout(runtime.desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }), 8000, 'Windows display selection timed out').then(sources => {
        if (run.stopping || this.run !== run) { callback({}); return; }
        const selected = selectDisplaySource(sources, run.settings.displayId, String(runtime.screen.getPrimaryDisplay().id));
        callback({ video: selected, audio: 'loopback' });
      }).catch(error => { callback({}); this.fail(run, error.message); });
    }, { useSystemPicker: false });
    runtime.ipcMain.handle(this.channel, async (event, raw: unknown) => {
      if (!this.authorized(event)) throw new Error('Unauthorized capture IPC sender');
      const message = parseWindowsCaptureEvent(raw);
      if (message.type === 'ready') { this.ready.resolve(); return { accepted: true }; }
      if (message.runId !== run.id || this.run !== run) return { accepted: false };
      if (message.type === 'stopped') { run.stopped.resolve(); return { accepted: true }; }
      if (run.stopping || run.failed) return { accepted: false };
      if (message.type === 'started') {
        if (message.system !== run.settings.captureSystem || message.microphone !== run.settings.captureMicrophone) throw new Error('Capture renderer enabled unexpected sources');
        run.started.resolve();
      } else if (message.type === 'audio') {
        const ingress = run.sources.get(message.source); if (!ingress) throw new Error('Capture source is disabled');
        ingress.accept(message.sequence, message.data.byteLength);
        this.onEvent({ type: 'audio', source: message.source, sampleRate: 16000, channels: 1, data: Buffer.from(message.data).toString('base64') });
      } else if (message.type === 'error') this.fail(run, message.message);
      else if (message.type === 'overrun') {
        if (!run.sources.has(message.source)) throw new Error('Capture source is disabled');
        if (Date.now() - this.lastOverrunAt > 5000) { this.lastOverrunAt = Date.now(); this.onEvent({ type: 'status', message: `${message.source === 'system' ? 'System' : 'Microphone'} audio queue dropped ${message.dropped} frames while the app was busy; capture continues.` }); }
      }
      return { accepted: true };
    });
    return window;
  }
  async start(settings: Settings, options: WindowsCaptureStartOptions = {}) {
    if (!this.available) throw new Error('Windows capture is unavailable. Build Watson on Windows before starting live capture.');
    await this.microphoneListTail.catch(() => {});
    if (this.run || this.stopOperation) throw new Error('Capture is already running or stopping');
    if (!settings.captureSystem && !settings.captureMicrophone && !settings.captureScreen) throw new Error('Enable microphone, system audio, or screen capture in Settings.');
    if (options.requestPermissions === false) await this.preflightWithoutPrompts(settings);
    await this.microphoneListTail.catch(() => {});
    if (this.run || this.stopOperation) throw new Error('Capture is already running or stopping');
    this.latestScreen = undefined; const run: Run = { id: randomUUID(), settings: { ...settings }, started: deferred<void>(), stopped: deferred<void>(), sources: new Map(), failed: false, stopping: false, requestPermissions: options.requestPermissions }; this.run = run;
    for (const source of ['system', 'microphone'] as const) if (source === 'system' ? settings.captureSystem : settings.captureMicrophone) run.sources.set(source, new PCMIngress());
    try {
      if (run.sources.size) {
        const window = this.createCaptureWindow(run);
        const start = (async () => {
          await window.loadFile(this.pagePath); await this.ready.promise;
          if (run.stopping || this.run !== run) throw new Error('Windows capture startup was cancelled');
          const command = { runId: run.id, system: settings.captureSystem, microphone: settings.captureMicrophone, microphoneDeviceId: settings.microphoneDeviceId };
          // The session Start action supplies the user activation required by getDisplayMedia.
          void window.webContents.executeJavaScript(`window.watsonStartCapture(${JSON.stringify(command)})`, true).catch(error => this.fail(run, error.message));
          await run.started.promise;
        })();
        await captureTimeout(start, this.options.startupTimeoutMs ?? 15000, 'Windows audio capture startup timed out. Check Windows privacy settings and the selected devices.');
      }
      if (settings.captureScreen) await this.screenshot(settings);
      if (run.stopping || this.run !== run) throw new Error('Windows capture startup was cancelled');
      this.onEvent({ type: 'status', status: 'capturing', running: true, system: settings.captureSystem, microphone: settings.captureMicrophone, screen: settings.captureScreen });
      if (settings.captureScreen) this.screenTimer = setInterval(() => {
        if (this.screenBusy || this.run !== run || run.stopping) return;
        this.screenBusy = true; void this.screenshot(settings).catch(error => this.fail(run, `Windows screen capture: ${error.message}`)).finally(() => { this.screenBusy = false; });
      }, 5000);
    } catch (error) { await this.stop(); throw error; }
  }
  async stop() {
    if (this.stopOperation) return this.stopOperation;
    const run = this.run; if (!run) return;
    run.stopping = true; run.started.reject(new Error('Windows capture stopped')); this.ready.reject(new Error('Windows capture stopped'));
    if (this.screenTimer) clearInterval(this.screenTimer); this.screenTimer = undefined;
    this.stopOperation = (async () => {
      const window = this.window;
      if (window && !window.isDestroyed()) {
        window.webContents.send(`${this.channel}:stop`, { runId: run.id });
        await captureTimeout(run.stopped.promise, this.options.stopTimeoutMs ?? 2000, 'Windows capture stop timed out').catch(() => {});
        if (!window.isDestroyed()) window.destroy();
      }
      this.runtime.ipcMain.removeHandler(this.channel);
      this.captureSession?.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      this.captureSession?.setPermissionCheckHandler(() => false);
      this.captureSession?.setDisplayMediaRequestHandler((_request, callback) => callback({}));
      this.captureSession = undefined; this.window = undefined;
      if (this.run === run) this.run = undefined;
      this.onEvent({ type: 'status', status: 'stopped', running: false, system: false, microphone: false, screen: false });
    })();
    try { await this.stopOperation; } finally { this.stopOperation = undefined; }
  }
  async listMicrophones(): Promise<WindowsMicrophoneInfo[]> {
    if (!this.available) throw new Error('Windows microphone enumeration is unavailable on this platform.');
    const operation = this.microphoneListTail.catch(() => {}).then(async () => {
      if (this.stopOperation) await this.stopOperation;
      let owner: WindowsCaptureManager = this; let temporary: WindowsCaptureManager | undefined;
      if (!this.window || this.window.isDestroyed()) {
        temporary = new WindowsCaptureManager(() => {}, { ...this.options, pagePath: this.pagePath, preloadPath: this.preloadPath, runtime: this.runtime, platform: this.platform }); owner = temporary;
        const run: Run = { id: randomUUID(), settings: { ...DEFAULT_SETTINGS, captureSystem: false, captureMicrophone: false, captureScreen: false }, started: deferred<void>(), stopped: deferred<void>(), sources: new Map(), failed: false, stopping: false, enumerating: true }; temporary.run = run;
        const window = temporary.createCaptureWindow(run);
        try { await captureTimeout(window.loadFile(this.pagePath).then(() => temporary!.ready.promise), this.options.startupTimeoutMs ?? 15000, 'Windows microphone list startup timed out'); }
        catch (error) { await temporary.stop(); throw error; }
      }
      const run = owner.run; if (!run || run.stopping) { if (temporary) await temporary.stop(); throw new Error('Capture changed while listing microphones. Refresh the microphone list.'); } run.enumerating = true;
      try {
        const raw: unknown = await captureTimeout(owner.window!.webContents.executeJavaScript('window.watsonListMicrophones()', true), 8000, 'Windows microphone enumeration timed out');
        if (!Array.isArray(raw) || raw.length > 1000) throw new Error('Windows returned an invalid microphone list');
        return raw.map((device: unknown) => {
          if (!device || typeof device !== 'object' || !('id' in device) || typeof device.id !== 'string' || !device.id || device.id.length > 1000 || !('label' in device) || typeof device.label !== 'string' || device.label.length > 2000) throw new Error('Windows returned an invalid microphone device');
          return { id: device.id, label: device.label, isDefault: 'isDefault' in device && device.isDefault === true };
        });
      } finally { run.enumerating = false; if (temporary) await temporary.stop(); }
    });
    this.microphoneListTail = operation; return operation;
  }
  async screenshot(settings: Settings): Promise<Extract<NativeEvent, { type: 'screen' }>> {
    if (!this.available) throw new Error('Windows screenshot capture is unavailable on this platform.');
    // Serialize temporary content protection to avoid restoring another request's state.
    const operation = this.screenshotTail.catch(() => {}).then(async () => {
      const runtime = this.runtime; const displays = runtime.screen.getAllDisplays();
      const display = settings.displayId ? displays.find(item => String(item.id) === settings.displayId) : runtime.screen.getPrimaryDisplay();
      if (!display) throw new Error('The selected display is unavailable. Choose another display in Settings.');
      const protectedWindows = runtime.BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());
      const previous = protectedWindows.map(window => ({ window, protected: window.isContentProtected() }));
      try {
        for (const { window } of previous) window.setContentProtection(true);
        // Display affinity is applied at desktop composition; it is not synchronous.
        await new Promise(resolve => setTimeout(resolve, 120));
        const scale = Math.min(1, 1600 / Math.max(display.size.width, display.size.height));
        const sources = await captureTimeout(runtime.desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.max(1, Math.round(display.size.width * scale)), height: Math.max(1, Math.round(display.size.height * scale)) }, fetchWindowIcons: false }), 10000, 'Windows screen capture timed out');
        const selected = selectDisplaySource(sources, String(display.id), String(runtime.screen.getPrimaryDisplay().id));
        if (selected.thumbnail.isEmpty()) throw new Error('Windows returned an empty screen frame. Check capture access.');
        const data = selected.thumbnail.toJPEG(78); if (!data.length) throw new Error('Windows returned an empty screen image');
        const frame: Extract<NativeEvent, { type: 'screen' }> = { type: 'screen', mimeType: 'image/jpeg', data: data.toString('base64'), capturedAt: new Date().toISOString() };
        this.latestScreen = frame; this.onEvent(frame); return frame;
      } finally { for (const { window, protected: value } of previous) if (!window.isDestroyed()) window.setContentProtection(window === this.window ? true : this.options.contentProtection?.() ?? value); }
    });
    this.screenshotTail = operation; return operation;
  }
}
