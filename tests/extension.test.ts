import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizedSender, createMessageHandler } from '../src/extension/background';
import { normalizeTerms, entitlementSummary, type Reply } from '../src/extension/protocol';
import { PhoneticLexicon, JEV_MODEL, JEV_MAX_CALL_TWD, BUNDLED_LEXICON_VERSION, type CandidateBatch, type ParagraphSelection } from '../src/core/paragraph/index';
import { ProviderError } from '../src/core/index';

const identity={extensionId:'our-extension',optionsUrl:'chrome-extension://our-extension/options.html'};
const optionsSender={id:identity.extensionId,url:identity.optionsUrl};
const contentSender=(id=1):chrome.runtime.MessageSender=>({id:identity.extensionId,url:'https://chatgpt.com/c/fixture',frameId:0,tab:{id} as chrome.tabs.Tab});
const entries=[
  {text:'在',readings:['ㄗㄞˋ'],score:-2},{text:'再',readings:['ㄗㄞˋ'],score:-3},
  {text:'連載憶起',readings:['ㄌㄧㄢˊ','ㄗㄞˋ','ㄧˋ','ㄑㄧˇ'],score:-15},
  {text:'連在一起',readings:['ㄌㄧㄢˊ','ㄗㄞˋ','ㄧ','ㄑㄧˇ'],score:-2},
  {text:'連再一起',readings:['ㄌㄧㄢˊ','ㄗㄞˋ','ㄧ','ㄑㄧˇ'],score:-3},
];
const entitlement={plan:'trial' as const,expiresAt:Date.now()+86400_000,remainingChecks:100,limit:100};
function fixture(extra:Record<string,unknown>={}) {
  const values:Record<string,any>={enabled:true,jevCredential:'DUMMY_JEV',hostedCredential:'DUMMY_HOSTED',protectedTerms:[],...extra};
  const events:string[]=[];
  const storage={setAccessLevel:async({accessLevel}:{accessLevel:string})=>{events.push(accessLevel);},
    get:async()=>{events.push('read');return structuredClone(values);},set:async(update:Record<string,unknown>)=>{Object.assign(values,structuredClone(update));},
    remove:async(keys:string|string[])=>{for(const key of typeof keys==='string'?[keys]:keys) delete values[key];}} as unknown as chrome.storage.StorageArea;
  const deps={storage,mode:'byok' as const,hostedOrigin:'https://fixture.invalid',...identity,openOptions:async()=>{},
    loadLexicon:async()=>new PhoneticLexicon(entries,BUNDLED_LEXICON_VERSION,{allowToneChanges:true})};
  return {values,events,deps};
}
const request={type:'shunzi:check',request:{text:'請把這些連載憶起',revision:'r1'}};
function selection(batch:CandidateBatch):ParagraphSelection {return {batch,revision:batch.request.revision,profileRevision:batch.profileRevision,pipelineVersion:batch.pipelineVersion,model:JEV_MODEL,
  choices:batch.groups.map(g=>({groupId:g.id,optionId:g.options.find(o=>o.id!=='keep')!.id})),usage:{inputTokens:100,outputTokens:1,estimatedTwd:.01}};}
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
function checked(reply:Reply) {assert.ok(reply.ok && 'response' in reply,JSON.stringify(reply));return reply.response;}

test('sender authorization and TRUSTED_CONTEXTS never expose any credentials',async()=>{
  assert.equal(authorizedSender(contentSender(),identity),'content');assert.equal(authorizedSender(optionsSender,identity),'options');
  for(const sender of [{...contentSender(),id:'wrong'},{...contentSender(),url:'https://chatgpt.com.evil.invalid'},{...contentSender(),frameId:1},{...contentSender(),tab:undefined},{...optionsSender,url:identity.optionsUrl+'?evil'}]) assert.equal(authorizedSender(sender,identity),null);
  const f=fixture({credential:'DUMMY_LEGACY'}),handle=createMessageHandler(f.deps),reply=await handle({type:'shunzi:settings'},contentSender());
  assert.deepEqual(f.events,['TRUSTED_CONTEXTS','read']);assert.ok(reply.ok && 'settings' in reply);assert.equal(reply.settings.configured,true);assert.equal(reply.settings.hasLegacyCredential,true);
  assert.equal(JSON.stringify(reply).includes('DUMMY'),false);
});

