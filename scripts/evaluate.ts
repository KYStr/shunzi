import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkWithGemini, applyEdits, MAX_CALL_TWD, MODEL, ProviderError, type Category, type CorrectionPolicy } from '../src/core/index.js';
import { evaluationCompletion, evaluationMetrics, evaluationFailureStopReason, type EvaluationResult } from './evaluation-metrics.js';
import { EvaluationBudgetError, LOCAL_EVALUATION_LIMIT_TWD, initializeEvaluationLedger, reserveEvaluationCall,
  settleEvaluationCall, failEvaluationCall, evaluationSpentTwd } from './evaluation-ledger.js';

const startedAt = new Date().toISOString();
const args = process.argv.slice(2);
const arg = (name: string, fallback = '') => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? fallback : fallback; };
const split = arg('--split', 'dev');
const label = arg('--run-label', `run-${Date.now()}`);
if (!/^[a-zA-Z0-9_-]{1,70}$/.test(label) || !['dev', 'holdout', 'smoke'].includes(split)) throw new Error('Invalid run arguments');
const limit = Number(arg('--limit', '500'));
const timeoutMs = Number(arg('--timeout-ms', '2800'));
if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 20000) {
  throw new Error('Limit must be 1–500 and timeout 500–20000ms');
}
const key = process.env.GEMINI_API_KEY;
if (!key) { process.stderr.write('GEMINI_API_KEY is required; no calls made.\n'); process.exit(1); }
mkdirSync('.local', { recursive: true });
const reportPath = resolve('.local', `eval-${label}.json`);
if (existsSync(reportPath)) throw new Error('Run label already exists; do not overwrite evidence');
const db = new DatabaseSync('.local/eval-budget.sqlite');
initializeEvaluationLedger(db, MAX_CALL_TWD);

type Row = { id: string; split: string; kind: 'error' | 'correct' | 'ambiguous'; category: Category; text: string; expected: string };
const splitRows: Row[] = split === 'smoke' ? [
  { id: 'smoke-1', split: 'dev', kind: 'error', category: 'word-boundary', text: '請把這兩段連載憶起。', expected: '請把這兩段連在一起。' }
] : readFileSync('eval/corpus.jsonl', 'utf8').split(/\r?\n/).filter(Boolean).map(x => JSON.parse(x)).filter(x => x.split === split);
const rows = splitRows.slice(0, limit);
if (!rows.length) { db.close(); throw new Error('No corpus rows selected; no calls made'); }
const evalPolicy: CorrectionPolicy = { model: MODEL, autoCategories: ['homophone', 'word-boundary'], validatedAt: 'evaluation-only', evidence: null };
const results: EvaluationResult[] = [];
let stopReason: string | null = null;
for (const row of rows) {
  const id = randomUUID();
  try { reserveEvaluationCall(db, { id, label, model: MODEL, maxCallTwd: MAX_CALL_TWD }); }
  catch (error) { stopReason = error instanceof EvaluationBudgetError ? error.code : 'ledger_reservation_failed'; break; }
  const start = performance.now();
  let costTwd = MAX_CALL_TWD;
  let providerCompleted = false;
  try {
    const response = await checkWithGemini({ text: row.text, revision: id }, key, { timeoutMs, policy: evalPolicy });
    providerCompleted = true;
    const latencyMs = Math.round(performance.now() - start);
    const settlement = settleEvaluationCall(db, id, response.usage?.estimatedTwd, MAX_CALL_TWD);
    costTwd = settlement.costTwd;
    stopReason = settlement.stopReason;
    const suggested = applyEdits(row.text, response.edits);
    const automatic = applyEdits(row.text, response.edits, true);
    results.push({ id: row.id, kind: row.kind, category: row.category, success: true, latencyMs,
      suggested, automatic, expected: row.expected, original: row.text, edits: response.edits, costTwd });
  } catch (error) {
    if (providerCompleted) stopReason ??= 'ledger_or_result_processing_failed';
    failEvaluationCall(db, id);
    results.push({ id: row.id, kind: row.kind, category: row.category, success: false, latencyMs: Math.round(performance.now() - start),
      error: error instanceof ProviderError ? error.code : 'evaluation_error', costTwd });
  }
  // Progress contains only corpus identifiers and aggregate outcome, never credentials or user text.
  if (results.length % 10 === 0 || rows.length === 1) console.log(JSON.stringify({ attempted: results.length, planned: rows.length, lastError: results.at(-1)?.error ?? null }));
  if (stopReason) break;
  stopReason = evaluationFailureStopReason(results);
  if (stopReason) break;
}
const metrics = evaluationMetrics(results);
const completion = evaluationCompletion(rows.length, results.length, metrics.failedCalls, stopReason);
const fullSplitPlanned = rows.length === splitRows.length;
const report = {
  model: MODEL, split, label, startedAt, finishedAt: new Date().toISOString(),
  corpusKind: 'human-authored synthetic; not user pilot',
  ...completion, availableInSplit: splitRows.length, requestedLimit: limit, fullSplitPlanned,
  completeSplitEvidence: split !== 'smoke' && fullSplitPlanned && completion.completionStatus === 'complete',
  hypotheticalPolicyOnly: true,
  autoPrecisionMaySupport99PercentGate: split === 'holdout' && fullSplitPlanned && completion.completionStatus === 'complete' && metrics.autoPrecisionAlignmentReliable,
  realEndToEndLatencyGatePassed: false,
  timeoutMs, policy: evalPolicy, metrics,
  byCategory: Object.fromEntries(['homophone', 'word-boundary', 'other'].map(category => [category, evaluationMetrics(results.filter(result => result.category === category))])),
  costTwd: results.reduce((sum, result) => sum + result.costTwd, 0),
  localEvaluationLimitTwd: LOCAL_EVALUATION_LIMIT_TWD,
  totalEvaluationCostTwd: evaluationSpentTwd(db), results,
};
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ report: reportPath, ...completion, metrics: report.metrics,
  costTwd: report.costTwd, totalEvaluationCostTwd: report.totalEvaluationCostTwd }));
db.close();
if (completion.completionStatus !== 'complete') process.exitCode = 1;
