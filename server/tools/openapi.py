"""Generate the checked-in HTTP contract. No runtime server dependency."""
import json
from pathlib import Path

schemas = {
 'User': {'type':'object','required':['id','email','name'],'properties':{k:{'type':'string'} for k in ['id','email','name','createdAt','updatedAt']}},
 'AuthResult': {'type':'object','required':['token','expiresAt','user','device'],'properties':{'token':{'type':'string','description':'256-bit opaque bearer. Store in OS secure storage; never sync.'},'expiresAt':{'type':'string','format':'date-time'},'user':{'$ref':'#/components/schemas/User'},'device':{'type':'object','properties':{k:{'type':'string'} for k in ['id','name','createdAt']}}}},
 'Error': {'type':'object','properties':{'error':{'type':'object','properties':{'code':{'type':'string'},'message':{'type':'string'},'details':{}}}}},
 'Session': {'type':'object','required':['id','title','startedAt'],'additionalProperties':False,'properties':{k:{'type':'string'} for k in ['id','title','startedAt','endedAt','modeId','notes','followupDraft','organizationId','calendarEventId']}},
 'Resource': {'type':'object','required':['id','entity','revision','scope','data'],'properties':{'id':{'type':'string'},'entity':{'enum':['meeting','knowledge','mode','calendar','settings','folder','person','scorecard']},'revision':{'type':'integer','minimum':1},'scope':{'enum':['personal','org','team']},'ownerId':{'type':'string'},'orgId':{'type':['string','null']},'teamId':{'type':['string','null']},'data':{'type':['object','null']},'deleted':{'type':'boolean'},'updatedAt':{'type':'string','format':'date-time'}}},
 'MeetingEnvelope':{'type':'object','properties':{'id':{'type':'string'},'revision':{'type':'integer'},'meeting':{'$ref':'#/components/schemas/Session'},'updatedAt':{'type':'string'}}},
 'SyncChange': {'type':'object','required':['entity','id','expectedRevision','data'],'properties':{'entity':{'enum':['meeting','knowledge','mode','calendar','settings','folder','person','scorecard']},'id':{'type':'string','maxLength':128},'expectedRevision':{'type':'integer','minimum':0},'data':{'type':['object','null']},'changeId':{'type':'string','maxLength':128,'description':'Optional mutation idempotency key; unique within account.'}}},
 'SyncResult':{'type':'object','properties':{'cursor':{'type':'integer'},'changes':{'type':'array','items':{'type':'object','properties':{'sequence':{'type':'integer'},'entity':{'type':'string'},'id':{'type':'string'},'revision':{'type':'integer'},'data':{'type':['object','null']},'deleted':{'type':'boolean'},'updatedAt':{'type':'string'}}}},'applied':{'type':'array','items':{'$ref':'#/components/schemas/Resource'}},'conflicts':{'type':'array','items':{'type':'object','properties':{'id':{'type':'string'},'entity':{'type':'string'},'code':{'const':'revision_conflict'},'current':{'oneOf':[{'$ref':'#/components/schemas/Resource'},{'type':'null'}]}}}},'shared':{'type':'array','items':{'$ref':'#/components/schemas/Resource'}},'policy':{'$ref':'#/components/schemas/Policy'},'assignedMode':{'oneOf':[{'$ref':'#/components/schemas/Resource'},{'type':'null'}]}}},
 'Policy':{'type':'object','properties':{'retentionDays':{'type':'integer','minimum':1,'maximum':3650},'recordingAllowed':{'type':'boolean'},'publicSharingAllowed':{'type':'boolean'}}},
 'ScopeInput':{'type':'object','required':['data'],'properties':{'data':{'type':'object'},'expectedRevision':{'type':'integer','minimum':0,'default':0},'scope':{'enum':['personal','org','team'],'default':'personal'},'orgId':{'type':'string'},'teamId':{'type':'string'}}},
}
schemas['Session']['properties'].update({k:{'type':'boolean'} for k in ['demo','pinned','consentConfirmed']})
schemas['Session']['properties'].update({k:{'type':'array','items':{'type':'string'}} for k in ['tags','actions','attendeeIds']})
schemas['Session']['properties'].update({'transcript':{'type':'array','items':{'type':'object'}},'answers':{'type':'array','items':{'type':'object'}},'commitments':{'type':'array','items':{'type':'object'}},'coaching':{'type':'array','items':{'type':'object'}},'usage':{'type':'object'},'recording':{'type':'object','required':['contentType','base64'],'properties':{'contentType':{'enum':['audio/wav','audio/webm','audio/mp4','audio/mpeg','audio/ogg','audio/x-caf','audio/caf']},'base64':{'type':'string','maxLength':3000000},'filename':{'type':'string','maxLength':200}}}})
paths={}
def obj(properties,required=()):
 return {'type':'object','properties':properties,'required':list(required)}
