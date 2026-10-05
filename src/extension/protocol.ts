import type { CheckRequest, CheckResponse } from '../core/types';

export type Mode = 'byok' | 'hosted';
export interface UsageEstimate { estimatedTwd: number; requests: number; unconfirmed: number }
export interface Entitlement { plan: 'trial' | 'paid'; expiresAt: number; remainingChecks: number; limit: number }
export interface ParagraphCheckResponse extends CheckResponse { reviewId?: string }
export function entitlementSummary(entitlement: Entitlement | undefined, now = Date.now()) {
  if (!entitlement) return { count:'尚未取得方案', detail:'儲存啟用碼後，重新整理用量。' };
  const expired = entitlement.expiresAt <= now;
  const date = new Intl.DateTimeFormat('zh-TW', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Taipei'}).format(entitlement.expiresAt);
  return { count:expired ? '本期已到期' : `剩餘 ${entitlement.remainingChecks} / ${entitlement.limit} 次`,
    detail:`${entitlement.plan==='trial'?'試用方案':'付費方案'} · ${date} 到期（台北時間）${expired?'，已暫停語意校對。':entitlement.remainingChecks===0?'，本期次數已用完。':''}` };
}
export interface PublicSettings {
  mode: Mode;
  enabled: boolean;
  configured: boolean;
  protectedTerms: string[];
  usage?: UsageEstimate;
  hasLegacyCredential?: boolean;
  profileRevision?: number;
  learnedTerms?: number;
  entitlement?: Entitlement;
}
export type Message =
  | { type: 'shunzi:settings' }
  | { type: 'shunzi:check'; request: CheckRequest }
  | { type: 'shunzi:remember'; term: string }
  | { type: 'shunzi:open-options' }
  | { type: 'shunzi:set-enabled'; enabled: boolean }
  | { type: 'shunzi:test-connection' }
  | { type: 'shunzi:refresh-status' }
  | { type: 'shunzi:clear-profile' }
  | { type: 'shunzi:feedback'; reviewId: string; editId: string; text: string; action: 'accept' | 'keep' | 'restore'; eventId: string }
  | { type: 'shunzi:save-options'; enabled: boolean; credential?: string; protectedTerms: string[] }
  | { type: 'shunzi:clear-key' };
export type Reply =
  | { ok: true; settings: PublicSettings }
  | { ok: true; response: ParagraphCheckResponse }
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };

export function normalizeTerms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((term): term is string => typeof term === 'string')
    .map(term => term.trim()).filter(term => term.length > 0 && [...term].length <= 30))].slice(0, 30);
}

export function runtimeMessage(message: Message): Promise<Reply> {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(message, (reply: Reply | undefined) => {
        if (chrome.runtime.lastError || !reply) {
          resolve({ ok: false, error: { code: 'DISCONNECTED', message: '擴充功能已更新，請重新整理這個頁面。' } });
        } else resolve(reply);
      });
    } catch {
      resolve({ ok: false, error: { code: 'DISCONNECTED', message: '擴充功能已更新，請重新整理這個頁面。' } });
    }
  });
}
