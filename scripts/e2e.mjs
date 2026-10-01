// Ende-zu-Ende-Test gegen simulierte Geräte (scripts/mock-wled.mjs) — keine echten Lampen.
//   npm run build && npm run e2e [-- --shots <ordner>]
// Startet die gebaute App über Playwright mit eigenem Datenverzeichnis, klickt die
// Hauptwege durch und prüft, was beim Gerät ankommt.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const SHOTS = arg('--shots') ?? path.join(tmpdir(), 'wled-client-e2e');
// --exe "release/win-unpacked/WLED Client.exe" testet die gepackte App statt der Quellen
const EXE = arg('--exe');
mkdirSync(SHOTS, { recursive: true });

const PORTS = { desk: 18281, bedroom: 18282, extra: 18283 };
const mock = spawn(
  process.execPath,
  [
    '--no-warnings',
    'scripts/mock-wled.mjs',
    `${PORTS.desk}:desk:Mock Desk`,
    `${PORTS.bedroom}:bedroom:Mock Bedroom`,
    `${PORTS.extra}:bedroom:Mock Extra`,
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
await new Promise((resolve) => mock.stdout.on('data', (d) => d.toString().includes(String(PORTS.extra)) && resolve()));

const api = async (port, p, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);
  return res.json();
};
const state = (port) => api(port, '/json/state');
const logOf = (port) => api(port, '/__log');

const userData = mkdtempSync(path.join(tmpdir(), 'wled-client-data-'));
writeFileSync(
  path.join(userData, 'devices.json'),
  JSON.stringify([
    { id: 'dev-desk', host: `127.0.0.1:${PORTS.desk}` },
    { id: 'dev-bedroom', host: `127.0.0.1:${PORTS.bedroom}` },
  ]),
);
writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ theme: 'dark', liveView: true, trayHintShown: true }));