def prop(kind='string',**extra):return {'type':kind,**extra}
def ref(name):return {'$ref':'#/components/schemas/'+name}
def route(path,method,description,body=None,response=None,status=200,public=False,query=()):
 op={'summary':description,'operationId':method+'_'+path.replace('/','_').replace('{','').replace('}',''),'responses':{str(status):{'description':'Success','content':{'application/json':{'schema':response or {'type':'object'}}}},**{str(code):{'description':label,'content':{'application/json':{'schema':ref('Error')}}} for code,label in [(400,'Validation error'),(401,'Sign in required'),(403,'Forbidden by scope or policy'),(404,'Not found'),(409,'Revision conflict or last admin protection'),(429,'Rate limit'),(503,'Provider or secret storage not configured')]}}}
 if status==204:op['responses']['204']={'description':'No content'}
 if public:op['security']=[]
 if body:op['requestBody']={'required':True,'content':{'application/json':{'schema':body}}}
 params=[{'name':part[1:-1],'in':'path','required':True,'schema':prop()} for part in path.split('/') if part.startswith('{')]
 params += [{'name':name,'in':'query','required':False,'schema':prop()} for name in query]
 if params:op['parameters']=params
 paths.setdefault(path,{})[method]=op
route('/health','get','Loopback server status',public=True)
authbody=obj({'email':prop(format='email'),'password':prop(minLength=12,maxLength=512),'name':prop(maxLength=200),'deviceName':prop(maxLength=200)},['email','password'])
for name in ['signup','login']:route('/auth/'+name,'post','Create account' if name=='signup' else 'Sign in and register device',authbody,ref('AuthResult'),201 if name=='signup' else 200,True)
route('/auth/logout','post','Revoke current bearer session')
route('/me','get','Profile, devices, memberships and effective organization policy')
route('/me','patch','Update profile; email change requires currentPassword',obj({'name':prop(),'email':prop(),'currentPassword':prop()}))
route('/me','delete','Delete account and private data; reauthentication and last admin guard',obj({'currentPassword':prop()},['currentPassword']))
route('/me/password','post','Change password and revoke all prior sessions',obj({'currentPassword':prop(),'newPassword':prop(minLength=12),'deviceName':prop()},['currentPassword','newPassword']),ref('AuthResult'))
route('/auth/capabilities','get','Public configured email verification/password recovery capabilities',public=True)
route('/me/email-verification','post','Queue an encrypted one-use verification email to current account address',obj({}),status=202)
route('/auth/email-verification/confirm','post','Consume hashed expiring verification token once',obj({'token':prop()},['token']),public=True)
route('/auth/email-verification/confirm','get','Scanner-safe browser verification form; requires explicit POST',public=True,query=['token'])
route('/auth/password-reset/request','post','Uniform non-enumerating recovery request; delivery via configured operator transport',obj({'email':prop(format='email')},['email']),status=202,public=True)
route('/auth/password-reset/confirm','post','Consume one-use recovery token, change password and revoke all sessions',obj({'token':prop(),'newPassword':prop(minLength=12,maxLength=512)},['token','newPassword']),public=True)
route('/auth/password-reset/confirm','get','Browser password reset form without consuming token',public=True,query=['token'])
for endpoint in ['/auth/email-verification/confirm','/auth/password-reset/confirm']:
 paths[endpoint]['get']['responses']['200']['content']={'text/html':{'schema':prop()}}
 paths[endpoint]['post']['requestBody']['content']['application/x-www-form-urlencoded']=paths[endpoint]['post']['requestBody']['content']['application/json']
