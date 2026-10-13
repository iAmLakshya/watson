import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { configurationGates, hashFile, installStagedUpdate, readUpdateConfiguration, recoverInterruptedUpdate, verifyUpdateManifest } from '../electron/updater';

function argument(name:string){const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];}
async function main(){
  const stage=argument('--stage'),target=argument('--target'),currentVersion=argument('--current-version'),pid=Number(argument('--parent-pid'));
  if(!stage||!target||!currentVersion||!Number.isSafeInteger(pid)||pid<=0)throw new Error('Usage: node --import tsx scripts/install-watson-update.ts --stage directory --target installation-directory --current-version x.y.z --parent-pid previous-watson-pid --config trusted-config.json [--apply | --recover journal]');
  const configuration=await readUpdateConfiguration(resolve(argument('--config')??'config/update-config.json'));const gates=configurationGates(configuration,process.platform);if(gates.length)throw new Error(gates.join(' '));
  const directory=resolve(stage),destination=resolve(target),record=JSON.parse(await readFile(join(directory,'stage.json'),'utf8'));
  const {manifest}=verifyUpdateManifest(record.envelope,configuration!);const artifact=manifest.artifacts.find(a=>a.platform===process.platform&&a.architecture===process.arch);
  if(!artifact||basename(destination)!==artifact.bundlePath||await hashFile(join(directory,'artifact.zip'))!==artifact.sha256)throw new Error('Staged artifact identity, platform, or SHA-256 is invalid');
  const options={stageDirectory:directory,destination,configuration:configuration!,currentVersion,parentPid:pid};const recovery=argument('--recover');
  if(recovery){if(!process.argv.includes('--apply'))throw new Error('Recovery requires --apply after reviewing the journal');console.log(await recoverInterruptedUpdate(resolve(recovery),options));return;}
  if(!process.argv.includes('--apply')){console.log(JSON.stringify({operation:'closed-app staged update',target:destination,from:currentVersion,to:manifest.version,sha256:artifact.sha256,parentPid:pid,apply:false,rollback:'The current bundle is retained in a sibling backup; no relaunch is performed.'},null,2));return;}
  console.log(JSON.stringify(await installStagedUpdate(options),null,2));
}
void main().catch(error=>{console.error(error.message);process.exitCode=1;});
