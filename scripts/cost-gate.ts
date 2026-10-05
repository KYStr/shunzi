import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { JEV_MODEL, JEV_MAX_CALL_TWD, SUPPORTED_PIPELINE_VERSION, createJevChoiceRequest,
  estimateJevRequestTwd, selectWithJev, type CandidateBatch } from '../src/core/paragraph/index.js';
import { initializeEvaluationLedger, reserveEvaluationCall, settleEvaluationCall, failEvaluationCall,
  evaluationSpentTwd } from './evaluation-ledger.js';

// Default is offline. --live sends exactly one synthetic maximum-size request within the shared budget.
const text='甲乙丙丁戊己庚辛'.repeat(62)+'甲乙丙丁';
const batch:CandidateBatch={request:{text,revision:'cost-bound'},pipelineVersion:SUPPORTED_PIPELINE_VERSION,
  profileRevision:0,truncated:false,groups:Array.from({length:8},(_,i)=>({id:`g${i*8}_${i*8+8}`,
    start:i*8,end:i*8+8,original:text.slice(i*8,i*8+8),options:[{id:'keep',text:text.slice(i*8,i*8+8),rankScore:0},
      ...['壬','癸','子','丑','寅'].map((c,j)=>({id:`o${j}`,text:c.repeat(8),rankScore:1}))]}))};
const cases=[{name:'500-characters-8-groups-6-options',estimatedTwd:estimateJevRequestTwd(createJevChoiceRequest(batch))},
  {name:'failure-with-unknown-usage',reservedTwd:JEV_MAX_CALL_TWD}];
let liveSample: {inputTokens?:number;estimatedTwd?:number;latencyMs?:number;error?:string;totalLedgerTwd:number}|undefined;
if(process.argv.includes('--live')) {
  const key=(await readFile('.local/jev-api-key.txt','utf8')).trim();
  const db=new DatabaseSync('.local/eval-budget.sqlite'), id=randomUUID(), started=performance.now();
  initializeEvaluationLedger(db,JEV_MAX_CALL_TWD);
  try {
    reserveEvaluationCall(db,{id,label:'product-maximum-size-cost',model:JEV_MODEL,maxCallTwd:JEV_MAX_CALL_TWD});
    try {
      const selected=await selectWithJev(batch,key);
      const settlement=settleEvaluationCall(db,id,selected.usage?.estimatedTwd,JEV_MAX_CALL_TWD);
      liveSample={inputTokens:selected.usage?.inputTokens,estimatedTwd:settlement.costTwd,
        latencyMs:Math.round(performance.now()-started),totalLedgerTwd:evaluationSpentTwd(db)};
      if(settlement.stopReason) throw new Error('cost_guard');
    } catch(error) {
      failEvaluationCall(db,id);
      liveSample={error:error instanceof Error && 'code' in error?String(error.code):'cost_sample_failed',totalLedgerTwd:evaluationSpentTwd(db)};
      process.exitCode=1;
    }
    await writeFile('.local/maximum-size-cost.json',JSON.stringify(liveSample,null,2));
  } finally {db.close();}
}
// Unknown provider outcomes must retain the full reservation. This fixture never calls a provider.
const failureDb=new DatabaseSync(':memory:');
initializeEvaluationLedger(failureDb,JEV_MAX_CALL_TWD);
reserveEvaluationCall(failureDb,{id:'failure',label:'fixture',model:JEV_MODEL,maxCallTwd:JEV_MAX_CALL_TWD});
failEvaluationCall(failureDb,'failure');
const failureRetainedTwd=evaluationSpentTwd(failureDb); failureDb.close();
if(failureRetainedTwd!==JEV_MAX_CALL_TWD) throw new Error('Failure accounting guard did not retain cost');
const report={schemaVersion:1,model:JEV_MODEL,pipelineVersion:SUPPORTED_PIPELINE_VERSION,
  maxCallTwd:JEV_MAX_CALL_TWD,planChecks:500,planEstimateTwd:500*JEV_MAX_CALL_TWD,
  passed:false,reason:'500 requests at the current conservative reserve exceed NT$40; no independently verified lower billing upper bound.',
  liveBillingVerified:false,cases,liveSample,failureRetainedTwd};
await mkdir('release',{recursive:true});
const bytes=JSON.stringify(report,null,2)+'\n';
await writeFile('release/cost-gate.json',bytes);
await writeFile('release/cost-gate.sha256',createHash('sha256').update(bytes).digest('hex')+'  cost-gate.json\n');
console.log(JSON.stringify(report));
