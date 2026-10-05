import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';

// This test never reads a provider credential from the environment. The isolated
// profile receives a dummy string only, is offline, and all worker fetches are mocked.
const DUMMY_CREDENTIAL = 'shunzi_lifecycle_DUMMY_NOT_AN_API_KEY';
const localRoot = resolve('.local');
const screenshot = resolve(localRoot, 'lifecycle-options.png');
const extensionPath = resolve('dist/byok');

async function mockWorker(worker: Worker): Promise<void> {
  await worker.evaluate(`globalThis.__lifecycleProviderCalls = 0;
    globalThis.fetch = async function () {
      globalThis.__lifecycleProviderCalls++;
      return new Response(JSON.stringify({
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"edits":[]}' }] } }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 0 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };`);
}

async function launch(profile: string) {
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: true, viewport: { width: 1120, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      '--host-resolver-rules=MAP * ~NOTFOUND', '--disable-background-networking'],
  });
  try {
    await context.setOffline(true);
    await context.route(/^https?:\/\//, route => route.abort('blockedbyclient'));
    const worker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension://')) ??
      await context.waitForEvent('serviceworker', { predicate: item => item.url().startsWith('chrome-extension://'), timeout: 10_000 });
    await mockWorker(worker);
    context.on('serviceworker', next => { void mockWorker(next).catch(() => {}); });
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.locator('#settings-form').waitFor();
    return { context, worker, page, extensionId };
  } catch (error) {
    await context.close();
    throw error;
  }
}

function settings(page: Page) {
  return page.evaluate(() => chrome.runtime.sendMessage({ type: 'shunzi:settings' }));
}
async function assertConfigured(page: Page) {
  const reply = await settings(page);
  assert.equal(reply.ok, true);
  assert.equal(reply.settings.configured, true);
  assert.equal(reply.settings.enabled, true);
  assert.deepEqual(reply.settings.protectedTerms, ['順字測試詞']);
  assert.equal(Object.prototype.hasOwnProperty.call(reply.settings, 'credential'), false);
  assert.equal(JSON.stringify(reply).includes(DUMMY_CREDENTIAL), false);
  assert.equal(await page.locator('#credential').inputValue(), '');
}

async function assertContentStorageIsolation(context: BrowserContext, extensionId: string) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const worlds: { id: number; origin: string; name: string }[] = [];
  cdp.on('Runtime.executionContextCreated', ({ context: world }) => worlds.push(world));
  await cdp.send('Runtime.enable');
  // Supply the host document entirely in memory; no ChatGPT request leaves the browser.
  await page.route('https://chatgpt.com/lifecycle-fixture', route => route.fulfill({ status: 200,
    contentType: 'text/html', body: '<!doctype html><html><body><textarea id="prompt-textarea"></textarea></body></html>' }));
  try {
    await page.goto('https://chatgpt.com/lifecycle-fixture');
    for (let i = 0; i < 100 && !worlds.some(world => world.origin === `chrome-extension://${extensionId}`); i++) await page.waitForTimeout(20);
    const contentWorld = worlds.find(world => world.origin === `chrome-extension://${extensionId}`);
    assert.ok(contentWorld, `Actual extension content-script world missing: ${JSON.stringify(worlds)}`);
    const response = await cdp.send('Runtime.evaluate', { contextId: contentWorld.id, awaitPromise: true, returnByValue: true,
      expression: `(async () => {
        const extensionId = chrome.runtime.id;
        const reply = await chrome.runtime.sendMessage({ type: 'shunzi:settings' });
        let denied = false, hasCredential = false, error = '';
        try { const raw = await chrome.storage.local.get('credential'); hasCredential = typeof raw.credential === 'string'; }
        catch (failure) { denied = true; error = String(failure); }
        return { extensionId, hasStorageApi: typeof chrome.storage.local.get === 'function', denied, hasCredential, error,
          publicConfigured: reply.ok && reply.settings.configured,
          publicHasCredential: reply.settings && Object.prototype.hasOwnProperty.call(reply.settings, 'credential') };
      })()` });
    assert.equal(response.exceptionDetails, undefined);
    const result = response.result.value;
    assert.equal(result.extensionId, extensionId);
    assert.equal(result.hasStorageApi, true, 'This must be the real extension content context, not the web page main world');
    assert.equal(result.publicConfigured, true);
    assert.equal(result.publicHasCredential, false);
    assert.equal(result.denied, true, 'TRUSTED_CONTEXTS must reject a real content-script storage read');
    assert.equal(result.hasCredential, false);
    assert.match(result.error, /access|allowed|denied/i);
  } finally { await cdp.detach(); await page.close(); }
}

