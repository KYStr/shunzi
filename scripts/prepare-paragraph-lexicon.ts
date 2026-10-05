/** Download public, pinned data into ignored local storage. Never execute upstream source. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import type { LexiconEntry } from '../src/core/paragraph/types.js';

const revision = 'e7bfa5547b92e08265bff2b23ecf0ada832d9270';
const expectedHash = 'f4540be733eec5293569f6d968874748b9a9f22d611b2e299b45e143f796fa45';
const origin = `https://raw.githubusercontent.com/openvanilla/McBopomofoWeb/${revision}`;
const directory = '.local/mcbopomofo';
await mkdir(directory, { recursive: true });
async function download(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Public dictionary download failed (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}
let source: Buffer;
try { source = await readFile(`${directory}/WebData.ts`); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  source = await download(`${origin}/src/McBopomofo/WebData.ts`);
}
if (createHash('sha256').update(source).digest('hex') !== expectedHash) throw new Error('Pinned dictionary hash mismatch');
await writeFile(`${directory}/WebData.ts`, source);
const ast = ts.createSourceFile('WebData.ts', source.toString('utf8'), ts.ScriptTarget.Latest, true);
let literal: string | undefined;
for (const statement of ast.statements) if (ts.isVariableStatement(statement)) {
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name) && declaration.name.text === 'source' && declaration.initializer &&
        ts.isNoSubstitutionTemplateLiteral(declaration.initializer)) literal = declaration.initializer.text;
  }
}
if (!literal) throw new Error('Unsupported upstream data format');
const data: unknown = JSON.parse(literal);
if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid upstream dictionary');
// McBopomofo absolute-order encoding: base 79 pairs; consonant × medial × final × tone.
// Format reference: pinned src/Mandarin/BopomofoSyllable.ts. Only the data format is decoded here.
const consonants = ['', ...'ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒㄓㄔㄕㄖㄗㄘㄙ'];
const medials = ['', ...'ㄧㄨㄩ'], finals = ['', ...'ㄚㄛㄜㄝㄞㄟㄠㄡㄢㄣㄤㄥㄦ'];
const tones = ['', 'ˊ', 'ˇ', 'ˋ', '˙'];
function decode(pair: string): string {
  const order = pair.charCodeAt(0) - 48 + (pair.charCodeAt(1) - 48) * 79;
  if (order < 0 || order >= 6160) throw new Error('Invalid upstream reading');
  return consonants[order % 22] + medials[Math.floor(order / 22) % 4] +
    finals[Math.floor(order / 88) % 14] + tones[Math.floor(order / 1232)];
}
const entries: LexiconEntry[] = [];
for (const [key, value] of Object.entries(data)) {
  if (!key || !/^[\x30-\x7e]+$/.test(key) || key.length % 2 || key.length > 16 || typeof value !== 'string' ||
      /^_(?:ctrl_|half_|kana_|letter_|number_|punctuation_)/.test(key)) continue;
  let readings: string[];
  try { readings = key.match(/.{2}/g)!.map(decode); } catch { continue; }
  const tokens = value.split(' ');
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const text = tokens[i], score = Number(tokens[i+1]);
    if (/^\p{Script=Han}+$/u.test(text) && [...text].length === readings.length && readings.every(Boolean) && Number.isFinite(score))
      entries.push({ text, readings, score });
  }
}
await writeFile(`${directory}/LICENSE-Web-MIT.txt`, await download(`${origin}/LICENSE.txt`));
await writeFile(`${directory}/tools-README.md`, await download(`${origin}/tools/README.md`));
await writeFile(`${directory}/SOURCE.json`, JSON.stringify({ repository: 'https://github.com/openvanilla/McBopomofoWeb',
  revision, sourceUrl: `${origin}/src/McBopomofo/WebData.ts`, sha256: expectedHash,
  extraction: 'TypeScript AST literal -> JSON.parse -> Han-only entries of 1-8 code points; no upstream code executed',
  sourceNotes: ['Web project: MIT; see LICENSE-Web-MIT.txt',
    'Generated from McBopomofo data.txt; see tools-README.md',
    'Upstream BPMFMappings derives from BSD-licensed libtabe tsi.src; original notices and provenance are preserved in third_party/mcbopomofo-web.'],
  distribution: 'Bundle with complete third_party/mcbopomofo-web notices; the derived dictionary is not MIT-only.' }, null, 2));
await writeFile(`${directory}/lexicon.json`, JSON.stringify({ version: `mcbopomofo-${revision.slice(0,12)}`, entries }));
console.log(JSON.stringify({ entries: entries.length, sha256: expectedHash, output: `${directory}/lexicon.json`, notices: 'third_party/mcbopomofo-web' }));
