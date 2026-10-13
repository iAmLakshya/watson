import { spawn } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { configurationGates, hashFile, installStagedUpdate, verifyCurrentApplication, verifyUpdateManifest } from './updater';
import type { UpdateRunnerPlan } from './updater';

function alive(pid:number){try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}}
async function relaunch(plan:UpdateRunnerPlan){
  const command=plan.platform==='darwin'?'/usr/bin/open':plan.relaunchExecutable;
  const args=plan.platform==='darwin'?['-a',plan.destination]:[];
  const child=spawn(command,args,{cwd:dirname(plan.destination),detached:true,stdio:'ignore',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
  await new Promise<void>((accept,reject)=>{child.once('spawn',accept);child.once('error',reject);});child.unref();
}
async function main(){
  const i=process.argv.indexOf('--plan'),path=i<0?undefined:process.argv[i+1];if(!path)throw new Error('The update runner requires a prepared local plan');
  const bytes=await readFile(resolve(path));if(bytes.length>512*1024)throw new Error('Installer plan exceeds its permitted size');const plan=JSON.parse(bytes.toString('utf8')) as UpdateRunnerPlan;
  if(plan.schemaVersion!==1||plan.platform!==process.platform||plan.architecture!==process.arch||!Number.isSafeInteger(plan.parentPid)||plan.parentPid<=0||typeof plan.destination!=='string'||typeof plan.stageDirectory!=='string'||typeof plan.relaunchExecutable!=='string')throw new Error('Installer plan identity or runtime platform is invalid');
  if(typeof plan.nonce!=='string'||!/^[0-9a-f-]{36}$/.test(plan.nonce)||plan.readyFile!==join(dirname(resolve(path)),'ready.json')||configurationGates(plan.configuration,plan.platform).length)throw new Error('Installer trust/readiness configuration is invalid');
  const staged=JSON.parse(await readFile(join(plan.stageDirectory,'stage.json'),'utf8'));const {manifest}=verifyUpdateManifest(staged.envelope,plan.configuration);const artifact=manifest.artifacts.find(a=>a.platform===plan.platform&&a.architecture===plan.architecture);
  if(!artifact||basename(plan.destination)!==artifact.bundlePath||await hashFile(join(plan.stageDirectory,'artifact.zip'))!==artifact.sha256)throw new Error('Installer stage identity or hash changed');
  await writeFile(`${plan.readyFile}.part`,JSON.stringify({ready:true,nonce:plan.nonce,pid:process.pid})+'\n',{flag:'wx',mode:0o600});await rename(`${plan.readyFile}.part`,plan.readyFile);
  const resultFile=join(dirname(resolve(path)),'result.json');const deadline=Date.now()+120000;
  while(alive(plan.parentPid)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,200));
  if(alive(plan.parentPid))throw new Error('Watson did not close; the current installation was preserved');
  try{
    const result=await installStagedUpdate({...plan,afterSwap:()=>relaunch(plan)});await writeFile(resultFile,JSON.stringify({state:'installed',...result,at:new Date().toISOString()})+'\n',{mode:0o600});
  }catch(error){
    let restored=false;try{await verifyCurrentApplication(plan.destination,plan.configuration.appId,plan.currentVersion,plan.configuration);restored=true;}catch{}
    await writeFile(resultFile,JSON.stringify({state:restored?'rolled-back':'error',message:(error as Error).message,at:new Date().toISOString()})+'\n',{mode:0o600});if(restored)await relaunch(plan);throw error;
  }
}
void main().catch(error=>{console.error((error as Error).message);process.exitCode=1;});
