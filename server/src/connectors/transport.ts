import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { ApiError, fail, object, type Row } from '../core.ts';
import type { ConnectorOptions, ProviderReply } from './types.ts';

export class ProviderError extends ApiError {
  retryAfter: number;
  constructor(status:number,code:string,retryAfter=0) {super(status,code,code==='reconnect_required'?'The provider authorization expired. Reconnect the account.':code==='provider_rate_limited'?'Provider rate limit reached. Try again later.':'The connector provider request failed.');this.retryAfter=retryAfter;}
}
export function classify(status:number,retryAfter:string|null=null) {
  const seconds=Number(retryAfter);const retryMs=Number.isFinite(seconds)?Math.min(3600000,Math.max(0,seconds)*1000):Math.max(0,Date.parse(retryAfter??'')-Date.now());
  return new ProviderError(status===401||status===403?409:status===429?429:502,status===401||status===403?'reconnect_required':status===429?'provider_rate_limited':status===410?'sync_expired':status>=500?'provider_unavailable':'provider_rejected',retryMs);
}
export function approvedEndpoint(value:string,officialOrigins:string[],options:ConnectorOptions) {
  const url=new URL(value);if(url.username||url.password||url.hash)throw new Error('Provider endpoint cannot contain credentials or a fragment.');
  if(!officialOrigins.includes(url.origin)&&!options.testNetworkOrigins?.includes(url.origin))throw new Error('Provider endpoint must use its official HTTPS origin.');return url;
}
export async function provider(url:URL,init:RequestInit={}):Promise<ProviderReply> {
  let response:Response;try{response=await fetch(url,{...init,redirect:'manual',signal:AbortSignal.timeout(15000)});}catch{throw new ProviderError(502,'provider_unavailable');}
  if(response.status>=300&&response.status<400)throw new ProviderError(502,'provider_redirect');
  if(!response.ok) { await response.body?.cancel();throw classify(response.status,response.headers.get('retry-after')); }
  const parts:Uint8Array[]=[];let size=0;if(response.body)for await(const part of response.body){size+=part.length;if(size>4*1024*1024){await response.body.cancel().catch(()=>{});fail(502,'provider_response_too_large','Provider response exceeds 4 MiB.');}parts.push(part);}
  let data:Row;try{data=object(JSON.parse(Buffer.concat(parts).toString('utf8')||'{}'));}catch{fail(502,'provider_invalid_response','Provider returned invalid JSON.');}return {status:response.status,headers:response.headers,data};
}
/** Reject non-global destinations, including IPv4 mapped into IPv6. */
export function isPublicAddress(address:string):boolean {
  const family=isIP(address);if(family===4){const p=address.split('.').map(Number);return !(p[0]===0||p[0]===10||p[0]===127||p[0]>=224||(p[0]===100&&p[1]>=64&&p[1]<=127)||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&(p[1]===168||p[1]===0||p[1]===2))||(p[0]===198&&(p[1]===18||p[1]===19||p[1]===51))||(p[0]===203&&p[1]===0&&p[2]===113));}
  if(family===6){const lower=new URL(`https://[${address}]`).hostname.slice(1,-1);if(!/^[23][0-9a-f]{3}:/.test(lower))return false;const parts=lower.split(':');if(parts[0]==='2001'&&(!parts[1]||parseInt(parts[1],16)<0x200))return false;return !lower.startsWith('2001:db8:')&&!lower.startsWith('2002:')&&!lower.startsWith('3fff:');}return false;
}
export function validateImportUrl(raw:string,options:ConnectorOptions,approvedOrigin?:string):URL {
  let url:URL;try{url=new URL(raw);}catch{fail(400,'invalid_url','Enter an absolute HTTPS URL.');}
  if(url.username||url.password||url.hash||url.href.length>4000)fail(400,'invalid_url','URL credentials and fragments are not supported.');
  const fixture=options.testNetworkOrigins?.includes(url.origin);if(!fixture&&(url.protocol!=='https:'||url.port&&url.port!=='443'))fail(400,'invalid_url','Live knowledge URLs must use HTTPS on port 443.');
  if(approvedOrigin&&url.origin!==approvedOrigin)fail(403,'url_not_approved','Pagination or redirects cannot leave the approved source origin.');
  return url;
}
export async function safeUrlGet(url:URL,options:ConnectorOptions):Promise<{status:number;headers:Row;text:string}> {
  const hostname=url.hostname.replace(/^\[|\]$/g,'');const fixture=options.testNetworkOrigins?.includes(url.origin);let addresses:{address:string;family:number}[];
  try{addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await lookup(hostname,{all:true,verbatim:true});}catch{fail(502,'source_dns_failed','Knowledge source could not be resolved.');}
  if(!addresses.length||!fixture&&addresses.some(a=>!isPublicAddress(a.address)))fail(403,'source_destination_blocked','Knowledge URLs cannot access private, local, or reserved networks.');
  // Pin the validated address in the actual TCP lookup, avoiding a second DNS resolution.
  const chosen=addresses[0];return await new Promise((resolve,reject)=>{
    const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method:'GET',headers:{Accept:'text/html,text/plain,application/json','User-Agent':'WatsonKnowledge/0.1'},lookup:((_name: string,_opts:unknown,cb:(err:Error|null,address:string,family:number)=>void)=>cb(null,chosen.address,chosen.family)) as any},res=>{
      const parts:Buffer[]=[];let size=0;res.on('data',part=>{size+=part.length;if(size>2*1024*1024){request.destroy();reject(new ApiError(502,'source_too_large','Knowledge source exceeds 2 MiB.'));}else parts.push(Buffer.from(part));});
      res.on('end',()=>{let content=Buffer.concat(parts);const encoding=String(res.headers['content-encoding']??'identity').toLowerCase();try{const opts={maxOutputLength:2*1024*1024};if(encoding==='gzip')content=gunzipSync(content,opts);else if(encoding==='br')content=brotliDecompressSync(content,opts);else if(encoding==='deflate')content=inflateSync(content,opts);else if(encoding!=='identity')throw new Error('Unsupported encoding');}catch{reject(new ApiError(502,'source_invalid_encoding','Knowledge source encoding is invalid or exceeds 2 MiB after decompression.'));return;}resolve({status:res.statusCode??502,headers:res.headers,text:content.toString('utf8')});});res.on('error',()=>reject(new ApiError(502,'source_unavailable','Knowledge source request failed.')));
    });request.setTimeout(15000,()=>request.destroy());request.on('error',()=>reject(new ApiError(502,'source_unavailable','Knowledge source request failed.')));request.end();
  });
}