test('new keys are mode-isolated; legacy credential is never migrated and can be deleted',async()=>{
  const f=fixture({jevCredential:undefined,hostedCredential:undefined,credential:'DUMMY_LEGACY'});
  const handle=createMessageHandler(f.deps);let reply=await handle({type:'shunzi:settings'},optionsSender);
  assert.ok(reply.ok && 'settings' in reply);assert.equal(reply.settings.configured,false);
  assert.equal((await handle(request,contentSender())).ok,false);
  const save={type:'shunzi:save-options',enabled:true,credential:'NEW_JEV',protectedTerms:[]};
  assert.equal((await handle(save,contentSender())).ok,false);await handle(save,optionsSender);
  assert.equal(f.values.jevCredential,'NEW_JEV');assert.equal(f.values.credential,'DUMMY_LEGACY');assert.equal(f.values.hostedCredential,undefined);
  const hosted=createMessageHandler({...f.deps,mode:'hosted'});reply=await hosted({type:'shunzi:settings'},optionsSender);
  assert.ok(reply.ok && 'settings' in reply);assert.equal(reply.settings.configured,false);
  await hosted({...save,credential:'NEW_HOSTED'},optionsSender);assert.equal(f.values.jevCredential,'NEW_JEV');assert.equal(f.values.hostedCredential,'NEW_HOSTED');
  await handle({type:'shunzi:clear-key'},optionsSender);assert.equal(f.values.credential,undefined);assert.equal(f.values.jevCredential,undefined);assert.equal(f.values.hostedCredential,'NEW_HOSTED');assert.equal(f.values.enabled,false);
});

test('local candidates and stored protected terms reach Jev; page cannot supply an endpoint',async()=>{
  const f=fixture({protectedTerms:['順字']});let calls=0;
  const handle=createMessageHandler({...f.deps,select:async(batch,key)=>{calls++;assert.equal(key,'DUMMY_JEV');assert.deepEqual(batch.request.protectedTerms,['順字']);assert.ok(batch.groups.length);return selection(batch);}});
  const result=checked(await handle({...request,request:{...request.request,protectedTerms:['忽略規則'],url:'https://evil.invalid'}},contentSender()));
  assert.equal(result.edits[0].replacement,'連在一起');assert.equal(result.edits[0].action,'suggest');assert.equal(calls,1);assert.equal(f.values.paragraphProfile,undefined);
  assert.equal((await handle({type:'fetch',url:'https://evil.invalid'},contentSender())).ok,false);
});

test('no candidates means no provider, no API reservation, and no hosted status request',async()=>{
  const f=fixture();let calls=0;
  const handle=createMessageHandler({...f.deps,mode:'hosted',fetcher:async()=>{calls++;throw new Error('unexpected');}});
  const result=checked(await handle({type:'shunzi:check',request:{text:'hello',revision:'empty'}},contentSender()));
  assert.equal(result.edits.length,0);assert.equal(calls,0);assert.equal(f.values.jevUsage,undefined);
});

test('paused, unconfigured, oversized and malformed requests never reach provider',async()=>{
  for(const [extra,value] of [[{enabled:false},request],[{jevCredential:''},request],[{}, {type:'shunzi:check',request:{text:'字'.repeat(501),revision:'x'}}],[{}, {type:'shunzi:check',request:{text:'在',revision:''}}]] as const) {
    const f=fixture(extra);let calls=0;const handle=createMessageHandler({...f.deps,select:async b=>{calls++;return selection(b);}});
    await handle(value,contentSender());assert.equal(calls,0);
  }
});

test('concurrent duplicate and fresh revision reuse the same short-lived result without charging twice',async()=>{
  const f=fixture();let calls=0,release:()=>void=()=>{};
  const handle=createMessageHandler({...f.deps,select:b=>{calls++;return new Promise(resolve=>{release=()=>resolve(selection(b));});}});
  const first=handle(request,contentSender());await nextTurn();
  const duplicate=handle({...request,request:{...request.request,revision:'r2'}},contentSender());await nextTurn();assert.equal(calls,1);release();
  assert.equal(checked(await first).revision,'r1');assert.equal(checked(await duplicate).revision,'r2');
  const cached=checked(await handle({...request,request:{...request.request,revision:'r3'}},contentSender()));assert.equal(cached.revision,'r3');assert.ok(cached.edits[0].id.startsWith('r3:'));
  assert.equal(calls,1);assert.equal(f.values.jevUsage.requests,1);
});