schemas['User']['properties'].update({'emailVerified':prop('boolean'),'emailVerifiedAt':{'type':['string','null']}})
route('/devices/{deviceId}','delete','Revoke device and every bearer associated with it')
route('/assigned-mode','get','Read the caller’s sole assigned organization/team prompt for its assistant context',response=obj({'mode':{'oneOf':[ref('Resource'),{'type':'null'}]}}))
route('/policy','get','Effective strictest policy from every joined organization',response=ref('Policy'))
route('/sync','post','Push personal records and pull private changes plus authoritative shared snapshot',obj({'deviceId':prop(),'cursor':prop('integer',minimum=0,default=0),'changes':{'type':'array','maxItems':100,'items':ref('SyncChange')}},['deviceId','changes']),ref('SyncResult'))
route('/meetings','get','List/search personal meetings',query=['q'])
route('/meetings','post','Create meeting revision 1',obj({'meeting':ref('Session'),'expectedRevision':prop('integer',const=0)},['meeting']),ref('MeetingEnvelope'),201)
route('/meetings/{meetingId}','get','Read owner meeting',response=ref('MeetingEnvelope'))
route('/meetings/{meetingId}','put','Replace owner meeting with optimistic revision check',obj({'meeting':ref('Session'),'expectedRevision':prop('integer',minimum=1)},['meeting','expectedRevision']),ref('MeetingEnvelope'))
route('/meetings/{meetingId}','delete','Delete owner meeting; revoke shares and emit sync tombstone',obj({'expectedRevision':prop('integer',minimum=1)},['expectedRevision']))
route('/meetings/{meetingId}/share','post','Create/rotate expiring public share',obj({'expiresInDays':prop('integer',minimum=1,maximum=365,default=30)}),obj({'token':prop(),'url':prop(),'viewerUrl':prop(),'expiresAt':prop()}),201)
route('/meetings/{meetingId}/share','delete','Revoke public share immediately')
route('/meetings/{meetingId}/export','get','Export owner meeting JSON')
route('/meetings/{meetingId}/recording','get','Download owner uploaded audio recording')
paths['/meetings/{meetingId}/recording']['get']['responses']['200']['content']={'audio/wav':{'schema':prop(format='binary')},'audio/webm':{'schema':prop(format='binary')},'audio/mp4':{'schema':prop(format='binary')},'audio/mpeg':{'schema':prop(format='binary')},'audio/ogg':{'schema':prop(format='binary')}}
route('/recordings/capabilities','get','Read own storage configuration, bounded request size, accepted storage MIME types, current policy and consent requirement')
route('/meetings/{meetingId}/recording','put','Stream raw owner audio into encrypted bounded private storage; consent and revision headers required',status=201)
paths['/meetings/{meetingId}/recording']['put']['requestBody']={'required':True,'content':{mime:{'schema':prop(format='binary')} for mime in ['audio/wav','audio/webm','audio/mp4','audio/mpeg','audio/ogg','audio/x-caf','audio/caf']}}
paths['/meetings/{meetingId}/recording']['put']['parameters'] += [{'name':'X-Watson-Expected-Revision','in':'header','required':True,'schema':prop('integer',minimum=1)},{'name':'X-Watson-Recording-Consent','in':'header','required':True,'schema':{'const':'true'}},{'name':'X-Watson-Filename','in':'header','required':False,'schema':prop()}]
route('/meetings/{meetingId}/recording','delete','Remove owner audio and emit a new meeting revision',obj({'expectedRevision':prop('integer',minimum=1)},['expectedRevision']))
route('/meetings/{meetingId}/recording','head','Authenticated large audio metadata headers')
route('/meetings/{meetingId}/recording/info','get','Owner-only audio metadata; no storage paths, keys or encryption salt')
paths['/meetings/{meetingId}/recording']['get']['parameters'].append({'name':'Range','in':'header','required':False,'schema':prop(),'description':'Single byte range for encrypted streamed attachments.'})
paths['/meetings/{meetingId}/recording']['get']['responses']['206']={'description':'Decrypted authenticated single byte range','content':paths['/meetings/{meetingId}/recording']['get']['responses']['200']['content']}
route('/public/shares/{token}','get','Read explicit public notes/actions/followup/transcript projection',public=True)
route('/public/view/{token}','get','Readable escaped Watson meeting share viewer',public=True)
paths['/public/view/{token}']['get']['responses']['200']['content']={'text/html':{'schema':prop()}}
route('/resources','get','List ACL-filtered personal and organization resources',query=['entity','scope','orgId','teamId','q'])
route('/resources/{entity}','post','Create scoped knowledge, folder, mode or personal resource',ref('ScopeInput'),ref('Resource'),201)
route('/resources/{entity}/{resourceId}','get','Read ACL-filtered resource',response=ref('Resource'))
route('/resources/{entity}/{resourceId}','put','Update resource under scope and revision checks',ref('ScopeInput'),ref('Resource'))
route('/resources/{entity}/{resourceId}','delete','Delete writable resource',obj({'expectedRevision':prop('integer',minimum=1)},['expectedRevision']),ref('Resource'))
route('/context','get','Retrieve accessible knowledge and assigned modes; optional selected mode limits document IDs',query=['q','modeId'])
route('/organizations','get','List organizations joined by this account')
route('/organizations','post','Create organization and admin membership',obj({'name':prop()},['name']),status=201)
route('/organizations/{orgId}','get','Read joined organization')
route('/organizations/{orgId}','patch','Admin updates organization name',obj({'name':prop()},['name']))
route('/organizations/{orgId}','delete','Admin deletes organization and scoped resources')
route('/organizations/{orgId}/policy','get','Read organization policy',response=ref('Policy'))
route('/organizations/{orgId}/policy','put','Admin enforces recording/sharing/retention; immediately sweep historical data',ref('Policy'),ref('Policy'))
route('/organizations/{orgId}/members','get','List joined organization members')
route('/organizations/{orgId}/members','post','Admin adds an existing registered account',obj({'email':prop(),'role':{'enum':['admin','manager','member']}},['email']),status=201)
route('/organizations/{orgId}/members/{userId}','patch','Admin changes role; last admin protected',obj({'role':{'enum':['admin','manager','member']}},['role']))
route('/organizations/{orgId}/members/{userId}','delete','Admin removes member and all team memberships')
route('/organizations/{orgId}/teams','get','List own teams or all teams for organization admin')
route('/organizations/{orgId}/teams','post','Organization admin/manager creates a team',obj({'name':prop()},['name']),status=201)
route('/organizations/{orgId}/teams/{teamId}','patch','Team manager or organization admin updates team',obj({'name':prop()},['name']))
route('/organizations/{orgId}/teams/{teamId}','delete','Organization admin/manager deletes team')
route('/organizations/{orgId}/teams/{teamId}/members','get','List team members under membership ACL')
route('/organizations/{orgId}/teams/{teamId}/members','post','Team manager adds joined organization member',obj({'userId':prop(),'role':{'enum':['manager','member']}},['userId']),status=201)
route('/organizations/{orgId}/teams/{teamId}/members/{userId}','patch','Team manager changes team role',obj({'role':{'enum':['manager','member']}},['role']))
route('/organizations/{orgId}/teams/{teamId}/members/{userId}','delete','Team manager removes member; resource access revoked immediately')
route('/usage','post','Record idempotent client reported factual usage event',obj({'id':prop(),'kind':{'enum':['assist','transcription_seconds','meeting_seconds','screen_capture','import','export']},'amount':prop('number',minimum=0,maximum=86400),'orgId':prop(),'metadata':prop('object')},['kind','amount']),status=201)
route('/usage','get','Aggregate/export own events; no fabricated provider cost',query=['from','to'])
route('/organizations/{orgId}/usage','get','Legacy admin-only redacted events; use scoped analytics for team/member reporting',query=['from','to'])
route('/organizations/{orgId}/analytics','get','Current-role scoped org/team/member factual telemetry and coaching with declared missing measurements',query=['from','to','teamId','userId','includeDemo'])
route('/organizations/{orgId}/analytics/export','get','CSV with identical current scope/date filters and spreadsheet formula neutralization',response=obj({'filename':prop(),'csv':prop()}),query=['from','to','teamId','userId','includeDemo'])
route('/organizations/{orgId}/audit','get','Admin reads latest 1000 persisted organization audit events')
route('/export','get','Export account and only its accessible resources/events')

