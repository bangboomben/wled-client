// Prüft, ob jeder übersetzbare Text (t('…') und key('…') im Code) eine englische Fassung hat.
//   npm run i18n            Lücken und verwaiste Einträge anzeigen (Exit 1 bei Lücken)
//   npm run i18n -- --list  alle gefundenen Texte ausgeben

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { EN } from '../src/shared/i18n-en.ts';

const ROOT = 'src';
const CALL = /\b(?:t|key)\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|tsx)$/.test(name) && !name.startsWith('i18n')) yield p;
  }
}

const found = new Map();
for (const file of files(ROOT)) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(CALL)) {
    const text = m[2].replace(/\\(['"\\])/g, '$1');
    if (!found.has(text)) found.set(text, file);
  }
}

if (process.argv.includes('--list')) {
  for (const text of [...found.keys()].sort()) console.log(text);
  process.exit(0);
}

const missing = [...found.keys()].filter((k) => !(k in EN));
const unused = Object.keys(EN).filter((k) => !found.has(k));
// Platzhalter müssen in beiden Sprachen gleich sein
const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const badVars = [...found.keys()].filter((k) => k in EN && vars(k) !== vars(EN[k]));

console.log(`${found.size} Texte im Code, ${Object.keys(EN).length} englische Einträge`);
for (const k of missing) console.log(`  fehlt:      ${JSON.stringify(k)}  (${found.get(k)})`);
for (const k of unused) console.log(`  unbenutzt:  ${JSON.stringify(k)}`);
for (const k of badVars) console.log(`  Platzhalter: ${JSON.stringify(k)} ≠ ${JSON.stringify(EN[k])}`);
if (!missing.length && !badVars.length) console.log('Alles übersetzt.');
process.exit(missing.length || badVars.length ? 1 : 0);
