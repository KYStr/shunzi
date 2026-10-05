import type { CheckRequest } from '../types.js';

/** An engine-neutral dictionary row, not a model probability. */
export interface LexiconEntry { text: string; readings: string[]; score: number }
export interface CandidateOption { id: string; text: string; rankScore: number }
export interface CandidateGroup {
  id: string;
  /** UTF-16 offsets into the unchanged original draft. */
  start: number; end: number; original: string;
  options: CandidateOption[];
}
export interface CandidateBatch {
  request: CheckRequest;
  pipelineVersion: string;
  profileRevision: number;
  groups: CandidateGroup[];
  /** Capped work is reported; an empty result is never a quality guarantee. */
  truncated: boolean;
}
export interface ChoiceDecision { groupId: string; optionId: string }
export interface ParagraphProfile {
  revision: number;
  /** Only explicitly chosen dictionary words; no paragraphs or API credentials. */
  weights: Record<string, number>;
  eventIds: string[];
}
export const EMPTY_PROFILE: ParagraphProfile = { revision: 0, weights: {}, eventIds: [] };
export const PARAGRAPH_ENGINE_VERSION = 'paragraph-phonetic-v2';
export const BUNDLED_LEXICON_VERSION = 'mcbopomofo-e7bfa5547b92';
export const SUPPORTED_PIPELINE_VERSION = `${PARAGRAPH_ENGINE_VERSION}/${BUNDLED_LEXICON_VERSION}/loose-tones`;
export interface HostedEntitlement {
  plan: 'trial' | 'paid';
  expiresAt: number;
  remainingChecks: number;
  limit: number;
}
export const MAX_GROUPS = 8;
export const MAX_OPTIONS = 6; // Includes the original; UI may show fewer.
