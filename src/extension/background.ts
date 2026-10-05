import { validateRequest, ProviderError, MAX_CHARACTERS } from '../core/index';
import { PhoneticLexicon, prepareParagraph, selectWithJev, reviewJevSelection, learnParagraphChoice,
  EMPTY_PROFILE, JEV_MODEL, JEV_MAX_CALL_TWD, BUNDLED_LEXICON_VERSION, SUPPORTED_PIPELINE_VERSION,
  type CandidateBatch, type ParagraphProfile, type ParagraphSelection, type LexiconEntry } from '../core/paragraph/index';
import type { CheckRequest } from '../core/types';
import { normalizeTerms, type Mode, type PublicSettings, type Reply, type UsageEstimate, type Entitlement } from './protocol';

type Storage = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove' | 'setAccessLevel'>;
interface Dependencies {
  storage: Storage; mode: Mode; hostedOrigin: string; extensionId: string; optionsUrl: string;
  openOptions: () => Promise<void>; lexiconUrl?: string; loadLexicon?: () => Promise<PhoneticLexicon>;
  fetcher?: typeof fetch; select?: typeof selectWithJev; now?: () => number;
}
const publicError = (code: string, message: string): Reply => ({ ok: false, error: { code, message } });
const settingsKeys = ['enabled', 'jevCredential', 'hostedCredential', 'credential', 'protectedTerms', 'jevUsage', 'paragraphProfile', 'entitlement'];
const credentialKey = (mode: Mode) => mode === 'byok' ? 'jevCredential' : 'hostedCredential';
function usageEstimate(value: unknown): UsageEstimate {
  const item = value as Partial<UsageEstimate> | undefined;
  return { estimatedTwd: Number.isFinite(item?.estimatedTwd) && item!.estimatedTwd! >= 0 ? item!.estimatedTwd! : 0,
    requests: Number.isSafeInteger(item?.requests) && item!.requests! >= 0 ? item!.requests! : 0,
    unconfirmed: Number.isSafeInteger(item?.unconfirmed) && item!.unconfirmed! >= 0 ? item!.unconfirmed! : 0 };
}
function profileOf(raw: Record<string, unknown>): ParagraphProfile {
  const p = raw.paragraphProfile as ParagraphProfile | undefined;
  if (!p) return structuredClone(EMPTY_PROFILE);
  if (!Number.isSafeInteger(p.revision) || p.revision < 0 || !p.weights || typeof p.weights !== 'object' ||
      Object.keys(p.weights).length > 1000 || Object.entries(p.weights).some(([word,n]) => !/^\p{Script=Han}{1,8}$/u.test(word) || !Number.isInteger(n) || n < 0 || n > 100) ||
      !Array.isArray(p.eventIds) || p.eventIds.length > 512 || p.eventIds.some(id => typeof id !== 'string' || id.length > 100))
    throw new ProviderError('invalid_profile', '個人偏好無法讀取，請到設定清除後再試。');
  return p;
}
export function validEntitlement(value: unknown): Entitlement | undefined {
  const e = value as Entitlement | undefined;
  return e && ['trial','paid'].includes(e.plan) && Number.isSafeInteger(e.expiresAt) && e.expiresAt > 0 &&
    Number.isSafeInteger(e.limit) && e.limit > 0 && Number.isSafeInteger(e.remainingChecks) && e.remainingChecks >= 0 && e.remainingChecks <= e.limit ?
    { plan:e.plan, expiresAt:e.expiresAt, remainingChecks:e.remainingChecks, limit:e.limit } : undefined;
}
function publicSettings(raw: Record<string, unknown>, mode: Mode): PublicSettings {
  const profile = profileOf(raw);
  return { mode, enabled:raw.enabled === true, configured:typeof raw[credentialKey(mode)] === 'string' && !!raw[credentialKey(mode)],
    hasLegacyCredential:typeof raw.credential === 'string' && !!raw.credential,
    protectedTerms:normalizeTerms(raw.protectedTerms), usage:usageEstimate(raw.jevUsage),
    profileRevision:profile.revision, learnedTerms:Object.values(profile.weights).filter(n=>n>0).length,
    ...(mode === 'hosted' && validEntitlement(raw.entitlement) ? { entitlement:validEntitlement(raw.entitlement) } : {}) };
}
const errorMessages: Record<string,string> = {
  invalid_key:'Jev 金鑰無效，請到設定更新。', forbidden:'Jev 帳戶沒有使用權限，請確認 API 帳戶設定。',
  rate_limit:'API 額度不足或請求過多，請稍後再試。', timeout:'校對逾時，原文已保留。請稍後再試。',
  auth:'啟用碼無效，請到設定更新。', expired:'使用期限已到，請到設定查看方案。',
  quota:'本期校對次數已用完，原文已保留。', budget:'服務預算已用完，這段文字保留原樣。',
  duplicate:'這次校對已處理，請保留原文或稍後重新輸入。', busy:'上一段還在校對，請稍候。',
  paid_blocked:'付費方案尚未開放使用，請查看設定頁。', candidate_budget:'這段候選超過單次成本限制，請縮短草稿後再試。',
  stale_result:'草稿或設定已變更，這次結果已捨棄。', invalid_profile:'個人偏好無法讀取，請到設定清除後再試。',
  lexicon_unavailable:'本機詞庫無法載入，請重新安裝完整套件。',
  unavailable:'這次無法校對，原文已保留。請查看設定頁的常見問題。',
};
const errorAliases: Record<string,string> = { unauthorized:'auth', checks_exhausted:'quota',quota_exhausted:'quota',budget_exhausted:'budget',
  duplicate_request:'duplicate',duplicate_snapshot:'duplicate',request_in_progress:'busy',server_busy:'busy',rate_limited:'rate_limit' };
