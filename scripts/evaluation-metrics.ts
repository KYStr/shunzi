import type { Category, CorrectionEdit } from '../src/core/types.js';

export interface EvaluationResult {
  id: string;
  kind: 'error' | 'correct' | 'ambiguous';
  category: Category;
  success: boolean;
  latencyMs: number;
  original?: string;
  expected?: string;
  suggested?: string;
  automatic?: string;
  edits?: CorrectionEdit[];
  error?: string;
  costTwd: number;
}
interface GoldEdit { start: number; end: number; replacement: string }

/** A unique minimum edit alignment is required. Repeated-text ambiguities stay unscored. */
export function alignedGoldEdits(original: string, expected: string): GoldEdit[] | null {
  const source = Array.from(original), target = Array.from(expected);
  const width = target.length + 1;
  const distance = new Uint16Array((source.length + 1) * width);
  const ways = new Uint8Array(distance.length);
  const at = (i: number, j: number) => i * width + j;
  ways[0] = 1;
  for (let i = 1; i <= source.length; i++) { distance[at(i, 0)] = i; ways[at(i, 0)] = 1; }
  for (let j = 1; j <= target.length; j++) { distance[at(0, j)] = j; ways[at(0, j)] = 1; }
  for (let i = 1; i <= source.length; i++) for (let j = 1; j <= target.length; j++) {
    const diagonal = distance[at(i - 1, j - 1)] + Number(source[i - 1] !== target[j - 1]);
    const deletion = distance[at(i - 1, j)] + 1;
    const insertion = distance[at(i, j - 1)] + 1;
    const minimum = Math.min(diagonal, deletion, insertion);
    distance[at(i, j)] = minimum;
    ways[at(i, j)] = Math.min(2,
      (diagonal === minimum ? ways[at(i - 1, j - 1)] : 0) +
      (deletion === minimum ? ways[at(i - 1, j)] : 0) +
      (insertion === minimum ? ways[at(i, j - 1)] : 0));
  }
  if (ways[at(source.length, target.length)] !== 1) return null;
  const operations: ('match' | 'replace' | 'delete' | 'insert')[] = [];
  let i = source.length, j = target.length;
  while (i || j) {
    const current = distance[at(i, j)];
    if (i && j && current === distance[at(i - 1, j - 1)] + Number(source[i - 1] !== target[j - 1])) {
      operations.push(source[i - 1] === target[j - 1] ? 'match' : 'replace'); i--; j--;
    } else if (i && current === distance[at(i - 1, j)] + 1) { operations.push('delete'); i--; }
    else { operations.push('insert'); j--; }
  }
  const edits: GoldEdit[] = [];
  let offset = 0, sourceIndex = 0, targetIndex = 0, active: GoldEdit | undefined;
  for (const operation of operations.reverse()) {
    if (operation === 'match') {
      if (active) edits.push(active);
      active = undefined;
      offset += source[sourceIndex++]!.length; targetIndex++;
      continue;
    }
    active ??= { start: offset, end: offset, replacement: '' };
    if (operation !== 'insert') { offset += source[sourceIndex++]!.length; active.end = offset; }
    if (operation !== 'delete') active.replacement += target[targetIndex++];
  }
  if (active) edits.push(active);
  return edits;
}

function validEdit(original: string, edit: CorrectionEdit): boolean {
  return Number.isInteger(edit.start) && Number.isInteger(edit.end) && edit.start >= 0 && edit.end >= edit.start &&
    edit.end <= original.length && original.slice(edit.start, edit.end) === edit.original && edit.original !== edit.replacement;
}

function editMatchesGold(original: string, edit: CorrectionEdit, gold: GoldEdit[]): boolean {
  if (!validEdit(original, edit)) return false;
  const touches = gold.filter(g => g.start === g.end
    ? g.start >= edit.start && g.start <= edit.end
    : g.start < edit.end && g.end > edit.start);
  if (!touches.length || touches.some(g => g.start < edit.start || g.end > edit.end)) return false;
  let wanted = original.slice(edit.start, edit.end);
  for (const g of [...touches].reverse()) {
    wanted = wanted.slice(0, g.start - edit.start) + g.replacement + wanted.slice(g.end - edit.start);
  }
  return wanted === edit.replacement;
}

