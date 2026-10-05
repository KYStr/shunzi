import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';

let browser: Browser, bundle: string;
before(async () => {
  const result = await build({ stdin: { contents: "export {createController,startChatGPTAdapter,findChatGPTEditor} from './src/extension/content'; export {snapshot,replaceRange} from './src/extension/dom';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'iife', globalName: 'ShunziTest', platform: 'browser', target: 'chrome120' });
  bundle = result.outputFiles[0].text;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
});
after(async () => { await browser?.close(); });

async function fixture({ textarea = false, auto = false, deferred = false, debounceMs = 40, html = '' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  await page.setContent(`<html lang="zh-Hant"><style>body{margin:0;font:18px/1.8 Arial}#prompt-textarea{margin:200px 80px 0;padding:20px;border:1px solid #ddd;width:650px;min-height:120px;box-sizing:border-box}p{margin:0}</style>${textarea ? '<textarea id="prompt-textarea"></textarea>' : `<div contenteditable="true" id="prompt-textarea" role="textbox">${html}</div>`}</html>`);
  await page.addScriptTag({ content: bundle });
  // tsx names nested functions in serialized page.evaluate callbacks.
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.evaluate(({ auto, deferred, debounceMs }) => {
    const w = window as any;
    w.requests = []; w.messages = []; w.releases = [];
    w.settings = { mode: 'byok', enabled: true, configured: true, protectedTerms: [] };
    w.reply = (r: any) => {
      const start = r.text.indexOf('連載憶起');
      return { ok: true, response: { revision: r.revision, status: 'ok', edits: start < 0 ? [] : [{ id: 'fixture-edit', start, end: start + 4, original: '連載憶起', replacement: '連在一起', alternatives: ['接在一起'], category: 'word-boundary', action: auto ? 'auto' : 'suggest', reason: '依上下文，這裡是在說接在一起。' }] } };
    };
    w.controller = w.ShunziTest.createController(document.querySelector('#prompt-textarea'), {
      debounceMs,
      send: async (message: any) => {
        w.messages.push(message);
        if (message.type === 'shunzi:settings') return { ok: true, settings: { ...w.settings } };
        if (message.type === 'shunzi:set-enabled') { w.settings.enabled = message.enabled; return { ok: true, settings: { ...w.settings } }; }
        if (message.type === 'shunzi:remember') { w.settings.protectedTerms.push(message.term); return { ok: true, settings: { ...w.settings } }; }
        if (message.type === 'shunzi:check') {
          w.requests.push(message.request);
          if (deferred) return new Promise(resolve => w.releases.push(() => resolve(w.reply(message.request))));
          return w.reply(message.request);
        }
        return { ok: true };
      },
    });
  }, { auto, deferred, debounceMs });
  return page;
}
async function draft(page: Page, text: string, inputType = 'insertText') {
  await page.evaluate(({ text, inputType }) => {
    const editor = document.querySelector('#prompt-textarea') as HTMLElement | HTMLTextAreaElement;
    editor.focus();
    if (editor instanceof HTMLTextAreaElement) editor.value = text; else editor.textContent = text;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data: text }));
  }, { text, inputType });
}
const mark = (page: Page) => page.locator('[data-shunzi] .marker');
const menu = (page: Page) => page.getByRole('dialog', { name: '順字校對建議' });

test('DOM mapping preserves UTF-16 offsets and safely declines rich inline formatting', async () => {
  const page = await fixture({ html: '<p><strong>🙂請</strong><span>連載</span><em>憶起</em></p><p>下一段</p>' });
  try {
    const result = await page.evaluate(() => {
      const w = window as any, editor = document.querySelector('#prompt-textarea') as HTMLElement;
      w.controller.destroy(); editor.focus();
      const before = w.ShunziTest.snapshot(editor).text;
      const changed = w.ShunziTest.replaceRange(editor, 3, 7, '連載憶起', '連在一起');
      return { before, changed, after: w.ShunziTest.snapshot(editor).text, strong: editor.querySelector('strong')?.textContent, paragraphs: editor.querySelectorAll('p').length };
    });
    assert.deepEqual(result, { before: '🙂請連載憶起\n下一段', changed: false, after: '🙂請連載憶起\n下一段', strong: '🙂請', paragraphs: 2 });
    const plain = await page.evaluate(() => {
      const w = window as any, editor = document.querySelector('#prompt-textarea') as HTMLElement;
      editor.innerHTML = '<p>🙂請連載憶起</p><p><strong>保留格式</strong></p>';
      return { changed: w.ShunziTest.replaceRange(editor, 3, 7, '連載憶起', '連在一起'), text: w.ShunziTest.snapshot(editor).text, strong: editor.querySelector('strong')?.textContent };
    });
    assert.deepEqual(plain, { changed: true, text: '🙂請連在一起\n保留格式', strong: '保留格式' });
    await page.evaluate(() => { document.querySelector('#prompt-textarea')!.innerHTML = '<p>一<br><br>二</p><p><br></p><p>三</p>'; });
    assert.equal(await page.evaluate(() => (window as any).ShunziTest.snapshot(document.querySelector('#prompt-textarea')).text), '一\n\n二\n\n三');
  } finally { await page.close(); }
});

test('IME input is untouched and the committed draft waits the full 600 ms debounce', async () => {
  const page = await fixture({ debounceMs: 600 });
  try {
    await page.evaluate(() => {
      const editor = document.querySelector('#prompt-textarea') as HTMLElement;
      editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); editor.textContent = '請連載憶起';
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, inputType: 'insertCompositionText' }));
    });
    await page.waitForTimeout(700); assert.equal(await page.evaluate(() => (window as any).requests.length), 0);
    await page.evaluate(() => document.querySelector('#prompt-textarea')!.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    await page.waitForTimeout(350); assert.equal(await page.evaluate(() => (window as any).requests.length), 0);
    await page.waitForFunction(() => (window as any).requests.length === 1);
    assert.equal(await page.locator('#prompt-textarea').textContent(), '請連載憶起'); assert.ok(await mark(page).count());
  } finally { await page.close(); }
});

