import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PhoneticLexicon, prepareParagraph, reviewJevSelection, selectWithJev, JEV_MODEL, JEV_MAX_CALL_TWD,
  SUPPORTED_PIPELINE_VERSION } from '../src/core/paragraph/index.js';
import { initializeEvaluationLedger, reserveEvaluationCall, settleEvaluationCall, failEvaluationCall,
  evaluationSpentTwd } from './evaluation-ledger.js';
import { expectedReachable, paragraphMetrics, type ParagraphEvalRow } from './paragraph-evaluation.js';

const args = process.argv.slice(2);
const value = (name: string, fallback: string) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i+1]; };
const split = value('--split','dev'), label = value('--label',`${split}-${Date.now()}`), live = args.includes('--live');
if (!['dev','holdout'].includes(split) || !/^[a-zA-Z0-9_-]{1,80}$/.test(label)) throw new Error('Invalid evaluation arguments');
if (split === 'holdout' && !live) throw new Error('Holdout is only opened for a frozen live evaluation, not local tuning.');
await mkdir('.local',{recursive:true});
const path = `.local/paragraph-eval-${label}.json`;
// Exclusive creation prevents overwriting evidence even if the process is interrupted later.
await writeFile(path, JSON.stringify({status:'running',split,live}), {flag:'wx'});
const dictionaryBytes = await readFile('.local/mcbopomofo/lexicon.json');
const dictionary = JSON.parse(dictionaryBytes.toString('utf8'));
const lexicon = new PhoneticLexicon(dictionary.entries,dictionary.version,{allowToneChanges:true});
async function fingerprint() {
  const hash = createHash('sha256');
  for (const name of (await readdir('src/core/paragraph')).filter(n=>n.endsWith('.ts')).sort()) {
    hash.update(name); hash.update(await readFile(`src/core/paragraph/${name}`));
  }
  hash.update(await readFile('src/core/protection.ts')); hash.update(await readFile('src/core/index.ts'));
  hash.update(dictionaryBytes);
  return hash.digest('hex');
}
const frozen = { model:JEV_MODEL, pipelineVersion:SUPPORTED_PIPELINE_VERSION, engineSha256:await fingerprint(),
  lexiconSha256:createHash('sha256').update(dictionaryBytes).digest('hex'), frozenAt:new Date().toISOString() };
// Freeze before reading holdout labels. Reports from this split must never guide this run's implementation.
await writeFile(`.local/paragraph-freeze-${label}.json`, JSON.stringify(frozen,null,2), {flag:'wx'});
const corpusBytes = await readFile('eval/corpus.jsonl');
type CorpusRow = {id:string;split:string;kind:'error'|'correct'|'ambiguous';category:string;text:string;expected:string};
const rows: CorpusRow[] = corpusBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s)).filter(r=>r.split===split);
if (split === 'holdout' && (rows.filter(r=>r.kind==='error').length !== 100 || rows.filter(r=>r.kind!=='error').length !== 100))
  throw new Error('Unexpected holdout composition');
const key = live ? (await readFile('.local/jev-api-key.txt','utf8')).trim() : '';
const db = live ? new DatabaseSync('.local/eval-budget.sqlite') : undefined;
if (db) initializeEvaluationLedger(db,JEV_MAX_CALL_TWD);
const results: ParagraphEvalRow[] = [];
let stopReason: string | null = null;
try {
  for (const row of rows) {
    const started = performance.now();
    const batch = prepareParagraph({text:row.text,revision:randomUUID()},lexicon);
    const result: ParagraphEvalRow = {id:row.id,kind:row.kind,category:row.category,
      candidateReachable:expectedReachable(batch,row.expected), completed:false, costTwd:0};
    if (!live) { results.push(result); continue; }
    try {
      let output = row.text, edits: ReturnType<typeof reviewJevSelection>['edits'] = [];
      if (batch.groups.length) {
        reserveEvaluationCall(db!, {id:batch.request.revision,label,model:JEV_MODEL,maxCallTwd:JEV_MAX_CALL_TWD});
        result.costTwd = JEV_MAX_CALL_TWD;
        try {
          const selected = await selectWithJev(batch,key);
          const settlement = settleEvaluationCall(db!,batch.request.revision,selected.usage?.estimatedTwd,JEV_MAX_CALL_TWD);
          result.costTwd = settlement.costTwd; stopReason = settlement.stopReason;
          const review = reviewJevSelection(selected,batch.request,0);
          output = review.text; edits = review.edits;
        } catch (error) { failEvaluationCall(db!,batch.request.revision); throw error; }
      }
      // For unequal-length gold, exact sentence matches count; unmatched sentences conservatively get no valid edits.
      const validEdits = output === row.expected ? edits.length : row.text.length === row.expected.length
        ? edits.filter(e => row.expected.slice(e.start,e.end) === e.replacement && row.text.slice(e.start,e.end)!==e.replacement).length : 0;
      Object.assign(result,{completed:true,matchesExpected:output===row.expected,changed:output!==row.text,
        edits:edits.length,validEdits,latencyMs:Math.round(performance.now()-started)});
    } catch (error) {
      result.error = error instanceof Error && 'code' in error ? String(error.code) : 'evaluation_error';
      stopReason = result.error; // No blind retries or spending through a broken provider.
    }
    results.push(result);
    if (results.length % 20 === 0) console.log(JSON.stringify({split,completed:results.length,total:rows.length}));
    if (stopReason) break;
  }
  const unchanged = frozen.engineSha256 === await fingerprint();
  if (!unchanged) stopReason = 'engine_changed_during_evaluation';
  const metrics = paragraphMetrics(results);
  const report = { schemaVersion:1, ...frozen, corpusSha256:createHash('sha256').update(corpusBytes).digest('hex'),
    split,live,kind:'synthetic-heldout-or-development-not-human-pilot',expectedRows:rows.length,
    complete:live && results.length===rows.length && !stopReason,stopReason,metrics,
    repairGatePassed:live && split==='holdout' && !stopReason && results.length===rows.length && (metrics.repairRate ?? 0)>=.8,
    automaticEditingEnabled:false, realBrowserLatencyVerified:false,
    totalLedgerTwd:db ? evaluationSpentTwd(db) : undefined, results };
  await writeFile(path,JSON.stringify(report,null,2));
  console.log(JSON.stringify({report:path,complete:report.complete,metrics,stopReason,totalLedgerTwd:report.totalLedgerTwd}));
  if (stopReason) process.exitCode=1;
} finally { db?.close(); }
