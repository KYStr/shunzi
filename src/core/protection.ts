export type Span = { start: number; end: number };
export function protectedSpans(text: string, terms: readonly string[]): Span[] {
  const spans: Span[] = [];
  const patterns = [/```[\s\S]*?(?:```|$)/g, /`[^`\n]+`/g, /https?:\/\/\S+/g,
    /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, /[A-Za-z0-9_][A-Za-z0-9_./:@+-]*/g,
    /「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"/g];
  for (const re of patterns) for (const m of text.matchAll(re)) spans.push({ start: m.index!, end: m.index! + m[0].length });
  for (const term of terms) {
    if (!term) continue;
    let start = 0;
    while ((start = text.indexOf(term, start)) >= 0) { spans.push({ start, end: start + term.length }); start += term.length; }
  }
  return spans;
}
