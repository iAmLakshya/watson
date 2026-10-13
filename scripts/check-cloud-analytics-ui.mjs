import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..'), temporary = await realpath(await mkdtemp(join(tmpdir(), 'watson-analytics-ui-')));
await symlink(join(root,'node_modules'),join(temporary,'node_modules'),'dir');
const sourceFiles = ['renderer/CloudPanel.tsx','renderer/CloudPanel.css','shared/cloud-types.ts'];
const sourceDigests = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file,createHash('sha256').update(await readFile(join(root,file))).digest('hex')])));
await writeFile(join(temporary,'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Watson analytics UI fixture</title></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
await writeFile(join(temporary,'fixture.tsx'), `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CloudAnalyticsPanel} from ${JSON.stringify(join(root,'renderer/CloudPanel.tsx'))};
import ${JSON.stringify(join(root,'renderer/styles.css'))};
const fixture={pending:[],exports:[],notifications:[]};window.__analyticsHarness=fixture;
const initial={cloud:{signedIn:true,user:{id:'actor-a',email:'actor-a@example.test',name:'Actor A'},endpoint:'http://127.0.0.1:4319/api/v1',organizations:[{id:'org-a',name:'Organization A',role:'admin'}],authorizationRevision:1,busy:false}};
function App(){const[state,setState]=useState(initial);fixture.state=state;fixture.update=patch=>setState(value=>({...value,cloud:{...value.cloud,...patch}}));
const invoke=(command,input)=>command==='cloud:analytics'?new Promise(resolve=>fixture.pending.push({input,resolve})):command==='cloud:analytics-export'?new Promise(resolve=>fixture.exports.push({input,resolve})):Promise.resolve({saved:true});
return <div style={{maxWidth:1000,margin:'25px auto'}}><CloudAnalyticsPanel state={state} invoke={invoke} notify={(message,error)=>fixture.notifications.push({message,error})}/></div>}
createRoot(document.getElementById('root')).render(<App/>);
`);
const server=await createServer({configFile:false,root:temporary,cacheDir:join(temporary,'.vite-cache'),plugins:[react()],optimizeDeps:{include:['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','lucide-react','react-markdown']},server:{host:'127.0.0.1',port:0,fs:{allow:[root,temporary]},strictPort:false}});
let browser,page;const checks=[],errors=[];const startedAt=new Date().toISOString();
try {
  await server.listen();const address=server.httpServer.address();const origin=`http://127.0.0.1:${address.port}`;
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});page=await browser.newPage({viewport:{width:1280,height:960}});page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);await page.getByLabel('Report organization',{exact:true}).waitFor({timeout:10000});
  const waitPending=async count=>page.waitForFunction(count=>window.__analyticsHarness.pending.length===count,count);
  const update=async patch=>{await page.evaluate(patch=>window.__analyticsHarness.update(patch),patch);await page.waitForTimeout(30);};
  const report=(input,name,ownOnly=false)=>{const metrics={sessions:1,liveSessions:1,demoSessions:0,wallSeconds:60,capturedSeconds:30,microphoneSeconds:1,systemSeconds:2,providerRequests:1,inputTokens:20,outputTokens:5,screenshots:1,answers:1,completedAnswers:1,failedAnswers:0,knowledgeReferences:0,webReferences:0,averageLatencyMs:200,coachingScore:null};return {orgId:input.orgId,generatedAt:new Date().toISOString(),dateRange:{from:input.from,to:input.to},filters:{...input},allowedFilters:{organizationWide:!ownOnly,ownOnly,teams:[],members:[{id:'member',name,email:'member@example.test'}]},summary:metrics,adoption:{eligibleMembers:1,activeMembers:1,activeDefinition:'Fixture activity'},series:[],byMember:[{userId:'member',name,email:'member@example.test',teamIds:[],lastSeenAt:null,lastAppOpenAt:null,appVersion:null,usageEventCount:1,metrics}],byTeam:[],byMode:[],features:[],usageEvents:{eventCount:1,totals:{},byKind:[],source:'Fixture source'},missingMeasurements:{sessionsWithoutUsage:0,sessionsWithoutEnd:0,sessionsWithoutLatency:0,sessionsWithoutCoaching:1,unscopedSessionsExcluded:0,unscopedUsageEventsExcluded:0,meetingCoverage:null,reasons:[]},source:{sessions:'Fixture sessions',events:'Fixture events',membership:'Fixture current membership',deduplication:'Fixture deduplication',coaching:'Fixture coaching',audio:'Fixture audio'}};};
  const respond=async(index,name,ownOnly=false)=>{const input=await page.evaluate(index=>window.__analyticsHarness.pending[index].input,index);await page.evaluate(({index,value})=>window.__analyticsHarness.pending[index].resolve(value),{index,value:report(input,name,ownOnly)});await page.waitForTimeout(40);};
  await page.getByLabel('Report organization',{exact:true}).selectOption('org-a');await waitPending(1);
  await update({user:{id:'actor-b',email:'actor-b@example.test',name:'Actor B'}});await respond(0,'OLD_ACCOUNT_ROW');assert.equal(await page.getByText('OLD_ACCOUNT_ROW',{exact:true}).count(),0);checks.push('Late response from a prior account is ignored');
  await page.getByLabel('Report organization',{exact:true}).selectOption('org-a');await waitPending(2);await respond(1,'AUTHORIZED_ACCOUNT_ROW');await page.getByText('AUTHORIZED_ACCOUNT_ROW',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Export CSV',exact:true}).click();await page.waitForFunction(()=>window.__analyticsHarness.exports.length===1);await update({organizations:[],authorizationRevision:2});assert.equal(await page.getByText('AUTHORIZED_ACCOUNT_ROW',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Export CSV',exact:true}).count(),0);checks.push('Membership revocation clears displayed report and CSV action');await page.evaluate(()=>window.__analyticsHarness.exports[0].resolve({saved:true,path:'/tmp/fixture-only.csv'}));await page.waitForTimeout(30);assert.equal(await page.evaluate(()=>window.__analyticsHarness.notifications.length),0);checks.push('An export response from revoked context is discarded without cached result or success notification');
  await update({organizations:[{id:'org-a',name:'Organization A',role:'member'}],authorizationRevision:3});await page.getByLabel('Report organization',{exact:true}).selectOption('org-a');await waitPending(3);
  await update({authorizationRevision:4});await waitPending(4);await respond(2,'OLD_TEAM_SCOPE_ROW');assert.equal(await page.getByText('OLD_TEAM_SCOPE_ROW',{exact:true}).count(),0);await respond(3,'CURRENT_OWN_SCOPE_ROW',true);await page.getByText('CURRENT_OWN_SCOPE_ROW',{exact:true}).waitFor();assert.equal(await page.getByLabel('Report member',{exact:true}).isDisabled(),true);checks.push('Late response from an earlier team scope is ignored and current own-only scope renders');
  await page.getByRole('button',{name:'Refresh report',exact:true}).click();await waitPending(5);await update({endpoint:'https://another-server.example.test/api/v1'});await respond(4,'OLD_BACKEND_ROW');assert.equal(await page.getByText('OLD_BACKEND_ROW',{exact:true}).count(),0);assert.equal(await page.getByText('CURRENT_OWN_SCOPE_ROW',{exact:true}).count(),0);checks.push('Changing servers clears prior report and ignores its pending response');
  assert.deepEqual(errors,[]);const result={passed:true,startedAt,finishedAt:new Date().toISOString(),checks,sourceDigests,scope:'Real React component in installed headless Chrome with controlled deferred IPC fixture; actual backend ACLs separately tested by cloud-analytics-client.test.ts.'};await writeFile(join(root,'evidence/cloud-analytics-ui-validation.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
} catch(error) {console.error(JSON.stringify({failed:true,error:error.message,pageErrors:errors}));if(page)await page.screenshot({path:join(root,'evidence/cloud-analytics-ui-failure.png')}).catch(()=>{});throw error;} finally {if(browser)await browser.close();await server.close();await rm(temporary,{recursive:true,force:true});}
