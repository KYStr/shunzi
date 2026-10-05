import { checkWithGemini, validateRequest, ProviderError, MAX_CHARACTERS, MAX_CALL_TWD } from '../core/index';
import type { CheckRequest, CheckResponse } from '../core/types';
import { normalizeTerms, type Mode, type PublicSettings, type Reply, type UsageEstimate } from './protocol';

type Storage = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove' | 'setAccessLevel'>;
interface Dependencies {
  storage: Storage;
  mode: Mode;
  hostedOrigin: string;
  extensionId: string;
  optionsUrl: string;
  openOptions: () => Promise<void>;
  fetcher?: typeof fetch;
  check?: typeof checkWithGemini;
}
const publicError = (code: string, message: string): Reply => ({ ok: false, error: { code, message } });
const settingsKeys = ['enabled', 'credential', 'protectedTerms', 'usage'];
function usageEstimate(value: unknown): UsageEstimate {
  const item = value as Partial<UsageEstimate> | undefined;
  return { estimatedTwd: Number.isFinite(item?.estimatedTwd) && item!.estimatedTwd! >= 0 ? item!.estimatedTwd! : 0,
    requests: Number.isSafeInteger(item?.requests) && item!.requests! >= 0 ? item!.requests! : 0,
    unconfirmed: Number.isSafeInteger(item?.unconfirmed) && item!.unconfirmed! >= 0 ? item!.unconfirmed! : 0 };
}
function publicSettings(raw: Record<string, unknown>, mode: Mode): PublicSettings {
  return { mode, enabled: raw.enabled === true, configured: typeof raw.credential === 'string' && raw.credential.length > 0,
    protectedTerms: normalizeTerms(raw.protectedTerms), usage: usageEstimate(raw.usage) };
}
const errorMessages: Record<string, string> = {
  invalid_key: 'API 金鑰無效，請到設定更新金鑰。', forbidden: 'API 權限或地區受限，請查看設定頁的常見問題。',
  rate_limit: 'API 額度不足或請求過多，請查看 API 帳務頁或稍後再試。', timeout: '校對逾時，原文已保留。請稍後再試。',
  model_unavailable: '此帳戶無法使用指定模型，請查看設定頁的常見問題。', provider_request: '模型不接受這次要求，請更新擴充套件或查看常見問題。',
  AUTH: '啟用碼無效或已到期，請到設定更新。', BUDGET: '體驗預算已用完，這段文字保留原樣。',
  RATE_LIMIT: '已達使用上限，請稍後再試。', DUPLICATE: '這個要求已處理，原文已保留。',
  UNAVAILABLE: '這次無法校對，原文已保留。請查看設定頁的常見問題。',
};
const safeError = (code: string) => publicError(code in errorMessages ? code : 'UNAVAILABLE', errorMessages[code] ?? errorMessages.UNAVAILABLE);

export function authorizedSender(sender: chrome.runtime.MessageSender, deps: Pick<Dependencies, 'extensionId' | 'optionsUrl'>): 'options' | 'content' | null {
  if (sender.id !== deps.extensionId) return null;
  if (sender.url === deps.optionsUrl) return 'options';
  try {
    const url = new URL(sender.url ?? '');
    if (url.origin === 'https://chatgpt.com' && sender.frameId === 0 && Number.isInteger(sender.tab?.id)) return 'content';
  } catch { /* deny malformed senders */ }
  return null;
}

