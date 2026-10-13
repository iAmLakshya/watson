import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const children = [];
const run = (command, args, env = process.env) => { const child = spawn(command, args, { stdio: 'inherit', env }); children.push(child); return child; };
function stop() { for (const child of children) child.kill(); }
process.on('SIGINT', () => { stop(); process.exit(); }); process.on('SIGTERM', () => { stop(); process.exit(); });
const compile = run('npm', ['run', 'build:electron']);
await new Promise((resolve, reject) => compile.on('exit', code => code === 0 ? resolve() : reject(new Error('Electron compilation failed'))));
if (!existsSync('native/bin/watson-capture') && process.platform === 'darwin') {
  const native = run('npm', ['run', 'build:native']); await new Promise(resolve => native.on('exit', resolve));
}
run('npm', ['exec', 'vite']);
run('npm', ['exec', 'tsc', '--', '-p', 'tsconfig.electron.json', '--watch']);
let ready = false;
for (let attempt = 0; attempt < 100; attempt++) { try { const response = await fetch('http://127.0.0.1:5173'); if (response.ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
if (!ready) { stop(); throw new Error('Vite did not start'); }
const electron = run('npm', ['exec', 'electron', '--', '.'], { ...process.env, WATSON_DEV_URL: 'http://127.0.0.1:5173' });
electron.on('exit', () => { stop(); process.exit(); });
