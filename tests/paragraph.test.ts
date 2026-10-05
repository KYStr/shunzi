import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhoneticLexicon, prepareParagraph, reviewParagraph, changeReviewOption, reviewJevSelection,
  learnParagraphChoice, assertCurrentBatch, createJevChoiceRequest, selectWithJev, JEV_MODEL,
  JEV_ENDPOINT, EMPTY_PROFILE, type CandidateBatch, type LexiconEntry } from '../src/core/paragraph/index.js';

const entries: LexiconEntry[] = [
  ['連',['ㄌㄧㄢˊ'],-4],['載',['ㄗㄞˋ'],-5],['在',['ㄗㄞˋ'],-2],['再',['ㄗㄞˋ'],-3],
  ['憶',['ㄧˋ'],-6],['一',['ㄧˋ'],-2],['起',['ㄑㄧˇ'],-3],
  ['連載',['ㄌㄧㄢˊ','ㄗㄞˋ'],-5],['憶起',['ㄧˋ','ㄑㄧˇ'],-5],
  ['連在一起',['ㄌㄧㄢˊ','ㄗㄞˋ','ㄧˋ','ㄑㄧˇ'],-3],['在一起',['ㄗㄞˋ','ㄧˋ','ㄑㄧˇ'],-4],
  ['行',['ㄒㄧㄥˊ'],-4],['行',['ㄏㄤˊ'],-4],['型',['ㄒㄧㄥˊ'],-3],['航',['ㄏㄤˊ'],-3],
  ['段',['ㄉㄨㄢˋ'],-4],['鍛鍊',['ㄉㄨㄢˋ','ㄌㄧㄢˋ'],-3],
  ['𠀀',['ㄓㄥ'],-5],['𠀁',['ㄓㄥ'],-3],
].map(([text,readings,score]) => ({ text: text as string, readings: readings as string[], score: score as number }));
const lexicon = new PhoneticLexicon(entries,'fixture');
const prepare = (text: string, protectedTerms: string[] = []) => prepareParagraph({text,revision:'r1',protectedTerms},lexicon);

test('paragraph candidates cross existing words and retain Unicode offsets', () => {
  const batch = prepare('😀請把兩段連載憶起。');
  const group = batch.groups.find(g => g.options.some(o => o.text === '連在一起'))!;
  assert.ok(group);
  assert.equal(batch.request.text.slice(group.start,group.end),'連載憶起');
  const choice = { groupId: group.id, optionId: group.options.find(o=>o.text==='連在一起')!.id };
  const review = reviewParagraph(batch,[choice]);
  assert.equal(review.text,'😀請把兩段連在一起。');
  assert.ok(review.edits.every(e=>e.action==='suggest'));
  const supplementary = prepare('😀𠀀');
  assert.equal(supplementary.groups[0].start,2);
  assert.equal(supplementary.groups[0].end,4);
});

test('repeated characters are independently addressable', () => {
  const batch = prepare('我現在在家，明天在回覆。');
  const group = batch.groups.find(g=>g.start===batch.request.text.lastIndexOf('在'))!;
  const review = reviewParagraph(batch,[{groupId:group.id,optionId:group.options.find(o=>o.text==='再')!.id}]);
  assert.equal(review.text,'我現在在家，明天再回覆。');
});

test('adjacent repetition gets an optional deletion without assuming reduplication is wrong', () => {
  for (const text of ['請看看','的的回覆','今天天天氣好']) {
    const batch = prepare(text);
    const group = batch.groups.find(g => [...g.original].length === 2 && [...g.original][0] === [...g.original][1]);
    assert.ok(group);
    assert.ok(group.options.some(o=>[...o.text].length===1));
    assert.equal(reviewParagraph(batch).text,text);
    assert.equal(reviewParagraph(batch,[{groupId:group.id,optionId:'unsure'}]).text,text);
  }
  assert.equal(prepare('「的的」').groups.length,0);
});

