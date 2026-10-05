import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEdits, validateRequest, checkWithGemini, applyEdits, MAX_CALL_TWD, estimateCostTwd, MODEL, type CorrectionPolicy } from '../src/core/index.js';

const policy: CorrectionPolicy = { model: MODEL, autoCategories: ['homophone','word-boundary'], validatedAt: 'test-only', evidence: 'fixture' };
const proposal = (original: string, replacement: string, overrides = {}) => ({ original, replacement, category:'homophone', certainty:'clear', sensitive:false, reason:'依上下文', alternatives:[], ...overrides });
test('unvalidated production policy cannot auto-correct',()=> {
  const r={text:'我明天會在確認一次。',revision:'1'};
  assert.equal(normalizeEdits(r,{edits:[proposal('會在確認','會再確認') ]})[0].action,'suggest');
});
test('cross-word edits map UTF16 positions without rewriting surrounding text',()=> {
  const r={text:'🙂請把兩段連載憶起。',revision:'1'};
  const edits=normalizeEdits(r,{edits:[proposal('連載憶起','連在一起',{category:'word-boundary'})]},policy);
  assert.equal(applyEdits(r.text,edits),'🙂請把兩段連在一起。');
  assert.equal(edits[0].action,'auto');
});
test('quoted discussion, URL, code and protected names cannot be patched',()=> {
  for(const text of ['請比較「連載憶起」。','`連載憶起` 是原文。','https://test.example/連載憶起','這個人叫連載憶起。']) {
    assert.deepEqual(normalizeEdits({text,revision:'1',protectedTerms:['連載憶起']},{edits:[proposal('連載憶起','連在一起')]},policy),[]);
  }
});
test('duplicates and overlapping suggestions are discarded',()=> {
  assert.deepEqual(normalizeEdits({text:'在在',revision:'1'},{edits:[proposal('在','再')]},policy),[]);
  assert.deepEqual(normalizeEdits({text:'連載憶起',revision:'1'},{edits:[proposal('載憶','在一'),proposal('憶起','一起')]},policy),[]);
});
test('semantic negation and pronoun changes are suggestion-only',()=> {
  assert.equal(normalizeEdits({text:'他來了',revision:'1'},{edits:[proposal('他','她')]},policy)[0].action,'suggest');
  assert.equal(normalizeEdits({text:'請買三張票',revision:'1'},{edits:[proposal('三','四')]},policy)[0].action,'suggest');
});

test('supplementary Han edits never split a surrogate pair; oversized alternatives are dropped',()=> {
  const [edit]=normalizeEdits({text:'𠀀',revision:'x'},{edits:[proposal('𠀀','𠀁')]},policy);
  assert.equal(edit.start,0); assert.equal(edit.end,2); assert.equal(edit.original,'𠀀');
  const [minimal]=normalizeEdits({text:'措',revision:'x'},{edits:[proposal('措','錯',{alternatives:['重新寫一整段不同語意的句子']})]},policy);
  assert.deepEqual(minimal.alternatives,[]);
});
test('request limits and upper-bound reservation are enforced',()=> {
  assert.throws(()=>validateRequest({text:'字'.repeat(501),revision:'x'}));
  assert.throws(()=>validateRequest({text:'字',revision:'x',protectedTerms:Array(31).fill('字')}));
  assert.ok(estimateCostTwd(10000,1024)<MAX_CALL_TWD);
});
test('provider uses only fixed HTTPS endpoint and header credential; errors never echo provider data',async()=> {
  let calls=0;
  const fetcher:typeof fetch=async(url,init)=> {
    calls++;
    assert.equal(String(url),`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`);
    assert.equal((init?.headers as Record<string,string>)['x-goog-api-key'],'test-key');
    assert.ok(!String(url).includes('test-key')); assert.equal(init?.redirect,'error');
    return new Response(JSON.stringify({error:{message:'secret=test-key'}}),{status:403});
  };
  await assert.rejects(checkWithGemini({text:'校對',revision:'x'},'test-key',{fetcher}),e=>e instanceof Error&&!e.message.includes('test-key'));
  assert.equal(calls,1);
});
test('missing usage or truncated completion cannot establish a valid correction',async()=> {
  const fetcher:typeof fetch=async()=>new Response(JSON.stringify({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'{}'}]}}]}));
  await assert.rejects(checkWithGemini({text:'校對',revision:'x'},'test-key',{fetcher}));
  const noOutputUsage:typeof fetch=async()=>new Response(JSON.stringify({usageMetadata:{promptTokenCount:100},candidates:[{finishReason:'STOP',content:{parts:[{text:'{"edits":[]}'}]}}]}));
  await assert.rejects(checkWithGemini({text:'校對',revision:'x'},'test-key',{fetcher:noOutputUsage}));
});