export function createMessageHandler(deps: Dependencies) {
  // This access restriction is awaited before reading or writing any credential.
  const ready = deps.storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const inflight = new Set<number>();
  let accounting: Promise<void> = Promise.resolve();
  function updateUsage(change: (usage: UsageEstimate) => UsageEstimate) {
    const task = accounting.then(async () => { const raw = await deps.storage.get('usage'); await deps.storage.set({ usage: change(usageEstimate(raw.usage)) }); });
    accounting = task.catch(() => {}); return task;
  }
  return async (message: unknown, sender: chrome.runtime.MessageSender): Promise<Reply> => {
    const caller = authorizedSender(sender, deps);
    if (!caller || !message || typeof message !== 'object' || !('type' in message)) return publicError('DENIED', '無法接受這個來源的要求。');
    await ready;
    const value = message as Record<string, unknown>;
    if (value.type === 'shunzi:settings') return { ok: true, settings: publicSettings(await deps.storage.get(settingsKeys), deps.mode) };
    if (value.type === 'shunzi:open-options' && caller === 'content') {
      await deps.openOptions();
      return { ok: true };
    }
    if (value.type === 'shunzi:set-enabled' && caller === 'content' && typeof value.enabled === 'boolean') {
      await deps.storage.set({ enabled: value.enabled });
      return { ok: true, settings: publicSettings(await deps.storage.get(settingsKeys), deps.mode) };
    }
    if (value.type === 'shunzi:save-options' && caller === 'options') {
      if (typeof value.enabled !== 'boolean' || !Array.isArray(value.protectedTerms)) return publicError('INVALID', '設定格式不正確。');
      const update: Record<string, unknown> = { enabled: value.enabled, protectedTerms: normalizeTerms(value.protectedTerms) };
      if (value.credential !== undefined) {
        if (typeof value.credential !== 'string' || !value.credential.trim() || value.credential.trim().length > 512 || /\s/.test(value.credential.trim())) return publicError('INVALID', '請貼上完整金鑰或啟用碼，不要包含空白。');
        update.credential = value.credential.trim();
      }
      await deps.storage.set(update);
      return { ok: true, settings: publicSettings(await deps.storage.get(settingsKeys), deps.mode) };
    }
    if (value.type === 'shunzi:clear-key' && caller === 'options') {
      await deps.storage.remove('credential');
      await deps.storage.set({ enabled: false });
      return { ok: true, settings: publicSettings(await deps.storage.get(settingsKeys), deps.mode) };
    }
    if (value.type === 'shunzi:remember' && caller === 'content') {
      if (typeof value.term !== 'string' || !value.term.trim() || [...value.term].length > 30) return publicError('INVALID', '記住的詞需為 1–30 個字元。');
      const raw = await deps.storage.get(settingsKeys);
      if (normalizeTerms(raw.protectedTerms).length >= 30 && !normalizeTerms(raw.protectedTerms).includes(value.term.trim())) return publicError('LIMIT', '已記住 30 個詞，請先在設定中整理。');
      await deps.storage.set({ protectedTerms: normalizeTerms([...normalizeTerms(raw.protectedTerms), value.term]) });
      return { ok: true, settings: publicSettings(await deps.storage.get(settingsKeys), deps.mode) };
    }
    const testing = value.type === 'shunzi:test-connection' && caller === 'options';
    if (!testing && (value.type !== 'shunzi:check' || caller !== 'content')) return publicError('DENIED', '這個操作只能在擴充功能設定頁完成。');
    const tabId = testing ? -1 : sender.tab!.id!;
    const raw = await deps.storage.get(settingsKeys);
    const requestValue = testing ? { text: '我現在正在整理文字。', revision: crypto.randomUUID() } : value.request as CheckRequest | undefined;
    const revision = typeof requestValue?.revision === 'string' ? requestValue.revision : '';
    if (!raw.enabled && !testing) return { ok: true, response: { revision, edits: [], status: 'paused' } };
    if (typeof raw.credential !== 'string' || !raw.credential) return publicError('NOT_CONFIGURED', '先在順字設定中完成連線。');
    if (typeof requestValue?.text === 'string' && Array.from(requestValue.text).length > MAX_CHARACTERS) {
      return { ok: true, response: { revision, edits: [], status: 'too-long', message: '超過 500 字元，這段先不校對。' } };
    }
    let request: CheckRequest;
    try {
      request = validateRequest({ ...requestValue, protectedTerms: testing ? [] : normalizeTerms(raw.protectedTerms) });
    } catch { return publicError('INVALID', '這段文字無法校對。'); }
    if (inflight.has(tabId) || inflight.size >= 6) return publicError('BUSY', '上一段還在校對，請稍候。');
    inflight.add(tabId);
    try {
      let endpoint = '';
      if (deps.mode === 'hosted') {
        const origin = new URL(deps.hostedOrigin);
        if (origin.protocol !== 'https:' || origin.origin !== deps.hostedOrigin || origin.username || origin.password) return publicError('CONFIGURATION', '此版本尚未設定服務位址。');
        endpoint = `${origin.origin}/v1/check`;
      }
      // Reserve the conservative maximum before sending. A timeout/unknown result
      // keeps its reserve, including if a service worker stops during the request.
      await updateUsage(usage => ({ estimatedTwd: usage.estimatedTwd + MAX_CALL_TWD, requests: usage.requests + 1, unconfirmed: usage.unconfirmed + 1 }));
      const confirm = async (result: CheckResponse) => {
        const actual = result.usage?.estimatedTwd;
        if (typeof actual === 'number' && Number.isFinite(actual) && actual >= 0) await updateUsage(usage => ({ ...usage,
          estimatedTwd: Math.max(0, usage.estimatedTwd - MAX_CALL_TWD + actual), unconfirmed: Math.max(0, usage.unconfirmed - 1) }));
        return { ok: true, response: result } as Reply;
      };
      if (deps.mode === 'byok') {
        const response = await (deps.check ?? checkWithGemini)(request, raw.credential);
        return await confirm(response);
      }
      const response = await (deps.fetcher ?? fetch)(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${raw.credential}`, 'X-Request-Id': crypto.randomUUID() },
        body: JSON.stringify(request), signal: AbortSignal.timeout(5000), credentials: 'omit', redirect: 'error', cache: 'no-store',
      });
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403 ? 'AUTH' : response.status === 402 ? 'BUDGET' : response.status === 429 ? 'RATE_LIMIT' : response.status === 409 ? 'DUPLICATE' : 'UNAVAILABLE';
        return safeError(code);
      }
      const result = await response.json() as CheckResponse;
      if (!result || result.revision !== request.revision || !Array.isArray(result.edits) || !['ok', 'too-long', 'paused', 'unavailable'].includes(result.status)) throw new Error('invalid response');
      return await confirm(result);
    } catch (error) {
      // Never return raw provider messages, response bodies, or headers to the page.
      const code = error instanceof ProviderError ? error.code : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'UNAVAILABLE';
      return safeError(code);
    } finally { inflight.delete(tabId); }
  };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && chrome.storage) {
  const handler = createMessageHandler({ storage: chrome.storage.local, mode: __MODE__, hostedOrigin: __HOSTED_ORIGIN__,
    extensionId: chrome.runtime.id, optionsUrl: chrome.runtime.getURL('options.html'), openOptions: () => chrome.runtime.openOptionsPage() });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    void handler(message, sender).then(respond).catch(() => respond(publicError('UNAVAILABLE', '暫時無法處理，原文已保留。')));
    return true;
  });
  chrome.action?.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });
}
