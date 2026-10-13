import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const files = [
  'electron/windows-capture.ts', 'electron/windows-capture-protocol.ts', 'electron/windows-capture-preload.ts',
  'renderer/public/windows-capture/index.html', 'renderer/public/windows-capture/capture.js', 'renderer/public/windows-capture/pcm-core.js', 'renderer/public/windows-capture/worklet.js',
  'electron/docx.ts', 'electron/documents.ts', 'tests/windows-capture.test.ts', 'tests/windows-pcm.test.ts', 'tests/windows-renderer.test.ts', 'tests/windows-documents.test.ts', 'tests/documents.test.ts',
  'electron/windows-conference.ts', 'electron/windows-conference-activity.ts', 'electron/windows-conference-protocol.ts', 'native/windows/ConferenceActivity.ps1', 'native/windows/ConferenceActivity.cs', 'tests/windows-conference.test.ts', 'tests/fixtures/windows-activity-helper.mjs',
];
const testFiles = ['tests/windows-capture.test.ts', 'tests/windows-pcm.test.ts', 'tests/windows-renderer.test.ts', 'tests/windows-documents.test.ts', 'tests/documents.test.ts', 'tests/windows-conference.test.ts'];
const args = ['--import', 'tsx', '--test', ...testFiles];
const tests = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 2_000_000 });
const output = `${tests.stdout ?? ''}${tests.stderr ?? ''}`;
const require = createRequire(import.meta.url);
const hashes = await Promise.all(files.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
const evidence = {
  collectedAt: new Date().toISOString(), authority: 'source-bound-automated-tests',
  host: { platform: process.platform, arch: process.arch, node: process.version },
  dependencies: { electron: require('electron/package.json').version, mammoth: require('mammoth/package.json').version },
  tests: { command: `node ${args.join(' ')}`, exitCode: tests.status, count: Number(output.match(/(?:#|ℹ)\s*tests\s+(\d+)/)?.[1] ?? 0), output },
  sourceHashes: hashes,
  proved: ['Shipped JavaScript PCM resampler/worklet behavior', 'Capture renderer source routing and cleanup in browser API harness', 'Capture IPC and lifecycle behavior in mocked Electron harness', 'Automatic capture refuses uncertain setup in mocked Electron harness', 'Portable DOCX text extraction in real Node worker threads', 'DOCX resource bounds, corrupt/encrypted input rejection, and worker termination', 'CoreAudio metadata parser projection against fixtures', 'Metadata reader lifecycle against actual Node fixture subprocess handles'],
  unverified: ['Windows OS microphone capture and loopback', 'Windows desktop images and real capture exclusion', 'Third-party Windows screen-sharing applications', 'Live transcription/response providers', 'Windows PowerShell C# bridge compilation and live CoreAudio metadata', 'Windows I/O-based meeting detection and actual helper attribution', 'Packaged Windows install/launch'],
};
await writeFile('evidence/windows-capture-validation.json', `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(JSON.stringify({ status: tests.status === 0 ? 'passed' : 'failed', tests: evidence.tests.count, evidence: 'evidence/windows-capture-validation.json' }) + '\n');
if (tests.status !== 0) process.exitCode = tests.status ?? 1;
