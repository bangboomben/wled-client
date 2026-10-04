// Erzeugt die Screenshots für die README aus simulierten Geräten (keine echten Daten).
//   npm run build && node scripts/screenshots.mjs           → docs/screenshots/*.png
//   npm run build && node scripts/screenshots.mjs --demo    → docs/demo.gif + docs/demo.mp4 (braucht ffmpeg)
//   npm run build && node scripts/screenshots.mjs --groups  → docs/groups.gif (Gruppen und Look übertragen)

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const OUT = 'docs/screenshots';
const DEMO = process.argv.includes('--demo');
const GROUPS = process.argv.includes('--groups');
const RECORD = DEMO || GROUPS;
const CLIP = GROUPS ? 'groups' : 'demo';
mkdirSync(OUT, { recursive: true });
const videoDir = RECORD ? mkdtempSync(path.join(tmpdir(), 'wled-client-video-')) : null;

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
// Beispielgruppe: TV Wall + Bedroom (Fantasie-Geräte, siehe DEVICES)
writeFileSync(path.join(userData, 'groups.json'), JSON.stringify([{ id: 'shot-group', name: 'Ambient', members: ['shot-1', 'shot-2'] }]));

const launchedAt = Date.now();
const app = await electron.launch({
  args: ['.'],
  // Gerätesuche nie ins echte Netz: mDNS an einen Port, auf dem niemand antwortet
  env: { ...process.env, WLED_CLIENT_USER_DATA: userData, WLED_CLIENT_KEEP_FLYOUT: '1', WLED_CLIENT_MDNS_TARGET: '127.0.0.1:9' },
  colorScheme: 'dark',
  ...(RECORD ? { recordVideo: { dir: videoDir, size: { width: 1220, height: 820 } } } : {}),
});
let demoStart = 0;
let video = null;

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

  if (RECORD) {
    video = win.video();
    demoStart = await (GROUPS ? recordGroups : recordDemo)(win, select);
  } else {
    await shoot(win, fly, select);
  }
} finally {
  await app.close().catch(() => {});
  mock.kill();
  rmSync(userData, { recursive: true, force: true });
}

async function shoot(win, fly, select) {
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
}

if (RECORD && video) {
  const src = await video.path();
  const trim = Math.max(0, (demoStart - launchedAt) / 1000 - 0.2).toFixed(2);
  const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  if (DEMO) ff(['-ss', trim, '-i', src, '-vf', 'fps=30,scale=1220:-2:flags=lanczos', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', 'docs/demo.mp4']);
  ff([
    '-ss', trim, '-i', src,
    '-vf', 'fps=12,scale=860:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    `docs/${CLIP}.gif`,
  ]);
  rmSync(videoDir, { recursive: true, force: true });
  const mb = (f) => (statSync(f).size / 1048576).toFixed(1);
  console.log(`Clip: docs/${CLIP}.gif (${mb(`docs/${CLIP}.gif`)} MB)${DEMO ? `, docs/demo.mp4 (${mb('docs/demo.mp4')} MB)` : ''}`);
}

/** Sichtbarer Mauszeiger und Gesten für die Aufnahmen. */
async function pointer(win) {
  const pause = (ms) => win.waitForTimeout(ms);
  // Die Videoaufnahme zeigt keinen Mauszeiger — ein eigener Punkt folgt der Maus.
  await win.evaluate(() => {
    const c = document.createElement('div');
    Object.assign(c.style, {
      position: 'fixed', left: '-40px', top: '-40px', width: '20px', height: '20px', margin: '-10px 0 0 -10px',
      borderRadius: '50%', background: 'rgba(255,255,255,.9)', pointerEvents: 'none', zIndex: '99999',
      boxShadow: '0 0 0 2px rgba(0,0,0,.45), 0 3px 10px rgba(0,0,0,.5)', transition: 'transform .1s',
    });
    document.body.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = `${e.clientX}px`; c.style.top = `${e.clientY}px`; }, true);
    addEventListener('mousedown', () => { c.style.transform = 'scale(.65)'; }, true);
    addEventListener('mouseup', () => { c.style.transform = ''; }, true);
  });
  const center = async (sel, fx = 0.5, fy = 0.5) => {
    const b = await win.locator(sel).first().boundingBox();
    return [b.x + b.width * fx, b.y + b.height * fy];
  };
  const glide = async (sel, fx, fy, steps = 22) => {
    const [x, y] = await center(sel, fx, fy);
    await win.mouse.move(x, y, { steps });
  };
  const tap = async (sel, fx, fy) => {
    await glide(sel, fx, fy);
    await pause(120);
    await win.mouse.down();
    await win.mouse.up();
  };
  const drag = async (sel, from, to, fy = 0.5) => {
    await glide(sel, from, fy);
    await win.mouse.down();
    const [x] = await center(sel, to, fy);
    const [, y] = await center(sel, from, fy);
    await win.mouse.move(x, y, { steps: 30 });
    await win.mouse.up();
  };

  return { pause, center, glide, tap, drag };
}

