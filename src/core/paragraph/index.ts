import { validateRequest, ProviderError } from '../index.js';
import { protectedSpans } from '../protection.js';
import type { CheckRequest, CorrectionEdit } from '../types.js';
import { PhoneticLexicon } from './lexicon.js';
import { JEV_MODEL, type ParagraphSelection } from './jev.js';
import { EMPTY_PROFILE, PARAGRAPH_ENGINE_VERSION, MAX_GROUPS, MAX_OPTIONS,
  type CandidateBatch, type CandidateGroup, type ChoiceDecision, type ParagraphProfile } from './types.js';
import { SUPPORTED_PIPELINE_VERSION } from './types.js';
export * from './types.js';
export * from './lexicon.js';
export * from './jev.js';

const han = /^\p{Script=Han}+$/u;
function validateProfile(profile: ParagraphProfile): void {
  if (!Number.isSafeInteger(profile.revision) || profile.revision < 0 || !profile.weights ||
      Object.keys(profile.weights).length > 1000 || Object.entries(profile.weights).some(([word, n]) =>
        !han.test(word) || [...word].length > 8 || !Number.isSafeInteger(n) || n < 0 || n > 100) ||
      !Array.isArray(profile.eventIds) || profile.eventIds.length > 512 ||
      profile.eventIds.some(id => typeof id !== 'string' || id.length > 100))
    throw new ProviderError('invalid_profile', '個人詞庫格式不正確。');
}

