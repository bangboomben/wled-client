// Nach dem Signieren: Größe, Prüfsumme und Blockmap des Installers neu berechnen und in
// latest.yml eintragen. Signieren verändert die Datei — ohne diesen Schritt verwirft
// electron-updater das Update (sha512 passt nicht) und differenzielle Updates fallen weg.
//
//   node scripts/update-feed.mjs [ordner]     (Standard: release)

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
// Dieselbe Funktion, mit der electron-builder die Blockmap beim Build erzeugt.
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap.js');

const dir = process.argv[2] ?? 'release';
const feedPath = path.join(dir, 'latest.yml');
const feed = yaml.load(readFileSync(feedPath, 'utf8'));

for (const file of feed.files) {
  const installer = path.join(dir, file.url);
  const info = await buildBlockMap(installer, 'gzip', `${installer}.blockmap`);
  console.log(`${file.url}: ${file.size} → ${info.size} Bytes, Blockmap neu`);
  file.size = info.size;
  file.sha512 = info.sha512;
  if (feed.path === file.url) feed.sha512 = info.sha512;
}

writeFileSync(feedPath, yaml.dump(feed, { lineWidth: -1 }));
console.log(`${feedPath} aktualisiert`);