test('stale or composition-time responses never change the current draft', async () => {
  const page = await fixture({ auto: true, deferred: true });
  try {
    await draft(page, '請連載憶起'); await page.waitForFunction(() => (window as any).requests.length === 1);
    await draft(page, '這是新的正確草稿');
    await page.evaluate(() => (window as any).releases.shift()());
    await page.waitForTimeout(20); assert.equal(await mark(page).count(), 0);
    assert.equal(await page.locator('#prompt-textarea').textContent(), '這是新的正確草稿');
    await page.waitForFunction(() => (window as any).requests.length === 2);
    await page.evaluate(() => {
      const editor = document.querySelector('#prompt-textarea')!;
      editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      (window as any).releases.shift()();
    });
    await page.waitForTimeout(30); assert.equal(await mark(page).count(), 0);
  } finally { await page.close(); }
});

test('suggestions apply only on selection, remain marked, restore and stay suppressed', async () => {
  const page = await fixture();
  try {
    await draft(page, '請把這些連載憶起'); await mark(page).first().waitFor();
    assert.equal(await page.locator('#prompt-textarea').textContent(), '請把這些連載憶起');
    await page.locator('#prompt-textarea').press('Alt+ArrowDown'); await menu(page).waitFor();
    await mkdir('.local', { recursive: true });
    await page.screenshot({ path: '.local/candidate-preview.png' });
    await menu(page).getByRole('button', { name: '連在一起', exact: true }).click();
    assert.equal(await page.locator('#prompt-textarea').textContent(), '請把這些連在一起');
    assert.ok(await page.locator('[data-shunzi] .marker.applied').count());
    await mark(page).first().click(); await menu(page).getByRole('button', { name: '還原原文' }).click();
    assert.equal(await page.locator('#prompt-textarea').textContent(), '請把這些連載憶起');
    await draft(page, '請把這些連載憶起，謝謝'); await page.waitForTimeout(130);
    assert.equal(await mark(page).count(), 0);
  } finally { await page.close(); }
});