/** Kurzer Rundgang mit sichtbarem Mauszeiger. Gibt den Startzeitpunkt zurück (zum Zuschneiden). */
async function recordDemo(win, select) {
  await select('Desk', 'effects');
  await win.waitForFunction(() => document.querySelectorAll('.pal-bar').length > 20);
  const { pause, center, tap, drag } = await pointer(win);
  await win.mouse.move(760, 520);
  const start = Date.now();
  await pause(1300);

  // Effekt suchen und wählen
  await tap('.fx-layout .search input');
  await win.keyboard.type('aurora', { delay: 110 });
  await pause(250);
  await tap('.list-item:has-text("Aurora")');
  await pause(1200);
  // Palette wechseln
  await tap('.fx-side .search input');
  await win.keyboard.type('ocean', { delay: 110 });
  await pause(250);
  await tap('.pal-item:has-text("Ocean")', 0.5, 0.7);
  await pause(1200);
  // Helligkeit ziehen
  await drag('.hero .slider', 0.82, 0.3);
  await pause(300);
  await drag('.hero .slider', 0.3, 0.95);
  await pause(900);

  // Gerät wechseln, Farbe wählen
  await tap('.device-row:has-text("TV Wall") .device-name');
  await pause(700);
  await tap('.tab[data-tab="colors"]');
  await pause(700);
  const [cx, cy] = await center('.wheel');
  const r = 95;
  await win.mouse.move(cx + r * Math.cos(-1.4), cy + r * Math.sin(-1.4), { steps: 20 });
  await win.mouse.down();
  for (let a = -1.4; a <= 1.6; a += 0.06) await win.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a), { steps: 2 });
  await win.mouse.up();
  await pause(1000);

  // Schnellzugriff in der Seitenleiste
  await drag('.device-row:has-text("Bedroom") .slider', 0.27, 0.85);
  await pause(500);
  await tap('.device-row:has-text("Kitchen") .toggle');
  await pause(900);

  // Preset anwenden
  await tap('.device-row:has-text("Desk") .device-name');
  await pause(500);
  await tap('.tab[data-tab="presets"]');
  await pause(600);
  await tap('.preset-card:has-text("Party") .preset-main');
  await pause(1800);
  return start;
}

/** Gruppen: Look übertragen, Gruppenansicht, „Für alle“ und Gruppenregler. Gibt den Startzeitpunkt zurück. */
async function recordGroups(win, select) {
  await select('Desk', 'effects');
  await win.waitForFunction(() => document.querySelectorAll('.pal-bar').length > 20);
  const { pause, glide, tap, drag } = await pointer(win);

  await win.mouse.move(760, 520);
  const start = Date.now();
  await pause(1000);

  // Look vom Desk auf die Gruppe übertragen
  await tap('.chip-btn:has-text("Copy look")');
  await pause(700);
  await tap('.popover .copy-groups .check:has-text("Ambient")');
  await pause(500);
  await tap('.popover .btn.primary');
  await pause(1400);

  // Gruppe öffnen: Mitglieder zeigen jetzt den Look vom Desk
  await tap('.group-row:has-text("Ambient") .device-name');
  await win.waitForSelector('.group-view .for-all');
  await pause(1300);

  // Für alle: Schnellfarbe, dann ein Effekt
  await tap('.for-all .quick-btn[title="Blue"]');
  await pause(1300);
  await win.waitForFunction(() => !document.querySelector('.for-all select')?.disabled);
  await glide('.for-all select[aria-label="Effect for all …"]');
  await pause(300);
  await win.selectOption('.for-all select[aria-label="Effect for all …"]', 'Rainbow');
  await pause(1400);

  // Gruppe in der Seitenleiste dimmen und wieder hochziehen
  await drag('.group-row:has-text("Ambient") .slider', 0.8, 0.3);
  await pause(400);
  await drag('.group-row:has-text("Ambient") .slider', 0.3, 0.9);
  await pause(1500);
  return start;
}
