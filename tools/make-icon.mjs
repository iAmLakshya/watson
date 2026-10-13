import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const drawn = spawnSync('swift', ['-module-cache-path', '.cache/swift', 'tools/make-icon.swift'], { stdio: 'inherit' });
if (drawn.status !== 0) process.exit(drawn.status ?? 1);
// Modern ICNS entries carry the original PNG payloads at each native size.
const parts = [['icp4', 'icon_16x16'], ['icp5', 'icon_32x32'], ['icp6', 'icon_32x32@2x'], ['ic07', 'icon_128x128'], ['ic08', 'icon_256x256'], ['ic09', 'icon_512x512'], ['ic10', 'icon_512x512@2x']].map(([type, name]) => {
  const png = readFileSync(`.cache/Watson.iconset/${name}.png`);
  const header = Buffer.alloc(8); header.write(type); header.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([header, png]);
});
const header = Buffer.alloc(8); header.write('icns'); header.writeUInt32BE(8 + parts.reduce((sum, part) => sum + part.length, 0), 4);
mkdirSync('native/assets', { recursive: true });
writeFileSync('native/assets/Watson.icns', Buffer.concat([header, ...parts]));
console.log('Created native/assets/Watson.icns');
