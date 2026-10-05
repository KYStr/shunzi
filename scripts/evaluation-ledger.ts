import type { DatabaseSync } from 'node:sqlite';

export const LOCAL_EVALUATION_LIMIT_TWD = 55;
export class EvaluationBudgetError extends Error {
  constructor(public readonly code: 'budget_exhausted' | 'persistent_budget_guard') { super(code); }
}

export function initializeEvaluationLedger(db: DatabaseSync, maxCallTwd: number): void {
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, label TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, cost REAL NOT NULL, started TEXT NOT NULL); CREATE TABLE IF NOT EXISTS evaluation_guards (name TEXT PRIMARY KEY, reason TEXT NOT NULL, tripped_at TEXT NOT NULL);');
  // A previous process might predate the guard implementation. Never ignore its overspend.
  const historical = db.prepare('SELECT id FROM calls WHERE cost > ? OR cost < 0 LIMIT 1').get(maxCallTwd);
  if (historical) tripGuard(db, 'historical_reservation_exceeded');
}

function tripGuard(db: DatabaseSync, reason: string) {
  db.prepare('INSERT OR IGNORE INTO evaluation_guards VALUES(?,?,?)').run('cost_reservation', reason, new Date().toISOString());
}

export function evaluationSpentTwd(db: DatabaseSync): number {
  return (db.prepare('SELECT COALESCE(SUM(cost),0) AS cost FROM calls').get() as { cost: number }).cost;
}

export function reserveEvaluationCall(db: DatabaseSync, call: { id: string; label: string; model: string; maxCallTwd: number }): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT name FROM evaluation_guards LIMIT 1').get()) throw new EvaluationBudgetError('persistent_budget_guard');
    if (evaluationSpentTwd(db) + call.maxCallTwd > LOCAL_EVALUATION_LIMIT_TWD) throw new EvaluationBudgetError('budget_exhausted');
    db.prepare('INSERT INTO calls VALUES(?,?,?,?,?,?)').run(call.id, call.label, call.model, 'reserved', call.maxCallTwd, new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Atomically commit the bill and a durable stop flag before the next request may reserve. */
export function settleEvaluationCall(db: DatabaseSync, id: string, reportedTwd: number | undefined, maxCallTwd: number) {
  const invalidUsage = reportedTwd !== undefined && (!Number.isFinite(reportedTwd) || reportedTwd < 0);
  const costTwd = invalidUsage || reportedTwd === undefined ? maxCallTwd : reportedTwd;
  const stopReason = invalidUsage ? 'invalid_usage_cost' : costTwd > maxCallTwd ? 'reservation_exceeded' : null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const updated = db.prepare('UPDATE calls SET cost=?,status=? WHERE id=? AND status=?')
      .run(costTwd, stopReason ? 'completed-budget-guard' : 'completed', id, 'reserved');
    if (updated.changes !== 1) throw new Error('Missing or already settled evaluation reservation');
    if (stopReason) tripGuard(db, stopReason);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { costTwd, stopReason };
}

export function failEvaluationCall(db: DatabaseSync, id: string): void {
  // Do not undo a successful settlement or its persisted guard if later report assembly fails.
  db.prepare('UPDATE calls SET status=? WHERE id=? AND status=?').run('unknown-or-failed', id, 'reserved');
}
