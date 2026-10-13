import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const bundle = path.resolve(process.argv[2] ?? `release/v${version}/mac-arm64/Watson.app`);
const resources = path.join(bundle, 'Contents/Resources');
const asar = fs.readFileSync(path.join(resources, 'app.asar'));
const base = 8 + asar.readUInt32LE(4);
const header = JSON.parse(asar.subarray(16, 16 + asar.readUInt32LE(12)).toString());
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function member(name) {
  let node = header;
  for (const part of name.split('/')) node = node.files?.[part];
  if (!node || node.files || node.unpacked) throw new Error(`Packed member missing: ${name}`);
  return asar.subarray(base + Number(node.offset), base + Number(node.offset) + node.size);
}
const files = ['dist/index.html', 'dist-electron/electron/main.js', 'dist-electron/electron/preload.js', 'dist-electron/electron/engine.js', 'dist/licenses/dm-sans-OFL.txt', 'dist/licenses/manrope-OFL.txt'];
function builtFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? builtFiles(filename) : [filename];
  });
}
files.push(...builtFiles('dist'), ...builtFiles('dist-electron'));
const html = member('dist/index.html').toString();
for (const match of html.matchAll(/(?:src|href)="\.\/([^\"]+)"/g)) files.push(`dist/${match[1]}`);
for (const entry of fs.readdirSync('dist/assets')) files.push(`dist/assets/${entry}`);
const matches = [...new Set(files)].map(name => {
  const packed = member(name); const built = fs.readFileSync(name);
  if (hash(packed) !== hash(built)) throw new Error(`Stale build in package: ${name}`);
  return { path: name, sha256: hash(packed), bytes: packed.length };
});
const helper = fs.readFileSync(path.join(resources, 'watson-capture'));
// Signing can update the helper bytes; verify its actual packaged signature
// rather than requiring byte equality with the pre-signing development helper.
const signature = execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const name = execFileSync('plutil', ['-extract', 'CFBundleName', 'raw', path.join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
const minimumOS = execFileSync('plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', path.join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
if (name !== 'Watson' || minimumOS !== '13.0') throw new Error('Package identity or minimum OS is incorrect');
const architecture = execFileSync('lipo', ['-archs', path.join(bundle, 'Contents/MacOS/Watson')], { encoding: 'utf8' }).trim();
const helperArchitecture = execFileSync('lipo', ['-archs', path.join(resources, 'watson-capture')], { encoding: 'utf8' }).trim();
if (architecture !== 'arm64' || helperArchitecture !== architecture) throw new Error('Package and capture helper must both be ARM64');
const icon = fs.readFileSync(path.join(resources, 'icon.icns'));
if (hash(icon) !== hash(fs.readFileSync('native/assets/Watson.icns'))) throw new Error('Package does not contain the current Watson icon');
const packageMetadata = JSON.parse(member('package.json').toString());
if (packageMetadata.version !== version) throw new Error('Package version is stale');
const updateConfiguration = fs.readFileSync(path.join(resources, 'update-config.json'));
if (hash(updateConfiguration) !== hash(fs.readFileSync('config/update-config.json'))) throw new Error('Package update configuration is stale');
const result = { checkedAt: new Date().toISOString(), version, bundle, name, minimumOS, architecture, helperArchitecture, helperSha256: hash(helper), iconSha256: hash(icon), updateConfigurationSha256: hash(updateConfiguration), archiveSha256: hash(asar), matchedBuildFiles: matches, codeSignature: { validDeepStrict: true, type: 'ad-hoc development', notarized: false, stdout: signature }, nativeRuntimeVerified: false, statement: 'Resource identity, actual binary architectures, exact built-file hashes and development signatures are verified. This does not prove app launch or live capture.' };
fs.writeFileSync('evidence/package-validation.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ name, minimumOS, matchedFiles: matches.length, nativeHelper: true, validDeepStrictSignature: true, nativeRuntimeVerified: false }));
