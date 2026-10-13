import { createReadStream } from 'node:fs';
import { open, stat, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { hashFile, inspectUpdateZip } from './updater';
import type { UpdateArtifact, UpdateConfiguration } from '../shared/update-types';

/** Repackage a Windows electron-builder root ZIP under a single directory.
 * Compressed bytes are streamed unchanged; no application is extracted/run. */
export async function wrapWindowsUpdateZip(input:string,output:string,bundlePath='Watson'){
  if(!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,100}$/.test(bundlePath)||bundlePath.endsWith('.')||bundlePath.endsWith(' '))throw new Error('Windows bundle directory name is invalid');
  const artifact:UpdateArtifact={platform:'win32',architecture:'x64',format:'zip',url:'https://fixture.invalid/source.zip',sha256:await hashFile(input),size:(await stat(input)).size,bundlePath,signing:{type:'authenticode',certificateThumbprint:'0'.repeat(40),executable:'Watson.exe'}};
  const configuration:UpdateConfiguration={enabled:false,appId:'com.watson.app',channel:'stable'};
  const entries=await inspectUpdateZip(input,artifact,configuration,{allowUnwrappedWindows:true});
  if(entries.some(e=>e.name===bundlePath||e.name.startsWith(`${bundlePath}/`)))throw new Error('Input ZIP is already wrapped or collides with the destination directory');
  if(!entries.some(e=>!e.directory&&e.name==='Watson.exe'))throw new Error('Unwrapped Windows archive must contain Watson.exe at its root');
  const file=await open(output,'wx',0o600);let position=0;const central:Buffer[]=[];let centralBytes=0;
  const write=async(buffer:Buffer)=>{let offset=0;while(offset<buffer.length){const result=await file.write(buffer,offset,buffer.length-offset);if(!result.bytesWritten)throw new Error('Unable to write wrapped archive');offset+=result.bytesWritten;}position+=buffer.length;};
  try{
    for(const entry of entries){
      const name=Buffer.from(`${bundlePath}/${entry.name}${entry.directory?'/':''}`),localOffset=position;
      const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(entry.method,8);local.writeUInt16LE(0x21,12);local.writeUInt32LE(entry.crc,14);local.writeUInt32LE(entry.compressed,18);local.writeUInt32LE(entry.size,22);local.writeUInt16LE(name.length,26);await write(local);await write(name);
      let copied=0;if(entry.compressed)for await(const chunk of createReadStream(input,{start:entry.dataOffset,end:entry.dataOffset+entry.compressed-1})){copied+=chunk.length;await write(chunk as Buffer);}if(copied!==entry.compressed)throw new Error('Source ZIP entry is truncated');
      const header=Buffer.alloc(46);header.writeUInt32LE(0x02014b50,0);header.writeUInt16LE(0x314,4);header.writeUInt16LE(20,6);header.writeUInt16LE(0x800,8);header.writeUInt16LE(entry.method,10);header.writeUInt16LE(0x21,14);header.writeUInt32LE(entry.crc,16);header.writeUInt32LE(entry.compressed,20);header.writeUInt32LE(entry.size,24);header.writeUInt16LE(name.length,28);header.writeUInt32LE(((entry.mode<<16)|(entry.directory?16:0))>>>0,38);header.writeUInt32LE(localOffset,42);centralBytes+=header.length+name.length;if(centralBytes>32*1024*1024)throw new Error('Wrapped central directory exceeds its permitted size');central.push(header,name);
    }
    const centralOffset=position;for(const chunk of central)await write(chunk);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralBytes,12);end.writeUInt32LE(centralOffset,16);await write(end);await file.sync();await file.close();
    const result={path:output,bundlePath,entries:entries.length,size:(await stat(output)).size,sha256:await hashFile(output),source:basename(input),sourceSha256:artifact.sha256};await inspectUpdateZip(output,{...artifact,size:result.size,sha256:result.sha256},configuration);return result;
  }catch(error){try{await file.close();}catch{}await rm(output,{force:true});throw error;}
}
