// Erzeugt die Screenshots für die README aus simulierten Geräten (keine echten Daten).
//   npm run build && node scripts/screenshots.mjs
// Ergebnis: docs/screenshots/*.png

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const OUT = 'docs/screenshots';
mkdirSync(OUT, { recursive: true });

const DEVICES = [
  { port: 19181, fixture: 'desk', name: 'Desk' },
  { port: 19182, fixture: 'desk', name: 'TV Wall' },
  { port: 19183, fixture: 'bedroom', name: 'Bedroom' },
  { port: 19184, fixture: 'bedroom', name: 'Kitchen' },
];

const mock = spawn(
  process.execPath,
  ['--no-warnings', 'scripts/mock-wled.mjs', ...DEVICES.map((d) => `${d.port}:${d.fixture}:${d.name}`)],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
await new Promise((resolve) => mock.stdout.on('data', (d) => d.toString().includes(String(DEVICES.at(-1).port)) && resolve()));

const post = (port, body) =>
  fetch(`http://127.0.0.1:${port}/json/state`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
const effects = await fetch(`http://127.0.0.1:${DEVICES[0].port}/json/eff`).then((r) => r.json());
const palettes = await fetch(`http://127.0.0.1:${DEVICES[0].port}/json/pal`).then((r) => r.json());
const fx = (name) => effects.indexOf(name);
const pal = (name) => palettes.indexOf(name);

// Ausgangszustände für die Bilder
const [desk, tv, bedroom, kitchen] = DEVICES.map((d) => d.port);
await post(desk, { psave: 5, n: 'Evening', ql: '★', o: true, on: true, bri: 140, seg: { fx: fx('Aurora'), pal: pal('Sunset') } });
await post(desk, { psave: 2, n: 'Warm White', ql: '1', o: true, on: true, bri: 255, seg: { fx: 0, col: [[255, 200, 120, 255]] } });
await post(desk, { psave: 3, n: 'Party', ql: '2', o: true, on: true, bri: 255, seg: { fx: fx('Rainbow'), pal: pal('Party') } });
await post(desk, {
  psave: 6,
  n: 'Night Cycle',
  o: true,
  on: true,
  playlist: { ps: [5, 2, 3], dur: [600, 300, 300], transition: [20, 20, 20], repeat: 0, end: 0, r: false },
});
await post(desk, {
  on: true,
  bri: 210,
  seg: [
    { id: 0, start: 0, stop: 240, n: 'Shelf', fx: fx('Colorloop'), pal: pal('Rainbow'), sx: 96, ix: 180, sel: true },
    { id: 1, start: 240, stop: 400, n: 'Underglow', fx: 0, col: [[40, 90, 255, 0]], sel: false },
  ],
});
await post(tv, { on: true, bri: 180, seg: { fx: 0, col: [[150, 40, 255, 0]] } });
await post(bedroom, { on: true, bri: 70, seg: { fx: 0, col: [[255, 120, 30]] } });
await post(kitchen, { on: false, bri: 200 });

const userData = mkdtempSync(path.join(tmpdir(), 'wled-client-shots-'));
writeFileSync(
  path.join(userData, 'devices.json'),
  JSON.stringify(DEVICES.map((d, i) => ({ id: `shot-${i}`, host: `127.0.0.1:${d.port}` }))),
);
writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ theme: 'dark', liveView: true, trayHintShown: true, language: 'en' }));

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, WLED_CLIENT_USER_DATA: userData, WLED_CLIENT_KEEP_FLYOUT: '1' },
  colorScheme: 'dark',
});

try {
  await new Promise((r) => setTimeout(r, 1500));
  const win = app.windows().find((w) => w.url().includes('index.html'));
  const fly = app.windows().find((w) => w.url().includes('flyout.html'));
  await win.waitForFunction(() => document.querySelectorAll('.device-row').length === 4);
  // alle Geräte verbunden = kein Schalter mehr gesperrt
  await win.waitForFunction(() => document.querySelectorAll('.device-row .toggle:not(:disabled)').length === 4);
  const select = async (name, tab) => {
    await win.click(`.device-row:has-text("${name}")`);
    await win.waitForFunction((n) => document.querySelector('.device-title')?.textContent === n, name);
    await win.click(`.tab[data-tab="${tab}"]`);
    await win.mouse.move(5, 400);
    await win.waitForTimeout(1500);
  };

  await select('Desk', 'effects');
  await win.waitForFunction(() => document.querySelectorAll('.pal-bar').length > 20);
  await win.waitForTimeout(1200);
  await win.screenshot({ path: path.join(OUT, 'effects.png') });

  await select('TV Wall', 'colors');
  await win.screenshot({ path: path.join(OUT, 'colors.png') });

  await select('Desk', 'presets');
  await win.screenshot({ path: path.join(OUT, 'presets.png') });

  await select('Desk', 'segments');
  await win.screenshot({ path: path.join(OUT, 'segments.png') });

  await win.emulateMedia({ colorScheme: 'light' });
  await select('Bedroom', 'colors');
  await win.screenshot({ path: path.join(OUT, 'light.png') });
  await win.emulateMedia({ colorScheme: 'dark' });

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().includes('flyout'))
      .showInactive();
  });
  await fly.waitForSelector('.flyout-row');
  await fly.waitForTimeout(800);
  await fly.screenshot({ path: path.join(OUT, 'tray.png') });
  console.log(`Screenshots in ${OUT}/`);
} finally {
  await app.close().catch(() => {});
  mock.kill();
  rmSync(userData, { recursive: true, force: true });
}