route('/organizations/{orgId}/assignments','get','Admin lists org assignments; team manager lists managed-team members and hides assignments from other teams',query=['teamId'])
route('/organizations/{orgId}/assignments/{userId}','put','Assign one prompt to member, replacing any previous assignment; manager restricted to managed-team prompts',obj({'modeId':{'type':['string','null']}},['modeId']))

route('/assistant/action-link','post','Resolve only the assigned hidden link template with URL-encoded own/transient context',obj({'actionId':prop(),'question':prop(),'sessionId':prop(),'sessionContext':prop('object'),'transcript':{'type':'array','items':prop('object')}},['actionId']),obj({'url':prop()}))
route('/assistant/status','get','Read operator assistant configuration and metadata-only effective prompt')
route('/assistant','post','Run the hidden assigned prompt through the operator model with ACL-checked context; stream controlled SSE only',obj({'kind':{'enum':['assist','say','followup','recap','chat','notes','email','brief','custom','coaching']},'question':prop(maxLength=20000),'transcript':{'type':'array','maxItems':2000,'items':prop('object')},'sessionId':prop(),'screen':obj({'dataUrl':prop(maxLength=3000000),'capturedAt':prop()},['dataUrl']),'answers':{'type':'array','maxItems':30,'items':obj({'role':{'enum':['user','assistant']},'text':prop(maxLength=20000)},['role','text'])},'outputLanguage':prop(),'actionId':prop(),'scope':{'enum':['session','history','calendar']},'calendarEventId':prop(),'scorecardId':prop(),'requestId':prop(),'smart':prop('boolean'),'webResearch':prop('boolean'),'researchOnly':prop('boolean'),'sessionContext':obj({'id':prop(),'title':prop(),'notes':prop(),'actions':{'type':'array','items':prop()},'followupDraft':prop(),'attendees':{'type':'array','items':prop()}})}))
paths['/assistant']['post']['responses']['200']['content']={'text/event-stream':{'schema':prop(),'example':'event: delta\ndata: {"text":"Answer fragment"}\n\nevent: done\ndata: {"text":"Full answer","sources":[],"latencyMs":120,"refused":false}\n\n'}}