let failures = 0;
const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (err) {
    failures++;
    results.push(`  FAIL ${name}\n       ${String(err?.message ?? err).split('\n')[0]}`);
  }
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const waitFor = async (fn, msg, timeout = 4000) => {
  const end = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`Zeitüberschreitung: ${msg}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

const app = await electron.launch({
  ...(EXE ? { executablePath: path.resolve(EXE), args: [] } : { args: ['.'] }),
  env: { ...process.env, WLED_CLIENT_USER_DATA: userData, WLED_CLIENT_KEEP_FLYOUT: '1' },
  colorScheme: 'dark',
});
const consoleErrors = [];

try {
  await waitFor(async () => app.windows().length >= 2, 'beide Fenster', 15000);
  const win = app.windows().find((w) => w.url().includes('index.html'));
  const fly = app.windows().find((w) => w.url().includes('flyout.html'));
  for (const w of [win, fly]) {
    w.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    w.on('pageerror', (e) => consoleErrors.push(String(e)));
  }
  await win.waitForSelector('.device-row');

  await step('Beide Geräte verbunden', async () => {
    await win.waitForFunction(() => document.querySelectorAll('.device-row').length === 2);
    await win.waitForFunction(() => [...document.querySelectorAll('.device-sub')].every((e) => !/Verbinde|Offline/.test(e.textContent)), null, {
      timeout: 8000,
    });
    const names = await win.$$eval('.device-row .device-name', (els) => els.map((e) => e.textContent));
    expect(names.join('|') === 'Mock Desk|Mock Bedroom', `Namen: ${names}`);
  });

  await step('Farben-Reiter mit Effekt-Metadaten', async () => {
    await win.click('.tab:has-text("Farben")');
    await win.waitForSelector('.wheel canvas');
    await win.waitForTimeout(600);
    await win.screenshot({ path: path.join(SHOTS, '01-farben.png') });
  });

  await step('Ein/Aus über den großen Knopf', async () => {
    const before = (await state(PORTS.desk)).on;
    await win.click('.power-btn');
    await waitFor(async () => (await state(PORTS.desk)).on === !before, 'on umgeschaltet');
    await win.click('.power-btn');
    await waitFor(async () => (await state(PORTS.desk)).on === before, 'on zurück');
  });

  await step('Helligkeitsregler setzt bri', async () => {
    await win.locator('.hero .slider').fill('64');
    await waitFor(async () => (await state(PORTS.desk)).bri === 64, 'bri = 64');
    await win.waitForFunction(() => document.querySelector('.hero-pct')?.textContent?.includes('25'));
  });

  await step('Hex-Farbe setzt Farbslot 1 (RGBW bleibt erhalten)', async () => {
    await win.fill('.hex-input input', '3366ff');
    await win.press('.hex-input input', 'Enter');
    await waitFor(async () => {
      const c = (await state(PORTS.desk)).seg[0].col[0];
      return c[0] === 51 && c[1] === 102 && c[2] === 255 && c.length === 4;
    }, 'Farbe 3366ff');
  });

  await step('Effekt wählen, Regler mit Metadaten-Namen', async () => {
    await win.click('.tab:has-text("Effekte")');
    await win.fill('.fx-layout .search input >> nth=0', 'rainbow');
    await win.click('.list-item:has-text("Rainbow") >> nth=0');
    await waitFor(async () => (await state(PORTS.desk)).seg[0].fx !== 0, 'fx gesetzt');
    await win.fill('.fx-layout .search input >> nth=0', '');
    await win.waitForSelector('.pal-bar');
    await win.waitForTimeout(800);
    await win.screenshot({ path: path.join(SHOTS, '02-effekte.png') });
    const labels = await win.$$eval('.fx-side .field > span:first-child', (els) => els.map((e) => e.textContent));
    expect(labels.length >= 1, 'keine Effekt-Regler');
  });

  await step('Palette wählen', async () => {
    await win.click('.pal-item >> nth=5');
    await waitFor(async () => (await state(PORTS.desk)).seg[0].pal !== 50, 'pal geändert');
  });

  await step('Segment anlegen und löschen', async () => {
    await win.click('.tab:has-text("Segmente")');
    await win.click('.seg-toolbar .btn.primary');
    await win.fill('.seg-card.new input >> nth=1', '300');
    await win.fill('.seg-card.new input >> nth=2', '400');
    await win.click('.seg-card.new .btn.primary');
    await waitFor(async () => (await state(PORTS.desk)).seg.length === 2, 'zweites Segment');
    await win.waitForFunction(() => document.querySelectorAll('.seg-card').length === 2);
    await win.screenshot({ path: path.join(SHOTS, '03-segmente.png') });
    await win.click('.seg-card >> nth=1 >> .seg-title');
    win.once('dialog', (d) => d.accept());
    await win.click('.seg-card >> nth=1 >> .btn.danger');
    await waitFor(async () => (await state(PORTS.desk)).seg.length === 1, 'Segment gelöscht');
  });

  await step('Preset speichern, anwenden, löschen', async () => {
    await win.click('.tab:has-text("Presets")');
    await win.waitForSelector('.preset-card');
    await win.screenshot({ path: path.join(SHOTS, '04-presets.png') });
    await win.click('.presets-head .btn.primary');
    await win.fill('.modal input >> nth=0', 'E2E Blau');
    await win.fill('.modal input >> nth=2', 'B');
    await win.screenshot({ path: path.join(SHOTS, '05-preset-dialog.png') });
    await win.click('.modal-foot .btn.primary');
    await win.waitForSelector('.preset-card:has-text("E2E Blau")', { timeout: 5000 });
    await win.click('.preset-card:has-text("Party") .preset-main');
    await waitFor(async () => (await state(PORTS.desk)).ps === 3, 'Preset 3 aktiv');
    await win.click('.preset-card:has-text("E2E Blau") .icon-btn');
    win.once('dialog', (d) => d.accept());
    await win.click('.modal-foot .btn.danger');
    await win.waitForSelector('.preset-card:has-text("E2E Blau")', { state: 'detached', timeout: 5000 });
  });

  await step('Playlist anlegen', async () => {
    await win.click('.presets-head .btn:has-text("Playlist")');
    await win.fill('.modal input >> nth=0', 'E2E Playlist');
    await win.click('.playlist-editor > .btn');
    await win.waitForTimeout(300);
    await win.screenshot({ path: path.join(SHOTS, '06-playlist.png') });
    await win.click('.modal-foot .btn.primary');
    await win.waitForSelector('.preset-card:has-text("E2E Playlist")', { timeout: 5000 });
    const saved = (await logOf(PORTS.desk)).find((c) => c.playlist);
    expect(saved && saved.playlist.ps.length === 2 && saved.playlist.dur[0] === 300, `Playlist-Body: ${JSON.stringify(saved)}`);
  });

  await step('Gerät wechseln per Klick und Strg+1', async () => {
    await win.click('.device-row:has-text("Mock Bedroom")');
    await win.waitForFunction(() => document.querySelector('.device-title')?.textContent === 'Mock Bedroom');
    await win.click('.tab:has-text("Farben")');
    await win.waitForTimeout(300);
    await win.screenshot({ path: path.join(SHOTS, '07-bedroom-rgb.png') });
    expect(!(await win.$('.quick-w')), 'RGB-Gerät zeigt W-Knopf');
    await win.keyboard.press('Control+1');
    await win.waitForFunction(() => document.querySelector('.device-title')?.textContent === 'Mock Desk');
  });

  await step('Schnellregler in der Seitenleiste', async () => {
    await win.locator('.device-row:has-text("Mock Bedroom") .slider').fill('200');
    await waitFor(async () => (await state(PORTS.bedroom)).bri === 200, 'Bedroom bri 200');
  });

  await step('Live-Vorschau empfängt Frames', async () => {
    await win.waitForFunction(() => getComputedStyle(document.querySelector('.live-strip canvas')).display === 'block', null, {
      timeout: 5000,
    });
  });

  await step('Tray-Schnellzugriff', async () => {
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('flyout'));
      w.showInactive();
    });
    await fly.waitForSelector('.flyout-row');
    await fly.waitForTimeout(300);
    await fly.screenshot({ path: path.join(SHOTS, '08-flyout.png') });
    const before = (await state(PORTS.bedroom)).on;
    await fly.click('.flyout-row:has-text("Mock Bedroom") .toggle');
    await waitFor(async () => (await state(PORTS.bedroom)).on === !before, 'Bedroom umgeschaltet');
    await fly.locator('.flyout-row:has-text("Mock Desk") .slider').fill('180');
    await waitFor(async () => (await state(PORTS.desk)).bri === 180, 'Desk bri 180');
    await win.waitForFunction(() => document.querySelector('.hero-pct')?.textContent?.includes('71'));
  });

  await step('Gerät hinzufügen per Adresse', async () => {
    await win.click('.sidebar-foot .btn:has-text("Gerät")');
    await win.fill('.modal .inline-form input >> nth=0', `127.0.0.1:${PORTS.extra}`);
    await win.click('.modal .inline-form .btn.primary');
    await win.waitForFunction(() => document.querySelectorAll('.device-row').length === 3, null, { timeout: 6000 });
  });

  await step('Netzwerksuche findet Geräte', async () => {
    await win.fill('.modal .inline-form input >> nth=1', `127.0.0.1:${PORTS.desk}, 127.0.0.1:${PORTS.bedroom}, 127.0.0.1:${PORTS.extra}, 127.0.0.1:1`);
    await win.click('.modal .btn:has-text("Suchen")');
    await win.waitForFunction(() => document.querySelectorAll('.scan-row').length === 3, null, { timeout: 8000 });
    await win.screenshot({ path: path.join(SHOTS, '09-hinzufuegen.png') });
    await win.keyboard.press('Escape');
  });

  await step('Nachtlicht-Popover', async () => {
    await win.keyboard.press('Control+1');
    await win.waitForFunction(() => document.querySelector('.device-title')?.textContent === 'Mock Desk');
    await win.click('.chip-btn:has-text("Nachtlicht")');
    await win.click('.popover .toggle');
    await waitFor(async () => (await state(PORTS.desk)).nl.on === true, 'nl an');
    await win.waitForTimeout(300);
    await win.screenshot({ path: path.join(SHOTS, '10-nachtlicht.png') });
    await win.keyboard.press('Escape');
  });

  await step('Info-Dialog', async () => {
    await win.click('.chip-btn:has-text("Info")');
    await win.waitForSelector('.info-grid');
    await win.waitForTimeout(300);
    await win.screenshot({ path: path.join(SHOTS, '11-info.png') });
    await win.keyboard.press('Escape');
  });

  await step('Helles Design', async () => {
    await win.emulateMedia({ colorScheme: 'light' });
    await win.click('.tab:has-text("Effekte")');
    await win.waitForTimeout(500);
    await win.screenshot({ path: path.join(SHOTS, '12-hell.png') });
    await win.emulateMedia({ colorScheme: 'dark' });
  });

  await step('Gerät fällt aus und kommt zurück', async () => {
    const PORT = 18284;
    const startLone = () =>
      spawn(process.execPath, ['--no-warnings', 'scripts/mock-wled.mjs', `${PORT}:bedroom:Mock Flaky`], { stdio: 'ignore' });
    let lone = startLone();
    await waitFor(async () => !!(await api(PORT, '/json/info').catch(() => null)), 'Mock Flaky läuft');
    const r = await win.evaluate((h) => window.wled.addDevice(h), `127.0.0.1:${PORT}`);
    expect(r.ok, `addDevice: ${r.error}`);
    const sub = () =>
      win.evaluate(
        () =>
          [...document.querySelectorAll('.device-row')]
            .find((r) => r.querySelector('.device-name')?.textContent === 'Mock Flaky')
            ?.querySelector('.device-sub')?.textContent ?? '',
      );
    await waitFor(async () => /An|Aus/.test(await sub()), 'Flaky verbunden', 6000);
    lone.kill();
    await waitFor(async () => (await sub()) === 'Offline', 'Flaky offline', 8000);
    await win.click('.device-row:has-text("Mock Flaky")');
    await win.waitForTimeout(300);
    await win.screenshot({ path: path.join(SHOTS, '13-offline.png') });
    lone = startLone();
    await waitFor(async () => /An|Aus/.test(await sub()), 'Flaky wieder verbunden', 20000);
    lone.kill();
  });
} finally {
  await app.close().catch(() => {});
  mock.kill();
  rmSync(userData, { recursive: true, force: true });
}

console.log(results.join('\n'));
if (consoleErrors.length) {
  console.log(`\nKonsolenfehler (${consoleErrors.length}):`);
  for (const e of [...new Set(consoleErrors)].slice(0, 10)) console.log('  ' + e);
}
console.log(`\nScreenshots: ${SHOTS}`);
console.log(failures ? `\n${failures} Schritt(e) fehlgeschlagen` : '\nAlle Schritte bestanden');
process.exit(failures ? 1 : 0);
