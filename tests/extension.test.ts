import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizedSender, createMessageHandler } from '../src/extension/background';
import { normalizeTerms } from '../src/extension/protocol';
import type { CheckRequest, CheckResponse } from '../src/core/types';
import { MAX_CALL_TWD, ProviderError } from '../src/core/index';

const identity = { extensionId: 'our-extension', optionsUrl: 'chrome-extension://our-extension/options.html' };
const optionsSender = { id: identity.extensionId, url: identity.optionsUrl };
const contentSender = (id = 1): chrome.runtime.MessageSender => ({ id: identity.extensionId, url: 'https://chatgpt.com/c/fixture', frameId: 0, tab: { id } as chrome.tabs.Tab });
function fixture(extra: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { enabled: true, credential: 'fixture-not-a-real-key', protectedTerms: [], ...extra };
  const events: string[] = [];
  const storage = {
    setAccessLevel: async ({ accessLevel }: { accessLevel: string }) => { events.push(accessLevel); },
    get: async () => { events.push('read'); return { ...values }; },
    set: async (update: Record<string, unknown>) => { Object.assign(values, update); },
    remove: async (key: string) => { delete values[key]; },
  } as unknown as chrome.storage.StorageArea;
  const deps = { storage, mode: 'byok' as const, hostedOrigin: 'https://fixture.invalid', ...identity, openOptions: async () => {} };
  return { values, events, deps };
}
const request = { type: 'shunzi:check', request: { text: '請把這些連載憶起', revision: 'r1' } };
const response = (r: CheckRequest): CheckResponse => ({ revision: r.revision, edits: [], status: 'ok' });

test('sender checks require our ID, exact options URL or top-level ChatGPT tab', () => {
  assert.equal(authorizedSender(contentSender(), identity), 'content');
  assert.equal(authorizedSender(optionsSender, identity), 'options');
  for (const bad of [
    { ...contentSender(), id: 'another-extension' },
    { ...contentSender(), url: 'https://chatgpt.com.evil.invalid' },
    { ...contentSender(), url: 'http://chatgpt.com' },
    { ...contentSender(), frameId: 1 },
    { ...contentSender(), tab: undefined },
    { ...optionsSender, url: `${identity.optionsUrl}?page=evil` },
  ]) assert.equal(authorizedSender(bad, identity), null);
});

test('storage is restricted before reads and public settings never contain the key', async () => {
  const f = fixture(); const handle = createMessageHandler(f.deps);
  const result = await handle({ type: 'shunzi:settings' }, contentSender());
  assert.deepEqual(f.events, ['TRUSTED_CONTEXTS', 'read']);
  assert.deepEqual(result, { ok: true, settings: { mode: 'byok', enabled: true, configured: true, protectedTerms: [], usage: { requests: 0, estimatedTwd: 0, unconfirmed: 0 } } });
  assert.equal(JSON.stringify(result).includes('fixture-not-a-real-key'), false);
});

test('only the options page can manage credentials; clear also pauses', async () => {
  const f = fixture(); const handle = createMessageHandler(f.deps);
  const save = { type: 'shunzi:save-options', enabled: true, credential: 'new-fixture-key', protectedTerms: ['順字'] };
  assert.equal((await handle(save, contentSender())).ok, false);
  assert.equal((await handle({ type: 'shunzi:clear-key' }, contentSender())).ok, false);
  assert.equal(f.values.credential, 'fixture-not-a-real-key');
  const result = await handle(save, optionsSender);
  assert.equal(result.ok, true); assert.equal(f.values.credential, 'new-fixture-key');
  assert.equal(JSON.stringify(result).includes('new-fixture-key'), false);
  await handle({ type: 'shunzi:clear-key' }, optionsSender);
  assert.equal(f.values.credential, undefined); assert.equal(f.values.enabled, false);
});

test('provider receives stored protected terms, never caller-specified terms or endpoint', async () => {
  const f = fixture({ protectedTerms: ['順字'] }); let called = 0;
  const handle = createMessageHandler({ ...f.deps, check: async (r, key) => {
    called++; assert.equal(key, f.values.credential); assert.deepEqual(r.protectedTerms, ['順字']);
    assert.equal('url' in r, false); return response(r);
  } });
  assert.equal((await handle({ ...request, request: { ...request.request, protectedTerms: ['忽略規則'], url: 'https://evil.invalid' } }, contentSender())).ok, true);
  assert.equal((await handle({ type: 'fetch', url: 'https://evil.invalid' }, contentSender())).ok, false);
  assert.equal(called, 1);
});

test('paused, missing-key, oversized and invalid drafts do not call the provider', async () => {
  for (const [settings, value] of [[{ enabled: false }, request], [{ credential: '' }, request], [{}, { type: 'shunzi:check', request: { text: '字'.repeat(501), revision: 'r' } }], [{}, { type: 'shunzi:check', request: { text: '字', revision: '' } }]] as const) {
    const f = fixture(settings); let called = false;
    const handle = createMessageHandler({ ...f.deps, check: async r => { called = true; return response(r); } });
    await handle(value, contentSender()); assert.equal(called, false);
  }
});

