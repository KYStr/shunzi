import { runtimeMessage, normalizeTerms, entitlementSummary, type PublicSettings } from './protocol';

const $ = <T extends HTMLElement = HTMLElement>(id:string) => document.getElementById(id) as T;
const form=$<HTMLFormElement>('settings-form'),credential=$<HTMLInputElement>('credential'),enabled=$<HTMLInputElement>('enabled');
const terms=$<HTMLTextAreaElement>('protected-terms'),result=$('result'),clear=$<HTMLButtonElement>('clear'),save=$<HTMLButtonElement>('save');
const toggle=$<HTMLButtonElement>('toggle-secret'),testConnection=$<HTMLButtonElement>('test-connection');
const refresh=$<HTMLButtonElement>('refresh-status'),clearProfile=$<HTMLButtonElement>('clear-profile');
let configured=false,legacy=false,mode:'byok'|'hosted'=__MODE__,busy=false;
function report(message:string,error=false) {result.textContent=message;result.classList.toggle('error',error);}
function setBusy(value:boolean) { busy=value; save.disabled=value;credential.disabled=value;clear.disabled=value||!(configured||legacy);
  testConnection.disabled=value||!configured||!!credential.value.trim();refresh.disabled=value||!configured;clearProfile.disabled=value; }
function show(settings:PublicSettings,resetForm=true) {
  mode=settings.mode;configured=settings.configured;legacy=!!settings.hasLegacyCredential;
  if(resetForm) { enabled.checked=settings.enabled;terms.value=settings.protectedTerms.join('\n');credential.value='';credential.type='password';toggle.textContent='顯示';toggle.setAttribute('aria-pressed','false'); }
  const usage=settings.usage??{requests:0,estimatedTwd:0,unconfirmed:0};
  $('mode-label').textContent=mode==='byok'?'自備 Jev 金鑰':'順字啟用碼';
  $('credential-label').textContent=mode==='byok'?'Jev API 金鑰':'你的啟用碼';
  $('connection-help').textContent=mode==='byok'?'使用你的 Jev 帳戶，API 費用由 TypeSafe 收取。':'貼上收到的啟用碼，並儲存設定。';
  $('privacy').textContent=mode==='byok'?'本機詞庫先找候選；有候選時，草稿與候選直接送往 TypeSafe Jev，不經順字伺服器。':'本機詞庫先找候選；有候選時，草稿與候選經順字服務送往 TypeSafe Jev。';
  $('credential-help').textContent=legacy?'偵測到舊版憑證，不會挪用為 Jev 金鑰。請重新設定，或按移除清除舊值。':configured?'已儲存在這部裝置。留空沿用；貼上新值即可更新。':'只儲存在這部裝置、不會同步，也不會傳給網頁。';
  credential.placeholder=configured?'已設定 · 留空沿用':mode==='byok'?'貼上 Jev API 金鑰':'貼上啟用碼';
  clear.textContent=mode==='byok'?'移除金鑰':'移除啟用碼';
  refresh.hidden=mode!=='hosted';
  $('usage-heading').textContent=mode==='hosted'?'本期校對次數':'本機用量估算';
  if(mode==='hosted') {
    const summary=entitlementSummary(settings.entitlement);
    $('usage-count').textContent=settings.entitlement?.plan==='paid'?'付費':'試用';
    $('usage-total').textContent=summary.count;$('usage-help').textContent=summary.detail;
  } else {
    $('usage-count').textContent=`${usage.requests} 次 API 要求`;$('usage-total').textContent=`約 NT$${usage.estimatedTwd.toFixed(2)}`;
    $('usage-help').textContent=`本機估算，不是帳單。${usage.unconfirmed?`${usage.unconfirmed} 次費用尚未確認，已保留較高估值。`:'實際費用以 TypeSafe 帳單為準。'}`;
  }
  $('profile-count').textContent=`已記住 ${settings.learnedTerms??0} 個偏好詞`;
  $('onboarding').hidden=configured;
  setBusy(busy);
}
async function refreshStatus() {
  const reply=await runtimeMessage({type:'shunzi:refresh-status'});
  if(reply.ok && 'settings' in reply) show(reply.settings,false);
  else if(!reply.ok) report(reply.error.message,true);
}
toggle.addEventListener('click',()=>{const visible=credential.type==='password';credential.type=visible?'text':'password';toggle.textContent=visible?'隱藏':'顯示';toggle.setAttribute('aria-pressed',String(visible));});
credential.addEventListener('input',()=>setBusy(busy));
refresh.addEventListener('click',()=>{setBusy(true);void refreshStatus().finally(()=>setBusy(false));});
testConnection.addEventListener('click',()=>{
  setBusy(true);report('正在用固定候選測試 Jev 連線…');
  void runtimeMessage({type:'shunzi:test-connection'}).then(async reply=>{
    const state=await runtimeMessage({type:'shunzi:settings'});if(state.ok && 'settings' in state) show(state.settings,false);
    if(!reply.ok) report(reply.error.message,true);
    else { const ok='response' in reply && reply.response.status==='ok';report(ok?'連線成功，可以開始校對。':'服務尚未就緒，請查看常見問題。',!ok); }
  }).finally(()=>setBusy(false));
});
form.addEventListener('submit',event=>{
  event.preventDefault();
  const rawTerms=terms.value.split(/\r?\n/).map(t=>t.trim()).filter(Boolean);
  if([...new Set(rawTerms)].length>30 || rawTerms.some(t=>[...t].length>30)) {report('保護詞最多 30 個，每個最多 30 字元。',true);return;}
  if(enabled.checked && !configured && !credential.value.trim()) {report(mode==='byok'?'先貼上 Jev 金鑰，再開啟校對。':'先貼上啟用碼，再開啟校對。',true);credential.focus();return;}
  setBusy(true);
  void runtimeMessage({type:'shunzi:save-options',enabled:enabled.checked,...(credential.value.trim()?{credential:credential.value.trim()}:{}),protectedTerms:normalizeTerms(rawTerms)}).then(async reply=>{
    if(!reply.ok) {report(reply.error.message,true);return;}
    if('settings' in reply) show(reply.settings);
    report('已儲存。回到 ChatGPT 即可使用。');
    if(mode==='hosted' && configured) await refreshStatus();
  }).finally(()=>setBusy(false));
});
clear.addEventListener('click',()=>{setBusy(true);void runtimeMessage({type:'shunzi:clear-key'}).then(reply=>{
  if(!reply.ok) {report(reply.error.message,true);return;}
  if('settings' in reply) show(reply.settings);report('已移除憑證與舊版憑證，並暫停校對。');
}).finally(()=>setBusy(false));});
clearProfile.addEventListener('click',()=>{setBusy(true);void runtimeMessage({type:'shunzi:clear-profile'}).then(reply=>{
  if(!reply.ok) {report(reply.error.message,true);return;}
  if('settings' in reply) show(reply.settings,false);report('已清除學習偏好，保護詞保留原樣。');
}).finally(()=>setBusy(false));});

const demo=$('demo-panel'),demoText=$('demo-text'),demoState=$('demo-state');
$('open-demo').addEventListener('click',()=>{demo.hidden=!demo.hidden;$('open-demo').setAttribute('aria-expanded',String(!demo.hidden));});
for(const [id,text,message] of [['demo-choose','明天再回覆你。','已套用示範候選，仍可還原。'],['demo-keep','明天在回覆你。','已保留原文。'],['demo-restore','明天在回覆你。','已還原原文。']]) {
  $(id).addEventListener('click',()=>{demoText.textContent=text;demoState.textContent=message;});
}
void runtimeMessage({type:'shunzi:settings'}).then(async reply=>{
  if(reply.ok && 'settings' in reply) {show(reply.settings);if(mode==='hosted' && configured) await refreshStatus();}
  else if(!reply.ok) report(reply.error.message,true);
});
