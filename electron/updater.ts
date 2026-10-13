import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import type { SignedUpdateManifest, UpdateArtifact, UpdateConfiguration, UpdateManifest, UpdateStatus } from '../shared/update-types';

const run = promisify(execFile);
const MAX_MANIFEST = 256 * 1024;
const DEFAULT_DOWNLOAD = 750 * 1024 * 1024;
const DEFAULT_EXTRACTED = 4 * 1024 * 1024 * 1024;
const DEFAULT_ENTRY = 512 * 1024 * 1024;
const DECODER = new TextDecoder('utf-8', { fatal: true });
export type ArtifactVerifier = (bundle: string, artifact: UpdateArtifact, manifest: UpdateManifest, configuration: UpdateConfiguration) => Promise<void>;
interface UpdaterOptions {
  directory: string; currentVersion: string; platform?: string; architecture?: string; configuration?: UpdateConfiguration;
  fetch?: typeof globalThis.fetch; verifyArtifact?: ArtifactVerifier; onStatus?: (status: UpdateStatus) => void; now?: () => number;
}
interface StagingRecord { schemaVersion: 1; currentVersion: string; stageId: string; envelope: SignedUpdateManifest; }
interface PersistedState { schemaVersion: 1; appId: string; highestVersion?: string; staged?: StagingRecord; cleanupStageIds?: string[]; }
export interface ZipEntry { name: string; metadata: boolean; directory: boolean; symlink: boolean; mode: number; method: number; crc: number; compressed: number; size: number; dataOffset: number; }

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, maximum = 4000): string {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\u0000-\u001f]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function integer(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) throw new Error(`${label} exceeds its permitted size`);
  return value as number;
}
function strictKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} contains unknown fields`);
}
function version(value: unknown): string {
  const v = text(value, 'Version', 150);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(v)) throw new Error('Version must be valid SemVer');
  const parts = v.split('+')[0].split('-');
  if (parts.slice(1).join('-').split('.').some(p => /^\d+$/.test(p) && p.length > 1 && p.startsWith('0'))) throw new Error('Numeric prerelease identifiers may not have leading zeros');
  return v;
}
export function compareVersions(left: string, right: string): number {
  const parse = (v: string) => { const [base, ...pre] = version(v).split('+')[0].split('-'); return { base: base.split('.').map(BigInt), pre: pre.length ? pre.join('-').split('.') : [] }; };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) if (a.base[i] !== b.base[i]) return a.base[i] < b.base[i] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return !a.pre.length && !b.pre.length ? 0 : !a.pre.length ? 1 : -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i]; if (x === y) continue; if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
function https(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Update URLs must use HTTPS without credentials or fragments');
  return url;
}
function origins(configuration: UpdateConfiguration): Set<string> {
  const feed = https(text(configuration.feedUrl, 'Update feed URL'));
  return new Set([feed.origin, ...(configuration.artifactOrigins ?? []).map(origin => { const url = https(origin); if (url.pathname !== '/' || url.search) throw new Error('Artifact origin must not contain a path or query'); return url.origin; })]);
}
export function configurationGates(configuration: UpdateConfiguration | undefined, platform: string): string[] {
  const gates: string[] = [...configuration?.configurationGates ?? []];
  if (!configuration?.enabled) gates.push('Automatic update distribution is not configured for this build.');
  if (!configuration?.feedUrl) gates.push('A published HTTPS update feed is required.');
  else { try { origins(configuration); } catch { gates.push('The update feed and artifact origins must use HTTPS.'); } }
  if (!configuration?.publicKeys || !Object.keys(configuration.publicKeys).length) gates.push('A pinned Ed25519 release-verification key is required.');
  else for (const pem of Object.values(configuration.publicKeys)) { try { if (createPublicKey(pem).asymmetricKeyType !== 'ed25519') throw new Error(); } catch { gates.push('Every release-verification key must be a valid Ed25519 public key.'); break; } }
  if (platform === 'darwin' && !/^[A-Z0-9]{10}$/.test(configuration?.signing?.darwinTeamId ?? '')) gates.push('A Developer ID team identity and notarized macOS release are required.');
  if (platform === 'win32' && !/^[A-Fa-f0-9]{40,64}$/.test(configuration?.signing?.windowsCertificateThumbprint ?? '')) gates.push('A Windows Authenticode signing identity is required.');
  if (!['darwin', 'win32'].includes(platform)) gates.push('Updates are available only for supported macOS and Windows builds.');
  return [...new Set(gates)];
}
export async function readUpdateConfiguration(path: string): Promise<UpdateConfiguration | undefined> {
  try {
    const raw = await readFile(path); if (raw.length > MAX_MANIFEST) throw new Error('Update configuration is too large');
    const c = record(JSON.parse(DECODER.decode(raw)), 'Update configuration');
    strictKeys(c, ['enabled','appId','channel','feedUrl','artifactOrigins','publicKeys','signing','maxDownloadBytes','maxExtractedBytes','maxEntryBytes','maxEntries','requestTimeoutMs','configurationGates'], 'Update configuration');
    if (typeof c.enabled !== 'boolean' || !['stable','beta'].includes(String(c.channel))) throw new Error('Update configuration has invalid enabled/channel values');
    text(c.appId, 'Application identifier', 200);
    if (c.feedUrl !== undefined && c.feedUrl !== '') text(c.feedUrl, 'Update feed URL');
    if (c.artifactOrigins !== undefined && (!Array.isArray(c.artifactOrigins) || c.artifactOrigins.length > 20 || c.artifactOrigins.some(x => typeof x !== 'string'))) throw new Error('Artifact origins must be a bounded string list');
    if (c.publicKeys !== undefined) { const keys = record(c.publicKeys, 'Public keys'); if (Object.keys(keys).length > 20) throw new Error('Too many public keys'); for (const [id,pem] of Object.entries(keys)) { text(id,'Key identifier',100); if(typeof pem!=='string'||pem.length>10000||createPublicKey(pem).asymmetricKeyType!=='ed25519')throw new Error('Invalid Ed25519 public key'); } }
    if (c.signing !== undefined) { const signing = record(c.signing,'Signing pins'); strictKeys(signing,['darwinTeamId','windowsCertificateThumbprint'],'Signing pins'); }
    for (const field of ['maxDownloadBytes','maxExtractedBytes','maxEntryBytes','maxEntries','requestTimeoutMs']) if (c[field] !== undefined) integer(c[field],field,Number.MAX_SAFE_INTEGER);
    if (c.configurationGates !== undefined && (!Array.isArray(c.configurationGates) || c.configurationGates.length > 30 || c.configurationGates.some(x=>typeof x!=='string'))) throw new Error('Configuration gates must be a bounded string list');
    return c as unknown as UpdateConfiguration;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function base64(value: unknown, label: string, max: number): Buffer {
  const s = text(value,label,max * 2); if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) throw new Error(`${label} is not canonical base64`);
  const b = Buffer.from(s,'base64'); if (!b.length || b.length > max || b.toString('base64') !== s) throw new Error(`${label} is invalid`); return b;
}
export function verifyUpdateManifest(raw: unknown, configuration: UpdateConfiguration, now = Date.now()): { envelope: SignedUpdateManifest; manifest: UpdateManifest } {
  const e = record(raw,'Signed update envelope'); strictKeys(e,['keyId','payload','signature'],'Signed update envelope');
  const keyId=text(e.keyId,'Release key identifier',100), pem=configuration.publicKeys?.[keyId]; if (!pem) throw new Error('Update was signed by an untrusted release key');
  const key=createPublicKey(pem); if (key.asymmetricKeyType !== 'ed25519') throw new Error('Release verification requires an Ed25519 public key');
  const payload=base64(e.payload,'Manifest payload',MAX_MANIFEST),signature=base64(e.signature,'Manifest signature',64);
  if (signature.length!==64 || !verify(null,payload,key,signature)) throw new Error('Update manifest signature is invalid');
  const m=record(JSON.parse(DECODER.decode(payload)),'Update manifest'); strictKeys(m,['schemaVersion','appId','version','channel','releasedAt','issuedAt','expiresAt','minimumVersion','artifacts'],'Update manifest');
  if(m.schemaVersion!==1 || m.appId!==configuration.appId || m.channel!==configuration.channel) throw new Error('Update application, channel, or schema does not match this build');
  const v=version(m.version); if(configuration.channel==='stable' && v.split('+')[0].includes('-')) throw new Error('A stable release cannot be a prerelease');
  const released=Date.parse(text(m.releasedAt,'Release date',100)),issued=Date.parse(text(m.issuedAt,'Manifest issue date',100)),expires=Date.parse(text(m.expiresAt,'Manifest expiry',100));
  if (!Number.isFinite(released) || !Number.isFinite(issued) || !Number.isFinite(expires) || released>issued+5*60*1000 || issued>now+5*60*1000 || expires<=now || expires<=issued || expires-issued>90*24*60*60*1000) throw new Error('Update manifest is expired or has invalid release dates');
  if(m.minimumVersion!==undefined) version(m.minimumVersion);
  if(!Array.isArray(m.artifacts) || !m.artifacts.length || m.artifacts.length>8) throw new Error('Update artifacts must be a bounded nonempty list');
  const allowedOrigins=origins(configuration);const identities=new Set<string>();
  const artifacts=m.artifacts.map(value=>{
    const a=record(value,'Update artifact');strictKeys(a,['platform','architecture','format','url','sha256','size','bundlePath','signing'],'Update artifact');
    if(!['darwin','win32'].includes(String(a.platform)) || !['arm64','x64'].includes(String(a.architecture)) || a.format!=='zip') throw new Error('Unsupported artifact platform, architecture, or format');
    const identity=`${a.platform}:${a.architecture}`;if(identities.has(identity)) throw new Error('Duplicate platform/architecture artifact');identities.add(identity);
    if(!allowedOrigins.has(https(text(a.url,'Artifact URL')).origin)) throw new Error('Artifact URL origin is not pinned by this build');
    if(!/^[a-f0-9]{64}$/.test(text(a.sha256,'Artifact SHA-256',64))) throw new Error('Artifact SHA-256 is invalid');
    integer(a.size,'Artifact size',configuration.maxDownloadBytes??DEFAULT_DOWNLOAD);
    const bundlePath=text(a.bundlePath,'Bundle path',200); if(bundlePath.includes('/') || bundlePath.includes('\\') || bundlePath==='.' || bundlePath==='..' || /[:\u0000-\u001f]/.test(bundlePath)) throw new Error('Bundle path must be a single safe directory name');
    const s=record(a.signing,'Artifact signing');strictKeys(s,['type','teamId','certificateThumbprint','executable'],'Artifact signing');
    if(a.platform==='darwin' && (s.type!=='developer-id' || !bundlePath.endsWith('.app') || !/^[A-Z0-9]{10}$/.test(String(s.teamId)) || s.teamId!==configuration.signing?.darwinTeamId)) throw new Error('macOS artifact must match the pinned Developer ID team');
    if(a.platform==='win32' && (s.type!=='authenticode' || typeof s.certificateThumbprint!=='string' || s.certificateThumbprint.toUpperCase()!==configuration.signing?.windowsCertificateThumbprint?.toUpperCase() || s.executable!=='Watson.exe')) throw new Error('Windows artifact must match the pinned Authenticode identity');
    return a as unknown as UpdateArtifact;
  });
  return {envelope:e as unknown as SignedUpdateManifest,manifest:{...m,version:v,artifacts} as unknown as UpdateManifest};
}
function within(root: string, child: string): boolean { const r=relative(resolve(root),resolve(child));return r==='' || !r.startsWith(`..${sep}`)&&r!=='..'&&!isAbsolute(r); }
function safeArchiveName(name: string): string {
  if(!name || name.length>4096 || name.includes('\\') || name.startsWith('/') || /[:\u0000-\u001f]/.test(name)) throw new Error('Unsafe ZIP entry path');
  const cleaned=name.endsWith('/')?name.slice(0,-1):name;
  if(cleaned.split('/').some(part=>!part||part==='.'||part==='..'||part.endsWith('.')||part.endsWith(' ')||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('ZIP entry contains an unsafe path component');
  return cleaned;
}
async function readExact(handle: Awaited<ReturnType<typeof open>>,position:number,length:number):Promise<Buffer>{const data=Buffer.alloc(length);const result=await handle.read(data,0,length,position);if(result.bytesRead!==length)throw new Error('ZIP structure is truncated');return data;}
export async function inspectUpdateZip(path: string, artifact: UpdateArtifact, configuration: UpdateConfiguration, options: { allowUnwrappedWindows?: boolean } = {}): Promise<ZipEntry[]> {
  const file=await open(path,'r');try{
    const info=await file.stat();if(info.size!==artifact.size || info.size>(configuration.maxDownloadBytes??DEFAULT_DOWNLOAD))throw new Error('ZIP file size does not match its signed manifest');
    const tailSize=Math.min(info.size,65557),tail=await readExact(file,info.size-tailSize,tailSize);let end=-1;
    for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50 && i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break;}
    if(end<0)throw new Error('ZIP end record is missing');const count=tail.readUInt16LE(end+10),centralSize=tail.readUInt32LE(end+12),centralOffset=tail.readUInt32LE(end+16);
    if(tail.readUInt16LE(end+4)||tail.readUInt16LE(end+6)||tail.readUInt16LE(end+8)!==count||count===65535||centralSize===0xffffffff||centralOffset===0xffffffff)throw new Error('Multi-disk and ZIP64 update archives are unsupported');
    if(!count||count>(configuration.maxEntries??100000)||centralSize>32*1024*1024||centralOffset+centralSize!==info.size-tailSize+end)throw new Error('ZIP directory exceeds its permitted bounds');
    const central=await readExact(file,centralOffset,centralSize);let offset=0,total=0;const entries:ZipEntry[]=[];const names=new Set<string>();
    for(let i=0;i<count;i++){
      if(offset+46>central.length||central.readUInt32LE(offset)!==0x02014b50)throw new Error('ZIP central entry is invalid');
      const flags=central.readUInt16LE(offset+8),method=central.readUInt16LE(offset+10),crc=central.readUInt32LE(offset+16),compressed=central.readUInt32LE(offset+20),size=central.readUInt32LE(offset+24),nameLength=central.readUInt16LE(offset+28),extra=central.readUInt16LE(offset+30),comment=central.readUInt16LE(offset+32),localOffset=central.readUInt32LE(offset+42);
      if(flags&1 || ![0,8].includes(method) || offset+46+nameLength+extra+comment>central.length || compressed===0xffffffff || size===0xffffffff || localOffset===0xffffffff || central.readUInt16LE(offset+34)!==0)throw new Error('Encrypted, unsupported, or malformed ZIP entry');
      const rawName=central.subarray(offset+46,offset+46+nameLength),decoded=DECODER.decode(rawName),name=safeArchiveName(decoded),key=name.normalize('NFC').toLowerCase();
      if(names.has(key))throw new Error('Duplicate or case-colliding ZIP entry');names.add(key);
      const inBundle=name===artifact.bundlePath||name.startsWith(`${artifact.bundlePath}/`),metadataRoot=`__MACOSX/${artifact.bundlePath}`;const metadata=artifact.platform==='darwin'&&(name==='__MACOSX'||name===metadataRoot||name.startsWith(`${metadataRoot}/`));if(!inBundle&&!metadata&&!(options.allowUnwrappedWindows&&artifact.platform==='win32'))throw new Error('ZIP contains files outside the signed application bundle');
      total+=size;if(total>(configuration.maxExtractedBytes??DEFAULT_EXTRACTED)||size>(configuration.maxEntryBytes??DEFAULT_ENTRY))throw new Error('ZIP expands beyond its permitted bounds');
      const mode=central.readUInt32LE(offset+38)>>>16,type=mode&0xf000,directory=decoded.endsWith('/')||type===0x4000,isLink=type===0xa000;
      if(metadata&&(!directory&&!basename(name).startsWith('._')||isLink))throw new Error('ZIP AppleDouble metadata has an unsupported entry');
      if(type && ![0x8000,0x4000,0xa000].includes(type) || isLink && (artifact.platform!=='darwin'||size>4096))throw new Error('ZIP contains unsupported file types');
      if(directory && (size||compressed))throw new Error('ZIP directory contains data');
      const local=await readExact(file,localOffset,30);if(local.readUInt32LE(0)!==0x04034b50||local.readUInt16LE(6)!==flags||local.readUInt16LE(8)!==method||local.readUInt16LE(26)!==nameLength)throw new Error('ZIP local header does not match its central entry');
      const localName=await readExact(file,localOffset+30,nameLength);if(!rawName.equals(localName))throw new Error('ZIP local entry name mismatch');
      const dataOffset=localOffset+30+nameLength+local.readUInt16LE(28);if(dataOffset+compressed>centralOffset)throw new Error('ZIP entry data crosses its central directory');
      entries.push({name,metadata,directory,symlink:isLink,mode,method,crc,compressed,size,dataOffset});offset+=46+nameLength+extra+comment;
    }
    if(offset!==central.length)throw new Error('ZIP directory has unexpected trailing data');
    for(const link of entries.filter(e=>e.symlink))if(entries.some(e=>e.name.startsWith(`${link.name}/`)))throw new Error('ZIP writes through a symbolic-link ancestor');
    const ranges=entries.filter(e=>e.compressed).map(e=>({start:e.dataOffset,end:e.dataOffset+e.compressed})).sort((a,b)=>a.start-b.start);for(let i=1;i<ranges.length;i++)if(ranges[i].start<ranges[i-1].end)throw new Error('ZIP entry data ranges overlap');
    return entries;
  }finally{await file.close();}
}
const CRC_TABLE=Array.from({length:256},(_,n)=>{let v=n;for(let i=0;i<8;i++)v=(v&1)?0xedb88320^(v>>>1):v>>>1;return v>>>0;});
class EntryGuard extends Transform {
  count=0;crc=0xffffffff;
  constructor(private entry:ZipEntry){super();}
  _transform(chunk:Buffer,_encoding:BufferEncoding,callback:(error?:Error|null,data?:Buffer)=>void){this.count+=chunk.length;if(this.count>this.entry.size)return callback(new Error('ZIP entry exceeds its declared size'));for(const byte of chunk)this.crc=CRC_TABLE[(this.crc^byte)&255]^(this.crc>>>8);callback(null,chunk);}
  _flush(callback:(error?:Error|null)=>void){callback(this.count!==this.entry.size||((this.crc^0xffffffff)>>>0)!==this.entry.crc?new Error('ZIP entry size or CRC does not match'):null);}
}
export async function extractUpdateZip(archive:string,root:string,artifact:UpdateArtifact,configuration:UpdateConfiguration):Promise<string>{
  const entries=await inspectUpdateZip(archive,artifact,configuration);await mkdir(root,{recursive:false,mode:0o700});
  try{
    for(const entry of entries.filter(e=>!e.symlink&&!e.metadata)){
      const destination=resolve(root,entry.name);if(!within(root,destination))throw new Error('ZIP path escapes the extraction root');
      if(entry.directory){await mkdir(destination,{recursive:true,mode:0o755});continue;}
      await mkdir(dirname(destination),{recursive:true,mode:0o755});
      const guard=new EntryGuard(entry);const writer=createWriteStream(destination,{flags:'wx',mode:entry.mode&0o111?0o755:0o644});
      if(!entry.compressed){writer.end();await new Promise<void>((res,rej)=>{writer.on('finish',res);writer.on('error',rej);});if(entry.size||entry.crc)throw new Error('Empty ZIP entry has invalid metadata');}
      else{const stream=createReadStream(archive,{start:entry.dataOffset,end:entry.dataOffset+entry.compressed-1});if(entry.method===8)await pipeline(stream,createInflateRaw(),guard,writer);else await pipeline(stream,guard,writer);}
      await chmod(destination,entry.mode&0o111?0o755:0o644);
    }
    for(const entry of entries.filter(e=>e.symlink)){
      const temporary=join(root,`.link-${randomUUID()}`);const guard=new EntryGuard(entry);const stream=createReadStream(archive,{start:entry.dataOffset,end:entry.dataOffset+entry.compressed-1});if(entry.method===8)await pipeline(stream,createInflateRaw(),guard,createWriteStream(temporary,{flags:'wx',mode:0o600}));else await pipeline(stream,guard,createWriteStream(temporary,{flags:'wx',mode:0o600}));
      const target=DECODER.decode(await readFile(temporary));await rm(temporary);const destination=resolve(root,entry.name);
      if(!target||isAbsolute(target)||target.includes('\\')||/[\u0000-\u001f]/.test(target)||!within(root,resolve(dirname(destination),target)))throw new Error('ZIP symbolic link escapes the extraction root');
      await mkdir(dirname(destination),{recursive:true,mode:0o755});await symlink(target,destination);
    }
    for(const entry of entries.filter(e=>e.symlink))if(!within(await realpath(root),await realpath(resolve(root,entry.name))))throw new Error('ZIP symbolic link resolves outside the extraction root');
    const bundle=join(root,artifact.bundlePath);if(!(await lstat(bundle)).isDirectory())throw new Error('ZIP does not contain an application directory');return bundle;
  }catch(error){await rm(root,{recursive:true,force:true});throw error;}
}
export async function hashFile(path:string):Promise<string>{const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
function architectures(buffer:Buffer):string[]{
  if(buffer.length<8)throw new Error('Application executable is truncated');const big=buffer.readUInt32BE(0);
  if(big===0xcafebabe||big===0xcafebabf){const count=buffer.readUInt32BE(4),stride=big===0xcafebabe?20:32;if(count>20||8+count*stride>buffer.length)throw new Error('Mach-O architecture table is invalid');return Array.from({length:count},(_,i)=>buffer.readUInt32BE(8+i*stride)).map(cpu=>cpu===0x100000c?'arm64':cpu===0x1000007?'x64':'unknown');}
  if(buffer.readUInt32LE(0)===0xfeedfacf)return [buffer.readUInt32LE(4)===0x100000c?'arm64':buffer.readUInt32LE(4)===0x1000007?'x64':'unknown'];throw new Error('macOS application executable is not Mach-O');
}
async function prefix(path:string,size=4096):Promise<Buffer>{const h=await open(path,'r');try{const b=Buffer.alloc(size);const r=await h.read(b,0,size,0);return b.subarray(0,r.bytesRead);}finally{await h.close();}}
export async function verifyPlatformArtifact(bundle:string,artifact:UpdateArtifact,manifest:UpdateManifest,configuration:UpdateConfiguration):Promise<void>{
  if(artifact.platform==='darwin'){
    if(process.platform!=='darwin')throw new Error('macOS release verification requires macOS');
    await run('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{timeout:120000,maxBuffer:256*1024});
    const signature=await run('/usr/bin/codesign',['-dv','--verbose=4',bundle],{timeout:30000,maxBuffer:256*1024});const details=signature.stdout+'\n'+signature.stderr;
    if(!details.split('\n').includes(`Identifier=${configuration.appId}`)||!details.split('\n').includes(`TeamIdentifier=${artifact.signing.teamId}`)||!details.includes('Authority=Developer ID Application:'))throw new Error('macOS application signature does not match the pinned identity');
    const assessment=await run('/usr/sbin/spctl',['--assess','--type','execute','--verbose=2',bundle],{timeout:120000,maxBuffer:256*1024});if(!(assessment.stdout+'\n'+assessment.stderr).includes('source=Notarized Developer ID'))throw new Error('macOS update requires a notarized Developer ID assessment');await run('xcrun',['stapler','validate',bundle],{timeout:120000,maxBuffer:256*1024});
    const plist=await run('/usr/bin/plutil',['-convert','json','-o','-',join(bundle,'Contents','Info.plist')],{timeout:30000,maxBuffer:256*1024});const info=record(JSON.parse(plist.stdout),'Application Info.plist');
    if(info.CFBundleIdentifier!==manifest.appId || info.CFBundleShortVersionString!==manifest.version)throw new Error('macOS application identifier or version does not match the signed manifest');
    const executable=text(info.CFBundleExecutable,'Application executable',200);if(executable.includes('/')||executable.includes('\\')||executable==='.'||executable==='..')throw new Error('Application executable path is invalid');
    if(!architectures(await prefix(join(bundle,'Contents','MacOS',executable))).includes(artifact.architecture))throw new Error('macOS application architecture does not match the signed manifest');
  }else{
    if(process.platform!=='win32')throw new Error('Windows release verification requires Windows');
    const executable=join(bundle,artifact.signing.executable!);const head=await prefix(executable);if(head.length<64||head.readUInt16LE(0)!==0x5a4d)throw new Error('Windows application executable is not PE');const offset=head.readUInt32LE(60);if(offset+6>head.length||head.readUInt32LE(offset)!==0x4550)throw new Error('Windows PE architecture table is invalid');const machine=head.readUInt16LE(offset+4);if(machine!==(artifact.architecture==='arm64'?0xaa64:0x8664))throw new Error('Windows application architecture does not match');
    const script="$s=Get-AuthenticodeSignature -LiteralPath $env:WATSON_VERIFY_EXECUTABLE; $v=(Get-Item -LiteralPath $env:WATSON_VERIFY_EXECUTABLE).VersionInfo; @{Status=$s.Status.ToString();Thumbprint=$s.SignerCertificate.Thumbprint;ProductName=$v.ProductName;ProductVersion=$v.ProductVersion}|ConvertTo-Json -Compress";
    const result=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,WATSON_VERIFY_EXECUTABLE:executable},timeout:120000,maxBuffer:256*1024});const info=record(JSON.parse(result.stdout),'Authenticode signature');
    if(info.Status!=='Valid'||String(info.Thumbprint).toUpperCase()!==artifact.signing.certificateThumbprint!.toUpperCase()||info.ProductName!=='Watson'||normalProductVersion(info.ProductVersion)!==manifest.version)throw new Error('Windows signature or product version does not match the signed manifest');
  }
}
async function syncDirectory(path:string){try{const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}}catch(error){if(process.platform!=='win32')throw error;}}
async function atomicJson(path:string,value:unknown){await mkdir(dirname(path),{recursive:true,mode:0o700});const temporary=`${path}.${randomUUID()}.tmp`;const h=await open(temporary,'wx',0o600);try{await h.writeFile(JSON.stringify(value,null,2)+'\n');await h.sync();}finally{await h.close();}await rename(temporary,path);await syncDirectory(dirname(path));}
function selectArtifact(manifest:UpdateManifest,platform:string,architecture:string):UpdateArtifact{const a=manifest.artifacts.find(a=>a.platform===platform&&a.architecture===architecture);if(!a)throw new Error('This release has no artifact for the current platform and architecture');return a;}

export class WatsonUpdater {
  private value:UpdateStatus;private busy=false;private manifest?:UpdateManifest;private envelope?:SignedUpdateManifest;private artifact?:UpdateArtifact;private persisted:PersistedState;private readonly directory:string;private readonly fetcher:typeof globalThis.fetch;private readonly verifier:ArtifactVerifier;private readonly now:()=>number;
  constructor(private options:UpdaterOptions){
    version(options.currentVersion);this.directory=join(options.directory,'updates');this.fetcher=options.fetch??globalThis.fetch;this.verifier=options.verifyArtifact??verifyPlatformArtifact;this.now=options.now??Date.now;
    const platform=options.platform??process.platform,architecture=options.architecture??process.arch,gates=configurationGates(options.configuration,platform);
    if(!['arm64','x64'].includes(architecture))gates.push('This architecture is not supported by the update feed.');
    this.value={phase:gates.length?'unconfigured':'idle',configured:!gates.length,currentVersion:options.currentVersion,platform,architecture,message:gates.length?'Update distribution is awaiting release configuration.':'Ready to check for updates.',configurationGates:gates,readyToInstall:false};this.persisted={schemaVersion:1,appId:options.configuration?.appId??'com.watson.app'};
  }
  status():UpdateStatus{return structuredClone(this.value);}
  private set(patch:Partial<UpdateStatus>){this.value={...this.value,...patch};this.options.onStatus?.(this.status());return this.status();}
  private assertReady(){if(!this.value.configured||!this.options.configuration)throw new Error(this.value.configurationGates.join(' '));return this.options.configuration;}
  private async save(){await atomicJson(join(this.directory,'state.json'),this.persisted);}
  private async cleanupStage(stageId:string):Promise<boolean>{
    const directory=join(this.directory,stageId);try{
      for(const entry of await readdir(directory,{withFileTypes:true})){
        if(!entry.isDirectory()||!/^installer-[0-9a-f-]{36}$/.test(entry.name))continue;
        try{const path=join(directory,entry.name,'ready.json');const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>4096)return false;const ready=record(JSON.parse(await readFile(path,'utf8')),'Installer readiness');if(typeof ready.pid==='number'&&processRunning(ready.pid))return false;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return false;}
      }
      await rm(directory,{recursive:true,force:true});return true;
    }catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT';}
  }
  private deferCleanup(attempt=0){const timer=setTimeout(()=>{if(this.busy){if(attempt<10)this.deferCleanup(attempt+1);return;}this.busy=true;void(async()=>{const remaining:string[]=[];for(const id of this.persisted.cleanupStageIds??[])if(!await this.cleanupStage(id))remaining.push(id);this.persisted.cleanupStageIds=remaining;await this.save();if(remaining.length&&attempt<10)this.deferCleanup(attempt+1);})().catch(()=>{}).finally(()=>{this.busy=false;});},5000);timer.unref();}

  private async transaction(action:()=>Promise<UpdateStatus>):Promise<UpdateStatus>{if(this.busy)throw new Error('An update operation is already running');this.busy=true;try{return await action();}catch(error){return this.set({phase:'error',message:(error as Error).message,readyToInstall:false});}finally{this.busy=false;}}
  private async response(url:string,maximum:number):Promise<Response>{https(url);const response=await this.fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(this.options.configuration?.requestTimeoutMs??120000),headers:{Accept:'application/json, application/octet-stream'}});if(response.status>=300&&response.status<400)throw new Error('Update server redirects are not permitted');if(!response.ok||!response.body)throw new Error(`Update server returned HTTP ${response.status}`);if(response.url&&new URL(response.url).origin!==new URL(url).origin)throw new Error('Update response origin changed');const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>maximum))throw new Error('Update response exceeds its permitted size');return response;}
  async restore():Promise<UpdateStatus>{return this.transaction(async()=>{
    const configuration=this.assertReady();try{const raw=await readFile(join(this.directory,'state.json'));if(raw.length>MAX_MANIFEST*2)throw new Error('Stored update metadata is too large');const state=record(JSON.parse(DECODER.decode(raw)),'Stored update state');if(state.schemaVersion!==1||state.appId!==configuration.appId)throw new Error('Stored updater application identity mismatch');if(state.highestVersion!==undefined)version(state.highestVersion);if(state.cleanupStageIds!==undefined&&(!Array.isArray(state.cleanupStageIds)||state.cleanupStageIds.length>20||state.cleanupStageIds.some(id=>typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id))))throw new Error('Stored cleanup stage identifiers are invalid');this.persisted=state as unknown as PersistedState;if(this.persisted.cleanupStageIds?.length)this.deferCleanup();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const staged=this.persisted.staged;if(!staged)return this.status();if(!/^[0-9a-f-]{36}$/.test(staged.stageId))throw new Error('Stored update stage is invalid');
    const verified=verifyUpdateManifest(staged.envelope,configuration,this.now());const artifact=selectArtifact(verified.manifest,this.value.platform,this.value.architecture);if(compareVersions(verified.manifest.version,this.value.currentVersion)<=0){if(!await this.cleanupStage(staged.stageId)){this.persisted.cleanupStageIds=[...new Set([...(this.persisted.cleanupStageIds??[]),staged.stageId])];this.deferCleanup();}delete this.persisted.staged;await this.save();return this.set({phase:'current',message:'Watson is up to date.'});}
    const stage=join(this.directory,staged.stageId);if(await hashFile(join(stage,'artifact.zip'))!==artifact.sha256)throw new Error('Staged artifact hash changed');await this.verifier(join(stage,'extracted',artifact.bundlePath),artifact,verified.manifest,configuration);
    this.manifest=verified.manifest;this.envelope=verified.envelope;this.artifact=artifact;return this.set({phase:'staged',availableVersion:verified.manifest.version,stagedVersion:verified.manifest.version,readyToInstall:true,message:'Verified update is staged. Installation requires closing Watson.'});
  });}
  async check():Promise<UpdateStatus>{return this.transaction(async()=>{
    const configuration=this.assertReady();this.set({phase:'checking',message:'Checking the signed release feed.',readyToInstall:false});const response=await this.response(configuration.feedUrl!,MAX_MANIFEST);let size=0;const chunks:Buffer[]=[];for await(const chunk of response.body! as unknown as AsyncIterable<Uint8Array>){size+=chunk.length;if(size>MAX_MANIFEST)throw new Error('Update manifest exceeds its permitted size');chunks.push(Buffer.from(chunk));}
    const result=verifyUpdateManifest(JSON.parse(DECODER.decode(Buffer.concat(chunks))),configuration,this.now());const manifest=result.manifest,artifact=selectArtifact(manifest,this.value.platform,this.value.architecture);
    if(manifest.minimumVersion&&compareVersions(this.value.currentVersion,manifest.minimumVersion)<0)throw new Error('This release requires a newer base version; use the managed installer.');
    if(this.persisted.highestVersion&&compareVersions(manifest.version,this.persisted.highestVersion)<0)throw new Error('Update feed attempted to replay an older release');
    this.persisted.highestVersion=manifest.version;await this.save();this.manifest=manifest;this.envelope=result.envelope;this.artifact=artifact;
    const current=compareVersions(manifest.version,this.value.currentVersion)<=0;return this.set({phase:current?'current':'available',availableVersion:current?undefined:manifest.version,lastCheckedAt:new Date(this.now()).toISOString(),message:current?'Watson is up to date.':`Watson ${manifest.version} is available.`,readyToInstall:false});
  });}
  async stage():Promise<UpdateStatus>{return this.transaction(async()=>{
    const configuration=this.assertReady();if(!this.manifest||!this.envelope||!this.artifact||compareVersions(this.manifest.version,this.value.currentVersion)<=0)throw new Error('Check for an available update before downloading');verifyUpdateManifest(this.envelope,configuration,this.now());
    const artifact=this.artifact,manifest=this.manifest,id=randomUUID(),stage=join(this.directory,id);await mkdir(stage,{recursive:true,mode:0o700});const temporary=join(stage,'download.part');
    try{
      this.set({phase:'downloading',downloadedBytes:0,totalBytes:artifact.size,readyToInstall:false,message:'Downloading the verified release artifact.'});const response=await this.response(artifact.url,artifact.size);let size=0;const hash=createHash('sha256');const file=await open(temporary,'wx',0o600);
      try{for await(const chunk of response.body! as unknown as AsyncIterable<Uint8Array>){size+=chunk.length;if(size>artifact.size)throw new Error('Update download exceeds its signed size');hash.update(chunk);let offset=0;while(offset<chunk.length){const result=await file.write(chunk,offset,chunk.length-offset);if(!result.bytesWritten)throw new Error('Update download could not be written');offset+=result.bytesWritten;}this.set({downloadedBytes:size});}await file.sync();}finally{await file.close();}
      if(size!==artifact.size||hash.digest('hex')!==artifact.sha256)throw new Error('Update artifact size or SHA-256 does not match its signed manifest');await rename(temporary,join(stage,'artifact.zip'));this.set({phase:'verifying',message:'Verifying bundle signature, identity, version, and architecture.'});
      const candidate=await extractUpdateZip(join(stage,'artifact.zip'),join(stage,'extracted'),artifact,configuration);await this.verifier(candidate,artifact,manifest,configuration);
      const previous=this.persisted.staged;const record:StagingRecord={schemaVersion:1,currentVersion:this.value.currentVersion,stageId:id,envelope:this.envelope};await atomicJson(join(stage,'stage.json'),record);this.persisted.staged=record;await this.save();if(previous&&previous.stageId!==id&&/^[0-9a-f-]{36}$/.test(previous.stageId))await rm(join(this.directory,previous.stageId),{recursive:true,force:true});return this.set({phase:'staged',stagedVersion:manifest.version,stagedAt:new Date(this.now()).toISOString(),readyToInstall:true,message:'Verified update is staged. Installation requires closing Watson.'});
    }catch(error){await rm(stage,{recursive:true,force:true});throw error;}
  });}
  async clear():Promise<UpdateStatus>{return this.transaction(async()=>{const stage=this.persisted.staged;if(stage&&/^[0-9a-f-]{36}$/.test(stage.stageId))await rm(join(this.directory,stage.stageId),{recursive:true,force:true});delete this.persisted.staged;await this.save();return this.set({phase:this.value.configured?'idle':'unconfigured',stagedVersion:undefined,stagedAt:undefined,downloadedBytes:undefined,totalBytes:undefined,readyToInstall:false,message:'Staged update removed. The installed application is unchanged.'});});}
  async prepareInstall(options:PrepareInstallOptions):Promise<InstallerLaunchPlan>{
    if(this.busy)throw new Error('An update operation is already running');this.busy=true;try{
      const configuration=this.assertReady(),stage=this.stagedDirectory();if(!stage||!this.value.readyToInstall)throw new Error('A verified staged update is required before installation');
      this.set({phase:'preparing-install',message:'Preparing a verified update helper. Watson will close before installation.'});
      const plan=await prepareUpdateInstaller({...options,stageDirectory:stage,configuration,currentVersion:this.value.currentVersion,platform:this.value.platform,architecture:this.value.architecture});
      return plan;
    }catch(error){this.set({phase:'error',message:(error as Error).message,readyToInstall:false});throw error;}finally{this.busy=false;}
  }
  stagedDirectory():string|undefined{return this.persisted.staged?join(this.directory,this.persisted.staged.stageId):undefined;}
}

export interface InstallOptions {
  stageDirectory:string;destination:string;configuration:UpdateConfiguration;currentVersion:string;parentPid:number;platform?:string;architecture?:string;
  verifyArtifact?:ArtifactVerifier;isProcessRunning?:(pid:number)=>boolean;verifyInstalled?:(destination:string,appId:string,currentVersion:string)=>Promise<void>;afterSwap?:()=>Promise<void>;
}
interface InstallJournal { schemaVersion:1; state:'prepared'|'old-moved'|'installed'|'rolled-back'; destination:string;backup:string;temporary:string;version:string; }
function processRunning(pid:number){try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;return true;}}
function normalProductVersion(value:unknown){const text=String(value);return /^\d+\.\d+\.\d+\.0$/.test(text)?text.slice(0,-2):text;}
async function installedIdentity(destination:string,appId:string,currentVersion:string,configuration:UpdateConfiguration){
  if(process.platform==='darwin'){await run('/usr/bin/codesign',['--verify','--deep','--strict',destination],{timeout:120000,maxBuffer:256*1024});const signature=await run('/usr/bin/codesign',['-dv','--verbose=4',destination],{timeout:30000,maxBuffer:256*1024});const details=signature.stdout+'\n'+signature.stderr;if(!details.split('\n').includes(`Identifier=${appId}`)||!details.split('\n').includes(`TeamIdentifier=${configuration.signing?.darwinTeamId}`)||!details.includes('Authority=Developer ID Application:'))throw new Error('Installed or rollback bundle does not match the pinned Developer ID identity');const result=await run('/usr/bin/plutil',['-convert','json','-o','-',join(destination,'Contents','Info.plist')],{timeout:30000,maxBuffer:256*1024});const info=record(JSON.parse(result.stdout),'Installed application');if(info.CFBundleIdentifier!==appId||info.CFBundleShortVersionString!==currentVersion)throw new Error('Installed application identity or version changed');}
  else { const script="$s=Get-AuthenticodeSignature -LiteralPath $env:WATSON_VERIFY_EXECUTABLE; $v=(Get-Item -LiteralPath $env:WATSON_VERIFY_EXECUTABLE).VersionInfo; @{Status=$s.Status.ToString();Thumbprint=$s.SignerCertificate.Thumbprint;ProductName=$v.ProductName;ProductVersion=$v.ProductVersion}|ConvertTo-Json -Compress";const result=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,WATSON_VERIFY_EXECUTABLE:join(destination,'Watson.exe')},timeout:30000,maxBuffer:256*1024});const info=record(JSON.parse(result.stdout),'Installed application identity');if(info.Status!=='Valid'||String(info.Thumbprint).toUpperCase()!==configuration.signing?.windowsCertificateThumbprint?.toUpperCase()||info.ProductName!=='Watson'||normalProductVersion(info.ProductVersion)!==currentVersion)throw new Error('Installed application identity or version changed'); }
}
export async function installStagedUpdate(options:InstallOptions):Promise<{version:string;backup:string;journal:string}>{
  const running=options.isProcessRunning??processRunning;if(!Number.isSafeInteger(options.parentPid)||options.parentPid<=0||running(options.parentPid))throw new Error('Watson must be closed before replacing its installed application');
  const platform=options.platform??process.platform,architecture=options.architecture??process.arch,gates=configurationGates(options.configuration,platform);if(gates.length)throw new Error(gates.join(' '));
  const raw=await readFile(join(options.stageDirectory,'stage.json'));if(raw.length>MAX_MANIFEST*2)throw new Error('Staged metadata is too large');const staged=record(JSON.parse(DECODER.decode(raw)),'Staged update');if(staged.schemaVersion!==1||staged.currentVersion!==options.currentVersion)throw new Error('Staged update base version changed');
  const {manifest}=verifyUpdateManifest(staged.envelope,options.configuration);const artifact=selectArtifact(manifest,platform,architecture);if(compareVersions(manifest.version,options.currentVersion)<=0)throw new Error('Installing a downgrade or same version is not permitted');
  if(basename(options.destination)!==artifact.bundlePath||!isAbsolute(options.destination)||(await lstat(options.destination)).isSymbolicLink())throw new Error('Installation target does not match the signed application directory');await (options.verifyInstalled??((path:string,appId:string,version:string)=>installedIdentity(path,appId,version,options.configuration)))(options.destination,options.configuration.appId,options.currentVersion);
  const archive=join(options.stageDirectory,'artifact.zip');if(await hashFile(archive)!==artifact.sha256)throw new Error('Staged artifact SHA-256 changed');
  const parent=dirname(options.destination),id=randomUUID(),temporary=join(parent,`.watson-update-${id}`),backup=join(parent,`.watson-rollback-${id}-${artifact.bundlePath}`),journal=join(parent,`.watson-update-${id}.json`),lockPath=join(parent,`.${artifact.bundlePath}.update-lock`);const lock=await open(lockPath,'wx',0o600);let oldMoved=false,newMoved=false;await lock.writeFile(JSON.stringify({pid:process.pid,id}));await lock.sync();
  const state:InstallJournal={schemaVersion:1,state:'prepared',destination:options.destination,backup,temporary,version:manifest.version};
  try{
    const candidate=await extractUpdateZip(archive,temporary,artifact,options.configuration);await (options.verifyArtifact??verifyPlatformArtifact)(candidate,artifact,manifest,options.configuration);if(running(options.parentPid))throw new Error('Watson is still running; installation was not applied');await atomicJson(journal,state);
    await rename(options.destination,backup);oldMoved=true;state.state='old-moved';await atomicJson(journal,state);await rename(candidate,options.destination);newMoved=true;
    await (options.verifyArtifact??verifyPlatformArtifact)(options.destination,artifact,manifest,options.configuration);await options.afterSwap?.();state.state='installed';await atomicJson(journal,state);await rm(temporary,{recursive:true,force:true});return {version:manifest.version,backup,journal};
  }catch(error){
    if(oldMoved){if(newMoved)await rm(options.destination,{recursive:true,force:true});await rename(backup,options.destination);await (options.verifyInstalled??((path:string,appId:string,version:string)=>installedIdentity(path,appId,version,options.configuration)))(options.destination,options.configuration.appId,options.currentVersion);state.state='rolled-back';await atomicJson(journal,state);}
    await rm(temporary,{recursive:true,force:true});throw error;
  }finally{await lock.close();await rm(lockPath,{force:true});}
}

/** Recover an interrupted directory swap. The caller must supply the trusted
 * destination and expected old version; journal paths do not choose targets. */
export async function recoverInterruptedUpdate(journalPath:string,options:InstallOptions):Promise<'installed'|'rolled-back'|'unchanged'>{
  const running=options.isProcessRunning??processRunning;if(running(options.parentPid))throw new Error('Watson must be closed before recovering an update');
  const parent=dirname(options.destination),match=/^\.watson-update-([0-9a-f-]{36})\.json$/.exec(basename(journalPath));if(!match||resolve(dirname(journalPath))!==resolve(parent))throw new Error('Update journal is not in the trusted installation directory');
  const raw=await readFile(journalPath);if(raw.length>16384)throw new Error('Update journal is too large');const journal=record(JSON.parse(DECODER.decode(raw)),'Update journal');
  const id=match[1],expectedBackup=join(parent,`.watson-rollback-${id}-${basename(options.destination)}`),expectedTemporary=join(parent,`.watson-update-${id}`);
  if(journal.schemaVersion!==1||journal.destination!==options.destination||journal.backup!==expectedBackup||journal.temporary!==expectedTemporary||!['prepared','old-moved','installed','rolled-back'].includes(String(journal.state)))throw new Error('Update journal paths or state are invalid');
  const lockPath=join(parent,`.${basename(options.destination)}.update-lock`);try{const lock=record(JSON.parse(await readFile(lockPath,'utf8')),'Update lock');if(lock.id!==id||typeof lock.pid!=='number'||running(lock.pid))throw new Error('An update installer is still running');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(journal.state==='installed'){const staged=record(JSON.parse(await readFile(join(options.stageDirectory,'stage.json'),'utf8')),'Staged update');const {manifest}=verifyUpdateManifest(staged.envelope,options.configuration);const artifact=selectArtifact(manifest,options.platform??process.platform,options.architecture??process.arch);if(manifest.version!==journal.version)throw new Error('Installed journal version does not match its signed release');await (options.verifyArtifact??verifyPlatformArtifact)(options.destination,artifact,manifest,options.configuration);await rm(expectedTemporary,{recursive:true,force:true});await rm(lockPath,{force:true});return 'installed';}if(journal.state==='rolled-back'){await (options.verifyInstalled??((path:string,appId:string,version:string)=>installedIdentity(path,appId,version,options.configuration)))(options.destination,options.configuration.appId,options.currentVersion);await rm(expectedTemporary,{recursive:true,force:true});await rm(lockPath,{force:true});return 'rolled-back';}
  let backupExists=true;try{await lstat(expectedBackup);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')backupExists=false;else throw error;}
  if(!backupExists){if(journal.state==='old-moved')throw new Error('Rollback application is missing; preserve the journal for manual recovery');await (options.verifyInstalled??((path:string,appId:string,version:string)=>installedIdentity(path,appId,version,options.configuration)))(options.destination,options.configuration.appId,options.currentVersion);await rm(expectedTemporary,{recursive:true,force:true});await rm(lockPath,{force:true});return 'unchanged';}
  await (options.verifyInstalled??((path:string,appId:string,version:string)=>installedIdentity(path,appId,version,options.configuration)))(expectedBackup,options.configuration.appId,options.currentVersion);
  let destinationExists=true;try{await lstat(options.destination);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')destinationExists=false;else throw error;}
  if(destinationExists)await rename(options.destination,join(parent,`.watson-failed-${id}-${basename(options.destination)}`));
  await rename(expectedBackup,options.destination);journal.state='rolled-back';await atomicJson(journalPath,journal);await rm(expectedTemporary,{recursive:true,force:true});await rm(lockPath,{force:true});return 'rolled-back';
}

export interface PrepareInstallOptions { applicationDirectory:string; executablePath:string; runnerSourcePath:string; parentPid:number; verifyCurrent?:(directory:string,appId:string,version:string,configuration:UpdateConfiguration)=>Promise<void>; }
export interface InstallerLaunchPlan { executable:string; runner:string; planFile:string; readyFile:string; nonce:string; }
export interface UpdateRunnerPlan { schemaVersion:1; stageDirectory:string; destination:string; currentVersion:string; parentPid:number; configuration:UpdateConfiguration; platform:string; architecture:string; relaunchExecutable:string; readyFile:string; nonce:string; }
export async function prepareUpdateInstaller(options:PrepareInstallOptions & {stageDirectory:string;configuration:UpdateConfiguration;currentVersion:string;platform:string;architecture:string}):Promise<InstallerLaunchPlan>{
  if(configurationGates(options.configuration,options.platform).length)throw new Error('Release signing and update trust must be configured before preparing an installer');
  if(!Number.isSafeInteger(options.parentPid)||options.parentPid<=0)throw new Error('Installer parent PID is invalid');
  const destination=resolve(options.applicationDirectory),executable=resolve(options.executablePath);
  if(!within(destination,executable)||!within(destination,options.runnerSourcePath)||!isAbsolute(options.runnerSourcePath)||!isAbsolute(options.stageDirectory))throw new Error('Installer inputs must belong to the trusted application/stage directories');
  const metadata=record(JSON.parse(await readFile(join(options.stageDirectory,'stage.json'),'utf8')),'Staged update');const {manifest}=verifyUpdateManifest(metadata.envelope,options.configuration);const artifact=selectArtifact(manifest,options.platform,options.architecture);
  if(metadata.currentVersion!==options.currentVersion||basename(destination)!==artifact.bundlePath||compareVersions(manifest.version,options.currentVersion)<=0||await hashFile(join(options.stageDirectory,'artifact.zip'))!==artifact.sha256)throw new Error('Staged install identity or archive hash changed');
  const currentVerifier=options.verifyCurrent??installedIdentity;await currentVerifier(destination,options.configuration.appId,options.currentVersion,options.configuration);
  const helper=join(options.stageDirectory,`installer-${randomUUID()}`),host=join(helper,'host',basename(destination));await mkdir(dirname(host),{recursive:true,mode:0o700});
  try{
    await cp(destination,host,{recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:true,force:false});await currentVerifier(host,options.configuration.appId,options.currentVersion,options.configuration);
    const runner=join(helper,'update-runner.js');await copyFile(options.runnerSourcePath,runner);await copyFile(join(dirname(options.runnerSourcePath),'updater.js'),join(helper,'updater.js'));
    const plan:UpdateRunnerPlan={schemaVersion:1,stageDirectory:options.stageDirectory,destination,currentVersion:options.currentVersion,parentPid:options.parentPid,configuration:options.configuration,platform:options.platform,architecture:options.architecture,relaunchExecutable:executable,readyFile:join(helper,'ready.json'),nonce:randomUUID()};
    const planFile=join(helper,'install-plan.json');await atomicJson(planFile,plan);return{executable:join(host,relative(destination,executable)),runner,planFile,readyFile:plan.readyFile,nonce:plan.nonce};
  }catch(error){await rm(helper,{recursive:true,force:true});throw error;}
}
export { installedIdentity as verifyCurrentApplication };

/** A successful process spawn is insufficient: wait for the copied runtime to
 * enter Node mode and validate its plan before the main process may quit. */
export async function launchPreparedInstaller(plan:InstallerLaunchPlan,timeoutMs=15000):Promise<ChildProcess>{
  const child=spawn(plan.executable,[plan.runner,'--plan',plan.planFile],{detached:true,stdio:'ignore',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});let terminal=false;
  child.once('exit',()=>{terminal=true;});await new Promise<void>((accept,reject)=>{child.once('spawn',accept);child.once('error',reject);});
  const deadline=Date.now()+timeoutMs;
  while(!terminal&&Date.now()<deadline){
    try{const raw=await readFile(plan.readyFile);if(raw.length>4096)throw new Error('Installer readiness record is too large');const ready=record(JSON.parse(raw.toString('utf8')),'Installer readiness');if(ready.nonce!==plan.nonce||ready.pid!==child.pid||ready.ready!==true)throw new Error('Installer readiness identity mismatch');return child;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){child.kill();throw error;}}
    await new Promise(r=>setTimeout(r,100));
  }
  if(!terminal)child.kill();throw new Error('The verified update helper did not become ready. Watson remains open and its installation is unchanged.');
}