/** Produce local options for the whole paragraph. No network access and no text mutation. */
export function prepareParagraph(value: CheckRequest, lexicon: PhoneticLexicon,
  profile: ParagraphProfile = EMPTY_PROFILE): CandidateBatch {
  const request = validateRequest(value);
  validateProfile(profile);
  const protectedRanges = protectedSpans(request.text, request.protectedTerms ?? []);
  const groups = new Map<string, CandidateGroup>();
  let truncated = false;
  for (const run of request.text.matchAll(/\p{Script=Han}+/gu)) {
    const chars = [...run[0]], offsets = [run.index!];
    for (const char of chars) offsets.push(offsets.at(-1)! + char.length);
    for (let i = 0; i < chars.length; i++) {
      // Speech recognition may repeat a character. Repetition can also be grammatical:
      // offer one deletion, with keep as the default, and let the selector decide.
      if (i + 1 < chars.length && chars[i] === chars[i + 1]) {
        const start = offsets[i], end = offsets[i + 2];
        if (!protectedRanges.some(s => start < s.end && end > s.start)) {
          const original = request.text.slice(start,end), id = `g${start}_${end}`;
          groups.set(id, {id,start,end,original,options:[{id:'keep',text:original,rankScore:0},
            {id:'',text:chars[i],rankScore:10}]});
        }
      }
      const found = lexicon.matches(chars, i);
      truncated ||= found.truncated;
      for (const entry of found.entries) {
        const length = entry.readings.length;
        const start = offsets[i], end = offsets[i + length];
        const original = request.text.slice(start, end);
        if (original === entry.text || protectedRanges.some(s => start < s.end && end > s.start)) continue;
        const originalChars = [...original], replacementChars = [...entry.text];
        let changed = 0;
        for (let c = 0; c < length; c++) if (originalChars[c] !== replacementChars[c]) changed++;
        if (changed > 3) continue;
        const commonConfusion = length === 1 && new Set([original, entry.text]).size === 2 &&
          [original, entry.text].every(s => s === '在' || s === '再');
        const gain = entry.score - lexicon.scoreOriginal(original);
        // Prototype filtering only. This is not a calibrated probability or an auto-edit threshold.
        if (!commonConfusion && gain < 0.3) continue;
        const rankScore = gain - changed * 0.15 +
          (Math.log1p(profile.weights[entry.text] ?? 0) - Math.log1p(profile.weights[original] ?? 0)) * 0.3 +
          (commonConfusion ? 2 : 0);
        const id = `g${start}_${end}`;
        const group = groups.get(id) ?? { id, start, end, original,
          options: [{ id: 'keep', text: original, rankScore: 0 }] };
        const existing = group.options.find(o => o.text === entry.text);
        if (existing) existing.rankScore = Math.max(existing.rankScore, rankScore);
        else group.options.push({ id: '', text: entry.text, rankScore });
        groups.set(id, group);
      }
    }
  }
  const ranked = [...groups.values()].map(group => {
    const replacements = group.options.slice(1).sort((a,b) => b.rankScore - a.rankScore || a.text.localeCompare(b.text));
    if (replacements.length > MAX_OPTIONS - 1) truncated = true;
    group.options = [group.options[0], ...replacements.slice(0, MAX_OPTIONS - 1).map((o,i) => ({ ...o, id: `o${i}` }))];
    return group;
  }).sort((a,b) => b.options[1].rankScore - a.options[1].rankScore ||
    (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const selected: CandidateGroup[] = [];
  for (const group of ranked) {
    // Resolve overlaps locally, before Jev. Never ask it to choose mutually inconsistent edits.
    if (selected.some(g => group.start < g.end && group.end > g.start)) { truncated = true; continue; }
    if (selected.length === MAX_GROUPS) { truncated = true; continue; }
    selected.push(group);
  }
  return snapshotCandidateBatch({ request, pipelineVersion: `${PARAGRAPH_ENGINE_VERSION}/${lexicon.version}`,
    profileRevision: profile.revision, groups: selected.sort((a,b) => a.start - b.start), truncated });
}

export function snapshotCandidateBatch(batch: CandidateBatch): CandidateBatch {
  validateCandidateBatch(batch);
  const copy = structuredClone(batch);
  Object.freeze(copy.request.protectedTerms);
  Object.freeze(copy.request);
  for (const group of copy.groups) { group.options.forEach(Object.freeze); Object.freeze(group.options); Object.freeze(group); }
  Object.freeze(copy.groups);
  return Object.freeze(copy);
}

const invalidBatch = () => new ProviderError('invalid_candidates', '候選資料不完整，已保留原文。');
export function validateCandidateBatch(batch: CandidateBatch): void {
  if (!batch || typeof batch !== 'object') throw invalidBatch();
  const request = validateRequest(batch.request);
  if (typeof batch.pipelineVersion !== 'string' || !batch.pipelineVersion || batch.pipelineVersion.length > 180 ||
      !Number.isSafeInteger(batch.profileRevision) || batch.profileRevision < 0 ||
      typeof batch.truncated !== 'boolean' || !Array.isArray(batch.groups) || batch.groups.length > MAX_GROUPS) throw invalidBatch();
  const protectedRanges = protectedSpans(request.text, request.protectedTerms ?? []);
  const ids = new Set<string>();
  for (const group of batch.groups) {
    if (!group || typeof group !== 'object') throw invalidBatch();
    const boundary = (i: number) => i > 0 && i < request.text.length &&
      /[\uD800-\uDBFF]/.test(request.text[i - 1]) && /[\uDC00-\uDFFF]/.test(request.text[i]);
    if (!Number.isSafeInteger(group.start) || !Number.isSafeInteger(group.end) || group.start < 0 ||
        group.end > request.text.length || group.start >= group.end || boundary(group.start) || boundary(group.end) ||
        group.original !== request.text.slice(group.start, group.end) || group.id !== `g${group.start}_${group.end}` ||
        ids.has(group.id) || !han.test(group.original) || [...group.original].length > 8 ||
        protectedRanges.some(s => group.start < s.end && group.end > s.start) ||
        !Array.isArray(group.options) || group.options.length < 2 || group.options.length > MAX_OPTIONS ||
        group.options[0].id !== 'keep' || group.options[0].text !== group.original) throw invalidBatch();
    ids.add(group.id);
    const optionIds = new Set<string>(), values = new Set<string>();
    for (const option of group.options) {
      if (!option || typeof option !== 'object' || typeof option.id !== 'string' || option.id.length > 10 ||
          typeof option.text !== 'string' || !/^(keep|o\d+)$/.test(option.id) || optionIds.has(option.id) || values.has(option.text) ||
          !han.test(option.text) || [...option.text].length > 8 ||
          Math.abs([...option.text].length - [...group.original].length) > 3 || !Number.isFinite(option.rankScore)) throw invalidBatch();
      optionIds.add(option.id); values.add(option.text);
    }
  }
  if (batch.groups.some((g,i) => batch.groups.some((other,j) => i !== j && g.start < other.end && g.end > other.start))) throw invalidBatch();
}

/** Strict network boundary: no caller-supplied prompt, endpoint, or future pipeline. */
export function validateTransportBatch(value: unknown): CandidateBatch {
  const exact = (item: unknown, allowed: string[]) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some(k => !allowed.includes(k))) throw invalidBatch();
  };
  exact(value, ['request','pipelineVersion','profileRevision','groups','truncated']);
  const batch = value as CandidateBatch;
  exact(batch.request, ['text','revision','protectedTerms']);
  if (batch.pipelineVersion !== SUPPORTED_PIPELINE_VERSION || !Array.isArray(batch.groups)) throw invalidBatch();
  for (const group of batch.groups) {
    exact(group, ['id','start','end','original','options']);
    if (!Array.isArray(group.options)) throw invalidBatch();
    for (const option of group.options) exact(option, ['id','text','rankScore']);
  }
  return snapshotCandidateBatch(batch);
}