export function evaluationMetrics(items: EvaluationResult[]) {
  const errors = items.filter(x => x.kind === 'error');
  const negatives = items.filter(x => x.kind !== 'error');
  let autoEdits = 0, correctAutoEdits = 0, incorrectAutoEdits = 0, unscoredAutoEdits = 0;
  for (const item of items) {
    const automatic = item.edits?.filter(edit => edit.action === 'auto') ?? [];
    if (!automatic.length) continue;
    const gold = item.kind !== 'error' ? [] : item.original !== undefined && item.expected !== undefined
      ? alignedGoldEdits(item.original, item.expected) : null;
    for (const edit of automatic) {
      autoEdits++;
      if (item.original === undefined || gold === null) { unscoredAutoEdits++; continue; }
      const overlapping = automatic.some(other => other !== edit && other.start < edit.end && other.end > edit.start);
      if (item.success && !overlapping && editMatchesGold(item.original, edit, gold)) correctAutoEdits++;
      else incorrectAutoEdits++;
    }
  }
  const changed = items.filter(x => x.automatic !== undefined && x.automatic !== x.original);
  const latencies = items.filter(x => x.success).map(x => x.latencyMs + 600).sort((a, b) => a - b);
  const negativeMetric = (kind: 'correct' | 'ambiguous') => {
    const subset = negatives.filter(x => x.kind === kind);
    const suggestions = subset.filter(x => (x.edits?.length ?? 0) > 0).length;
    const automatic = subset.filter(x => x.automatic !== undefined && x.automatic !== x.original).length;
    return { samples: subset.length, suggestionFalsePositives: suggestions, automaticFalsePositives: automatic,
      suggestionFalsePositiveRate: subset.length ? suggestions / subset.length : null,
      automaticFalsePositiveRate: subset.length ? automatic / subset.length : null };
  };
  return {
    samples: items.length, successfulCalls: items.filter(x => x.success).length,
    failedCalls: items.filter(x => !x.success).length, errorSamples: errors.length, negativeSamples: negatives.length,
    correctionRecall: errors.length ? errors.filter(x => x.success && x.suggested === x.expected).length / errors.length : null,
    autoEdits, correctAutoEdits, incorrectAutoEdits, unscoredAutoEdits,
    autoPrecision: autoEdits && !unscoredAutoEdits ? correctAutoEdits / autoEdits : null,
    autoPrecisionConservativeLowerBound: autoEdits ? correctAutoEdits / autoEdits : null,
    autoPrecisionUnit: 'local-edit', autoPrecisionAlignmentReliable: autoEdits > 0 && unscoredAutoEdits === 0,
    sentenceAutoChanges: changed.length,
    sentenceAutoPrecision: changed.length ? changed.filter(x => x.success && x.automatic === x.expected).length / changed.length : null,
    sentenceAutoPrecisionMayEnable99PercentGate: false,
    negativeAutoChanges: negatives.filter(x => x.automatic !== undefined && x.automatic !== x.original).length,
    falsePositives: { correct: negativeMetric('correct'), ambiguous: negativeMetric('ambiguous') },
    estimatedSuccessfulApiPlus600msP95: latencies.length ? latencies[Math.ceil(latencies.length * .95) - 1] : null,
    latencyMeasurement: 'successful API-call duration + fixed 600ms estimate; excludes browser messaging/rendering; not end-to-end',
    latencySampleCount: latencies.length,
    latencyExcludesFailedCalls: true,
    realEndToEndP95Ms: null,
  };
}

export function evaluationCompletion(planned: number, attempted: number, failures: number, stopReason: string | null) {
  return { planned, attempted, unattempted: Math.max(0, planned - attempted),
    completionStatus: attempted < planned ? (attempted ? 'partial' : 'not-started') :
      stopReason ? 'stopped' : failures ? 'completed-with-failures' : 'complete', stopReason };
}

export function evaluationFailureStopReason(results: EvaluationResult[]): string | null {
  const last = results.at(-1);
  if (!last || last.success || !last.error) return null;
  if (['invalid_key', 'forbidden', 'model_unavailable', 'provider_request'].includes(last.error)) return last.error;
  const previous = results.at(-2);
  return previous && !previous.success && previous.error === last.error ? `repeated_${last.error}` : null;
}