route('/organizations/{orgId}/sso','get','Admin reads configured identity providers; no client secret returned')
route('/auth/sso/start','post','Start configured OIDC authorization-code PKCE login; authenticated start can link current password account',obj({'providerId':prop(),'deviceName':prop()},['providerId']),obj({'authorizationUrl':prop(),'requestId':prop(),'requestSecret':prop(),'expiresAt':prop()}),public=True)
route('/auth/sso/callback','get','Consume single-use OIDC state and verify ID token; display completion page',public=True,query=['code','state'])
route('/auth/sso/poll','post','Complete one-time encrypted auth handoff; 202 while provider pending',obj({'requestId':prop(),'requestSecret':prop()},['requestId','requestSecret']),ref('AuthResult'),public=True)
paths['/auth/sso/poll']['post']['responses']['202']={'description':'SSO pending','content':{'application/json':{'schema':obj({'pending':prop('boolean',const=True)})}}}
route('/organizations/{orgId}/directory','get','Admin reads SCIM directory status and provider base URL')
route('/organizations/{orgId}/directory/token','post','Admin rotates scoped SCIM token; plaintext token returned once',obj({}),status=201)
route('/organizations/{orgId}/directory/token','delete','Admin revokes directory provisioning token')
for resource in ['ServiceProviderConfig','ResourceTypes','Schemas']:
 route('/scim/v2/{orgId}/'+resource,'get','Read SCIM '+resource+' using organization directory bearer')
