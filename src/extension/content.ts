import { MAX_CHARACTERS, type CorrectionEdit } from '../core/types';
import { isTextArea, replaceRange, snapshot, textRange, type EditorElement } from './dom';
import { runtimeMessage, type Message, type PublicSettings, type Reply } from './protocol';
import policy from '../core/policy.json';

type Send = (message: Message) => Promise<Reply>;
interface RecordEdit { edit: CorrectionEdit; start: number; end: number; current: string; applied: boolean }
interface ControllerOptions { send?: Send; debounceMs?: number }
const signature = (edit: CorrectionEdit) => `${edit.original}\u0000${edit.replacement}`;
const overlayStyle = `
:host{all:initial;font-family:"Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif;font-size:13px;color:#25334a;color-scheme:light}
*{box-sizing:border-box}button{font:inherit;cursor:pointer}button:focus-visible{outline:2px solid #386bcc;outline-offset:3px}
.status{position:fixed;display:flex;align-items:center;gap:3px;border:1px solid #dce3ec;border-radius:7px;background:#fff;box-shadow:0 2px 9px #1428440d;padding:2px;z-index:2;max-width:calc(100vw - 24px)}.status .brand{max-width:min(340px,calc(100vw - 140px));overflow:hidden;text-overflow:ellipsis}
.status button{border:0;background:transparent;color:#4b5b72;border-radius:4px;padding:5px 8px;white-space:nowrap}.status button:hover{background:#f0f4fa}.status .brand{color:#244b85}
.marker{position:fixed;padding:0;border:0;border-bottom:2px solid #386bcc;background:#527fdb16;border-radius:1px;pointer-events:auto;min-width:5px}.marker.applied{border-color:#32916e;background:#32916e12}
.menu{position:fixed;width:260px;max-width:calc(100vw - 24px);border:1px solid #d9e1eb;border-radius:10px;background:#fff;box-shadow:0 8px 30px #162c4924;z-index:3;padding:14px;pointer-events:auto}
.menu h2{font-size:12px;color:#63738a;font-weight:500;letter-spacing:.06em;margin:0 0 10px}.menu p{margin:0 0 12px;font-size:13px;line-height:1.6;overflow-wrap:anywhere}.menu .from{color:#6b7788;text-decoration:line-through}.menu .to{font-weight:650;color:#244b85}.choices{display:grid;gap:4px;margin-bottom:8px}.choices button{text-align:left;border:0;background:#f2f5f9;padding:9px 11px;border-radius:5px;color:#223a5c}.choices button:hover{background:#e8effa}.actions{display:flex;gap:6px;border-top:1px solid #e8ecf1;padding-top:9px}.actions button{border:0;background:none;padding:5px 3px;color:#52657e;font-size:12px}.actions button:hover{color:#244b85;text-decoration:underline}.hint{margin:9px 0 0!important;font-size:11px!important;color:#7a889a}.sr{position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden}
`;

function makeButton(text: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = text; button.addEventListener('click', action);
  return button;
}

