import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { _electron } = require('playwright');
const workspace = resolve(process.env.WATSON_SMOKE_WORKSPACE || process.cwd());
const artifactRoot = join(workspace, 'evidence');
const fixtureRoot = join(artifactRoot, 'runtime-fixtures');
const shotRoot = join(artifactRoot, 'screenshots');
const userData = join(artifactRoot, `runtime-user-data-smoke-${new Date().toISOString().replace(/[^0-9]/g, '')}`);
await Promise.all([fixtureRoot, shotRoot, userData].map(path => mkdir(path, { recursive: true })));
const report = {
  startedAt: new Date().toISOString(), command: 'node evidence/run-desktop-smoke.mjs',
  executable: process.env.WATSON_SMOKE_EXECUTABLE || join(workspace, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  application: 'Real Electron Watson app with production renderer and native IPC bridge',
  isolatedUserData: userData, checks: [], screenshots: [], processes: [],
  boundaries: {
    browserFixtureAdapterUsed: false, audioRecordingRequested: false, screenCaptureRequested: false,
    realProviderRequestsRequested: false, providerEnvironmentRemoved: true,
    externalNavigationIntercepted: true, emailSent: false, crossApplicationCaptureExclusionProved: false,
    filePickerSelectionIntercepted: true,
    mockKeychainUsed: true, realOSCredentialVaultVerified: false,
  },
};
let app;
let dashboard;
let overlay;
let sessionId;
const state = () => dashboard.evaluate(() => window.watson.invoke('bootstrap'));
const invoke = (command, input) => dashboard.evaluate(({ command, input }) => window.watson.invoke(command, input), { command, input });
const check = async (name, action) => {
  const start = Date.now();
  try { const evidence = await action(); report.checks.push({ name, status: 'pass', milliseconds: Date.now() - start, ...(evidence ? { evidence } : {}) }); console.log(`PASS ${name}`); return true; }
  catch (error) { report.checks.push({ name, status: 'fail', milliseconds: Date.now() - start, error: String(error?.message || error).slice(0, 1400) }); console.log(`FAIL ${name}: ${String(error?.message || error).slice(0, 220)}`); return false; }
};
const shot = async (page, name) => {
  const path = join(shotRoot, `${name}.png`);
  await page.screenshot({ path, omitBackground: page === overlay });
  const bytes = await readFile(path);
  report.screenshots.push({ path: `evidence/screenshots/${name}.png`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, source: 'Actual Electron renderer screenshot' });
};
const nav = name => dashboard.locator('.sidebar').getByRole('button', { name: name === 'My sessions' ? /^My sessions(?:\s+\d+)?$/ : name, exact: true }).click();
const findOverlay = async () => {
  for (let i = 0; i < 40; i++) {
    const candidate = app.windows().find(page => page.url().includes('#overlay'));
    if (candidate) { await candidate.locator('.overlay-toolbar').waitFor(); return candidate; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Overlay page not available on the live Electron application handle');
};
const launch = async () => {
  app = await _electron.launch({
    executablePath: report.executable, args: [...(process.env.WATSON_SMOKE_PACKAGED ? [] : ['.']), '--use-mock-keychain'], cwd: workspace,
    env: { ...process.env, OPENAI_API_KEY: '', DEEPGRAM_API_KEY: '', WATSON_USER_DATA_DIR: userData, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }, timeout: 30000,
  });
  report.processes.push({ pid: app.process().pid, launchedAt: new Date().toISOString(), closed: false });
  for (let index = 0; index < 100; index++) {
    dashboard = app.windows().find(page => page.url().includes('#dashboard'));
    if (dashboard) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!dashboard) throw new Error('Dashboard page not available on the live Electron application handle');
  dashboard.setDefaultTimeout(6000);
  await dashboard.getByRole('heading', { name: 'Your space to think.' }).waitFor({ timeout: 30000 });
  if (await dashboard.getByRole('dialog', { name: 'Welcome to Watson' }).count()) await dashboard.getByRole('dialog', { name: 'Welcome to Watson' }).getByRole('button', { name: 'Explore on my own', exact: true }).click();
  await app.evaluate(({ shell }) => {
    globalThis.__watsonSmokeExternalUrls = [];
    shell.openExternal = async url => { const parsed = new URL(url); globalThis.__watsonSmokeExternalUrls.push({ hostname: parsed.hostname, pathname: parsed.pathname, queryKeys: [...parsed.searchParams.keys()] }); };
  });
  overlay = await findOverlay(); overlay.setDefaultTimeout(6000);
};
const close = async () => { if (!app) return; await app.close(); report.processes.at(-1).closed = true; report.processes.at(-1).closedAt = new Date().toISOString(); app = undefined; };
const picker = path => app.evaluate(({ dialog }, fixturePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixturePath] }); }, path);
const nativeOverlay = () => app.evaluate(({ BrowserWindow }) => {
  const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('#overlay'));
  return { bounds: window.getBounds(), opacity: window.getOpacity(), protected: window.isContentProtected(), visible: window.isVisible(), alwaysOnTop: window.isAlwaysOnTop() };
});
try {
  await launch();
  await check('dashboard uses native bridge and no browser fixture banner', async () => {
    const snapshot = await state(); assert.equal(snapshot.platform, 'darwin'); assert.equal(snapshot.credentials.openai, false); assert.equal(snapshot.credentials.deepgram, false);
    assert.equal(snapshot.settings.contentProtection, true);
    const protection = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => /#(?:dashboard|overlay)/.test(window.webContents.getURL())).map(window => ({ view: window.webContents.getURL().split('#').at(-1), protected: window.isContentProtected() })));
    assert.equal(protection.length, 2); assert.ok(protection.every(window => window.protected));
    assert.equal(await dashboard.locator('.preview-banner').count(), 0); await shot(dashboard, 'desktop-overview');
    return { platform: snapshot.platform, version: snapshot.version, providerKeysConfigured: false, permissions: snapshot.permissions, freshProfileCaptureExclusionDefault: true, nativeWindowProtection: protection };
  });
  const started = await check('UI starts a clearly labeled demo session', async () => {
    await dashboard.locator('.sidebar-start').click(); const modal = dashboard.getByRole('dialog', { name: 'Start a session' });
    await modal.getByLabel('Session title').fill('Runtime demo conversation'); await modal.getByRole('button', { name: /Try a demo/ }).click(); await modal.getByRole('button', { name: 'Start demo session', exact: true }).click();
    await dashboard.getByRole('heading', { name: 'Runtime demo conversation', exact: true }).waitFor();
    const snapshot = await state(); sessionId = snapshot.activeSessionId; const session = snapshot.sessions.find(session => session.id === sessionId);
    assert.equal(session.demo, true); assert.equal(snapshot.capture.running, false); assert.ok(session.transcript.length > 0); await shot(dashboard, 'desktop-demo-live');
    return { sessionId, demo: true, realCaptureRunning: false, fixtureTranscriptLines: session.transcript.length };
  });
  if (started) {
    await check('overlay begins as a compact native 110px assistant', async () => { const native = await nativeOverlay(); assert.equal(native.bounds.height, 110); assert.equal(await overlay.locator('.compact-overlay-row').count(), 1); await shot(overlay, 'desktop-overlay-compact'); return native; });
    await check('assist response expands native overlay and displays demo grounding', async () => { await overlay.getByRole('button', { name: /Get help/ }).click(); await overlay.locator('.answer-card').filter({ hasText: 'Demo · fixture response' }).waitFor(); const native = await nativeOverlay(); assert.ok(native.bounds.height > 110); await shot(overlay, 'desktop-overlay-expanded'); return { native, responseTextFixture: true }; });
    await check('UI pauses and resumes the session', async () => { await dashboard.getByRole('button', { name: 'Pause capture', exact: true }).click(); assert.equal((await state()).sessionPaused, true); await dashboard.getByRole('button', { name: 'Resume capture', exact: true }).click(); assert.equal((await state()).sessionPaused, false); });
    await check('typed chat and quick response actions use real engine demo IPC', async () => { const before = (await state()).sessions.find(session => session.id === sessionId).answers.length; await dashboard.getByRole('textbox', { name: 'Ask Watson', exact: true }).fill('What should I ask next?'); await dashboard.getByRole('textbox', { name: 'Ask Watson', exact: true }).press('Enter'); await dashboard.locator('.answer-card').filter({ hasText: 'What should I ask next?' }).waitFor(); await dashboard.getByRole('button', { name: 'What to say', exact: true }).click(); await dashboard.getByRole('button', { name: 'Recap', exact: true }).click(); const answers = (await state()).sessions.find(session => session.id === sessionId).answers; assert.ok(answers.length >= before + 3); assert.ok(answers.every(answer => answer.status === 'complete')); });
    await check('clear assistant responses preserves transcript', async () => { const before = (await state()).sessions.find(session => session.id === sessionId).transcript.length; await overlay.getByRole('button', { name: 'Clear assistant responses', exact: true }).click(); const session = (await state()).sessions.find(session => session.id === sessionId); assert.equal(session.answers.length, 0); assert.equal(session.transcript.length, before); });
    await check('UI ends and saves the session with automatic demo notes', async () => { await dashboard.getByRole('button', { name: 'End session', exact: true }).click(); await dashboard.getByRole('button', { name: 'Edit notes', exact: true }).waitFor(); const snapshot = await state(); const session = snapshot.sessions.find(session => session.id === sessionId); assert.equal(snapshot.activeSessionId, undefined); assert.ok(session.endedAt); assert.match(session.notes, /Demo · fixture response/); });
    await check('rename tags pin and notes edit persist through native IPC', async () => { await dashboard.getByRole('button', { name: 'Rename & tags', exact: true }).click(); const modal = dashboard.getByRole('dialog', { name: 'Rename & organize' }); await modal.getByLabel('Session title').fill('Verified runtime notes'); await modal.getByLabel('Tags').fill('Runtime, Product'); await modal.getByRole('button', { name: 'Save changes', exact: true }).click(); await dashboard.getByRole('button', { name: 'Pin session', exact: true }).click(); await dashboard.getByRole('button', { name: 'Edit notes', exact: true }).click(); await dashboard.getByLabel('Edit session notes').fill('# Verified notes\n\nThe demo session was reviewed.\n\n## Actions\n- Review the rollout plan.'); await dashboard.getByRole('button', { name: 'Save notes', exact: true }).click(); const session = (await state()).sessions.find(session => session.id === sessionId); assert.equal(session.title, 'Verified runtime notes'); assert.deepEqual(session.tags, ['Runtime', 'Product']); assert.equal(session.pinned, true); assert.match(session.notes, /Verified notes/); await shot(dashboard, 'desktop-session-notes'); });
    await check('follow-up draft opens Gmail compose without sending', async () => { await dashboard.getByRole('tab', { name: 'Follow-up', exact: true }).click(); await dashboard.getByRole('button', { name: 'Draft follow-up', exact: true }).click(); await dashboard.getByLabel('Follow-up draft').fill('Subject: Reviewed next steps\n\nThanks for the discussion. Please review the rollout plan.'); await dashboard.getByRole('button', { name: 'Save draft', exact: true }).click(); await dashboard.getByRole('button', { name: 'Open Gmail draft', exact: true }).click(); const urls = await app.evaluate(() => globalThis.__watsonSmokeExternalUrls); const gmail = urls.find(url => url.hostname === 'mail.google.com'); assert.ok(gmail); assert.ok(gmail.queryKeys.includes('body')); return { externalNavigationIntercepted: true, hostname: gmail.hostname, composeQueryKeys: gmail.queryKeys, emailSent: false }; });
    await check('session Markdown and JSON exports write actual local files', async () => { const target = join(fixtureRoot, 'runtime-session-export.md'); await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, target); await dashboard.getByRole('button', { name: 'Export', exact: true }).click(); await dashboard.getByRole('status').filter({ hasText: 'Session exported' }).waitFor(); const content = await readFile(target, 'utf8'); assert.match(content, /Verified runtime notes/); assert.match(content, /Verified notes/); const jsonPath = join(fixtureRoot, 'runtime-session-export.json'); await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, jsonPath); await dashboard.locator('.detail-panel footer').getByRole('button', { name: 'Export JSON', exact: true }).click(); let exported; const deadline = Date.now() + 5000; while (Date.now() < deadline) { try { exported = JSON.parse(await readFile(jsonPath, 'utf8')); if (exported.id === sessionId) break; } catch {} await new Promise(resolve => setTimeout(resolve, 25)); } assert.equal(exported?.id, sessionId); assert.equal(exported.notes, (await state()).sessions.find(session => session.id === sessionId).notes); assert.equal(exported.encryptedKeys, undefined); return { path: 'evidence/runtime-fixtures/runtime-session-export.md', bytes: Buffer.byteLength(content), jsonPath: 'evidence/runtime-fixtures/runtime-session-export.json', jsonExportVerified: true, providerKeysExported: false }; });
    await check('history search uses stored session text', async () => { await dashboard.getByRole('button', { name: 'All sessions', exact: true }).click(); await dashboard.getByLabel('Search sessions').fill('Verified notes'); await dashboard.getByRole('button').filter({ hasText: 'Verified runtime notes' }).waitFor(); await dashboard.getByLabel('Search sessions').fill(''); });
    await check('global history chat reports missing credentials without a fake session', async () => { const before = (await state()).sessions.length; await dashboard.getByLabel('Ask across your sessions').fill('What were my next steps?'); await dashboard.getByRole('button', { name: 'Ask Watson', exact: true }).click(); await dashboard.getByRole('alert').filter({ hasText: /OpenAI.*key/i }).waitFor(); assert.equal((await state()).sessions.length, before); });
  }
  await check('knowledge add and native-file import preserve real document text', async () => { await nav('Knowledge'); await dashboard.getByRole('button', { name: 'Add text', exact: true }).click(); const modal = dashboard.getByRole('dialog', { name: 'Add to your knowledge' }); await modal.getByLabel('Document title').fill('Runtime product context'); await modal.getByLabel('Content', { exact: true }).fill('Our rollout goal is a simple measurable first step, followed by a review.'); await modal.getByRole('button', { name: 'Add knowledge', exact: true }).click(); const imported = join(fixtureRoot, 'runtime-reference.txt'); await writeFile(imported, 'Runtime reference: decisions should include an owner and a success metric.'); await picker(imported); await dashboard.getByRole('button', { name: 'Import files', exact: true }).click(); const snapshot = await state(); assert.ok(snapshot.knowledge.some(doc => doc.title === 'Runtime product context')); assert.ok(snapshot.knowledge.some(doc => doc.text.includes('Runtime reference:'))); await shot(dashboard, 'desktop-knowledge'); });
  await check('custom mode links knowledge and notes template', async () => { await nav('Custom modes'); await dashboard.getByRole('button', { name: 'Create a mode', exact: true }).click(); const modal = dashboard.getByRole('dialog', { name: 'Create a custom mode' }); await modal.getByLabel('Mode name').fill('Runtime review'); await modal.getByLabel('Assistant instructions').fill('Help identify a clear next step and a concrete owner.'); await modal.getByLabel('Notes template').fill('Decisions\nOwners\nNext steps'); await modal.getByRole('checkbox', { name: 'Runtime product context', exact: true }).check(); await modal.getByRole('button', { name: 'Save mode', exact: true }).click(); const mode = (await state()).modes.find(mode => mode.name === 'Runtime review'); assert.ok(mode); assert.equal(mode.documentIds.length, 1); assert.match(mode.noteTemplate, /Owners/); await shot(dashboard, 'desktop-modes'); });
  await check('ICS calendar import and briefing credential error work without an active session', async () => { const start = new Date(Date.now() + 3600000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); const end = new Date(Date.now() + 7200000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); const path = join(fixtureRoot, 'runtime-calendar.ics'); await writeFile(path, `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:watson-runtime-event\r\nDTSTART:${start}\r\nDTEND:${end}\r\nSUMMARY:Runtime planning review\r\nDESCRIPTION:Review the rollout owner and success metric.\r\nATTENDEE;CN=Runtime reviewer:mailto:reviewer@example.invalid\r\nURL:https://meet.google.com/abc-defg-hij\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`); await nav('Calendar'); await picker(path); await dashboard.getByRole('button', { name: 'Import calendar', exact: true }).click(); await dashboard.getByRole('heading', { name: 'Runtime planning review', exact: true }).waitFor(); const before = (await state()).sessions.length; await dashboard.getByRole('button', { name: 'Prepare brief', exact: true }).click(); await dashboard.getByRole('alert').filter({ hasText: /OpenAI.*key/i }).waitFor(); assert.equal((await state()).sessions.length, before); await shot(dashboard, 'desktop-calendar'); });
  await check('settings save a custom shortcut and register it with Electron', async () => { await nav('Settings'); await dashboard.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click(); await dashboard.getByLabel('Show or hide assistant').fill('CommandOrControl+Alt+9'); await dashboard.getByRole('button', { name: 'Save shortcuts', exact: true }).click(); assert.equal((await state()).settings.shortcuts.toggleOverlay, 'CommandOrControl+Alt+9'); const registered = await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Alt+9')); assert.equal(registered, true); });
  await check('content protection and opacity reflect native window state once', async () => { await dashboard.getByRole('button', { name: 'Private assistant', exact: true }).click(); await dashboard.getByRole('switch', { name: /Exclude Watson from supported screen capture/ }).check(); const slider = dashboard.locator('.range-setting input'); await slider.focus(); await slider.press('Home'); for (let index = 0; index < 6; index++) await slider.press('ArrowRight'); const snapshot = await state(); const native = await nativeOverlay(); assert.equal(native.protected, true); assert.ok(Math.abs(native.opacity - snapshot.settings.opacity) < 0.01); const cssOpacity = await overlay.locator('.overlay-shell').evaluate(element => getComputedStyle(element).opacity); assert.equal(cssOpacity, '1'); await shot(dashboard, 'desktop-privacy-settings'); return { requestedProtection: snapshot.settings.contentProtection, nativeProtectionFlag: native.protected, nativeOpacity: native.opacity, cssOpacity, exclusionAcrossSharingAppsProved: false }; });
  await check('provider setup accurately identifies missing keys', async () => { await dashboard.getByRole('button', { name: 'AI providers', exact: true }).click(); assert.equal(await dashboard.getByText('Not configured', { exact: true }).count(), 2); assert.equal(await dashboard.locator('input[type=password]').count(), 2); await shot(dashboard, 'desktop-provider-setup'); });
  if (process.env.WATSON_SMOKE_EXTENDED === '1') {
    let personId;
    await check('People UI saves a local contact and finds it by company', async () => {
      await nav('People'); await dashboard.getByRole('button', { name: 'Add a person', exact: true }).click();
      const modal = dashboard.getByRole('dialog', { name: 'Add a person' });
      await modal.getByLabel('Name', { exact: true }).fill('Runtime reviewer'); await modal.getByLabel('Email', { exact: true }).fill('reviewer@example.invalid'); await modal.getByLabel('Company', { exact: true }).fill('Runtime Example'); await modal.getByLabel('Role', { exact: true }).fill('Reviewer'); await modal.getByLabel('Notes', { exact: true }).fill('An isolated runtime fixture contact.'); await modal.getByRole('button', { name: 'Save person', exact: true }).click();
      const person = (await state()).people.find(person => person.name === 'Runtime reviewer'); assert.ok(person); personId = person.id;
      await dashboard.getByLabel('Search people and commitments').fill('Runtime Example'); await dashboard.locator('.person-card').filter({ hasText: 'Runtime reviewer' }).waitFor(); await shot(dashboard, 'desktop-people');
    });
    await check('session links a person and a tracked commitment', async () => {
      await nav('My sessions'); await dashboard.locator('.session-card').filter({ hasText: 'Verified runtime notes' }).click(); await dashboard.getByRole('tab', { name: 'People', exact: true }).click(); await dashboard.getByRole('checkbox', { name: /Runtime reviewer/ }).check();
      await dashboard.getByLabel('Commitment', { exact: true }).fill('Review the rollout plan with an owner'); await dashboard.getByRole('combobox', { name: /^Linked person/ }).selectOption(personId); await dashboard.getByLabel('Owner name', { exact: true }).fill('Runtime reviewer'); await dashboard.getByLabel('Due date', { exact: true }).fill('2026-10-20'); await dashboard.getByRole('button', { name: 'Add commitment', exact: true }).click();
      const session = (await state()).sessions.find(session => session.id === sessionId); assert.ok(session.attendeeIds.includes(personId)); assert.equal(session.commitments[0].personId, personId); assert.equal(session.commitments[0].status, 'open'); await shot(dashboard, 'desktop-commitments');
      await dashboard.getByRole('checkbox', { name: 'Mark Review the rollout plan with an owner done', exact: true }).check(); assert.equal((await state()).sessions.find(session => session.id === sessionId).commitments[0].status, 'done');
    });
    await check('mode email template and custom prompt/link actions work in an explicit demo', async () => {
      await nav('Custom modes'); await dashboard.locator('.mode-card').filter({ hasText: 'Runtime review' }).getByRole('button', { name: 'Customize', exact: true }).click(); const modal = dashboard.getByRole('dialog', { name: 'Customize Runtime review' });
      await modal.getByLabel('Email template').fill('Keep the draft concise and include a clear next step.');
      await modal.getByRole('button', { name: 'Add action', exact: true }).click(); await modal.getByLabel('Custom action name', { exact: true }).nth(0).fill('Find a next step'); await modal.getByLabel('Custom action prompt', { exact: true }).fill('Find the next step in this conversation.');
      await modal.getByRole('button', { name: 'Add action', exact: true }).click(); await modal.getByLabel('Custom action name', { exact: true }).nth(1).fill('Open research'); await modal.getByLabel('Custom action type', { exact: true }).nth(1).selectOption('link'); await modal.getByLabel('Custom action URL template', { exact: true }).fill('https://example.invalid/search?q={{question}}'); await modal.getByRole('button', { name: 'Save mode', exact: true }).click();
      const mode = (await state()).modes.find(mode => mode.name === 'Runtime review'); assert.equal(mode.customActions.length, 2); assert.match(mode.emailTemplate, /concise/);
      await dashboard.locator('.sidebar-start').click(); const start = dashboard.getByRole('dialog', { name: 'Start a session' }); await start.getByLabel('Session title').fill('Runtime action demo'); await start.getByLabel('Conversation mode').selectOption(mode.id); await start.getByRole('button', { name: /Try a demo/ }).click(); await start.getByRole('button', { name: 'Start demo session', exact: true }).click();
      await dashboard.getByRole('button', { name: 'Find a next step', exact: true }).click(); const snapshot = await state(); const active = snapshot.sessions.find(session => session.id === snapshot.activeSessionId); assert.ok(active.answers.some(answer => answer.kind === 'custom' && answer.status === 'complete'));
      await dashboard.getByRole('textbox', { name: 'Ask Watson', exact: true }).fill('How can we learn faster?'); await dashboard.getByRole('button', { name: 'Open research', exact: true }).click(); const urls = await app.evaluate(() => globalThis.__watsonSmokeExternalUrls); assert.ok(urls.some(url => url.hostname === 'example.invalid' && url.queryKeys.includes('q'))); await shot(dashboard, 'desktop-custom-actions'); await dashboard.getByRole('button', { name: 'End session', exact: true }).click();
      return { externalNavigationIntercepted: true, providerCalls: 0, promptAction: true, linkAction: true };
    });
    await check('calendar start associates the meeting and known attendee without real capture', async () => {
      await nav('Calendar'); await dashboard.getByRole('button', { name: 'Start session', exact: true }).click(); const modal = dashboard.getByRole('dialog', { name: 'Start a session' }); assert.equal(await modal.getByLabel('Session title').inputValue(), 'Runtime planning review'); await modal.getByRole('button', { name: /Try a demo/ }).click(); await modal.getByRole('button', { name: 'Start demo session', exact: true }).click(); const snapshot = await state(); const session = snapshot.sessions.find(session => session.id === snapshot.activeSessionId); assert.equal(session.calendarEventId, snapshot.calendar.find(event => event.title === 'Runtime planning review').id); assert.equal(session.demo, true); assert.ok(session.attendeeIds.includes(personId)); assert.equal(snapshot.capture.running, false); await dashboard.getByRole('button', { name: 'End session', exact: true }).click();
    });
    await check('scorecard UI defines criteria and demo coaching avoids invented scores', async () => {
      await nav('Coaching'); await dashboard.getByRole('button', { name: 'Create a scorecard', exact: true }).click(); const modal = dashboard.getByRole('dialog', { name: 'Create a scorecard' }); await modal.getByLabel('Scorecard name', { exact: true }).fill('Runtime clarity'); await modal.getByLabel('Coaching instructions', { exact: true }).fill('Review clarity using exact transcript evidence.'); await modal.getByLabel('Criterion 1 name', { exact: true }).fill('Concrete next step'); await modal.getByLabel('Criterion 1 description', { exact: true }).fill('An owner and a specific next step are discussed.'); await modal.getByRole('button', { name: 'Save scorecard', exact: true }).click();
      const card = (await state()).scorecards.find(card => card.name === 'Runtime clarity'); assert.ok(card); assert.equal(card.criteria.length, 1);
      await nav('My sessions'); await dashboard.locator('.session-card').filter({ hasText: 'Verified runtime notes' }).click(); await dashboard.getByRole('tab', { name: 'Coaching', exact: true }).click(); await dashboard.getByLabel('Coaching scorecard', { exact: true }).selectOption(card.id); await dashboard.getByRole('button', { name: 'Run coaching', exact: true }).click(); await dashboard.getByText(/Demo · fixture response|Demo assessment only/).first().waitFor();
      const session = (await state()).sessions.find(session => session.id === sessionId); assert.ok(session.answers.some(answer => answer.kind === 'coaching' && answer.status === 'complete')); assert.ok((session.coaching || []).every(assessment => assessment.overallScore === undefined && assessment.criteria.every(criterion => criterion.score === null))); await shot(dashboard, 'desktop-coaching');
    });
    await check('analytics derives fixture session counts and exports actual CSV', async () => {
      await nav('Analytics'); await dashboard.getByRole('checkbox', { name: 'Include labeled demos', exact: true }).check(); await dashboard.locator('.analytics-table').waitFor(); const snapshot = await state(); const report = await invoke('analytics:get', { includeDemo: true }); assert.equal(report.summary.sessions, snapshot.sessions.length); assert.equal(report.summary.liveSessions, 0); assert.equal(report.summary.assistantRequests, 0); assert.ok(report.summary.completedAnswers > 0);
      const path = join(fixtureRoot, 'runtime-analytics.csv'); await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, path); await dashboard.getByRole('button', { name: 'Export CSV', exact: true }).click(); await dashboard.getByRole('status').filter({ hasText: 'Analytics exported' }).waitFor(); assert.match(await readFile(path, 'utf8'), /Verified runtime notes/); await shot(dashboard, 'desktop-analytics');
    });
    await check('audio calibration controls show real capture test boundary', async () => { await nav('Settings'); await dashboard.getByRole('button', { name: 'Audio & screen', exact: true }).click(); await dashboard.getByRole('button', { name: 'Start audio test', exact: true }).waitFor(); assert.equal(await dashboard.getByRole('meter').count(), 2); assert.equal(await dashboard.getByRole('switch', { name: /Test live transcription/ }).isDisabled(), true); assert.equal((await state()).audioTest?.running, false); await shot(dashboard, 'desktop-audio-calibration'); });
  }
  await check('isolated app reopens with saved sessions knowledge mode calendar and settings', async () => { const before = await state(); await close(); await launch(); const after = await state(); assert.equal(after.sessions.length, before.sessions.length); assert.equal(after.knowledge.length, before.knowledge.length); assert.equal(after.calendar.length, before.calendar.length); assert.equal(after.settings.shortcuts.toggleOverlay, before.settings.shortcuts.toggleOverlay); assert.equal(after.settings.contentProtection, before.settings.contentProtection); assert.equal(after.modes.length, before.modes.length); assert.equal(after.sessions.find(session => session.id === sessionId)?.notes, before.sessions.find(session => session.id === sessionId)?.notes); await shot(dashboard, 'desktop-reopened'); return { sessions: after.sessions.length, knowledgeDocuments: after.knowledge.length, modes: after.modes.length, calendarEvents: after.calendar.length, activeSessionId: after.activeSessionId || null }; });
} catch (error) {
  report.launchOrFatalError = String(error?.stack || error).slice(0, 4000); console.log(`FATAL ${String(error?.message || error).slice(0, 300)}`);
} finally {
  try { await close(); } catch (error) { report.closeError = String(error?.message || error).slice(0, 1000); }
  report.finishedAt = new Date().toISOString(); report.passed = report.checks.filter(check => check.status === 'pass').length; report.failed = report.checks.filter(check => check.status === 'fail').length;
  report.success = report.checks.length > 0 && report.failed === 0 && !report.launchOrFatalError;
  await writeFile(join(artifactRoot, 'desktop-runtime-validation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ success: report.success, passed: report.passed, failed: report.failed, screenshots: report.screenshots.length, report: 'evidence/desktop-runtime-validation.json' }));
  if (!report.success) process.exitCode = 1;
}
