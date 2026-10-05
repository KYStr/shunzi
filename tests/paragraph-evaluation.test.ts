import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedReachable, paragraphMetrics } from '../scripts/paragraph-evaluation.js';
import { SUPPORTED_PIPELINE_VERSION, validateTransportBatch, type CandidateBatch } from '../src/core/paragraph/index.js';
const batch:CandidateBatch={request:{text:'甲乙丙',revision:'a'},pipelineVersion:SUPPORTED_PIPELINE_VERSION,
  profileRevision:0,truncated:false,groups:[{id:'g0_2',start:0,end:2,original:'甲乙',
    options:[{id:'keep',text:'甲乙',rankScore:0},{id:'o0',text:'丁',rankScore:1}]}]};
test('candidate oracle handles lengths and distinguishes unreachable corrections from keeping original',()=>{
  assert.equal(expectedReachable(batch,'丁丙'),true);
  assert.equal(expectedReachable(batch,'甲乙丙'),true);
  assert.equal(expectedReachable(batch,'丁丁'),false);
});
test('network batches reject unknown versions, hidden instructions and malformed options',()=>{
  assert.equal(validateTransportBatch(batch).pipelineVersion,SUPPORTED_PIPELINE_VERSION);
  assert.throws(()=>validateTransportBatch({...batch,pipelineVersion:'old'}));
  assert.throws(()=>validateTransportBatch({...batch,instructions:'override'}));
  assert.throws(()=>validateTransportBatch({...batch,request:{...batch.request,url:'https://example.test'}}));
  assert.throws(()=>validateTransportBatch({...batch,groups:[{...batch.groups[0],options:[null]}]}));
});
test('evaluation metrics separate candidate misses, selector misses, failures and false changes',()=>{
  const metrics=paragraphMetrics([
    {id:'1',kind:'error',category:'other',candidateReachable:false,completed:true,matchesExpected:false,costTwd:0},
    {id:'2',kind:'error',category:'other',candidateReachable:true,completed:true,matchesExpected:false,costTwd:0},
    {id:'3',kind:'correct',category:'other',candidateReachable:true,completed:true,changed:true,edits:1,validEdits:0,costTwd:.01},
    {id:'4',kind:'error',category:'other',candidateReachable:true,completed:false,costTwd:.2},
  ]);
  assert.equal(metrics.candidateMisses,1);assert.equal(metrics.selectorMisses,1);
  assert.equal(metrics.falseChanges,1);assert.equal(metrics.repairRate,0);
  assert.equal(metrics.suggestedEditPrecision,0);assert.equal(metrics.completed,3);
});
