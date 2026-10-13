import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readdirSync,rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createWatsonServer } from '../src/app.ts';
test('only validated recording uploads receive the longer absolute body deadline; slow JSON is still408 and failed uploads clean up',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'watson-body-timeout-')),directory=join(folder,'audio');const app=createWatsonServer({dbPath:join(folder,'api.sqlite'),port:0,bodyTimeoutMs:100,recordings:{directory,encryptionKey:randomBytes(32).toString('base64'),uploadTimeoutMs:500,maxBytes:2*1024*1024}}),origin=await app.listen();const json=async(path:string,data:unknown,token?:string)=>fetch(origin+'/api/v1/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});
 try{const signup=await json('auth/signup',{email:'timeout@fixture.test',password:'Body-timeout-password-123'});assert.equal(signup.status,201);const account=await signup.json() as any;for(const id of ['slow-valid','too-slow'])assert.equal((await json('meetings',{meeting:{id,title:id,startedAt:new Date().toISOString(),transcript:[],answers:[]}},account.token)).status,201);
  const audio=Buffer.concat([Buffer.from('caff'),randomBytes(256*1024)]);const stream=(wait:number)=>Readable.from((async function*(){yield audio.subarray(0,65536);await new Promise(resolve=>setTimeout(resolve,wait));yield audio.subarray(65536);})());const upload=async(id:string,wait:number)=>fetch(origin+'/api/v1/meetings/'+id+'/recording',{method:'PUT',headers:{Authorization:'Bearer '+account.token,'Content-Type':'audio/x-caf','X-Watson-Expected-Revision':'1','X-Watson-Recording-Consent':'true'},body:stream(wait) as any,duplex:'half'} as any);
  const slow=await upload('slow-valid',250);assert.equal(slow.status,201);assert.equal((await slow.json() as any).recording.size,audio.length);
  const ordinary=await fetch(origin+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:Readable.from((async function*(){yield '{"email":"timeout@fixture.test",';await new Promise(resolve=>setTimeout(resolve,250));yield '"password":"Body-timeout-password-123"}';})()) as any,duplex:'half'} as any);assert.equal(ordinary.status,408);assert.equal((await ordinary.json() as any).error.code,'request_timeout');
  const timedOut=await upload('too-slow',650);assert.equal(timedOut.status,408);await timedOut.text();for(let attempt=0;attempt<40&&readdirSync(directory).some(name=>name.startsWith('.upload-'));attempt++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(readdirSync(directory).filter(name=>name.startsWith('.upload-')).length,0);assert.equal(app.store.get('SELECT COUNT(*) AS count FROM recording_files')!.count,1);
 }finally{await app.close();rmSync(folder,{recursive:true,force:true});}
});