test('native undo suppresses an automatic correction without immediate recorrection', async () => {
  const page = await fixture({ auto: true });
  try {
    await draft(page, '請連載憶起'); await page.waitForFunction(() => document.querySelector('#prompt-textarea')?.textContent === '請連在一起');
    await page.locator('#prompt-textarea').press('Control+z');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#prompt-textarea').textContent(), '請連載憶起'); assert.equal(await mark(page).count(), 0);
  } finally { await page.close(); }
});

test('candidate keyboard navigation, remember term and Enter leave host sending alone', async () => {
  const page = await fixture();
  try {
    await draft(page, '請連載憶起'); await mark(page).first().waitFor();
    const prevented = await page.evaluate(() => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      document.querySelector('#prompt-textarea')!.dispatchEvent(event); return event.defaultPrevented;
    });
    assert.equal(prevented, false);
    await page.locator('#prompt-textarea').press('Alt+ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.querySelector('[data-shunzi]')!.shadowRoot!.activeElement?.textContent), '接在一起');
    await page.keyboard.press('Escape'); assert.equal(await menu(page).count(), 0);
    await page.locator('#prompt-textarea').press('Alt+ArrowDown'); await menu(page).getByRole('button', { name: '記住原詞' }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).settings.protectedTerms), ['連載憶起']);
    assert.equal(await page.locator('#prompt-textarea').textContent(), '請連載憶起'); assert.equal(await mark(page).count(), 0);
  } finally { await page.close(); }
});

test('500 Unicode characters are allowed, larger drafts are skipped and unchanged focus does not rebill', async () => {
  const page = await fixture();
  try {
    await draft(page, '😀'.repeat(500)); await page.waitForFunction(() => (window as any).requests.length === 1);
    await page.evaluate(() => {
      const w = window as any; w.settings.usage = { requests: 1, estimatedTwd: 0.01, unconfirmed: 0 };
      return w.controller.refreshSettings();
    }); await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => (window as any).requests.length), 1);
    await draft(page, '字'.repeat(501)); await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => (window as any).requests.length), 1);
    assert.match(await page.locator('[data-shunzi] .brand').innerText(), /超過 500/);
  } finally { await page.close(); }
});

test('textarea fallback has original-position markers, replacement and native undo', async () => {
  const page = await fixture({ textarea: true });
  try {
    await draft(page, '請連載憶起'); await mark(page).first().waitFor();
    const editorBounds = await page.locator('#prompt-textarea').boundingBox(), markerBounds = await mark(page).first().boundingBox();
    assert.ok(editorBounds && markerBounds && markerBounds.x > editorBounds.x && markerBounds.y >= editorBounds.y);
    await mark(page).first().click(); await menu(page).getByRole('button', { name: '連在一起', exact: true }).click();
    assert.equal(await page.locator('#prompt-textarea').inputValue(), '請連在一起');
    await page.locator('#prompt-textarea').press('Control+z'); await page.waitForTimeout(130);
    assert.equal(await page.locator('#prompt-textarea').inputValue(), '請連載憶起'); assert.equal(await mark(page).count(), 0);
  } finally { await page.close(); }
});

test('changing conversation URL and pausing each invalidate an inflight response', async () => {
  const page = await fixture({ auto: true, deferred: true });
  try {
    await draft(page, '請連載憶起'); await page.waitForFunction(() => (window as any).requests.length === 1);
    await page.evaluate(() => { history.pushState({}, '', '#other-conversation'); (window as any).releases.shift()(); });
    await page.waitForTimeout(80);
    assert.equal(await page.locator('#prompt-textarea').textContent(), '請連載憶起'); assert.equal(await mark(page).count(), 0);
  } finally { await page.close(); }
  const paused = await fixture({ auto: true, deferred: true });
  try {
    await draft(paused, '請連載憶起'); await paused.waitForFunction(() => (window as any).requests.length === 1);
    await paused.getByRole('button', { name: '暫停', exact: true }).click();
    await paused.evaluate(() => (window as any).releases.shift()()); await paused.waitForTimeout(80);
    assert.equal(await paused.locator('#prompt-textarea').textContent(), '請連載憶起'); assert.equal(await mark(paused).count(), 0);
    assert.equal(await paused.getByRole('button', { name: '開啟', exact: true }).count(), 1);
  } finally { await paused.close(); }
});

