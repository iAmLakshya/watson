import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { configurationGates, extractUpdateZip, hashFile, readUpdateConfiguration, verifyPlatformArtifact, verifyUpdateManifest } from '../electron/updater';
import type { SignedUpdateManifest, UpdateArtifact, UpdateManifest } from '../shared/update-types';

function argument(name:string){const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];}
async function main(){
  const input=argument('--input'),output=argument('--output'),keyFile=argument('--key-file'),keyId=argument('--key-id');
  if(!input||!output||!keyFile||!keyId)throw new Error('Usage: node --import tsx scripts/create-update-release.ts --input release.json --output signed-manifest.json --config config.json --key-file private.pem --key-id release-key-id');
  const configuration=await readUpdateConfiguration(resolve(argument('--config')??'config/update-config.json'));
  const gates=configurationGates(configuration,process.platform);if(gates.length)throw new Error(gates.join(' '));
  const source=JSON.parse(await readFile(resolve(input),'utf8')) as Omit<UpdateManifest,'artifacts'> & {artifacts:(UpdateArtifact&{localPath:string})[]};
  if(!Array.isArray(source.artifacts)||!source.artifacts.length)throw new Error('Release input needs artifacts with localPath');
  const work=await mkdtemp(join(tmpdir(),'watson-release-verification-'));
  try{
    const artifacts:UpdateArtifact[]=[];
    for(const [index,item] of source.artifacts.entries()){
      if(item.platform!==process.platform)throw new Error('Create platform-specific manifests on their native signing/verification hosts. Foreign platform artifacts are not assumed verified.');
      const path=resolve(item.localPath);const {localPath:_,...metadata}=item;const artifact={...metadata,size:(await stat(path)).size,sha256:await hashFile(path)};
      const candidate=await extractUpdateZip(path,join(work,String(index)),artifact,configuration!);await verifyPlatformArtifact(candidate,artifact,{...source,artifacts:[]},configuration!);artifacts.push(artifact);
    }
    const manifest:UpdateManifest={...source,artifacts};const payload=Buffer.from(JSON.stringify(manifest));const privateKey=createPrivateKey(await readFile(resolve(keyFile)));if(privateKey.asymmetricKeyType!=='ed25519')throw new Error('Manifest signing requires an Ed25519 private key');
    const pinned=configuration!.publicKeys?.[keyId];if(!pinned||!createPublicKey(privateKey).export({format:'der',type:'spki'}).equals(createPublicKey(pinned).export({format:'der',type:'spki'})))throw new Error('Manifest signing key does not match a pinned verification key');
    const envelope:SignedUpdateManifest={keyId,payload:payload.toString('base64'),signature:sign(null,payload,privateKey).toString('base64')};verifyUpdateManifest(envelope,configuration!);
    await writeFile(resolve(output),JSON.stringify(envelope,null,2)+'\n',{flag:'wx',mode:0o644});console.log(`Verified and signed ${manifest.version} manifest at ${resolve(output)}. No artifact or manifest was published.`);
  }finally{await rm(work,{recursive:true,force:true});}
}
void main().catch(error=>{console.error(error.message);process.exitCode=1;});
