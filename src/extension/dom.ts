export type EditorElement = HTMLElement | HTMLTextAreaElement;
interface Position { node: Node; offset: number }
interface Piece { start: number; end: number; startPoint: Position; endPoint: Position; textNode?: Text }
export interface TextSnapshot { text: string; pieces: Piece[] }
const blocks = new Set(['DIV', 'P', 'LI', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

export function isTextArea(editor: EditorElement): editor is HTMLTextAreaElement {
  return editor.tagName === 'TEXTAREA';
}

/** Offsets are UTF-16, including one newline between editable blocks. */
export function snapshot(editor: EditorElement): TextSnapshot {
  if (isTextArea(editor)) return { text: editor.value, pieces: [] };
  let text = '';
  const pieces: Piece[] = [];
  const newline = (point: Position) => {
    pieces.push({ start: text.length, end: text.length + 1, startPoint: point, endPoint: point });
    text += '\n';
  };
  const visit = (parent: Node) => {
    let previous: Node | null = null;
    Array.from(parent.childNodes).forEach((node, index) => {
      if (node instanceof HTMLElement && (['SCRIPT', 'STYLE', 'SVG'].includes(node.tagName) || node.contentEditable === 'false')) return;
      const block = node instanceof HTMLElement && blocks.has(node.tagName);
      if (previous && (block || (previous instanceof HTMLElement && blocks.has(previous.tagName)))) newline({ node: parent, offset: index });
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.textContent ?? '';
        pieces.push({ start: text.length, end: text.length + value.length,
          startPoint: { node, offset: 0 }, endPoint: { node, offset: value.length }, textNode: node as Text });
        text += value;
      } else if (node instanceof HTMLElement) {
        if (node.tagName === 'BR') {
          // ProseMirror uses a trailing BR as an empty paragraph placeholder.
          if (node.classList.contains('ProseMirror-trailingBreak') || (parent.childNodes.length === 1 && blocks.has((parent as Element).tagName))) return;
          newline({ node: parent, offset: index + 1 });
          previous = node;
          return;
        }
        visit(node);
      }
      previous = node;
    });
  };
  visit(editor);
  return { text, pieces };
}

function positionAt(data: TextSnapshot, offset: number, end: boolean): Position | null {
  const pieces = end ? [...data.pieces].reverse() : data.pieces;
  // At a shared boundary, begin inside the following node and end inside the
  // preceding node, so an adjacent formatting span is not part of the edit.
  const piece = pieces.find(item => item.textNode && (end ? item.start < offset && item.end >= offset : item.start <= offset && item.end > offset))
    ?? pieces.find(item => item.textNode && item.start <= offset && item.end >= offset);
  if (piece?.textNode) return { node: piece.textNode, offset: offset - piece.start };
  const boundary = data.pieces.find(item => item.start <= offset && item.end >= offset);
  return boundary ? (end ? boundary.endPoint : boundary.startPoint) : null;
}

export function textRange(editor: EditorElement, start: number, end: number): Range | null {
  if (isTextArea(editor)) return null;
  const data = snapshot(editor);
  if (start < 0 || start > end || end > data.text.length) return null;
  const from = positionAt(data, start, false);
  const to = positionAt(data, end, true);
  if (!from || !to) return null;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

function plainEditableRange(editor: EditorElement, range: Range): boolean {
  // Native insertText can adopt an adjacent inline span's formatting. Leave rich
  // spans untouched instead of guessing how the host's document model stores them.
  for (const container of [range.startContainer, range.endContainer]) {
    let parent = container.parentElement;
    while (parent && parent !== editor) {
      if (!blocks.has(parent.tagName)) return false;
      parent = parent.parentElement;
    }
    if (!parent) return false;
  }
  const parent = range.startContainer.parentElement;
  return !parent || Array.from(parent.children).every(child => blocks.has(child.tagName) || child.tagName === 'BR');
}

function caretOffset(editor: EditorElement): { start: number; end: number } | null {
  if (isTextArea(editor)) return { start: editor.selectionStart, end: editor.selectionEnd };
  const selection = document.getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return null;
  const selected = selection.getRangeAt(0);
  const data = snapshot(editor);
  const resolve = (node: Node, offset: number) => {
    for (const piece of data.pieces) {
      if (piece.textNode === node) return piece.start + Math.min(offset, piece.end - piece.start);
    }
    const before = document.createRange();
    before.selectNodeContents(editor);
    before.setEnd(node, offset);
    // Element-boundary selections are uncommon; map via the closest text node.
    let last = 0;
    for (const piece of data.pieces) {
      if (piece.textNode && before.intersectsNode(piece.textNode)) last = piece.end;
    }
    return Math.min(last, data.text.length);
  };
  return { start: resolve(selected.startContainer, selected.startOffset), end: resolve(selected.endContainer, selected.endOffset) };
}

/** Use a native editing operation so the host editor receives its normal input event. */
export function replaceRange(editor: EditorElement, start: number, end: number, original: string, replacement: string): boolean {
  const before = snapshot(editor).text;
  if (before.slice(start, end) !== original) return false;
  const previousCaret = caretOffset(editor);
  const hadFocus = document.activeElement === editor || editor.contains(document.activeElement);
  if (isTextArea(editor)) {
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(start, end);
    if (!document.execCommand('insertText', false, replacement)) return false;
  } else {
    const range = textRange(editor, start, end);
    const selection = document.getSelection();
    if (!range || !selection || !plainEditableRange(editor, range)) return false;
    editor.focus({ preventScroll: true });
    selection.removeAllRanges();
    selection.addRange(range);
    // Chromium's native insertion participates in undo and editor input handling.
    // No innerHTML/textContent overwrite or hand-crafted rich-text tree mutations.
    if (!document.execCommand('insertText', false, replacement)) return false;
  }
  const expected = before.slice(0, start) + replacement + before.slice(end);
  if (snapshot(editor).text !== expected) return false;
  if (hadFocus && previousCaret) {
    const shift = replacement.length - (end - start);
    const adjust = (offset: number) => offset >= end ? offset + shift : offset > start ? start + replacement.length : offset;
    const from = adjust(previousCaret.start);
    const to = adjust(previousCaret.end);
    if (isTextArea(editor)) editor.setSelectionRange(from, to);
    else {
      const restored = textRange(editor, from, to);
      if (restored) {
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(restored);
      }
    }
  }
  return true;
}