test('quotes, URLs, code and user terms are excluded before generating options', () => {
  for (const [text,terms] of [
    ['「連載憶起」',[]],['https://example.test/連載憶起',[]],['`連載憶起`',[]],['連載憶起',['連載憶起']],
  ] as [string,string[]][]) assert.deepEqual(prepare(text,terms).groups,[]);
});

test('all dictionary readings are retained; unrelated tones require explicit opt-in', () => {
  assert.deepEqual(new Set(lexicon.readingsFor('行')),new Set(['ㄒㄧㄥˊ','ㄏㄤˊ']));
  const group = prepare('行').groups[0];
  assert.ok(group.options.some(o=>o.text==='型')); assert.ok(group.options.some(o=>o.text==='航'));
  assert.ok(!prepare('段連').groups.some(g=>g.options.some(o=>o.text==='鍛鍊')));
  const loose = new PhoneticLexicon(entries,'fixture',{allowToneChanges:true});
  assert.notEqual(loose.version,lexicon.version);
  assert.ok(prepareParagraph({text:'段連',revision:'r1'},loose).groups.some(g=>g.options.some(o=>o.text==='鍛鍊')));
});

test('bounded candidate groups are disjoint and report truncation', () => {
  const batch=prepare('在。'.repeat(20));
  assert.equal(batch.groups.length,8); assert.equal(batch.truncated,true);
  for(const group of batch.groups) assert.ok(group.options.length<=6);
  assert.throws(()=>prepare('在'.repeat(501)));
});

test('learn then replace or restore remains possible; explicit user edits invalidate the review', () => {
  const batch=prepare('明天在回覆'),group=batch.groups[0];
  const choice={groupId:group.id,optionId:group.options.find(o=>o.text==='再')!.id};
  const review=reviewParagraph(batch,[choice]);
  const learned=learnParagraphChoice(EMPTY_PROFILE,batch,choice,'event-1','user');
  assert.equal(learned.revision,1);
  const restored=changeReviewOption(review,group.id,'keep',{...batch.request,text:review.text});
  assert.equal(restored.text,batch.request.text);
  const changed=changeReviewOption(restored,group.id,choice.optionId,{...batch.request,text:restored.text});
  assert.equal(changed.text,review.text);
  assert.throws(()=>changeReviewOption(review,group.id,'keep',{...batch.request,text:review.text+'新字'}));
  assert.throws(()=>changeReviewOption(review,group.id,'keep',{...batch.request,text:review.text,revision:'other-chat'}));
});

test('all alternatives share the same span even when their lengths differ', () => {
  const batch:CandidateBatch={request:{text:'甲乙丙丁',revision:'r1'},pipelineVersion:'fixture',profileRevision:0,truncated:false,
    groups:[{id:'g0_2',start:0,end:2,original:'甲乙',options:[{id:'keep',text:'甲乙',rankScore:0},{id:'o0',text:'甲',rankScore:1},{id:'o1',text:'乙乙乙',rankScore:0}]},
      {id:'g2_4',start:2,end:4,original:'丙丁',options:[{id:'keep',text:'丙丁',rankScore:0},{id:'o0',text:'丙',rankScore:1}]}]};
  let review=reviewParagraph(batch,[{groupId:'g0_2',optionId:'o0'},{groupId:'g2_4',optionId:'o0'}]);
  assert.equal(review.text,'甲丙');
  review=changeReviewOption(review,'g0_2','o1',{text:review.text,revision:'r1'});
  assert.equal(review.text,'乙乙乙丙');
  review=changeReviewOption(review,'g0_2','keep',{text:review.text,revision:'r1'});
  review=changeReviewOption(review,'g2_4','keep',{text:review.text,revision:'r1'});
  assert.equal(review.text,'甲乙丙丁');
});