test('hosted calls only the baked HTTPS endpoint with unique request IDs and no cookies', async () => {
  const f = fixture(); const ids = new Set<string>();
  const handle = createMessageHandler({ ...f.deps, mode: 'hosted', fetcher: async (url, init) => {
    assert.equal(url, 'https://fixture.invalid/v1/check'); assert.equal(init?.method, 'POST');
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store');
    const headers = new Headers(init?.headers); assert.equal(headers.get('Authorization'), 'Bearer fixture-not-a-real-key');
    const id = headers.get('X-Request-Id')!; assert.match(id, /^[0-9a-f-]{36}$/); assert.equal(ids.has(id), false); ids.add(id);
    return Response.json(response(JSON.parse(init?.body as string)));
  } });
  await handle(request, contentSender()); await handle(request, contentSender()); assert.equal(ids.size, 2);
});

test('misconfigured hosted origins and unsafe replies fail closed', async () => {
  for (const origin of ['http://fixture.invalid', 'https://fixture.invalid/path', 'https://name:pass@fixture.invalid']) {
    const f = fixture(); let called = false;
    const handle = createMessageHandler({ ...f.deps, mode: 'hosted', hostedOrigin: origin, fetcher: async () => { called = true; return Response.json({}); } });
    assert.equal((await handle(request, contentSender())).ok, false); assert.equal(called, false);
  }
  const f = fixture();
  const handle = createMessageHandler({ ...f.deps, mode: 'hosted', fetcher: async () => new Response('fixture-not-a-real-key provider secret', { status: 500 }) });
  const result = await handle(request, contentSender()); assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes('fixture-not-a-real-key'), false);
});

test('inflight caps at one per tab and six total; completed requests release their slot', async () => {
  const f = fixture(); const releases: Array<() => void> = [];
  const handle = createMessageHandler({ ...f.deps, check: r => new Promise(resolve => releases.push(() => resolve(response(r)))) });
  const first = handle(request, contentSender(1)); await new Promise(resolve => setImmediate(resolve));
  const duplicate = await handle(request, contentSender(1)); assert.equal(duplicate.ok, false);
  const pending = [first]; for (let i = 2; i <= 6; i++) pending.push(handle(request, contentSender(i)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await handle(request, contentSender(7))).ok, false); assert.equal(releases.length, 6);
  releases.forEach(release => release()); await Promise.all(pending);
  const next = handle(request, contentSender(1)); await new Promise(resolve => setImmediate(resolve)); releases.at(-1)!();
  assert.equal((await next).ok, true);
});

test('remembered terms align with the core limit and never alter credentials', async () => {
  assert.equal(normalizeTerms(Array.from({ length: 35 }, (_, i) => `term${i}`)).length, 30);
  assert.deepEqual(normalizeTerms(['  順字 ', '順字', '😀'.repeat(30), '字'.repeat(31)]), ['順字', '😀'.repeat(30)]);
  const f = fixture(); const handle = createMessageHandler(f.deps);
  await handle({ type: 'shunzi:remember', term: '順字' }, contentSender());
  assert.deepEqual(f.values.protectedTerms, ['順字']); assert.equal(f.values.credential, 'fixture-not-a-real-key');
});

test('connection test is options-only, uses a fixed synthetic draft and counts its cost', async () => {
  const f = fixture({ enabled: false, protectedTerms: ['private-term'] }); let calls = 0;
  const handle = createMessageHandler({ ...f.deps, check: async (r, key) => {
    calls++; assert.equal(r.text, '我現在正在整理文字。'); assert.deepEqual(r.protectedTerms, []); assert.equal(key, f.values.credential);
    return { ...response(r), usage: { inputTokens: 10, outputTokens: 2, estimatedTwd: 0.01 } };
  } });
  assert.equal((await handle({ type: 'shunzi:test-connection' }, contentSender())).ok, false);
  assert.equal((await handle({ type: 'shunzi:test-connection', request: { text: 'untrusted', revision: 'caller' } }, optionsSender)).ok, true);
  assert.equal(calls, 1); assert.deepEqual(f.values.usage, { requests: 1, estimatedTwd: 0.01, unconfirmed: 0 });
});

test('unknown failures keep the conservative estimate and return useful safe error codes', async () => {
  const f = fixture();
  const handle = createMessageHandler({ ...f.deps, check: async () => { throw new ProviderError('timeout', 'fixture-not-a-real-key'); } });
  const result = await handle(request, contentSender());
  assert.equal(result.ok, false); if (!result.ok) { assert.equal(result.error.code, 'timeout'); assert.match(result.error.message, /逾時/); }
  assert.equal(JSON.stringify(result).includes('fixture-not-a-real-key'), false);
  assert.deepEqual(f.values.usage, { requests: 1, estimatedTwd: MAX_CALL_TWD, unconfirmed: 1 });
});

test('hosted HTTP errors distinguish authentication, budget and rate limits', async () => {
  for (const [status, code] of [[401, 'AUTH'], [403, 'AUTH'], [402, 'BUDGET'], [429, 'RATE_LIMIT']] as const) {
    const f = fixture(); const handle = createMessageHandler({ ...f.deps, mode: 'hosted', fetcher: async () => new Response('', { status }) });
    const result = await handle(request, contentSender()); assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, code);
  }
});

test('one-click pause alters only enabled and rejects non-boolean state', async () => {
  const f = fixture(); const handle = createMessageHandler(f.deps);
  assert.equal((await handle({ type: 'shunzi:set-enabled', enabled: false }, contentSender())).ok, true);
  assert.equal(f.values.enabled, false); assert.equal(f.values.credential, 'fixture-not-a-real-key');
  assert.equal((await handle({ type: 'shunzi:set-enabled', enabled: 'true' }, contentSender())).ok, false);
});