test('real unpacked MV3 keeps private settings through worker and browser restarts, then deletes credentials', { timeout: 45_000 }, async () => {
  mkdirSync(localRoot, { recursive: true });
  const profile = mkdtempSync(resolve(localRoot, 'lifecycle-profile-'));
  let context: BrowserContext | undefined;
  try {
    let live = await launch(profile);
    context = live.context;
    assert.match(live.worker.url(), /^chrome-extension:\/\/[a-p]{32}\/background\.js$/);
    assert.equal((await settings(live.page)).settings.configured, false);
    await live.page.locator('#credential').fill(DUMMY_CREDENTIAL);
    await live.page.locator('#protected-terms').fill('順字測試詞');
    await live.page.locator('#enabled').check();
    await live.page.locator('#save').click();
    await live.page.locator('#result').filter({ hasText: '已儲存' }).waitFor();
    await assertConfigured(live.page);
    assert.equal(await live.worker.evaluate('globalThis.__lifecycleProviderCalls'), 0);
    assert.equal(await live.page.evaluate(async () => (await chrome.storage.local.get('credential')).credential), DUMMY_CREDENTIAL);
    await live.page.screenshot({ path: screenshot, fullPage: true });

    // Explicitly stop the real extension service worker, then let a runtime
    // message wake a new worker, exercising the same storage restoration as sleep.
    const session = await live.context.newCDPSession(live.page);
    let versionId: string | undefined;
    const runningStates: string[] = [];
    session.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
      for (const version of versions) if (version.scriptURL === live.worker.url()) {
        versionId = version.versionId; runningStates.push(version.runningStatus);
      }
    });
    await session.send('ServiceWorker.enable');
    for (let i = 0; i < 50 && !versionId; i++) await live.page.waitForTimeout(20);
    assert.ok(versionId, 'CDP must expose the actual extension worker version');
    await session.send('ServiceWorker.stopWorker', { versionId });
    for (let i = 0; i < 50 && !runningStates.includes('stopped'); i++) await live.page.waitForTimeout(20);
    assert.ok(runningStates.includes('stopped'), `Worker did not stop: ${runningStates.join(',')}`);
    const stoppedAt = runningStates.lastIndexOf('stopped');
    await assertConfigured(live.page);
    for (let i = 0; i < 50 && !runningStates.slice(stoppedAt + 1).includes('running'); i++) await live.page.waitForTimeout(20);
    assert.ok(runningStates.slice(stoppedAt + 1).includes('running'), `Worker did not resume: ${runningStates.join(',')}`);
    await session.detach();

    // Closing only this test-owned browser simulates an actual browser restart.
    // Reusing the same private profile must retain storage without exposing it in UI.
    const extensionId = live.extensionId;
    await context.close();
    context = undefined;
    live = await launch(profile);
    context = live.context;
    assert.equal(live.extensionId, extensionId);
    await assertConfigured(live.page);
    await live.page.reload();
    await assertConfigured(live.page);
    await assertContentStorageIsolation(context, extensionId);

    // Reload the extension itself (the unpacked-extension update action), not
    // just its options document, and verify persistent storage in its new worker.
    const nextWorker = context.waitForEvent('serviceworker', {
      predicate: worker => worker.url() === `chrome-extension://${extensionId}/background.js`, timeout: 10_000,
    });
    await live.page.evaluate(() => chrome.runtime.reload());
    const reloadedWorker = await nextWorker;
    await mockWorker(reloadedWorker);
    const reloadedOptions = await context.newPage();
    await reloadedOptions.goto(`chrome-extension://${extensionId}/options.html`);
    await reloadedOptions.locator('#settings-form').waitFor();
    live = { ...live, worker: reloadedWorker, page: reloadedOptions };
    await assertConfigured(live.page);
    assert.equal(await live.page.evaluate(async () => (await chrome.storage.local.get('credential')).credential), DUMMY_CREDENTIAL);
    await live.page.locator('#clear').click();
    await live.page.locator('#result').filter({ hasText: '已移除' }).waitFor();
    const cleared = await settings(live.page);
    assert.equal(cleared.settings.configured, false);
    assert.equal(cleared.settings.enabled, false);
    assert.deepEqual(await live.page.evaluate(() => chrome.storage.local.get('credential')), {});
    assert.equal(await live.worker.evaluate('globalThis.__lifecycleProviderCalls'), 0);
    await live.page.reload();
    assert.equal((await settings(live.page)).settings.configured, false);
    assert.equal(await live.page.locator('#enabled').isChecked(), false);
  } finally {
    await context?.close();
    const checked = resolve(profile);
    assert.ok(checked.startsWith(`${localRoot}${sep}lifecycle-profile-`), 'Only delete the task-owned temporary profile');
    rmSync(checked, { recursive: true, force: true });
  }
});