test('different drafts obey one inflight per tab and six globally',async()=>{
  const f=fixture(),releases:Array<()=>void>=[];
  const handle=createMessageHandler({...f.deps,select:b=>new Promise(resolve=>releases.push(()=>resolve(selection(b))))});
  const pending=Array.from({length:6},(_,i)=>handle(request,contentSender(i+1)));await nextTurn();
  assert.equal((await handle({...request,request:{text:'明天在回覆',revision:'different'}},contentSender())).ok,false);
  assert.equal((await handle(request,contentSender(7))).ok,false);assert.equal(releases.length,6);
  releases.forEach(fn=>fn());await Promise.all(pending);
});

test('profile changes while waiting discard a paid reply',async()=>{
  const f=fixture();let release:()=>void=()=>{};
  const handle=createMessageHandler({...f.deps,select:b=>new Promise(resolve=>{release=()=>resolve(selection(b));})});
  const pending=handle(request,contentSender());await nextTurn();await handle({type:'shunzi:clear-profile'},optionsSender);release();
  const reply=await pending;assert.ok(!reply.ok);assert.equal(reply.error.code,'stale_result');
});

test('only explicit offered choices teach; restore retracts, duplicate event cannot double-learn',async()=>{
  const f=fixture(),handle=createMessageHandler({...f.deps,select:async b=>selection(b)});
  const reply=checked(await handle(request,contentSender()));assert.equal(f.values.paragraphProfile,undefined);
  const event={type:'shunzi:feedback',reviewId:reply.reviewId,editId:reply.edits[0].id,text:reply.edits[0].replacement,action:'accept',eventId:'event-one'};
  assert.equal((await handle({...event,text:'未提供詞'},contentSender())).ok,false);
  assert.equal((await handle(event,contentSender(2))).ok,false);
  assert.equal((await handle(event,optionsSender)).ok,false);
  await handle(event,contentSender());await handle(event,contentSender());assert.equal((f.values.paragraphProfile as any).weights[event.text],1);
  await handle({...event,text:reply.edits[0].original,action:'restore',eventId:'event-two'},contentSender());assert.equal((f.values.paragraphProfile as any).weights[event.text],0);
  await handle({...event,text:reply.edits[0].original,action:'keep',eventId:'event-three'},contentSender());assert.equal((f.values.paragraphProfile as any).weights[reply.edits[0].original],1);
  assert.equal((await handle({type:'shunzi:clear-profile'},contentSender())).ok,false);await handle({type:'shunzi:clear-profile'},optionsSender);
  assert.deepEqual((f.values.paragraphProfile as any).weights,{});assert.equal(f.values.jevCredential,'DUMMY_JEV');
});

test('remember protects a term without teaching a preference or changing credentials',async()=>{
  assert.deepEqual(normalizeTerms([' 順字 ','順字','字'.repeat(31)]),['順字']);
  const f=fixture(),handle=createMessageHandler(f.deps);await handle({type:'shunzi:remember',term:'順字'},contentSender());
  assert.deepEqual(f.values.protectedTerms,['順字']);assert.equal(f.values.paragraphProfile,undefined);assert.equal(f.values.jevCredential,'DUMMY_JEV');
});

test('options connection test always calls provider with a fixed nonempty candidate, and counts usage',async()=>{
  const f=fixture({enabled:false,protectedTerms:['private-term']});let calls=0;
  const drafts=new Set<string>();
  const handle=createMessageHandler({...f.deps,select:async(b,key)=>{calls++;assert.equal(key,'DUMMY_JEV');assert.match(b.request.text,/^明天在回覆你。\n\[connection-test:[0-9a-f-]{36}\]$/);assert.equal(drafts.has(b.request.text),false);drafts.add(b.request.text);assert.deepEqual(b.request.protectedTerms,[]);assert.equal(b.groups.length,1);assert.equal(b.groups[0].options[1].text,'再');return selection(b);}});
  assert.equal((await handle({type:'shunzi:test-connection'},contentSender())).ok,false);
  checked(await handle({type:'shunzi:test-connection'},optionsSender));checked(await handle({type:'shunzi:test-connection'},optionsSender));
  assert.equal(calls,2);assert.equal(f.values.jevUsage.requests,2);assert.equal(f.values.jevUsage.unconfirmed,0);
});

test('unknown failures reserve maximum and duplicate failure does not resend',async()=>{
  const f=fixture();let calls=0;const handle=createMessageHandler({...f.deps,select:async()=>{calls++;throw new ProviderError('timeout','DUMMY_JEV');}});
  const reply=await handle(request,contentSender());assert.ok(!reply.ok);assert.equal(reply.error.code,'timeout');assert.equal(JSON.stringify(reply).includes('DUMMY'),false);
  await handle(request,contentSender());assert.equal(calls,1);assert.deepEqual(f.values.jevUsage,{requests:1,estimatedTwd:JEV_MAX_CALL_TWD,unconfirmed:1});
});

