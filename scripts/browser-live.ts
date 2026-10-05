/** Actual MV3 + real Jev, on an explicitly labelled local host fixture. Never sends a ChatGPT message. */
import { chromium, type BrowserContext, type Worker } from 'playwright';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { JEV_ENDPOINT, JEV_MAX_CALL_TWD, JEV_MODEL } from '../src/core/paragraph/index.js';
import { initializeEvaluationLedger, reserveEvaluationCall, settleEvaluationCall, failEvaluationCall,
  evaluationSpentTwd } from './evaluation-ledger.js';

const hosted=process.argv.includes('--hosted');
const root=resolve('.local'), key=hosted ? JSON.parse(await readFile('.local/hosted-eval.json','utf8')).token
  : (await readFile('.local/jev-api-key.txt','utf8')).trim();
const liveEndpoint=hosted?'https://proof.040141.xyz/v1/check':JEV_ENDPOINT;
const demo=process.argv.includes('--demo');
await mkdir(root,{recursive:true}); await mkdir('docs/assets',{recursive:true});
const profile=await mkdtemp(resolve(root,'product-live-profile-'));
const videoDirectory=resolve(profile,'videos');
const db=new DatabaseSync(resolve(root,'eval-budget.sqlite'));
initializeEvaluationLedger(db,JEV_MAX_CALL_TWD);
let context:BrowserContext|undefined;
const rows:{latencyMs:number;expected:boolean;costTwd:number}[]=[];
let worker:Worker|undefined;
try {
  const extension=resolve(`dist/${hosted?'hosted':'byok'}`);
  context=await chromium.launchPersistentContext(profile,{channel:'msedge',headless:true,
    viewport:{width:1120,height:820},ignoreDefaultArgs:['--disable-extensions'],
    recordVideo:demo?{dir:videoDirectory,size:{width:1120,height:820}}:undefined,
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--disable-background-networking']});
  worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://')) ??
    await context.waitForEvent('serviceworker',{timeout:15000});
  const extensionId=new URL(worker.url()).host;
  // Exactly one remote request may consume each pre-reserved slot. No automatic retries spend unreserved money.
  await worker.evaluate(({endpoint,key,hosted})=>{
    const w=globalThis as any, nativeFetch=globalThis.fetch.bind(globalThis);
    w.__liveSlot=false; w.__liveResult=undefined;
    w.fetch=async(input:any,init:any)=>{
      if(String(input)!==endpoint) return nativeFetch(input,init);
      if(!w.__liveSlot) throw new Error('No prepaid test slot');
      w.__liveSlot=false; w.__liveResult={sent:true};
      try {
        const response=await nativeFetch(input,init);
        const result=await response.clone().json();
        w.__liveResult={sent:true,status:response.status,usage:hosted?{
          input_tokens:result.selection?.usage?.inputTokens,output_tokens:result.selection?.usage?.outputTokens}:result.usage,
          model:hosted?result.selection?.model:result.model};
        return response;
      } catch { w.__liveResult={sent:true,error:'request_failed'}; throw new Error('Live request failed'); }
    };
    return chrome.storage.local.set({[hosted?'hostedCredential':'jevCredential']:key,enabled:true,protectedTerms:[]});
  },{endpoint:liveEndpoint,key,hosted});
  const options=await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator('#settings-form').waitFor();
  if(await options.locator('#credential').inputValue()) throw new Error('Credential unexpectedly rendered');
  if(!demo) await options.screenshot({path:resolve(`docs/assets/options-${hosted?'hosted':'byok'}.png`),fullPage:true});
  await options.close();
  const page=await context.newPage();
  const fixture='https://chatgpt.com/shunzi-local-test';
  await page.route(fixture,route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>順字實機測試</title><style>body{font:18px/1.8 "Microsoft JhengHei",sans-serif;color:#25334a;background:#f8fafc;margin:0}main{max-width:850px;margin:90px auto}small{color:#62738a}h1{font-size:34px;letter-spacing:.02em;margin:8px 0}p{color:#52657e}#prompt-textarea{background:white;border:1px solid #cbd5e1;border-radius:12px;padding:24px;margin-top:90px;min-height:100px;outline-color:#386bcc}footer{margin-top:80px;font-size:14px;color:#62738a}</style><main><small>順字 · 真實擴充套件與 Jev 連線</small><h1>說完之後，少花時間修錯字。</h1><p>這是本機測試草稿，沒有傳送 ChatGPT 對話。</p><div data-composer-input><div id="prompt-textarea" data-composer-markdown contenteditable="true" role="textbox" aria-label="測試草稿"></div></div><footer>點一下底線，選詞或保留原文。範例不代表所有句子的修正品質。</footer></main></html>`}));
  await page.goto(fixture);
  await page.locator('[data-shunzi]').waitFor();
  const editor=page.getByRole('textbox',{name:'測試草稿'});
  if(demo) await page.waitForTimeout(2500);
  for(let i=0;i<(demo?1:hosted?6:30);i++) {
    const id=randomUUID();
    if(!hosted) reserveEvaluationCall(db,{id,label:'product-browser-live',model:JEV_MODEL,maxCallTwd:JEV_MAX_CALL_TWD});
    await worker.evaluate(()=>{(globalThis as any).__liveResult=undefined;(globalThis as any).__liveSlot=true;});
    const text=`第${i+1}則：請把這兩段連載憶起，整理成一份筆記。`+(hosted?` [browser:${id}]`:'');
    const start=performance.now();
    try {
      await editor.fill(text);
      const mark=page.locator('[data-shunzi] .marker').first();
      await mark.waitFor({state:'visible',timeout:6000});
      const latencyMs=Math.round(performance.now()-start);
      const provider=await worker.evaluate(()=>(globalThis as any).__liveResult);
      if(provider?.status!==200 || provider.model!==JEV_MODEL || !Number.isSafeInteger(provider.usage?.input_tokens))
        throw new Error('No confirmed Jev usage');
      const cost=provider.usage.input_tokens*.042/1e6*35;
      if(!hosted) {
        const settlement=settleEvaluationCall(db,id,cost,JEV_MAX_CALL_TWD);
        if(settlement.stopReason) throw new Error('Cost guard');
      }
      if(demo) await page.waitForTimeout(3500);
      await mark.click();
      const dialog=page.getByRole('dialog',{name:'順字校對建議'});
      await dialog.waitFor();
      const choices=await dialog.locator('.choices button').allTextContents();
      rows.push({latencyMs,expected:choices.some(c=>/連在一起|在一起/.test(c)),costTwd:cost});
      if(i===0 && !demo && !hosted) await page.screenshot({path:resolve('docs/assets/candidate-review.png')});
      if(demo) {
        await page.waitForTimeout(4000);
        await dialog.locator('.choices button').first().click();
        await page.waitForTimeout(4000);
        await mark.click();
        await page.getByRole('button',{name:'還原原文',exact:true}).click();
        await page.waitForTimeout(4000);
      } else await page.keyboard.press('Escape');
    } catch {
      const diagnostic={case:i+1,provider:await worker.evaluate(()=>(globalThis as any).__liveResult).catch(()=>null),
        marks:await page.locator('[data-shunzi] .marker').count(),
        status:await page.locator('[data-shunzi] .brand').textContent().catch(()=>null)};
      await writeFile('.local/browser-live-failure.json',JSON.stringify(diagnostic,null,2));
      console.log(JSON.stringify(diagnostic));
      if(!hosted) failEvaluationCall(db,id);
      throw new Error(`Browser live check failed at synthetic case ${i+1}`);
    }
  }
  const latencies=rows.map(r=>r.latencyMs).sort((a,b)=>a-b);
  const report={kind:'actual-edge-mv3-real-jev-local-host-fixture',edition:hosted?'hosted':'byok',notLiveChatGPTSite:true,includesDebounceMs:600,
    requests:rows.length,p95Ms:latencies[Math.ceil(latencies.length*.95)-1],coldFirstMs:rows[0]?.latencyMs,
    expectedCandidates:rows.filter(r=>r.expected).length,totalLedgerTwd:evaluationSpentTwd(db),rows};
  await writeFile(`.local/browser-${demo?'demo':hosted?'hosted-live':'live'}.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
  if(demo) {
    const video=page.video(); await page.close();
    await video?.saveAs(resolve('docs/assets/shunzi-demo.webm'));
  }
} finally {
  // Only this task-owned temporary profile, after all browser processes exit.
  try { await worker?.evaluate(()=>chrome.storage.local.clear()); } catch { /* profile will be deleted */ }
  await context?.close(); db.close();
  const resolved=resolve(profile);
  if(!resolved.startsWith(root+sep) || !resolved.includes('product-live-profile-')) throw new Error('Unsafe cleanup path');
  await rm(resolved,{recursive:true,force:true});
}
