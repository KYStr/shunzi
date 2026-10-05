export type Category = 'homophone' | 'word-boundary' | 'other';
export interface CheckRequest {
  text: string;
  revision: string;
  protectedTerms?: string[];
}
export interface CorrectionEdit {
  id: string;
  start: number;
  end: number;
  original: string;
  replacement: string;
  alternatives: string[];
  category: Category;
  action: 'auto' | 'suggest';
  reason: string;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  estimatedTwd: number;
}
export interface CheckResponse {
  revision: string;
  edits: CorrectionEdit[];
  usage?: Usage;
  status: 'ok' | 'too-long' | 'paused' | 'unavailable';
  message?: string;
}
export interface ModelEdit {
  original: string;
  replacement: string;
  alternatives?: string[];
  category: Category;
  certainty: 'clear' | 'uncertain';
  sensitive: boolean;
  reason: string;
}
export interface CorrectionPolicy {
  autoCategories: Category[];
  model: string;
  validatedAt: string | null;
  evidence: string | null;
}
export const MAX_CHARACTERS = 500;
export const MODEL = 'gemini-3.5-flash-lite';
export const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';
export const FX_TWD_PER_USD = 35;
export const INPUT_USD_PER_MILLION = 0.30;
export const OUTPUT_USD_PER_MILLION = 2.50;
export const MAX_OUTPUT_TOKENS = 1024;
export const REQUEST_TIMEOUT_MS = 2800;