for resource in ['Users','Groups']:
 route('/scim/v2/{orgId}/'+resource,'get','SCIM directory list/filter/page '+resource,query=['filter','startIndex','count'])
 route('/scim/v2/{orgId}/'+resource,'post','SCIM provision '+resource,prop('object'),status=201)
 route('/scim/v2/{orgId}/'+resource+'/{resourceId}','get','SCIM read '+resource)
 route('/scim/v2/{orgId}/'+resource+'/{resourceId}','put','SCIM replace supported '+resource+' fields',prop('object'))
 route('/scim/v2/{orgId}/'+resource+'/{resourceId}','patch','SCIM add/replace/remove supported fields/members',obj({'Operations':{'type':'array','items':prop('object')}},['Operations']))
 route('/scim/v2/{orgId}/'+resource+'/{resourceId}','delete','SCIM deprovision '+resource+'; preserve last admin',status=204)
for path in paths:
 if path.startswith('/scim/'):
  for op in paths[path].values():
   op['security']=[{'directoryBearer':[]}]
   if 'requestBody' in op:op['requestBody']['content']['application/scim+json']=op['requestBody']['content']['application/json']
   for response in op['responses'].values():
    if 'content' in response:response['content']['application/scim+json']=response['content']['application/json']
route('/billing','get','Read own configured plans, verified subscription and received invoices')
route('/billing/checkout','post','Create actual Stripe customer/subscription Checkout session for configured price',obj({'priceId':prop(),'seats':prop('integer',minimum=1,maximum=10000)},['priceId']),status=201)
route('/billing/portal','post','Create actual Stripe customer portal session',obj({}),status=201)
route('/billing/webhook','post','Verify raw Stripe payload HMAC/timestamp and idempotently persist subscription/invoice events',prop('object'),public=True)
paths['/billing/webhook']['post']['parameters']=[{'name':'Stripe-Signature','in':'header','required':True,'schema':prop()}]

spec={'openapi':'3.1.0','info':{'title':'Watson local cloud API','version':'0.1.0','description':'Self-hosted account, sync, meeting and enterprise workspace API. Provider credentials are not syncable. Hosted deployment and live-provider operation remain separate validation gates. OIDC, SCIM and Stripe adapters are implemented and protocol tested.'},'servers':[{'url':'http://127.0.0.1:4319/api/v1'}],'security':[{'bearerAuth':[]}],'paths':paths,'components':{'securitySchemes':{'directoryBearer':{'type':'http','scheme':'bearer','description':'Separate organization admin-issued SCIM token, hashed at rest.'},'bearerAuth':{'type':'http','scheme':'bearer','description':'Opaque 256-bit session token, hashed at rest.'}},'schemas':schemas}}
fragment=Path(__file__).resolve().parents[1].joinpath('src/connectors/openapi.json')
if fragment.exists():
 connector=json.loads(fragment.read_text())
 for path,item in connector.get('paths',{}).items():
  if path in spec['paths']:raise ValueError('Duplicate connector path '+path)
  spec['paths'][path]=item
 for section,items in connector.get('components',{}).items():spec['components'].setdefault(section,{}).update(items)
Path(__file__).resolve().parents[1].joinpath('openapi.json').write_text(json.dumps(spec,indent=2)+'\n')