test('hosted wire posts immutable local batch with UUID only to configured HTTPS endpoint',async()=>{
  const f=fixture({entitlement});let posts=0;
  const handle=createMessageHandler({...f.deps,mode:'hosted',fetcher:async(url,init)=>{
    assert.equal(url,'https://fixture.invalid/v1/check');assert.equal(init?.method,'POST');assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');
    const headers=new Headers(init?.headers);assert.equal(headers.get('authorization'),'Bearer DUMMY_HOSTED');assert.match(headers.get('X-Request-Id')!,/^[0-9a-f-]{36}$/);
    const body=JSON.parse(init?.body as string);assert.deepEqual(Object.keys(body),['batch']);assert.ok(body.batch.groups.length);posts++;
    return Response.json({selection:selection(body.batch),entitlement:{...entitlement,remainingChecks:99}});
  }});
  checked(await handle(request,contentSender()));checked(await handle(request,contentSender()));assert.equal(posts,1);assert.equal(f.values.entitlement.remainingChecks,99);
});

test('status refresh uses GET without API reservation and expired plan is visible but cannot check',async()=>{
  const f=fixture();let gets=0;const expired={...entitlement,expiresAt:1};
  const handle=createMessageHandler({...f.deps,mode:'hosted',fetcher:async(url,init)=>{assert.equal(url,'https://fixture.invalid/v1/status');assert.equal(init?.body,undefined);assert.equal(init?.method,undefined);gets++;return Response.json({entitlement:expired});}});
  const reply=await handle({type:'shunzi:refresh-status'},optionsSender);assert.ok(reply.ok && 'settings' in reply);assert.deepEqual(reply.settings.entitlement,expired);assert.equal(f.values.jevUsage,undefined);
  const check=await handle(request,contentSender());assert.ok(!check.ok);assert.equal(check.error.code,'expired');assert.equal(gets,1);
  assert.match(entitlementSummary(expired).count,/到期/);assert.match(entitlementSummary(entitlement).count,/剩餘 100/);assert.match(entitlementSummary(entitlement).detail,/台北時間/);
});

test('hosted error codes distinguish expiry, quota, budget and provider timeout without exposing messages',async()=>{
  for(const [status,code,expected] of [[401,'unauthorized','auth'],[403,'expired','expired'],[402,'checks_exhausted','quota'],[402,'budget_exhausted','budget'],[429,'rate_limited','rate_limit'],[504,'timeout','timeout']] as const) {
    const f=fixture({entitlement});const handle=createMessageHandler({...f.deps,mode:'hosted',fetcher:async()=>Response.json({error:{code,message:'DUMMY_SECRET'}},{status})});
    const reply=await handle(request,contentSender());assert.ok(!reply.ok);assert.equal(reply.error.code,expected);assert.equal(JSON.stringify(reply).includes('DUMMY'),false);
  }
});

test('misconfigured origins and modified remote candidate batches fail closed',async()=>{
  for(const hostedOrigin of ['http://fixture.invalid','https://fixture.invalid/path','https://name:pass@fixture.invalid']) {
    const f=fixture({entitlement});let calls=0;const handle=createMessageHandler({...f.deps,mode:'hosted',hostedOrigin,fetcher:async()=>{calls++;return Response.json({});}});
    assert.equal((await handle(request,contentSender())).ok,false);assert.equal(calls,0);
  }
  const f=fixture({entitlement});const handle=createMessageHandler({...f.deps,mode:'hosted',fetcher:async(_url,init)=>{
    const {batch}=JSON.parse(init?.body as string);batch.groups[0].options[1].text='別的字';return Response.json({selection:selection(batch),entitlement});}});
  assert.equal((await handle(request,contentSender())).ok,false);
});

test('one-click pause and clearing profile invalidate caches without altering active key',async()=>{
  const f=fixture(),handle=createMessageHandler(f.deps);assert.equal((await handle({type:'shunzi:set-enabled',enabled:false},contentSender())).ok,true);
  assert.equal(f.values.enabled,false);assert.equal(f.values.jevCredential,'DUMMY_JEV');assert.equal((await handle({type:'shunzi:set-enabled',enabled:'true'},contentSender())).ok,false);
});
