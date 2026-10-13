import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaptureManager, type NativeEvent } from '../electron/capture';
import { DEFAULT_SETTINGS } from '../shared/defaults';
test('capture waits for helper readiness, sends selected flags, and takes fresh screenshots', { skip: process.platform !== 'darwin' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watson-helper-fixture-')); const path = join(directory, 'helper');
  await writeFile(path, `#!/usr/bin/env node\nconst args=process.argv.slice(2); const emit=e=>process.stdout.write(JSON.stringify(e)+'\\n'); if(args.includes('--screenshot')) {emit({type:'screen',mimeType:'image/jpeg',data:Buffer.from(String(Date.now())).toString('base64'),capturedAt:new Date().toISOString()});process.exit();} emit({type:'status',status:'capturing',system:!args.includes('--no-system'),microphone:args.includes('--microphone'),screen:args.includes('--screen')}); process.stdin.resume(); process.on('SIGTERM',()=>process.exit());`); await chmod(path, 0o755);
  const events: NativeEvent[] = []; const capture = new CaptureManager(path, event => events.push(event));
  try { await capture.start({ ...DEFAULT_SETTINGS, captureSystem: false }); const status = events.find(event => event.type === 'status'); assert.ok(status?.type === 'status'); assert.equal(status.system, false); assert.equal(status.microphone, true); const first = await capture.screenshot(DEFAULT_SETTINGS); const second = await capture.screenshot(DEFAULT_SETTINGS); assert.ok(new Date(second.capturedAt).getTime() >= new Date(first.capturedAt).getTime()); assert.notEqual(first.data, second.data); await capture.stop(); }
  finally { await capture.stop(); await rm(directory, { recursive: true, force: true }); }
});
test('helper startup errors reject a live capture request instead of marking it ready', { skip: process.platform !== 'darwin' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watson-helper-denied-fixture-')); const path = join(directory, 'helper'); await writeFile(path, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type:"error",message:"Permission denied fixture"})+"\\n");process.exit(1);'); await chmod(path, 0o755); const capture = new CaptureManager(path, () => {});
  try { await assert.rejects(capture.start(DEFAULT_SETTINGS), /Permission denied fixture/); } finally { await capture.stop(); await rm(directory, { recursive: true, force: true }); }
});
