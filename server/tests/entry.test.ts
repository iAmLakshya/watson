import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
test('production entrypoint starts with connectors and disabled enterprise providers on loopback',async()=>{
  const portProbe=createServer();await new Promise<void>(resolve=>portProbe.listen(0,'127.0.0.1',resolve));const port=(portProbe.address() as {port:number}).port;await new Promise<void>(resolve=>portProbe.close(()=>resolve()));const folder=mkdtempSync(join(tmpdir(),'watson-main-'));const env={...process.env,WATSON_PORT:String(port),WATSON_HOST:'127.0.0.1',WATSON_DB_PATH:join(folder,'entry.sqlite')};for(const key of Object.keys(env))if(key.startsWith('WATSON_')&&!['WATSON_PORT','WATSON_HOST','WATSON_DB_PATH'].includes(key))delete env[key as keyof typeof env];
  const child=spawn(process.execPath,['--experimental-strip-types',fileURLToPath(new URL('../src/main.ts',import.meta.url))],{env,stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
  const ready=new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Entry launch timed out: '+errors)),10000);child.stdout.on('data',()=>{if(output.includes('Watson API listening')){clearTimeout(timeout);resolve();}});child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Entry exited '+code+': '+errors));});});
  try{await ready;assert.ok(output.includes('http://127.0.0.1:'+port));const base=`http://127.0.0.1:${port}/api/v1/`;const health=await fetch(base+'health');assert.equal(health.status,200);const signup=await fetch(base+'auth/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'entry@watson.test',password:'Entry-Watson-password'})});assert.equal(signup.status,201);const account=await signup.json() as {token:string};const status=await fetch(base+'connectors/status',{headers:{Authorization:'Bearer '+account.token}});assert.equal(status.status,200);const connectors=await status.json() as Record<string,unknown>;assert.equal(connectors.googleConfigured,false);assert.equal(connectors.mergeConfigured,false);const billing=await fetch(base+'billing',{headers:{Authorization:'Bearer '+account.token}});assert.equal(billing.status,200);assert.equal((await billing.json() as {configured:boolean}).configured,false);
  }finally{const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGTERM');await exited;rmSync(folder,{recursive:true,force:true});}
});
