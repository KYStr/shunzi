import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CorrectionEdit } from '../src/core/types.js';
import { alignedGoldEdits, evaluationMetrics, evaluationCompletion, evaluationFailureStopReason, type EvaluationResult } from '../scripts/evaluation-metrics.js';
import { initializeEvaluationLedger, reserveEvaluationCall, settleEvaluationCall, failEvaluationCall,
  evaluationSpentTwd, EvaluationBudgetError, LOCAL_EVALUATION_LIMIT_TWD } from '../scripts/evaluation-ledger.js';

const edit = (start: number, end: number, original: string, replacement: string): CorrectionEdit => ({
  id: `${start}-${end}`, start, end, original, replacement, action: 'auto', category: 'homophone', alternatives: [], reason: '',
});
const row = (overrides: Partial<EvaluationResult> = {}): EvaluationResult => ({ id: 'synthetic', kind: 'error',
  category: 'homophone', success: true, latencyMs: 300, original: '我再家，明天在說。', expected: '我在家，明天再說。',
  suggested: '我在家，明天再說。', automatic: '我在家，明天再說。', edits: [edit(1, 2, '再', '在'), edit(6, 7, '在', '再')], costTwd: .01,
  ...overrides });

test('unique gold alignment identifies independent local edits with UTF-16 offsets', () => {
  assert.deepEqual(alignedGoldEdits('🙂我再家', '🙂我在家'), [{ start: 3, end: 4, replacement: '在' }]);
  assert.deepEqual(alignedGoldEdits('我再家，明天在說。', '我在家，明天再說。'), [
    { start: 1, end: 2, replacement: '在' }, { start: 6, end: 7, replacement: '再' },
  ]);
});

test('precision counts edits, not all-or-nothing sentence correctness', () => {
  const metrics = evaluationMetrics([row({ automatic: '我在家，明天才說。', suggested: '我在家，明天才說。',
    edits: [edit(1, 2, '再', '在'), edit(6, 7, '在', '才')] })]);
  assert.equal(metrics.autoEdits, 2);
  assert.equal(metrics.correctAutoEdits, 1);
  assert.equal(metrics.autoPrecision, .5);
  assert.equal(metrics.sentenceAutoPrecision, 0);
  assert.equal(metrics.correctionRecall, 0);
});

test('an edit may carry unchanged word context without counting it as a new correction', () => {
  const metrics = evaluationMetrics([row({ edits: [edit(0, 3, '我再家', '我在家')], automatic: '我在家，明天在說。' })]);
  assert.equal(metrics.autoPrecision, 1);
  assert.equal(metrics.sentenceAutoPrecision, 0);
});

test('ambiguous repeated-character alignment is unscored and cannot claim 99 percent evidence', () => {
  assert.equal(alignedGoldEdits('我收到你的的信。', '我收到你的信。'), null);
  const metrics = evaluationMetrics([row({ original: '我收到你的的信。', expected: '我收到你的信。',
    suggested: '我收到你的信。', automatic: '我收到你的信。', edits: [edit(5, 6, '的', '')] })]);
  assert.equal(metrics.unscoredAutoEdits, 1);
  assert.equal(metrics.autoPrecision, null);
  assert.equal(metrics.autoPrecisionAlignmentReliable, false);
  assert.equal(metrics.sentenceAutoPrecision, 1);
  assert.equal(metrics.sentenceAutoPrecisionMayEnable99PercentGate, false);
});

test('correct and ambiguous drafts count unsolicited automatic edits as incorrect', () => {
  for (const kind of ['correct', 'ambiguous'] as const) {
    const metrics = evaluationMetrics([row({ kind, original: '我在想。', expected: '我在想。', suggested: '我再想。',
      automatic: '我再想。', edits: [edit(1, 2, '在', '再')] })]);
    assert.equal(metrics.autoPrecision, 0);
    assert.equal(metrics.falsePositives[kind].automaticFalsePositiveRate, 1);
    assert.equal(metrics.falsePositives[kind].suggestionFalsePositiveRate, 1);
  }
});

test('empty automatic results are N/A; latency estimate excludes failures but makes that explicit', () => {
  const metrics = evaluationMetrics([row({ edits: [], automatic: '我再家，明天在說。' }),
    row({ id: 'failed', success: false, latencyMs: 2800, edits: undefined, suggested: undefined, automatic: undefined })]);
  assert.equal(metrics.autoPrecision, null);
  assert.equal(metrics.autoPrecisionAlignmentReliable, false);
  assert.equal(metrics.correctionRecall, .5);
  assert.equal(metrics.estimatedSuccessfulApiPlus600msP95, 900);
  assert.equal(metrics.latencySampleCount, 1);
  assert.equal(metrics.failedCalls, 1);
  assert.equal(metrics.realEndToEndP95Ms, null);
});

