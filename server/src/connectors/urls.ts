import { bool, fail, integer, now, object, str, type Principal, type Row } from '../core.ts';
import { ConnectorStorage } from './storage.ts';
import { safeUrlGet, validateImportUrl } from './transport.ts';
import type { Connection } from './types.ts';

const htmlText=(html:string)=>html.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
export class UrlKnowledgeConnector {
  private db:ConnectorStorage;
  constructor(db:ConnectorStorage) {this.db=db;}
  create(user:Principal,input:Row) {
    if(input.approveUrl!==true)fail(400,'url_approval_required','Approve this URL before Watson reads it.');
    const url=validateImportUrl(str(input.url,'url',4000),this.db.options);
    const title=input.title===undefined?url.hostname:str(input.title,'title',1000);
    const c=this.db.create(user,'url','knowledge',{...input,label:title,settings:{url:url.href,title,approvedAt:now(),autoSync:input.autoSync===undefined?false:bool(input.autoSync,'autoSync'),syncIntervalMinutes:input.syncIntervalMinutes===undefined?60:integer(input.syncIntervalMinutes,'syncIntervalMinutes',5,10080),nextSyncAt:0}});return this.db.public(c);
  }
  async sync(c:Connection,actorId=c.user_id) {
    const initial=validateImportUrl(str(c.settings.url,'url',4000),this.db.options),pages:Row[]=[];const visited=new Set<string>();let next:string|undefined=initial.href;
    while(next){let url=validateImportUrl(next,this.db.options,initial.origin);if(visited.has(url.href)||visited.size>=50)fail(502,'source_pagination_invalid','Knowledge source pagination did not finish.');visited.add(url.href);
      let response=await safeUrlGet(url,this.db.options);let redirects=0;
      while(response.status>=300&&response.status<400){if(!response.headers.location||redirects++>=3)fail(502,'source_redirect_invalid','Knowledge source redirects did not finish.');url=validateImportUrl(new URL(String(response.headers.location),url).href,this.db.options,initial.origin);response=await safeUrlGet(url,this.db.options);}
      if(response.status!==200)fail(502,response.status===429?'source_rate_limited':'source_unavailable','Knowledge source is unavailable.');
      const mime=String(response.headers['content-type']??'').split(';')[0].trim().toLowerCase();let title=pages.length?`${c.settings.title} (${pages.length+1})`:c.settings.title;let content:string;next=undefined;
      if(mime==='application/json'||mime.endsWith('+json')){let raw:unknown;try{raw=JSON.parse(response.text);}catch{fail(502,'source_invalid_json','Knowledge source returned invalid JSON.');}
        if(raw&&typeof raw==='object'&&!Array.isArray(raw)){const value=object(raw);content=JSON.stringify(value.items??value.results??value.data??value,null,2);if(value.next!==undefined&&value.next!==null){next=new URL(str(value.next,'source.next',4000),url).href;validateImportUrl(next,this.db.options,initial.origin);}}
        else content=JSON.stringify(raw,null,2);
      }else if(mime==='text/html'){const rawTitle=response.text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];if(rawTitle)title=htmlText(rawTitle).slice(0,1000);content=htmlText(response.text);const link=String(response.headers.link??'').match(/<([^>]+)>\s*;\s*rel="?next"?/i)?.[1];if(link){next=new URL(link,url).href;validateImportUrl(next,this.db.options,initial.origin);}}
      else if(['text/plain','text/markdown','text/csv'].includes(mime))content=response.text;
      else fail(415,'source_type_unsupported','Live links support HTML, text, Markdown, CSV, and JSON.');
      if(!content.trim())fail(502,'source_empty','Knowledge source contained no readable text.');
      if(pages.reduce((total,p)=>total+Buffer.byteLength(p.text),0)+Buffer.byteLength(content)>4*1024*1024)fail(502,'source_too_large','Combined knowledge pages exceed 4 MiB.');
      pages.push({url:url.href,title:String(title).slice(0,1000),text:`Source: ${url.href}\n\n${content}`,id:this.db.resourceId(c,'knowledge',url.href)});
    }
    this.db.store.transaction(()=>{
      const seen=new Set(pages.map(p=>p.url));for(const old of this.db.records(c,'knowledge'))if(!seen.has(old.remote_id)){if(old.resource_id)this.db.removeResource(c,old.resource_id);this.db.store.run('DELETE FROM connector_records WHERE connection_id=? AND kind=? AND remote_id=?',c.id,'knowledge',old.remote_id);}
      for(const page of pages){const data={id:page.id,title:page.title,text:page.text,addedAt:now(),size:Buffer.byteLength(page.text),fileType:'url',source:{provider:'url',connectionId:c.id,url:page.url}};const existing=this.db.store.get("SELECT revision FROM resources WHERE entity='knowledge' AND id=?",page.id);this.db.store.put(actorId,'knowledge',page.id,data,existing?.revision??0,c.org_id?(c.team_id?'team':'org'):'personal',c.org_id,c.team_id);this.db.record(c,'knowledge',page.url,data,page.id);}
    });this.db.saveSettings(c,{...c.settings,nextSyncAt:this.db.time()+Number(c.settings.syncIntervalMinutes)*60000});this.db.store.run("UPDATE connector_connections SET last_sync=?,status='connected',last_error=NULL WHERE id=?",now(),c.id);return {imported:pages.length,sources:pages.map(p=>p.url)};
  }
  configure(c:Connection,input:Row) {const settings={...c.settings};if(input.syncIntervalMinutes!==undefined)settings.syncIntervalMinutes=integer(input.syncIntervalMinutes,'syncIntervalMinutes',5,10080);if(input.autoSync!==undefined)settings.autoSync=bool(input.autoSync,'autoSync');this.db.saveSettings(c,settings);return this.db.public(c);}
  disconnect(c:Connection) {this.db.disconnect(c);return {disconnected:true};}
}
