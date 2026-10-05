/** Synthetic development smoke only. Default is offline; --live explicitly calls Jev. */
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PhoneticLexicon, prepareParagraph, reviewParagraph, reviewJevSelection, selectWithJev, JEV_MODEL, JEV_MAX_CALL_TWD } from '../src/core/paragraph/index.js';
import { initializeEvaluationLedger, reserveEvaluationCall, settleEvaluationCall, failEvaluationCall, evaluationSpentTwd } from './evaluation-ledger.js';

const dictionary = JSON.parse(await readFile('.local/mcbopomofo/lexicon.json','utf8'));
const startup = performance.now();
const lexicon = new PhoneticLexicon(dictionary.entries, dictionary.version, {allowToneChanges:true});
const indexMs = Math.round(performance.now() - startup);
const examples = [
  { text: '請把這兩段連載憶起，整理成一份筆記。', expected: '請把這兩段連在一起，整理成一份筆記。' },
  { text: '我現在在家，明天在回覆你。', expected: '我現在在家，明天再回覆你。' },
  { text: '這部小說正在連載，我會再看一次。', expected: '這部小說正在連載，我會再看一次。' },
  { text: '他忽然憶起往事。', expected: '他忽然憶起往事。' },
  { text: '請解釋「連載憶起」這個錯字。', expected: '請解釋「連載憶起」這個錯字。' },
  { text: '王再興今天在家。', expected: '王再興今天在家。', protectedTerms: ['王再興'] },
];
const live = process.argv.includes('--live');
const key = live ? (await readFile('.local/jev-api-key.txt','utf8')).trim() : '';
const db = live ? new DatabaseSync('.local/eval-budget.sqlite') : undefined;
if (db) initializeEvaluationLedger(db, JEV_MAX_CALL_TWD);
const rows = [];
try {
  for (let i = 0; i < examples.length; i++) {
    const example = examples[i], begin = performance.now();
    const batch = prepareParagraph({ text: example.text, revision: `development-${i}`, protectedTerms: example.protectedTerms }, lexicon);
    const candidateMs = Math.round((performance.now() - begin) * 10) / 10;
    // These smoke pairs have equal UTF-16 lengths. Gold labels only measure coverage, never enter Jev's request.
    const oracleChoices = batch.groups.map(g => ({ groupId: g.id,
      optionId: g.options.find(o => o.text === example.expected.slice(g.start,g.end))?.id ?? 'keep' }));
    const row: Record<string,unknown> = { text: example.text, expected: example.expected, candidateMs,
      expectedReachable: reviewParagraph(batch, oracleChoices).text === example.expected,
      groups: batch.groups.map(g => ({ start: g.start, end: g.end, original: g.original, options: g.options.map(o => ({ id: o.id, text: o.text })) })),
      truncated: batch.truncated };
    if (live && db && batch.groups.length) {
      const id = randomUUID();
      reserveEvaluationCall(db, { id, label: `paragraph-development-${i}`, model: JEV_MODEL, maxCallTwd: JEV_MAX_CALL_TWD });
      const apiBegin = performance.now();
      try {
        const result = await selectWithJev(batch, key);
        const settlement = settleEvaluationCall(db, id, result.usage?.estimatedTwd, JEV_MAX_CALL_TWD);
        Object.assign(row, { apiMs: Math.round(performance.now() - apiBegin), model: result.model,
          choices: result.choices, usage: result.usage, preview: reviewJevSelection(result, batch.request, 0).text,
          estimatedSpendTwd: evaluationSpentTwd(db) });
        if (settlement.stopReason) { row.stopReason = settlement.stopReason; rows.push(row); break; }
      } catch (error) {
        failEvaluationCall(db, id);
        // Never serialize upstream exception objects, which can contain request credentials.
        row.error = error instanceof Error && 'code' in error ? String(error.code) : 'probe_failed';
        rows.push(row); break;
      }
    }
    rows.push(row);
  }
  const report = { kind: 'development-smoke-not-holdout', live, lexiconVersion: lexicon.version,
    entries: lexicon.size, indexMs, rows, totalLedgerTwd: db ? evaluationSpentTwd(db) : undefined };
  const output = `.local/paragraph-${live ? 'live' : 'offline'}.json`;
  await writeFile(output, JSON.stringify(report,null,2));
  console.log(JSON.stringify({ ...report, rows: rows.map(({groups, ...row}) => ({ ...row,
    candidateGroups: (groups as unknown[]).length })) },null,2));
  console.log(`Saved synthetic development report: ${output}`);
} finally { db?.close(); }
