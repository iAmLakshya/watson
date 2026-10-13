import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { _electron } = require('playwright');
mkdirSync('evidence/screenshots', { recursive: true });
const isolated = resolve('.cache/runtime-probe-profile');
const env = { ...process.env, WATSON_USER_DATA_DIR: isolated };
delete env.OPENAI_API_KEY; delete env.DEEPGRAM_API_KEY;
const app = await _electron.launch({
  executablePath: resolve('release/mac-arm64/Watson.app/Contents/MacOS/Watson'),
  args: [], env, timeout: 30000,
});
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.desktop-shell', { timeout: 30000 });
  const state = await page.evaluate(() => window.watson.invoke('bootstrap'));
  await page.screenshot({ path: 'evidence/screenshots/watson-dashboard.png' });
  const result = {
    observedAt: new Date().toISOString(), actualElectronProcess: true,
    pid: app.process().pid, windows: app.windows().length, title: await page.title(),
    bridgePresent: await page.evaluate(() => !!window.watson),
    platform: state.platform, nativeHelperAvailable: state.capture.helperAvailable,
    permissionState: state.permissions, screenshot: 'evidence/screenshots/watson-dashboard.png',
    providerKeysInRenderer: Object.keys(state).some(key => /encryptedKeys|apiKey|token/i.test(key)),
    scope: 'Packaged app dashboard with isolated blank test data. No live audio/model requests.',
  };
  writeFileSync('evidence/runtime-probe.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await app.close(); }