/** Owns only its shadow overlay; the host's rich-text tree is edited through native insertion. */
export function createController(editor: EditorElement, options: ControllerOptions = {}) {
  const send = options.send ?? runtimeMessage;
  const pageHref = location.href;
  const host = document.createElement('div');
  host.dataset.shunzi = 'overlay';
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '2147483000', pointerEvents: 'none' });
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = overlayStyle;
  const marks = document.createElement('div');
  const status = document.createElement('div'); status.className = 'status'; status.style.pointerEvents = 'auto';
  const badge = makeButton('順字', () => records.length ? openMenu(records[0]) : void send({ type: 'shunzi:open-options' }));
  badge.className = 'brand'; badge.title = '校對建議（Alt + ↓）';
  const settingsButton = makeButton('設定', () => { void send({ type: 'shunzi:open-options' }); });
  const pauseButton = makeButton('暫停', () => { void setEnabled(!settings.enabled); });
  const announcement = document.createElement('span'); announcement.className = 'sr'; announcement.setAttribute('role', 'status');
  status.append(badge, pauseButton, settingsButton); root.append(style, marks, status, announcement); document.documentElement.append(host);
  let settings: PublicSettings = { mode: 'byok', enabled: false, configured: false, protectedTerms: [] };
  let records: RecordEdit[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0, composing = false, applying = false, destroyed = false, busy = false;
  let lastText = snapshot(editor).text;
  let menu: HTMLElement | undefined;
  let activeRecord: RecordEdit | undefined;
  const suppressed = new Set<string>();
  let raf = 0;

  function label(text: string) { badge.textContent = text; badge.title = `${text}（Alt + ↓ 查看建議）`; announcement.textContent = text; }
  function idleLabel() {
    pauseButton.textContent = settings.enabled ? '暫停' : '開啟'; pauseButton.disabled = !settings.configured;
    if (!settings.configured) label('順字 · 尚未連線');
    else if (!settings.enabled) label('順字 · 已暫停');
    else if (records.length) label(`順字 · ${records.length} 處可檢查`);
    else label(policy.autoCategories.length ? '順字' : '順字 · 建議試驗');
  }
  function closeMenu(focus = false) {
    menu?.remove(); menu = undefined; activeRecord = undefined;
    badge.setAttribute('aria-expanded', 'false');
    if (focus) editor.focus({ preventScroll: true });
  }

  // A textarea needs a measurement mirror, because DOM Ranges cannot address its value.
  // The mirror is inert, contains only this draft, and never replaces the host input.
  function rects(record: RecordEdit): DOMRect[] {
    if (!isTextArea(editor)) return Array.from(textRange(editor, record.start, record.end)?.getClientRects() ?? []);
    const bounds = editor.getBoundingClientRect(), computed = getComputedStyle(editor);
    const mirror = document.createElement('div');
    for (const property of ['font', 'line-height', 'letter-spacing', 'padding', 'border-width', 'box-sizing', 'word-break', 'overflow-wrap', 'text-indent', 'tab-size']) mirror.style.setProperty(property, computed.getPropertyValue(property));
    Object.assign(mirror.style, { position: 'fixed', top: `${bounds.top - editor.scrollTop}px`, left: `${bounds.left - editor.scrollLeft}px`,
      width: `${bounds.width}px`, height: 'auto', whiteSpace: 'pre-wrap', visibility: 'hidden', pointerEvents: 'none', borderStyle: 'solid' });
    const span = document.createElement('span'); span.textContent = editor.value.slice(record.start, record.end);
    mirror.append(document.createTextNode(editor.value.slice(0, record.start)), span, document.createTextNode(editor.value.slice(record.end) || '\u200b'));
    root.append(mirror);
    const result = Array.from(span.getClientRects()); mirror.remove(); return result;
  }
  function positionMenu(record: RecordEdit) {
    if (!menu) return;
    const anchor = rects(record)[0] ?? editor.getBoundingClientRect();
    const height = menu.getBoundingClientRect().height;
    const top = anchor.bottom + height + 10 < innerHeight ? anchor.bottom + 8 : Math.max(8, anchor.top - height - 8);
    menu.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - 272))}px`;
    menu.style.top = `${top}px`;
  }
  function render() {
    if (destroyed) return;
    marks.replaceChildren();
    const bounds = editor.getBoundingClientRect();
    status.hidden = !editor.isConnected || bounds.width === 0;
    status.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - 230))}px`;
    status.style.top = `${Math.max(8, Math.min(bounds.top - 35, innerHeight - 40))}px`;
    for (const record of records) {
      for (const rect of rects(record)) {
        if (!rect.width || rect.bottom < bounds.top || rect.top > bounds.bottom) continue;
        const mark = makeButton('', () => openMenu(record));
        mark.className = `marker${record.applied ? ' applied' : ''}`;
        mark.tabIndex = -1; mark.setAttribute('aria-label', `檢查「${record.current}」`);
        const left = Math.max(rect.left, bounds.left), right = Math.min(rect.right, bounds.right);
        if (right <= left) continue;
        Object.assign(mark.style, { left: `${left}px`, top: `${Math.max(rect.top, bounds.top)}px`, width: `${right - left}px`, height: `${Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top)}px` });
        marks.append(mark);
      }
    }
    if (activeRecord) positionMenu(activeRecord);
  }
  function requestRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

  function change(record: RecordEdit, replacement: string, restore = false) {
    if (composing || destroyed || location.href !== pageHref || snapshot(editor).text.slice(record.start, record.end) !== record.current) { closeMenu(); return; }
    generation++; clearTimeout(timer);
    applying = true;
    const previousEnd = record.end;
    const changed = replaceRange(editor, record.start, record.end, record.current, replacement);
    applying = false;
    if (!changed) {
      records = []; closeMenu(); lastText = snapshot(editor).text;
      label('順字 · 無法安全套用，請手動修改'); render(); return;
    }
    const shift = replacement.length - (record.end - record.start);
    for (const other of records) if (other !== record && other.start >= previousEnd) { other.start += shift; other.end += shift; }
    record.current = replacement; record.end = record.start + replacement.length; record.applied = replacement !== record.edit.original;
    lastText = snapshot(editor).text;
    if (restore) {
      suppressed.add(signature(record.edit)); records = records.filter(item => item !== record);
    }
    closeMenu(); idleLabel(); render();
  }
  function openMenu(record: RecordEdit) {
    if (composing || !records.includes(record)) return;
    closeMenu(); activeRecord = record;
    menu = document.createElement('section'); menu.className = 'menu'; menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-label', '順字校對建議');
    const heading = document.createElement('h2'); heading.textContent = record.applied ? '已調整 · 仍可還原' : '有一個地方可以看看';
    const comparison = document.createElement('p');
    const from = document.createElement('span'); from.className = 'from'; from.textContent = record.edit.original;
    const to = document.createElement('span'); to.className = 'to'; to.textContent = record.edit.replacement;
    comparison.append(from, document.createTextNode(' → '), to);
    const reason = document.createElement('p'); reason.textContent = record.edit.reason;
    const choices = document.createElement('div'); choices.className = 'choices';
    for (const candidate of [...new Set([record.edit.replacement, ...record.edit.alternatives])]) {
      if (candidate !== record.current) choices.append(makeButton(candidate, () => change(record, candidate)));
    }
    const actions = document.createElement('div'); actions.className = 'actions';
    actions.append(makeButton(record.applied ? '還原原文' : '保留原文', () => record.applied ? change(record, record.edit.original, true) : dismiss(record)));
    actions.append(makeButton('記住原詞', () => { void remember(record); }));
    const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = '↑ ↓ 選擇 · Esc 關閉';
    menu.append(heading, comparison, reason, choices, actions, hint); root.append(menu);
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const buttons = Array.from(menu?.querySelectorAll('button') ?? []);
        const current = buttons.indexOf(root.activeElement as HTMLButtonElement);
        buttons[(current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
      // Enter is the browser's normal focused-button activation, never captured on the editor.
    });
    badge.setAttribute('aria-expanded', 'true'); positionMenu(record); menu.querySelector('button')?.focus({ preventScroll: true });
  }
  function dismiss(record: RecordEdit) {
    suppressed.add(signature(record.edit)); records = records.filter(item => item !== record);
    closeMenu(true); idleLabel(); render();
  }
  async function remember(record: RecordEdit) {
    const response = await send({ type: 'shunzi:remember', term: record.edit.original });
    if (destroyed) return;
    if (!response.ok) { label(`順字 · ${response.error.message}`); closeMenu(); return; }
    if ('settings' in response) settings = response.settings;
    if (record.applied) change(record, record.edit.original, true); else dismiss(record);
    label('順字 · 已記住原詞');
  }

  function validEdits(value: unknown, text: string): CorrectionEdit[] {
    if (!Array.isArray(value) || value.length > 12) return [];
    const edits = value.filter((e): e is CorrectionEdit => !!e && typeof e === 'object' &&
      Number.isInteger(e.start) && Number.isInteger(e.end) && e.start >= 0 && e.end > e.start && e.end <= text.length &&
      typeof e.original === 'string' && text.slice(e.start, e.end) === e.original &&
      typeof e.replacement === 'string' && e.replacement.length > 0 && e.replacement.length <= 64 && !/[\r\n<>\u0000-\u001f]/.test(e.replacement) &&
      Array.isArray(e.alternatives) && e.alternatives.length <= 2 && e.alternatives.every((a: unknown) => typeof a === 'string' && a.length > 0 && a.length <= 64 && !/[\r\n<>\u0000-\u001f]/.test(a)) &&
      ['auto', 'suggest'].includes(e.action) && typeof e.reason === 'string' && e.reason.length <= 160);
    return edits.filter((e, i) => !suppressed.has(signature(e)) && !edits.some((other, j) => i !== j && e.start < other.end && e.end > other.start));
  }
  async function check(version: number) {
    if (destroyed || composing || location.href !== pageHref || !editor.isConnected || !settings.enabled || !settings.configured || generation !== version) return;
    if (busy) { timer = setTimeout(() => { void check(version); }, 150); return; }
    const text = snapshot(editor).text;
    if (!text.trim()) { records = []; suppressed.clear(); closeMenu(); idleLabel(); render(); return; }
    if ([...text].length > MAX_CHARACTERS) { records = []; closeMenu(); label('順字 · 超過 500 字元，略過'); render(); return; }
    const revision = `${Date.now().toString(36)}-${version}`;
    busy = true; label('順字 · 校對中');
    let response: Reply;
    try { response = await send({ type: 'shunzi:check', request: { text, revision } }); }
    catch { response = { ok: false, error: { code: 'UNAVAILABLE', message: '這次無法校對，原文已保留。' } }; }
    busy = false;
    if (destroyed || composing || location.href !== pageHref || generation !== version || snapshot(editor).text !== text || !editor.isConnected) return;
    if (!response.ok) { label(`順字 · ${response.error.message}`); return; }
    if (!('response' in response) || response.response.revision !== revision) { idleLabel(); return; }
    if (response.response.status !== 'ok') { label(response.response.status === 'paused' ? '順字 · 已暫停' : '順字 · 這段先保留原文'); return; }
    const proposed = validEdits(response.response.edits, text).filter(edit => !records.some(record => edit.start < record.end && edit.end > record.start));
    records.push(...proposed.map(edit => ({ edit, start: edit.start, end: edit.end, current: edit.original, applied: false })));
    for (const record of [...records].sort((a, b) => b.start - a.start)) {
      if (!record.applied && record.edit.action === 'auto' && document.activeElement === editor) change(record, record.edit.replacement);
    }
    records.sort((a, b) => a.start - b.start); lastText = snapshot(editor).text; idleLabel(); render();
  }
  function queue() {
    clearTimeout(timer); generation++;
    if (!composing) { const version = generation; timer = setTimeout(() => { void check(version); }, options.debounceMs ?? 600); }
  }
  function onInput(event: Event) {
    if (applying) return;
    const text = snapshot(editor).text;
    if (event instanceof InputEvent && event.inputType === 'historyUndo') {
      for (const record of records) if (record.applied) suppressed.add(signature(record.edit));
      records = [];
    } else {
      let start = 0, beforeEnd = lastText.length, afterEnd = text.length;
      while (start < beforeEnd && start < afterEnd && lastText[start] === text[start]) start++;
      while (beforeEnd > start && afterEnd > start && lastText[beforeEnd - 1] === text[afterEnd - 1]) { beforeEnd--; afterEnd--; }
      const shift = afterEnd - beforeEnd;
      records = records.filter(record => {
        if (beforeEnd <= record.start) { record.start += shift; record.end += shift; return true; }
        if (start >= record.end) return true;
        if (record.applied && text.includes(record.edit.original)) suppressed.add(signature(record.edit));
        return false;
      });
    }
    if (!text.trim()) { records = []; suppressed.clear(); }
    lastText = text; closeMenu(); idleLabel(); render(); queue();
  }
  function compositionStart() { composing = true; clearTimeout(timer); generation++; closeMenu(); marks.replaceChildren(); }
  function compositionEnd() { composing = false; onInput(new Event('input')); }
  function keydown(value: Event) {
    const event = value as KeyboardEvent;
    if (!composing && event.altKey && event.key === 'ArrowDown' && records.length) { event.preventDefault(); openMenu(records[0]); }
  }
  function outside(event: Event) { if (!event.composedPath().includes(host)) closeMenu(); }
  async function setEnabled(enabled: boolean) {
    pauseButton.disabled = true;
    const response = await send({ type: 'shunzi:set-enabled', enabled });
    if (destroyed) return;
    if (!response.ok) { label(`順字 · ${response.error.message}`); pauseButton.disabled = false; return; }
    if ('settings' in response) settings = response.settings;
    generation++; clearTimeout(timer); records = []; closeMenu(); idleLabel(); render();
    if (settings.enabled) queue();
  }
  async function refreshSettings() {
    const response = await send({ type: 'shunzi:settings' });
    if (destroyed) return;
    const previous = JSON.stringify([settings.enabled, settings.configured, settings.protectedTerms]);
    if (response.ok && 'settings' in response) settings = response.settings;
    if (!settings.enabled || !settings.configured) { generation++; clearTimeout(timer); records = []; closeMenu(); }
    idleLabel(); render();
    if (previous !== JSON.stringify([settings.enabled, settings.configured, settings.protectedTerms]) && settings.enabled && settings.configured && snapshot(editor).text.trim()) queue();
  }
  editor.addEventListener('input', onInput);
  editor.addEventListener('compositionstart', compositionStart);
  editor.addEventListener('compositionend', compositionEnd);
  editor.addEventListener('keydown', keydown);
  editor.addEventListener('scroll', requestRender);
  document.addEventListener('pointerdown', outside);
  window.addEventListener('scroll', requestRender, true); window.addEventListener('resize', requestRender);
  const resize = new ResizeObserver(requestRender); resize.observe(editor);
  void refreshSettings();
  return {
    refreshSettings,
    destroy() {
      destroyed = true; generation++; clearTimeout(timer); cancelAnimationFrame(raf); resize.disconnect(); host.remove();
      editor.removeEventListener('input', onInput); editor.removeEventListener('compositionstart', compositionStart); editor.removeEventListener('compositionend', compositionEnd);
      editor.removeEventListener('keydown', keydown); editor.removeEventListener('scroll', requestRender); document.removeEventListener('pointerdown', outside);
      window.removeEventListener('scroll', requestRender, true); window.removeEventListener('resize', requestRender);
    },
  };
}

