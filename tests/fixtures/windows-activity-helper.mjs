import { createInterface } from 'node:readline';
const mode = process.argv[2] || 'normal';
if (mode === 'no-stop') setInterval(() => {}, 1000);
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`);
if (mode !== 'no-ready') output({ type: 'ready', protocol: 1 });
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.type === 'stop') { if (mode !== 'no-stop') process.exit(0); return; }
  if (request.type !== 'sample') throw new Error('Unknown fixture request');
  if (mode === 'hang') return;
  if (mode === 'invalid') { process.stdout.write('not-json\n'); return; }
  if (mode === 'exit') { process.stderr.write('Metadata service unavailable fixture'); process.exit(7); }
  const rows = request.allowedExecutables.includes('zoom.exe') ? [
    { pid: 800, ownerPid: 800, executable: 'Zoom.exe', ownerExecutable: 'Zoom.exe', flow: 'capture', state: 'active', singleProcess: true },
    { pid: 800, ownerPid: 800, executable: 'Zoom.exe', ownerExecutable: 'Zoom.exe', flow: 'render', state: 'inactive', singleProcess: true },
  ] : [];
  output({ type: 'activity', protocol: 1, requestId: request.requestId, checkedAt: new Date().toISOString(), sessions: rows, errors: mode === 'partial' ? ['An endpoint scan failed fixture'] : [] });
});