test('options needs an explicit saved-key test action, shows estimates and clears the secret input', async () => {
  const page = await browser.newPage();
  try {
    const html = (await readFile('src/extension/options.html', 'utf8')).replace('<script type="module" src="options.js"></script>', '');
    await page.setContent(html); await page.addStyleTag({ content: await readFile('src/extension/style.css', 'utf8') });
    await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
    await page.evaluate(() => {
      const w = window as any;
      w.messages = []; w.settings = { mode: 'byok', enabled: false, configured: false, protectedTerms: [], usage: { requests: 0, estimatedTwd: 0, unconfirmed: 0 } };
      w.chrome = w.chrome ?? {};
      w.chrome.runtime = { sendMessage(message: any, callback: (value: any) => void) {
        w.messages.push(message);
        if (message.type === 'shunzi:save-options') { w.settings.configured = !!message.credential || w.settings.configured; w.settings.enabled = message.enabled; w.settings.protectedTerms = message.protectedTerms; }
        if (message.type === 'shunzi:clear-key') { w.settings.configured = false; w.settings.enabled = false; }
        if (message.type === 'shunzi:test-connection') {
          w.settings.usage = { requests: 1, estimatedTwd: 0.01, unconfirmed: 0 };
          callback({ ok: true, response: { revision: 'test', status: 'ok', edits: [] } }); return;
        }
        callback({ ok: true, settings: w.settings });
      } };
    });
    const result = await build({ entryPoints: ['src/extension/options.ts'], bundle: true, write: false, format: 'iife', platform: 'browser', define: { __MODE__: '"byok"' } });
    await page.addScriptTag({ content: result.outputFiles[0].text });
    assert.equal(await page.getByRole('button', { name: '測試連線', exact: true }).isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => (window as any).messages.map((m: any) => m.type)), ['shunzi:settings']);
    await page.getByLabel('Gemini API 金鑰', { exact: true }).fill('fixture-not-a-real-key');
    await page.getByRole('switch', { name: '開啟校對' }).check();
    await page.getByRole('button', { name: '儲存設定', exact: true }).click();
    assert.equal(await page.locator('#credential').inputValue(), '');
    assert.equal(await page.getByRole('button', { name: '測試連線', exact: true }).isEnabled(), true);
    await page.getByRole('button', { name: '測試連線', exact: true }).click();
    assert.match(await page.locator('#result').innerText(), /連線成功/);
    assert.equal(await page.locator('#usage-total').innerText(), '約 NT$0.01');
    assert.match(await page.locator('#usage-help').innerText(), /不是帳單/);
    await page.getByRole('button', { name: '移除金鑰', exact: true }).click();
    assert.equal(await page.getByRole('switch', { name: '開啟校對' }).isChecked(), false);
    assert.equal(await page.getByRole('button', { name: '測試連線', exact: true }).isDisabled(), true);
  } finally { await page.close(); }
});

async function adapterFixture() {
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  await page.setContent('<style>body{margin:80px;font:18px/1.8 Arial}[data-composer-markdown],#prompt-textarea{width:650px;min-height:100px;border:1px solid #ddd;padding:12px}</style><div data-composer-input><div data-composer-input-layout><div data-composer-markdown="" contenteditable="true" role="textbox" aria-multiline="true" class="ProseMirror" aria-label="問問 ChatGPT"></div></div></div>');
  await page.addScriptTag({ content: bundle }); await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.evaluate(() => {
    const w = window as any;
    w.requests = []; w.releases = [];
    w.stopAdapter = w.ShunziTest.startChatGPTAdapter({ debounceMs: 30, send: async (message: any) => {
      if (message.type === 'shunzi:settings') return { ok: true, settings: { mode: 'byok', enabled: true, configured: true, protectedTerms: [] } };
      if (message.type === 'shunzi:check') {
        const request = message.request; w.requests.push(request);
        return new Promise(resolve => w.releases.push(() => resolve({ ok: true, response: { revision: request.revision, status: 'ok', edits: [{
          id: request.revision, start: 1, end: 5, original: '連載憶起', replacement: '連在一起', alternatives: [], category: 'word-boundary', action: 'auto', reason: '固定測試候選',
        }] } })));
      }
      return { ok: true };
    } });
  });
  return page;
}