export interface ParagraphReview { batch: CandidateBatch; choices: ChoiceDecision[]; text: string; edits: CorrectionEdit[] }
/** Re-render from the original snapshot. Alternatives always retain their original common span. */
export function reviewParagraph(batch: CandidateBatch, choices: readonly ChoiceDecision[] = []): ParagraphReview {
  batch = snapshotCandidateBatch(batch);
  const selected = new Map<string,string>();
  for (const choice of choices) {
    const group = batch.groups.find(g => g.id === choice.groupId);
    if (!group || selected.has(group.id) ||
        (choice.optionId !== 'unsure' && !group.options.some(o => o.id === choice.optionId))) throw invalidBatch();
    selected.set(group.id, choice.optionId);
  }
  const edits: CorrectionEdit[] = [];
  for (const group of batch.groups) {
    const id = selected.get(group.id) ?? 'keep';
    if (id === 'keep' || id === 'unsure') continue;
    const option = group.options.find(o => o.id === id)!;
    edits.push({ id: `${batch.request.revision}:${group.id}`, start: group.start, end: group.end,
      original: group.original, replacement: option.text,
      alternatives: group.options.filter(o => o.id !== id && o.id !== 'keep').slice(0, 2).map(o => o.text),
      category: [...group.original].length > 1 ? 'word-boundary' : 'homophone', action: 'suggest',
      reason: '依完整草稿與本機同音候選提出的建議' });
  }
  let text = batch.request.text;
  for (const edit of [...edits].sort((a,b) => b.start - a.start))
    text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  return { batch, choices: batch.groups.map(g => ({ groupId: g.id, optionId: selected.get(g.id) ?? 'keep' })), text, edits };
}

export function assertCurrentBatch(batch: CandidateBatch, current: CheckRequest, profileRevision: number): void {
  const normalized = validateRequest(current);
  if (batch.request.revision !== normalized.revision || batch.request.text !== normalized.text ||
      JSON.stringify(batch.request.protectedTerms ?? []) !== JSON.stringify(normalized.protectedTerms ?? []) ||
      batch.profileRevision !== profileRevision)
    throw new ProviderError('stale_result', '草稿或個人詞庫已更新，已捨棄舊結果。');
}

/** For host UI: switching/restoring an option is safe only while the displayed snapshot is unchanged. */
export function changeReviewOption(review: ParagraphReview, groupId: string, optionId: string,
  current: CheckRequest): ParagraphReview {
  const normalized = validateRequest(current);
  if (normalized.text !== review.text || normalized.revision !== review.batch.request.revision ||
      JSON.stringify(normalized.protectedTerms ?? []) !== JSON.stringify(review.batch.request.protectedTerms ?? []))
    throw new ProviderError('stale_result', '文字已變更，請重新校對。');
  if (!review.batch.groups.some(g => g.id === groupId)) throw invalidBatch();
  return reviewParagraph(review.batch, review.choices.map(c => c.groupId === groupId ? { groupId, optionId } : c));
}

export function reviewJevSelection(selection: ParagraphSelection, current: CheckRequest,
  profileRevision: number): ParagraphReview {
  const batch = selection.batch;
  if (selection.model !== JEV_MODEL || selection.revision !== batch.request.revision || selection.pipelineVersion !== batch.pipelineVersion ||
      selection.profileRevision !== batch.profileRevision) throw invalidBatch();
  assertCurrentBatch(batch, current, profileRevision);
  return reviewParagraph(batch, selection.choices);
}

/** Explicit feedback only; automatic decisions and silence never teach the dictionary. */
export function learnParagraphChoice(profile: ParagraphProfile, batch: CandidateBatch,
  choice: ChoiceDecision, eventId: string, origin: 'user' | 'automatic'): ParagraphProfile {
  validateProfile(profile); validateCandidateBatch(batch);
  if (origin !== 'user' || profile.eventIds.includes(eventId)) return profile;
  if (!eventId || eventId.length > 100) throw new ProviderError('invalid_feedback', '學習事件格式不正確。');
  const option = batch.groups.find(g => g.id === choice.groupId)?.options.find(o => o.id === choice.optionId);
  if (!option) throw invalidBatch();
  const weights = { ...profile.weights };
  if (!(option.text in weights) && Object.keys(weights).length >= 1000) return profile;
  weights[option.text] = Math.min(100, (weights[option.text] ?? 0) + 1);
  return { revision: profile.revision + 1, weights, eventIds: [...profile.eventIds, eventId].slice(-512) };
}
