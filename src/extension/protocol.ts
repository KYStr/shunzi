import type { CheckRequest, CheckResponse } from '../core/types';

export type Mode = 'byok' | 'hosted';
export interface UsageEstimate { estimatedTwd: number; requests: number; unconfirmed: number }
export interface PublicSettings {
  mode: Mode;
  enabled: boolean;
  configured: boolean;
  protectedTerms: string[];
  usage?: UsageEstimate;
}
export type Message =
  | { type: 'shunzi:settings' }
  | { type: 'shunzi:check'; request: CheckRequest }
  | { type: 'shunzi:remember'; term: string }
  | { type: 'shunzi:open-options' }
  | { type: 'shunzi:set-enabled'; enabled: boolean }
  | { type: 'shunzi:test-connection' }
  | { type: 'shunzi:save-options'; enabled: boolean; credential?: string; protectedTerms: string[] }
  | { type: 'shunzi:clear-key' };
export type Reply =
  | { ok: true; settings: PublicSettings }
  | { ok: true; response: CheckResponse }
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
