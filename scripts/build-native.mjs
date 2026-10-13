import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
if (process.platform !== 'darwin') {
  console.log('Native macOS helper skipped on this platform.');
  process.exit(0);
}
mkdirSync('native/bin', { recursive: true });
mkdirSync('.cache/swift', { recursive: true });
const args = ['-swift-version', '5', '-O', '-module-cache-path', resolve('.cache/swift'),
  '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`,
  'native/WatsonCapture.swift', '-o', 'native/bin/watson-capture',
  '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', resolve('native/Info.plist')];
const result = spawnSync('swiftc', args, { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const signed = spawnSync('codesign', ['--force', '--sign', '-', 'native/bin/watson-capture'], { stdio: 'inherit' });
if (signed.status !== 0) process.exit(signed.status ?? 1);
console.log('Built native/bin/watson-capture');
