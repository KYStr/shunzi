import type { CandidateBatch } from '../src/core/paragraph/index.js';

/** Oracle coverage only: gold never enters a provider request. Supports variable-length alternatives. */
export function expectedReachable(batch: CandidateBatch, expected: string): boolean {
  let positions = new Set([0]), originalPosition = 0;
  for (const group of [...batch.groups].sort((a,b) => a.start - b.start)) {
    const unchanged = batch.request.text.slice(originalPosition, group.start);
    const next = new Set<number>();
    for (const position of positions) {
      if (!expected.startsWith(unchanged, position)) continue;
      const after = position + unchanged.length;
      for (const option of group.options) if (expected.startsWith(option.text, after)) next.add(after + option.text.length);
    }
    positions = next; originalPosition = group.end;
  }
  const tail = batch.request.text.slice(originalPosition);
  return [...positions].some(position => expected.slice(position) === tail);
}

export interface ParagraphEvalRow {
  id: string; kind: 'error' | 'correct' | 'ambiguous'; category: string;
  candidateReachable: boolean; completed: boolean; matchesExpected?: boolean;
  changed?: boolean; edits?: number; validEdits?: number; latencyMs?: number; costTwd: number; error?: string;
}
export function paragraphMetrics(rows: ParagraphEvalRow[]) {
  const errors = rows.filter(r => r.kind === 'error');
  const preservation = rows.filter(r => r.kind !== 'error');
  const repairs = errors.filter(r => r.completed && r.matchesExpected).length;
  const totalEdits = rows.reduce((n,r) => n + (r.edits ?? 0), 0);
  const validEdits = rows.reduce((n,r) => n + (r.validEdits ?? 0), 0);
  const latencies = rows.filter(r => r.completed && r.latencyMs !== undefined).map(r => r.latencyMs!).sort((a,b) => a-b);
  return {
    rows: rows.length, errors: errors.length, completed: rows.filter(r => r.completed).length,
    candidateReachableErrors: errors.filter(r => r.candidateReachable).length,
    candidateMisses: errors.filter(r => !r.candidateReachable).length,
    selectorMisses: errors.filter(r => r.candidateReachable && r.completed && !r.matchesExpected).length,
    repairs, repairRate: errors.length ? repairs / errors.length : null,
    preserved: preservation.filter(r => r.completed && !r.changed).length, preservationCases: preservation.length,
    falseChanges: preservation.filter(r => r.changed).length,
    proposedEdits: totalEdits, validEdits, suggestedEditPrecision: totalEdits ? validEdits / totalEdits : null,
    pipelineP95Ms: latencies.length ? latencies[Math.ceil(latencies.length * .95) - 1] : null,
    costTwd: rows.reduce((n,r) => n + r.costTwd, 0),
  };
}