test('automatic selections never train; explicit feedback is deduplicated and contains no draft', () => {
  const batch=prepare('明天在回覆'),group=batch.groups[0],choice={groupId:group.id,optionId:'o0'};
  assert.equal(learnParagraphChoice(EMPTY_PROFILE,batch,choice,'auto','automatic'),EMPTY_PROFILE);
  const learned=learnParagraphChoice(EMPTY_PROFILE,batch,choice,'user-1','user');
  assert.equal(learnParagraphChoice(learned,batch,choice,'user-1','user'),learned);
  assert.equal(learned.weights['再'],1);
  assert.ok(!JSON.stringify(learned).includes(batch.request.text));
});

test('pending decisions expire on draft, protection or profile changes', () => {
  const batch=prepare('明天在回覆');
  assert.throws(()=>assertCurrentBatch(batch,{...batch.request,revision:'r2'},0));
  assert.throws(()=>assertCurrentBatch(batch,{...batch.request,protectedTerms:['在']},0));
  assert.throws(()=>assertCurrentBatch(batch,batch.request,1));
});

test('Jev receives the full paragraph and only relevant protection terms', () => {
  const batch=prepare('明天在回覆。補充背景：這是一個未來的動作。',['未出現的私人公司']);
  const payload=createJevChoiceRequest(batch);
  assert.equal(JSON.parse(payload.state).draft,batch.request.text);
  assert.ok(!JSON.stringify(payload).includes('未出現的私人公司'));
  for(const question of Object.values(payload.questions)) {
    assert.ok(question.criteria.keep);assert.ok(question.criteria.unsure);
  }
});

function success(batch:CandidateBatch, choices:Record<string,string>={}) {
  return {model:JEV_MODEL,answers:Object.fromEntries(batch.groups.map(g=>[g.id,{type:'choice',choice:choices[g.id]??'keep'}])),
    usage:{input_tokens:100,output_tokens:1}};
}
test('Jev endpoint/header are fixed, immutable snapshot binds ID to text, stale results rejected',async()=> {
  const original=structuredClone(prepare('明天在回覆')),group=original.groups[0];
  const request=structuredClone(original.request);
  const fetcher:typeof fetch=async(url,init)=> {
    assert.equal(url,JEV_ENDPOINT);assert.equal(init?.redirect,'error');
    assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer dummy-key');
    assert.ok(!String(url).includes('dummy-key'));assert.ok(!String(init?.body).includes('dummy-key'));
    original.groups[0].options[1].text='改';
    return new Response(JSON.stringify(success(original,{[group.id]:'o0'})));
  };
  const result=await selectWithJev(original,'dummy-key',{fetcher});
  assert.equal(reviewJevSelection(result,request,0).text,'明天再回覆');
  assert.throws(()=>reviewJevSelection(result,{...request,text:request.text+'。'},0));
  assert.throws(()=>{result.batch.groups[0].options[1].text='改';});
});

test('unknown IDs, missing answers, model changes and missing usage cannot produce edits',async()=> {
  const batch=prepare('明天在回覆');
  for(const mutate of [
    (r:any)=>{r.answers[batch.groups[0].id].choice='invented';},
    (r:any)=>{r.answers={};},(r:any)=>{r.model='unvalidated-model';},(r:any)=>{delete r.usage;},
  ]) {
    const raw=success(batch);mutate(raw);
    await assert.rejects(selectWithJev(batch,'dummy-key',{fetcher:async()=>new Response(JSON.stringify(raw))}));
  }
  assert.throws(()=>reviewParagraph(batch,[{groupId:batch.groups[0].id,optionId:'invented'}]));
});

test('empty plans are offline; provider failures never echo credential-bearing error details',async()=> {
  let calls=0;
  await selectWithJev(prepare('「在」'),'dummy-key',{fetcher:async()=>{calls++;throw new Error('dummy-key');}});
  assert.equal(calls,0);
  await assert.rejects(selectWithJev(prepare('明天在回覆'),'dummy-key',{
    fetcher:async()=>new Response(JSON.stringify({error:'dummy-key'}),{status:403}),
  }),error=>error instanceof Error&&!error.message.includes('dummy-key'));
});