test('composer adapter mounts without a legacy ID and disconnects old node and URL controllers', async () => {
  const page = await adapterFixture();
  try {
    assert.equal(await page.locator('#prompt-textarea').count(), 0);
    await page.locator('[data-shunzi]').waitFor();
    await page.locator('[data-composer-markdown]').fill('請連載憶起');
    await page.waitForFunction(() => (window as any).requests.length === 1);
    await page.evaluate(() => {
      const w = window as any;
      w.oldEditor = document.querySelector('[data-composer-markdown]'); w.oldOverlay = document.querySelector('[data-shunzi]');
      const replacement = w.oldEditor.cloneNode(false); w.oldEditor.replaceWith(replacement);
    });
    await page.waitForFunction(() => !(window as any).oldOverlay.isConnected && !!document.querySelector('[data-shunzi]'));
    await page.evaluate(() => {
      const w = window as any; w.releases.shift()();
      w.oldEditor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    });
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => (window as any).requests.length), 1);
    assert.equal(await page.locator('[data-composer-markdown]').textContent(), '');
    assert.equal(await mark(page).count(), 0);
    await page.locator('[data-composer-markdown]').fill('請連載憶起');
    await page.waitForFunction(() => (window as any).requests.length === 2);
    await page.evaluate(() => {
      (window as any).oldOverlay = document.querySelector('[data-shunzi]');
      history.pushState({}, '', '#another-conversation');
    });
    await page.waitForFunction(() => !(window as any).oldOverlay.isConnected && !!document.querySelector('[data-shunzi]'));
    await page.waitForFunction(() => (window as any).requests.length === 3);
    await page.evaluate(() => (window as any).releases.shift()()); await page.waitForTimeout(40);
    assert.equal(await page.locator('[data-composer-markdown]').textContent(), '請連載憶起'); assert.equal(await mark(page).count(), 0);
    await page.evaluate(() => (window as any).stopAdapter());
    assert.equal(await page.locator('[data-shunzi]').count(), 0);
  } finally { await page.close(); }
});

test('composer target requires one visible editor, rejects ambiguity and retains legacy fallback', async () => {
  const page = await adapterFixture();
  try {
    await page.locator('[data-shunzi]').waitFor();
    await page.evaluate(() => {
      const parent = document.querySelector('[data-composer-input]')!;
      const hidden = parent.cloneNode(true) as HTMLElement; hidden.hidden = true; hidden.dataset.fixtureHidden = 'true'; document.body.append(hidden);
    });
    assert.equal(await page.locator('[data-shunzi]').count(), 1);
    assert.equal(await page.evaluate(() => (window as any).ShunziTest.findChatGPTEditor()?.hasAttribute('data-composer-markdown')), true);
    await page.evaluate(() => { (document.querySelector('[data-fixture-hidden]') as HTMLElement).hidden = false; });
    await page.waitForFunction(() => !document.querySelector('[data-shunzi]'));
    assert.equal(await page.evaluate(() => (window as any).ShunziTest.findChatGPTEditor()), null);
    await page.evaluate(() => { (document.querySelector('[data-fixture-hidden]') as HTMLElement).style.opacity = '0'; });
    await page.locator('[data-shunzi]').waitFor();
    await page.evaluate(() => {
      document.querySelectorAll('[data-composer-input]').forEach(node => node.remove());
      const legacy = document.createElement('textarea'); legacy.id = 'prompt-textarea'; document.body.append(legacy);
    });
    await page.waitForFunction(() => (window as any).ShunziTest.findChatGPTEditor()?.tagName === 'TEXTAREA');
    await page.locator('[data-shunzi]').waitFor();
    await page.evaluate(() => { (document.querySelector('#prompt-textarea') as HTMLTextAreaElement).readOnly = true; });
    await page.waitForFunction(() => !document.querySelector('[data-shunzi]'));
    await page.evaluate(() => (window as any).stopAdapter());
  } finally { await page.close(); }
});