test('completion distinguishes early stop, unattempted requests, errors and full success', () => {
  assert.deepEqual(evaluationCompletion(40, 1, 1, 'forbidden'), {
    planned: 40, attempted: 1, unattempted: 39, completionStatus: 'partial', stopReason: 'forbidden',
  });
  assert.equal(evaluationCompletion(40, 0, 0, 'budget_exhausted').completionStatus, 'not-started');
  assert.equal(evaluationCompletion(40, 40, 1, null).completionStatus, 'completed-with-failures');
  assert.equal(evaluationCompletion(40, 40, 0, 'reservation_exceeded').completionStatus, 'stopped');
  assert.equal(evaluationCompletion(40, 40, 0, null).completionStatus, 'complete');
});

test('two identical consecutive failures stop further paid calls; permanent failures stop immediately', () => {
  const failed = (error: string) => row({ success: false, error, edits: undefined });
  for (const error of ['network', 'timeout', 'rate_limit', 'evaluation_error']) {
    assert.equal(evaluationFailureStopReason([failed(error)]), null);
    assert.equal(evaluationFailureStopReason([failed(error), failed(error)]), `repeated_${error}`);
    assert.equal(evaluationFailureStopReason([failed(error), row(), failed(error)]), null);
  }
  assert.equal(evaluationFailureStopReason([failed('timeout'), failed('network')]), null);
  assert.equal(evaluationFailureStopReason([row(), failed('forbidden')]), 'forbidden');
  assert.equal(evaluationFailureStopReason([]), null);
});

function ledger() { const db = new DatabaseSync(':memory:'); initializeEvaluationLedger(db, .2); return db; }
const reserve = (db: DatabaseSync, id: string) => reserveEvaluationCall(db, { id, label: 'mock', model: 'mock', maxCallTwd: .2 });
const guardError = (error: unknown) => error instanceof EvaluationBudgetError && error.code === 'persistent_budget_guard';

test('oversized reported usage is charged and immediately latches a guard across reinitialization', () => {
  const db = ledger();
  try {
    reserve(db, 'one');
    assert.deepEqual(settleEvaluationCall(db, 'one', .25, .2), { costTwd: .25, stopReason: 'reservation_exceeded' });
    assert.equal(evaluationSpentTwd(db), .25);
    assert.throws(() => reserve(db, 'two'), guardError);
    initializeEvaluationLedger(db, .2);
    assert.throws(() => reserve(db, 'three'), guardError);
    failEvaluationCall(db, 'one');
    assert.equal((db.prepare('SELECT status FROM calls WHERE id=?').get('one') as { status: string }).status, 'completed-budget-guard');
  } finally { db.close(); }
});

test('guard migration catches historical overspend and never silently resets it', () => {
  const db = ledger();
  try {
    db.prepare('INSERT INTO calls VALUES(?,?,?,?,?,?)').run('legacy', 'old', 'mock', 'completed', .3, '2026-01-01');
    initializeEvaluationLedger(db, .2);
    assert.throws(() => reserve(db, 'new'), guardError);
  } finally { db.close(); }
});

test('persisted guard survives closing and reopening the SQLite file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'shunzi-evaluation-test-'));
  const path = join(directory, 'budget.sqlite');
  let db = new DatabaseSync(path);
  try {
    initializeEvaluationLedger(db, .2);
    reserve(db, 'before-restart');
    settleEvaluationCall(db, 'before-restart', .21, .2);
    db.close();
    db = new DatabaseSync(path);
    initializeEvaluationLedger(db, .2);
    assert.throws(() => reserve(db, 'after-restart'), guardError);
  } finally {
    db.close();
    // Delete only these task-created SQLite files; no recursive filesystem cleanup.
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    rmdirSync(directory);
  }
});

test('local 55 TWD ceiling preserves the separate 5 TWD hosted-evaluation allocation', () => {
  assert.equal(LOCAL_EVALUATION_LIMIT_TWD, 55);
  const db = ledger();
  try {
    db.prepare('INSERT INTO calls VALUES(?,?,?,?,?,?)').run('total-fixture', 'old', 'mock', 'completed', 54.9, '2026-01-01');
    assert.throws(() => reserve(db, 'new'), (error: unknown) => error instanceof EvaluationBudgetError && error.code === 'budget_exhausted');
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM calls').get() as { count: number }).count, 1);
  } finally { db.close(); }
});

test('unknown cost keeps its reservation; invalid reported cost trips a permanent guard', () => {
  const db = ledger();
  try {
    reserve(db, 'unknown');
    assert.deepEqual(settleEvaluationCall(db, 'unknown', undefined, .2), { costTwd: .2, stopReason: null });
    reserve(db, 'invalid');
    assert.deepEqual(settleEvaluationCall(db, 'invalid', Number.NaN, .2), { costTwd: .2, stopReason: 'invalid_usage_cost' });
    assert.throws(() => reserve(db, 'later'), guardError);
    assert.throws(() => settleEvaluationCall(db, 'missing', .01, .2), /Missing/);
  } finally { db.close(); }
});
