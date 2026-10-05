import type { LexiconEntry } from './types.js';

const han = /^\p{Script=Han}+$/u;
export const withoutTone = (reading: string) => reading.replace(/[ˊˇˋ˙]/g, '');
interface Node { children: Map<string, Node>; entries: LexiconEntry[] }
const node = (): Node => ({ children: new Map(), entries: [] });

/** A bounded phonetic trie. It enumerates alternatives; it does not decide correctness. */
export class PhoneticLexicon {
  private root = node();
  private readings = new Map<string, Set<string>>();
  private scores = new Map<string, number>();
  readonly size: number;
  readonly version: string;
  private normalizeReading: (reading: string) => string;
  constructor(entries: readonly LexiconEntry[], dataVersion: string, options: { allowToneChanges?: boolean } = {}) {
    if (!dataVersion || dataVersion.length > 120) throw new Error('Invalid lexicon version');
    this.normalizeReading = options.allowToneChanges ? withoutTone : r => r;
    this.version = `${dataVersion}/${options.allowToneChanges ? 'loose-tones' : 'exact-tones'}`;
    let size = 0;
    for (const input of entries) {
      const chars = [...input.text];
      if (!han.test(input.text) || chars.length > 8 || chars.length !== input.readings.length ||
          !input.readings.every(r => typeof r === 'string' && r.length > 0 && r.length < 30) ||
          !Number.isFinite(input.score) || input.score > 0 || input.score < -100) continue;
      const entry = { text: input.text, readings: [...input.readings], score: input.score };
      let current = this.root;
      entry.readings.forEach((reading, i) => {
        const base = this.normalizeReading(reading);
        let child = current.children.get(base);
        if (!child) { child = node(); current.children.set(base, child); }
        current = child;
        const seen = this.readings.get(chars[i]) ?? new Set<string>();
        seen.add(reading); this.readings.set(chars[i], seen);
      });
      current.entries.push(entry);
      this.scores.set(entry.text, Math.max(this.scores.get(entry.text) ?? -100, entry.score));
      size++;
    }
    this.size = size;
  }
  readingsFor(character: string): string[] { return [...(this.readings.get(character) ?? [])]; }
  scoreOf(text: string): number | undefined { return this.scores.get(text); }

  /** Best dictionary segmentation of the original, so existing word boundaries are not binding. */
  scoreOriginal(text: string): number {
    const chars = [...text], best = Array(chars.length + 1).fill(-Infinity) as number[];
    best[0] = 0;
    for (let end = 1; end <= chars.length; end++) {
      for (let start = Math.max(0, end - 8); start < end; start++) {
        const phrase = chars.slice(start, end).join('');
        const score = this.scores.get(phrase) ?? (end - start === 1 ? -12 : -Infinity);
        best[end] = Math.max(best[end], best[start] + score);
      }
    }
    return best[chars.length];
  }

  /** Matching words at a character position, including multi-character boundary changes. */
  matches(chars: readonly string[], start: number): { entries: LexiconEntry[]; truncated: boolean } {
    let frontier = [this.root];
    const entries: LexiconEntry[] = [];
    let truncated = false;
    for (let end = start; end < Math.min(chars.length, start + 8); end++) {
      const sounds = [...new Set(this.readingsFor(chars[end]).map(this.normalizeReading))];
      const next = new Set<Node>();
      for (const parent of frontier) for (const sound of sounds) {
        const child = parent.children.get(sound);
        if (child) next.add(child);
      }
      if (next.size > 128) truncated = true;
      frontier = [...next].slice(0, 128);
      if (!frontier.length) break;
      for (const child of frontier) {
        if (entries.length + child.entries.length > 2048) truncated = true;
        entries.push(...child.entries.slice(0, Math.max(0, 2048 - entries.length)));
      }
    }
    return { entries, truncated };
  }
}
