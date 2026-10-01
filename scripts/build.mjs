// Baut Hauptprozess + Preload (esbuild, ein CJS-Bündel je Datei) und die Oberfläche (Vite).
import { build as esbuild } from 'esbuild';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { build as viteBuild } from 'vite';

export const mainOptions = {
  entryPoints: { main: 'src/main/main.ts', preload: 'src/preload/preload.ts' },
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // ws lädt diese optionalen Beschleuniger nur, wenn vorhanden.
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
};

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  rmSync('dist-electron', { recursive: true, force: true });
  await esbuild(mainOptions);
  await viteBuild({ configFile: 'vite.config.mts', logLevel: 'warn' });
  console.log('Build fertig: dist-electron/ und dist/renderer/');
}