const currentComposerSelector = '[data-composer-input] [data-composer-markdown][contenteditable="true"][role="textbox"]';
const legacyComposerSelector = '#prompt-textarea[contenteditable="true"], textarea#prompt-textarea';

function visibleEditor(element: EditorElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  if (isTextArea(element) && (element.disabled || element.readOnly)) return false;
  const bounds = element.getBoundingClientRect();
  if (!bounds.width || !bounds.height || bounds.bottom <= 0 || bounds.right <= 0 || bounds.top >= innerHeight || bounds.left >= innerWidth) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
  }
  return true;
}

/** Prefer the observed composer markup; a unique visible target is mandatory. */
export function findChatGPTEditor(): EditorElement | null {
  const candidates = [...document.querySelectorAll<EditorElement>(currentComposerSelector),
    ...document.querySelectorAll<EditorElement>(legacyComposerSelector)];
  const visible = [...new Set(candidates)].filter(visibleEditor);
  return visible.length === 1 ? visible[0] : null;
}

export function startChatGPTAdapter(options: ControllerOptions = {}) {
  let editor: EditorElement | null = null;
  let controller: ReturnType<typeof createController> | null = null;
  let href = location.href;
  const scan = () => {
    const found = findChatGPTEditor();
    if (found === editor && href === location.href) return;
    href = location.href;
    controller?.destroy(); editor = found; controller = found ? createController(found, options) : null;
  };
  const observer = new MutationObserver(scan);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['hidden', 'inert', 'aria-hidden', 'class', 'style', 'contenteditable', 'role', 'id', 'data-composer-input', 'data-composer-markdown', 'disabled', 'readonly'] });
  scan();
  // Visibility can also change through responsive CSS/animation without a DOM mutation.
  const navigation = setInterval(scan, 500);
  window.addEventListener('popstate', scan);
  window.addEventListener('resize', scan);
  // Fetch only public settings when returning from options; never subscribe to credential changes.
  const focus = () => { void controller?.refreshSettings(); };
  const visibility = () => { if (!document.hidden) focus(); };
  window.addEventListener('focus', focus);
  document.addEventListener('visibilitychange', visibility);
  return () => { clearInterval(navigation); observer.disconnect(); controller?.destroy(); window.removeEventListener('popstate', scan); window.removeEventListener('resize', scan); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', visibility); };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && location.origin === 'https://chatgpt.com') startChatGPTAdapter();