const safeError = (code: string) => {
  const normalized = errorAliases[code.toLowerCase()] ?? code.toLowerCase();
  return publicError(normalized in errorMessages ? normalized : 'unavailable', errorMessages[normalized] ?? errorMessages.unavailable);
};
export function authorizedSender(sender: chrome.runtime.MessageSender, deps: Pick<Dependencies,'extensionId'|'optionsUrl'>): 'options'|'content'|null {
  if (sender.id !== deps.extensionId) return null;
  if (sender.url === deps.optionsUrl) return 'options';
  try { const url = new URL(sender.url ?? '');
    if (url.origin === 'https://chatgpt.com' && sender.frameId === 0 && Number.isInteger(sender.tab?.id)) return 'content';
  } catch { /* deny */ }
  return null;
}

export function createMessageHandler(deps: Dependencies) {
  const ready = deps.storage.setAccessLevel({ accessLevel:'TRUSTED_CONTEXTS' });
  const now = deps.now ?? Date.now;
  const fetcher: typeof fetch = (input, init) => (deps.fetcher ?? fetch)(input, init);
  let epoch = 0, lexicon: Promise<PhoneticLexicon> | undefined, serial: Promise<unknown> = Promise.resolve();
  const inflight = new Map<number,string>();
  const cache = new Map<string,{ until:number; result:Promise<ParagraphSelection> }>();
  const reviews = new Map<string,{ owner:string; batch:CandidateBatch; until:number; learned:Map<string,{text:string;delta:number}> }>();
  function mutate<T>(work: () => Promise<T>): Promise<T> { const task = serial.then(work); serial = task.catch(()=>{}); return task; }
  function invalidate() { epoch++; cache.clear(); }
  const settings = async (): Promise<Reply> => ({ ok:true, settings:publicSettings(await deps.storage.get(settingsKeys), deps.mode) });
  function getLexicon() {
    if (!lexicon) lexicon = (async () => {
      if (deps.loadLexicon) return deps.loadLexicon();
      if (!deps.lexiconUrl || !deps.lexiconUrl.startsWith(`chrome-extension://${deps.extensionId}/data/`)) throw new Error();
      const response = await fetcher(deps.lexiconUrl, { credentials:'omit', cache:'force-cache' });
      if (!response.ok) throw new Error();
      const entries = await response.json();
      if (!Array.isArray(entries)) throw new Error();
      const value = new PhoneticLexicon(entries as LexiconEntry[], BUNDLED_LEXICON_VERSION, { allowToneChanges:true });
      if (!value.size) throw new Error();
      return value;
    })().catch(()=> { lexicon = undefined; throw new ProviderError('lexicon_unavailable',''); });
    return lexicon;
  }
  function endpoint(path: '/v1/check'|'/v1/status') {
    const url = new URL(deps.hostedOrigin);
    if (url.protocol !== 'https:' || url.origin !== deps.hostedOrigin || url.username || url.password) throw new ProviderError('configuration','');
    return `${url.origin}${path}`;
  }
  async function hostedError(response: Response): Promise<never> {
    let code = response.status === 401 || response.status === 403 ? 'auth' : response.status === 402 ? 'budget' : response.status === 429 ? 'rate_limit' : response.status === 409 ? 'duplicate' : 'unavailable';
    try { const body = await response.json(); if (typeof body?.error?.code === 'string') code = body.error.code; } catch { /* only public mappings */ }
    throw new ProviderError(code,'');
  }
  async function status(key: string) {
    const response = await fetcher(endpoint('/v1/status'), { headers:{ Authorization:`Bearer ${key}` }, signal:AbortSignal.timeout(5000), credentials:'omit', redirect:'error', cache:'no-store' });
    if (!response.ok) await hostedError(response);
    const entitlement = validEntitlement((await response.json()).entitlement);
    if (!entitlement) throw new ProviderError('invalid_response','');
    const raw = await deps.storage.get(settingsKeys);
    if (raw.hostedCredential === key) await deps.storage.set({ entitlement });
    return entitlement;
  }
  function connectionBatch(profileRevision:number): CandidateBatch {
    return { request:{ text:`明天在回覆你。\n[connection-test:${crypto.randomUUID()}]`, revision:crypto.randomUUID(), protectedTerms:[] }, pipelineVersion:SUPPORTED_PIPELINE_VERSION,
      profileRevision, truncated:false, groups:[{id:'g2_3',start:2,end:3,original:'在',options:[{id:'keep',text:'在',rankScore:0},{id:'o0',text:'再',rankScore:1}]}] };
  }
  async function reserve() { await mutate(async () => { const raw = await deps.storage.get('jevUsage'), u = usageEstimate(raw.jevUsage);
    await deps.storage.set({ jevUsage:{estimatedTwd:u.estimatedTwd+JEV_MAX_CALL_TWD,requests:u.requests+1,unconfirmed:u.unconfirmed+1} }); }); }
  async function confirm(selection:ParagraphSelection) { const actual=selection.usage?.estimatedTwd;
    if (typeof actual !== 'number' || !Number.isFinite(actual) || actual<0) return;
    await mutate(async()=> { const raw=await deps.storage.get('jevUsage'),u=usageEstimate(raw.jevUsage);
      await deps.storage.set({jevUsage:{...u,estimatedTwd:Math.max(0,u.estimatedTwd-JEV_MAX_CALL_TWD+actual),unconfirmed:Math.max(0,u.unconfirmed-1)}}); });
  }
  return async (message:unknown, sender:chrome.runtime.MessageSender):Promise<Reply> => {
    const caller=authorizedSender(sender,deps);
    if (!caller || !message || typeof message !== 'object' || !('type' in message)) return publicError('denied','無法接受這個來源的要求。');
    await ready;
    const value=message as Record<string,unknown>, owner=`${sender.tab?.id ?? -1}:${sender.url}:${sender.documentId ?? ''}`;
    try {
      if (value.type==='shunzi:settings') return await settings();
      if (value.type==='shunzi:open-options' && caller==='content') { await deps.openOptions(); return {ok:true}; }
      if (value.type==='shunzi:set-enabled' && caller==='content' && typeof value.enabled==='boolean') {
        invalidate(); await deps.storage.set({enabled:value.enabled}); return await settings();
      }
      if (value.type==='shunzi:save-options' && caller==='options') {
        if (typeof value.enabled!=='boolean' || !Array.isArray(value.protectedTerms)) return publicError('invalid','設定格式不正確。');
        const update:Record<string,unknown>={enabled:value.enabled,protectedTerms:normalizeTerms(value.protectedTerms)};
        if (value.credential!==undefined) {
          if (typeof value.credential!=='string' || !value.credential.trim() || value.credential.trim().length>512 || /\s/.test(value.credential.trim())) return publicError('invalid','請貼上完整金鑰或啟用碼，不要包含空白。');
          update[credentialKey(deps.mode)]=value.credential.trim();
          if (deps.mode==='hosted') await deps.storage.remove('entitlement');
        }
        invalidate(); reviews.clear(); await deps.storage.set(update); return await settings();
      }
      if (value.type==='shunzi:clear-key' && caller==='options') {
        invalidate(); reviews.clear(); await deps.storage.remove(['credential',credentialKey(deps.mode),'entitlement']);
        await deps.storage.set({enabled:false}); return await settings();
      }
      if (value.type==='shunzi:clear-profile' && caller==='options') {
        await mutate(async()=> {const raw=await deps.storage.get(settingsKeys); let revision=0;
          try { revision=profileOf(raw).revision; } catch { /* recover corrupted local data */ }
          invalidate(); reviews.clear(); await deps.storage.set({paragraphProfile:{revision:revision+1,weights:{},eventIds:[]}}); });
        return await settings();
      }
      if (value.type==='shunzi:refresh-status' && caller==='options' && deps.mode==='hosted') {
        const raw=await deps.storage.get(settingsKeys), key=raw.hostedCredential;
        if (typeof key!=='string' || !key) return publicError('not_configured','請先儲存啟用碼。');
        await status(key); return await settings();
      }
      if (value.type==='shunzi:remember' && caller==='content') {
        if (typeof value.term!=='string' || !value.term.trim() || [...value.term].length>30) return publicError('invalid','記住的詞需為 1–30 個字元。');
        await mutate(async()=> { const raw=await deps.storage.get(settingsKeys),terms=normalizeTerms(raw.protectedTerms);
          if (terms.length>=30 && !terms.includes((value.term as string).trim())) throw new ProviderError('limit','');
          invalidate(); await deps.storage.set({protectedTerms:normalizeTerms([...terms,value.term])}); });
        return await settings();
      }
      if (value.type==='shunzi:feedback' && caller==='content') {
        const saved=typeof value.reviewId==='string' ? reviews.get(value.reviewId) : undefined;
        if (!saved || saved.owner!==owner || saved.until<now() || typeof value.editId!=='string' || typeof value.text!=='string' ||
            typeof value.eventId!=='string' || !value.eventId || value.eventId.length>100 || !['accept','keep','restore'].includes(String(value.action))) return safeError('stale_result');
        const group=saved.batch.groups.find(g=>`${saved.batch.request.revision}:${g.id}`===value.editId);
        const option=group?.options.find(o=>o.text===value.text);
        if (!group || !option || (value.action!=='accept' && option.id!=='keep')) return publicError('invalid','這個候選已失效。');
        await mutate(async()=> {
          const raw=await deps.storage.get(settingsKeys); let profile=profileOf(raw);
          if (profile.eventIds.includes(value.eventId as string)) return;
          const previous=saved.learned.get(group.id);
          if (previous) profile={...profile,weights:{...profile.weights,[previous.text]:Math.max(0,(profile.weights[previous.text]??0)-previous.delta)}};
          if (value.action==='restore') profile={...profile,revision:profile.revision+1,eventIds:[...profile.eventIds,value.eventId as string].slice(-512)};
          else {
            const before=profile.weights[option.text]??0;
            profile=learnParagraphChoice(profile,saved.batch,{groupId:group.id,optionId:option.id},value.eventId as string,'user');
            saved.learned.set(group.id,{text:option.text,delta:(profile.weights[option.text]??0)-before});
          }
          if (value.action==='restore') saved.learned.delete(group.id);
          invalidate(); await deps.storage.set({paragraphProfile:profile});
        });
        return await settings();
      }
      const testing=value.type==='shunzi:test-connection' && caller==='options';
      if (!testing && (value.type!=='shunzi:check' || caller!=='content')) return publicError('denied','這個操作只能在擴充功能設定頁完成。');
      const raw=await deps.storage.get(settingsKeys), key=raw[credentialKey(deps.mode)], profile=profileOf(raw);
      const input=testing ? connectionBatch(profile.revision).request : value.request as CheckRequest|undefined;
      const revision=typeof input?.revision==='string'?input.revision:'';
      if (!raw.enabled && !testing) return {ok:true,response:{revision,edits:[],status:'paused'}};
      if (typeof key!=='string' || !key) return publicError('not_configured','先在順字設定中完成 Jev 金鑰或啟用碼連線。');
      if (typeof input?.text==='string' && [...input.text].length>MAX_CHARACTERS) return {ok:true,response:{revision,edits:[],status:'too-long'}};
      const request=validateRequest({...input,protectedTerms:testing?[]:normalizeTerms(raw.protectedTerms)});
      const startedEpoch=epoch, tabId=testing?-1:sender.tab!.id!;
      const cacheKey=JSON.stringify([owner,request.text,request.protectedTerms,profile.revision,startedEpoch,testing?request.revision:'']);
      for (const [id,item] of cache) if (item.until<now()) cache.delete(id);
      let entry=cache.get(cacheKey);
      if (!entry) {
        if (inflight.has(tabId) || inflight.size>=6) return safeError('busy');
        inflight.set(tabId,cacheKey);
        const result=(async()=> {
          try {
            const batch=testing?{...connectionBatch(profile.revision),request}:prepareParagraph(request,await getLexicon(),profile);
            if (!batch.groups.length) return {batch,revision:request.revision,pipelineVersion:batch.pipelineVersion,profileRevision:profile.revision,model:JEV_MODEL,choices:[]} as ParagraphSelection;
            let url='';
            if (deps.mode==='hosted') {
              url=endpoint('/v1/check');
              const entitlement=validEntitlement(raw.entitlement) ?? await status(key);
              if (entitlement.expiresAt<=now()) throw new ProviderError('expired','');
              if (!entitlement.remainingChecks) throw new ProviderError('quota','');
            }
            if (epoch!==startedEpoch) throw new ProviderError('stale_result','');
            await reserve();
            let selection:ParagraphSelection;
            if (deps.mode==='byok') selection=await (deps.select ?? selectWithJev)(batch,key,{fetcher});
            else {
              const response=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`,'X-Request-Id':crypto.randomUUID()},
                body:JSON.stringify({batch}),signal:AbortSignal.timeout(5000),credentials:'omit',redirect:'error',cache:'no-store'});
              if (!response.ok) await hostedError(response);
              const body=await response.json(),entitlement=validEntitlement(body.entitlement); selection=body.selection;
              if (!entitlement) throw new ProviderError('invalid_response','');
              if ((await deps.storage.get(settingsKeys)).hostedCredential===key) await deps.storage.set({entitlement});
            }
            if (JSON.stringify(selection.batch)!==JSON.stringify(batch)) throw new ProviderError('invalid_response','');
            reviewJevSelection(selection,request,profile.revision);
            await confirm(selection); return selection;
          } finally { if (inflight.get(tabId)===cacheKey) inflight.delete(tabId); }
        })();
        entry={until:now()+60_000,result}; cache.set(cacheKey,entry);
        if (cache.size>24) { const first=cache.keys().next().value; if(first) cache.delete(first); }
      }
      const selection=await entry.result;
      const latest=await deps.storage.get(settingsKeys);
      if (epoch!==startedEpoch || profileOf(latest).revision!==profile.revision || latest[credentialKey(deps.mode)]!==key || (!testing && !latest.enabled)) return safeError('stale_result');
      const rebound:ParagraphSelection={...selection,revision:request.revision,batch:{...selection.batch,request}};
      const review=reviewJevSelection(rebound,request,profile.revision), reviewId=crypto.randomUUID();
      for(const [id,item] of reviews) if(item.until<now()) reviews.delete(id);
      reviews.set(reviewId,{owner,batch:review.batch,until:now()+300_000,learned:new Map()});
      if(reviews.size>32) reviews.delete(reviews.keys().next().value!);
      return {ok:true,response:{revision:request.revision,status:'ok',edits:review.edits.map(e=>({...e,action:'suggest'})),reviewId,usage:selection.usage}};
    } catch(error) {
      return safeError(error instanceof ProviderError?error.code:error instanceof Error && ['TimeoutError','AbortError'].includes(error.name)?'timeout':'unavailable');
    }
  };
}

if (typeof chrome!=='undefined' && chrome.runtime?.id && chrome.storage) {
  const handler=createMessageHandler({storage:chrome.storage.local,mode:__MODE__,hostedOrigin:__HOSTED_ORIGIN__,extensionId:chrome.runtime.id,
    optionsUrl:chrome.runtime.getURL('options.html'),lexiconUrl:chrome.runtime.getURL('data/lexicon.json'),openOptions:()=>chrome.runtime.openOptionsPage()});
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{void handler(message,sender).then(respond).catch(()=>respond(safeError('unavailable')));return true;});
  chrome.action?.onClicked.addListener(()=>{void chrome.runtime.openOptionsPage();});
}
