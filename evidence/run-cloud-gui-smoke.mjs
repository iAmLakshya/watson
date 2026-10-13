import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createWatsonServer } from '../server/dist/app.js';
const { _electron } = createRequire(import.meta.url)('playwright');
const root = resolve('evidence', `cloud-gui-profile-${Date.now()}`);
await mkdir(root, { recursive: true });
const recordingDirectory = join(root, 'encrypted-recordings');
const server = createWatsonServer({ dbPath: join(root, 'server.sqlite'), port: 0, recordings: { directory: recordingDirectory, encryptionKey: randomBytes(32).toString('base64'), maxBytes: 8 * 1024 * 1024 } });
const origin = await server.listen();
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const report = { startedAt: new Date().toISOString(), application: 'Actual packaged Watson with actual temporary Node/SQLite service', executable: resolve(process.env.WATSON_SMOKE_EXECUTABLE || `release/v${version}/mac-arm64/Watson.app/Contents/MacOS/Watson`), boundaries: { syntheticSession: true, mockKeychainUsed: true, realOSCredentialVaultVerified: false, recordingRequested: false, providerCallsRequested: false, externalWrites: false, realOAuth: false }, checks: [], screenshots: [] };
let app; let page; let id; let shareUrl;
const audio = Buffer.alloc(5 * 1024 * 1024 + 44, 0);
audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40); audio.write('PRIVATE_AUDIO_GUI_FIXTURE_ONLY', 44);
const audioPath = join(root, 'Synthetic fixture.wav');
const exportPath = join(root, 'Exported synthetic fixture.wav');
await writeFile(audioPath, audio);
const state = () => page.evaluate(() => window.watson.invoke('bootstrap'));
const invoke = (command, input) => page.evaluate(({ command, input }) => window.watson.invoke(command, input), { command, input });
const wait = async predicate => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await page.evaluate(predicate)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Expected cloud state did not arrive within eight seconds');
};
async function check(name, action) { const started = Date.now(); try { const evidence = await action(); report.checks.push({ name, passed: true, milliseconds: Date.now()-started, evidence }); console.log(`PASS ${name}`); } catch (error) { report.checks.push({ name, passed: false, error: String(error.stack || error).slice(0,2000) }); throw error; } }
async function shot(name) { const path = resolve('evidence/screenshots', name+'.png'); await page.screenshot({ path }); report.screenshots.push(path); }
try {
  app = await _electron.launch({ executablePath: report.executable, args: ['--use-mock-keychain'], env: { ...process.env, OPENAI_API_KEY: '', DEEPGRAM_API_KEY: '', WATSON_USER_DATA_DIR: root }, timeout: 30000 });
  report.pid = app.process().pid;
  for (let i=0;i<80;i++) { page=app.windows().find(p=>p.url().includes('#dashboard')); if(page)break; await new Promise(r=>setTimeout(r,100)); }
  assert.ok(page); page.setDefaultTimeout(7000);
  await page.getByRole('heading',{ name:'Your space to think.' }).waitFor();
  const welcome = page.getByRole('dialog', { name: 'Welcome to Watson', exact: true });
  if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Explore on my own', exact: true }).click();
  await app.evaluate(({ shell }) => { shell.openExternal = async () => {}; });
  const seed = await invoke('session:start', { title: 'Cloud GUI fixture', demo: true }); id = seed.id; await invoke('session:stop');
  await page.locator('.sidebar').getByRole('button',{ name:'Settings', exact:true }).click();
  await page.getByRole('button',{ name:'Sync & sharing', exact:true }).click();
  const panel = page.locator('.cloud-panel');
  await check('UI configures isolated local backend and creates actual account', async()=>{
    await panel.getByLabel('Server address',{exact:true}).fill(origin); await panel.getByRole('button',{name:'Save server',exact:true}).click();
    await panel.getByRole('button',{name:'Create an account',exact:true}).click(); await panel.getByLabel('Name',{exact:true}).fill('Cloud GUI fixture'); await panel.getByLabel('Email',{exact:true}).fill('gui-fixture@watson.test'); await panel.getByLabel('Password',{exact:true}).fill('Watson GUI fixture password 2026'); await panel.getByRole('button',{name:'Create account',exact:true}).click();
    await panel.getByRole('heading',{name:'Choose what to sync',exact:true}).waitFor(); const current=await state(); assert.equal(current.cloud.signedIn,true); assert.equal(current.settings.contentProtection,true); assert.equal(server.store.all('SELECT id FROM users').length,1); assert.equal(server.store.all('SELECT id FROM resources').length,0); await shot('desktop-cloud-account'); return {accountPersisted:true,implicitUploads:0};
  });
  await check('Download-only sync and cancelled review upload no local history', async()=>{
    await panel.getByRole('button',{name:'Download updates',exact:true}).click(); await wait(async()=>{const s=await window.watson.invoke('bootstrap');return !!s.cloud.lastSyncAt&&!s.cloud.busy;});
    await panel.locator('.cloud-record-list label').filter({hasText:'Cloud GUI fixture'}).getByRole('checkbox').check(); await panel.getByRole('button',{name:/^Review uploads/}).click(); const modal=page.getByRole('dialog',{name:'Upload to this account?',exact:true}); await modal.getByRole('button',{name:'Cancel',exact:true}).click(); assert.equal(server.store.all('SELECT id FROM resources').length,0); return {serverResources:0};
  });
  await check('Explicit UI review commits selected session and excludes local privacy', async()=>{
    await panel.getByRole('button',{name:/^Review uploads/}).click(); await page.getByRole('dialog',{name:'Upload to this account?',exact:true}).getByRole('button',{name:'Upload & sync',exact:true}).click(); await wait(async()=>{const s=await window.watson.invoke('bootstrap');return s.cloud.boundRecords.some(r=>r.entity==='meeting')&&!s.cloud.busy;}); const rows=server.store.all("SELECT data FROM resources WHERE entity='meeting'"); assert.equal(rows.length,1); const data=JSON.parse(rows[0].data); assert.equal(data.title,'Cloud GUI fixture'); assert.equal(data.demo,true); assert.equal(data.contentProtection,undefined); assert.equal(data.encryptedKeys,undefined); assert.equal((await state()).settings.contentProtection,true); await shot('desktop-cloud-upload'); return {uploadedSessions:1,selectedOnly:true};
  });
  let audioPanel;
  await check('Session Audio tab uploads a private synthetic file only after consent and final review', async()=>{
    await page.locator('.sidebar').getByRole('button',{name:/^My sessions/}).click();
    await page.locator('.session-card').filter({hasText:'Cloud GUI fixture'}).click();
    await page.getByRole('tab',{name:'Audio',exact:true}).click();
    audioPanel=page.getByRole('region',{name:'Private audio attachment',exact:true});
    await audioPanel.getByText('This session has no audio attachment.',{exact:true}).waitFor();
    await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},audioPath);
    await audioPanel.getByRole('button',{name:'Choose audio file',exact:true}).click();
    const review=audioPanel.getByRole('button',{name:'Review audio upload',exact:true});
    assert.equal(await review.isEnabled(),false);
    await audioPanel.getByRole('checkbox',{name:/I have permission from the participants/}).check();
    await review.click(); await page.getByRole('dialog',{name:'Upload this audio attachment?',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal(server.store.all('SELECT id FROM recording_files').length,0);
    await review.click(); await page.getByRole('dialog',{name:'Upload this audio attachment?',exact:true}).getByRole('button',{name:'Upload attachment',exact:true}).click();
    await wait(async()=>{const s=await window.watson.invoke('bootstrap');return s.cloud.recordings?.entries.some(e=>e.recording?.size===5*1024*1024+44)&&!s.cloud.busy;});
    const current=await state();const recording=current.cloud.recordings.entries.find(e=>e.meetingId===id).recording;
    assert.equal(recording.sha256,createHash('sha256').update(audio).digest('hex'));assert.equal(recording.encryptedAtRest,true);assert.equal(JSON.stringify(current).includes(audioPath),false);
    const encrypted=await readdir(recordingDirectory);assert.equal(encrypted.length,1);assert.equal((await readFile(join(recordingDirectory,encrypted[0]))).includes(Buffer.from('PRIVATE_AUDIO_GUI_FIXTURE_ONLY')),false);
    await shot('desktop-session-audio');return{bytes:audio.length,consentRequired:true,cancelledReviewUploads:0,encryptedFiles:1,privateFilePathExposed:false};
  });
  await check('Session Audio export verifies exact bytes through the native save dialog broker', async()=>{
    await app.evaluate(({dialog},path)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:path});},exportPath);
    await audioPanel.getByRole('button',{name:'Export audio',exact:true}).click();
    await page.getByRole('status').filter({hasText:'Audio exported to your selected destination.'}).waitFor();
    assert.deepEqual(await readFile(exportPath),audio);return{bytes:audio.length,sha256:createHash('sha256').update(audio).digest('hex'),playbackStarted:false};
  });
  await check('Session Audio deletion removes encrypted attachment while preserving notes', async()=>{
    await audioPanel.getByRole('button',{name:'Delete attachment',exact:true}).click();
    await page.getByRole('dialog',{name:'Delete this audio attachment?',exact:true}).getByRole('button',{name:'Delete attachment',exact:true}).click();
    await audioPanel.getByText('This session has no audio attachment.',{exact:true}).waitFor();
    assert.equal(server.store.all('SELECT id FROM recording_files').length,0);assert.equal((await readdir(recordingDirectory)).length,0);
    assert.ok((await state()).sessions.find(s=>s.id===id)?.notes);
    await page.locator('.sidebar').getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Sync & sharing',exact:true}).click();
    return{encryptedFiles:0,sessionNotesRetained:true};
  });
  await check('Actual public HTML link shows reviewed fixture and UI revocation returns404', async()=>{
    await panel.getByRole('combobox',{name:/^Session/}).selectOption(id); await panel.getByRole('button',{name:'Create link',exact:true}).click(); await wait(async()=>{const s=await window.watson.invoke('bootstrap');return s.cloud.shares.length===1&&!s.cloud.busy;}); shareUrl=(await state()).cloud.shares[0].url; const view=await fetch(shareUrl); assert.equal(view.status,200); assert.match(view.headers.get('content-type'),/text\/html/); const html=await view.text(); assert.match(html,/Cloud GUI fixture/); assert.doesNotMatch(html,/encryptedKeys|apiKey|gui-fixture@watson.test/); await shot('desktop-cloud-share'); await panel.locator('.cloud-share-list').getByRole('button',{name:'Revoke',exact:true}).click(); await wait(async()=>{const s=await window.watson.invoke('bootstrap');return s.cloud.shares.length===0&&!s.cloud.busy;}); assert.equal((await fetch(shareUrl)).status,404); return {publicViewer:200,revokedViewer:404};
  });
  await check('Organization UI creates actual admin membership and policy controls', async()=>{
    await panel.getByLabel('New organization',{exact:true}).fill('GUI fixture organization'); await panel.getByRole('button',{name:'Create organization',exact:true}).click(); await wait(async()=>{const s=await window.watson.invoke('bootstrap');return s.cloud.organizations.length===1&&!s.cloud.busy;}); assert.equal((await state()).cloud.organizations[0].role,'admin'); assert.equal(server.store.all('SELECT role FROM org_members')[0].role,'admin'); await panel.getByRole('button',{name:'Refresh details',exact:true}).click(); await panel.getByRole('heading',{name:'Organization policy',exact:true}).waitFor(); await shot('desktop-cloud-organization'); return {role:'admin'};
  });
  await check('Unconfigured billing reports factual provider state without checkout', async()=>{
    await panel.getByRole('button',{name:'Check plan',exact:true}).click(); await panel.getByText('Billing is not configured on this server.',{exact:true}).waitFor(); return {checkoutLaunched:false};
  });
  await check('UI signout preserves local fixture and capture exclusion', async()=>{
    await panel.getByRole('button',{name:'Sign out',exact:true}).click(); await wait(async()=>{const s=await window.watson.invoke('bootstrap');return !s.cloud.signedIn&&!s.cloud.busy;}); await panel.getByText('Local workspace',{exact:true}).waitFor(); await panel.getByLabel('Email',{exact:true}).waitFor(); const current=await state(); assert.equal(current.cloud.signedIn,false); assert.ok(current.sessions.some(s=>s.id===id)); assert.equal(current.settings.contentProtection,true); return {localSessionRetained:true,protectionEnabled:true};
  });
  const metadata=await readFile(join(root,'cloud.json'),'utf8'); assert.doesNotMatch(metadata,/Watson GUI fixture password/);
} catch(error) { report.error=String(error.stack||error).slice(0,4000); console.log('FAIL '+String(error.message||error)); if(page) { report.lastCloud=(await state()).cloud; report.uiAlerts=await page.getByRole('alert').allTextContents(); await shot('desktop-cloud-error'); console.log(JSON.stringify({cloudError:report.lastCloud?.error,uiAlerts:report.uiAlerts})); } }
finally {
  if(app) {await app.close(); report.processClosed=true;} await server.close(); report.serverClosed=true;
  report.finishedAt=new Date().toISOString(); report.passed=report.checks.filter(c=>c.passed).length; report.failed=report.checks.filter(c=>!c.passed).length; report.success=report.passed===10&&!report.error;
  await writeFile('evidence/cloud-gui-runtime-validation.json',JSON.stringify(report,null,2)); console.log(JSON.stringify({success:report.success,passed:report.passed,failed:report.failed})); if(!report.success)process.exitCode=1;
}
