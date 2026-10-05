import { runtimeMessage, normalizeTerms, type PublicSettings } from './protocol';
import policy from '../core/policy.json';

const form = document.querySelector<HTMLFormElement>('#settings-form')!;
const credential = document.querySelector<HTMLInputElement>('#credential')!;
const enabled = document.querySelector<HTMLInputElement>('#enabled')!;
const terms = document.querySelector<HTMLTextAreaElement>('#protected-terms')!;
const result = document.querySelector<HTMLElement>('#result')!;
const clear = document.querySelector<HTMLButtonElement>('#clear')!;
const save = document.querySelector<HTMLButtonElement>('#save')!;
const toggle = document.querySelector<HTMLButtonElement>('#toggle-secret')!;
const testConnection = document.querySelector<HTMLButtonElement>('#test-connection')!;
let configured = false;
let mode: 'byok' | 'hosted' = __MODE__;
if (policy.autoCategories.length) document.querySelector('#policy-status')!.textContent = '已通過測試的錯字可先調整，修改後仍有底線提示並可還原。';

function report(message: string, error = false) { result.textContent = message; result.classList.toggle('error', error); }
function show(settings: PublicSettings) {
  mode = settings.mode; configured = settings.configured; enabled.checked = settings.enabled;
  terms.value = settings.protectedTerms.join('\n'); clear.disabled = !configured; testConnection.disabled = !configured;
  const usage = settings.usage ?? { requests: 0, estimatedTwd: 0, unconfirmed: 0 };
  document.querySelector('#usage-count')!.textContent = `${usage.requests} 次校對`;
  document.querySelector('#usage-total')!.textContent = `約 NT$${usage.estimatedTwd.toFixed(2)}`;
  document.querySelector('#usage-help')!.textContent = `這是本機累計估算，不是帳單。${usage.unconfirmed ? `${usage.unconfirmed} 次要求尚未確認費用，已先保留較高估值。` : '未確認的要求會先保留較高估值。'}`;
  document.querySelector('#mode-label')!.textContent = mode === 'byok' ? '自備金鑰 BYOK' : '順字體驗版';
  document.querySelector('#credential-label')!.textContent = mode === 'byok' ? 'Gemini API 金鑰' : '你的啟用碼';
  document.querySelector('#connection-help')!.textContent = mode === 'byok' ? '使用你自己的 Gemini 帳戶校對。使用費由 API 供應商收取。' : '貼上收到的啟用碼，即可開始校對。';
  document.querySelector('#privacy')!.textContent = mode === 'byok' ? '草稿文字與保護詞直接送往 Google Gemini，不經順字伺服器。順字不讀取對話記錄。' : '草稿文字與保護詞經順字服務送往 Google Gemini。順字不讀取對話記錄。';
  document.querySelector('#credential-help')!.textContent = configured ? '已儲存在這部裝置。留空可沿用；貼上新值即可更新。' : '只儲存在這部裝置，不會同步。具有此裝置權限的人仍可能讀取。';
  credential.value = ''; credential.type = 'password'; toggle.textContent = '顯示'; toggle.setAttribute('aria-pressed', 'false');
  credential.placeholder = configured ? '已設定 · 留空沿用' : mode === 'byok' ? '貼上 Gemini API 金鑰' : '貼上啟用碼';
  clear.textContent = mode === 'byok' ? '移除金鑰' : '移除啟用碼';
}
toggle.addEventListener('click', () => {
  const visible = credential.type === 'password'; credential.type = visible ? 'text' : 'password';
  toggle.textContent = visible ? '隱藏' : '顯示'; toggle.setAttribute('aria-label', visible ? '隱藏輸入的憑證' : '顯示輸入的憑證'); toggle.setAttribute('aria-pressed', String(visible));
});
credential.addEventListener('input', () => { testConnection.disabled = !configured || !!credential.value.trim(); });
testConnection.addEventListener('click', () => {
  testConnection.disabled = true; save.disabled = true; clear.disabled = true; credential.disabled = true;
  report('正在用固定範例句測試連線…');
  void runtimeMessage({ type: 'shunzi:test-connection' }).then(async reply => {
    save.disabled = false; credential.disabled = false;
    const refreshed = await runtimeMessage({ type: 'shunzi:settings' });
    if (refreshed.ok && 'settings' in refreshed) show(refreshed.settings);
    else { testConnection.disabled = !configured; clear.disabled = !configured; }
    if (!reply.ok) { report(reply.error.message, true); return; }
    report('response' in reply && reply.response.status === 'ok' ? '連線成功，可以開始校對。' : '服務尚未就緒，請查看常見問題。', !('response' in reply && reply.response.status === 'ok'));
  });
});
form.addEventListener('submit', event => {
  event.preventDefault();
  const rawTerms = terms.value.split(/\r?\n/).map(term => term.trim()).filter(Boolean);
  if ([...new Set(rawTerms)].length > 30 || rawTerms.some(term => [...term].length > 30)) { report('保護詞最多 30 個，每個最多 30 字元。', true); return; }
  if (enabled.checked && !configured && !credential.value.trim()) { report(mode === 'byok' ? '先貼上 API 金鑰，再開啟校對。' : '先貼上啟用碼，再開啟校對。', true); credential.focus(); return; }
  save.disabled = true;
  void runtimeMessage({ type: 'shunzi:save-options', enabled: enabled.checked, ...(credential.value.trim() ? { credential: credential.value.trim() } : {}), protectedTerms: normalizeTerms(rawTerms) }).then(reply => {
    save.disabled = false;
    if (!reply.ok) { report(reply.error.message, true); return; }
    if ('settings' in reply) show(reply.settings);
    report('已儲存。回到 ChatGPT 即可使用。');
  });
});
clear.addEventListener('click', () => {
  clear.disabled = true;
  void runtimeMessage({ type: 'shunzi:clear-key' }).then(reply => {
    if (!reply.ok) { report(reply.error.message, true); clear.disabled = false; return; }
    if ('settings' in reply) show(reply.settings);
    report('已移除憑證並暫停校對。');
  });
});
void runtimeMessage({ type: 'shunzi:settings' }).then(reply => {
  if (reply.ok && 'settings' in reply) show(reply.settings);
  else if (!reply.ok) report(reply.error.message, true);
});
