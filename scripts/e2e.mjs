// Ende-zu-Ende-Test gegen simulierte Geräte (scripts/mock-wled.mjs) — keine echten Lampen.
//   npm run build && npm run e2e [-- --shots <ordner>]
// Startet die gebaute App über Playwright mit eigenem Datenverzeichnis, klickt die
// Hauptwege durch und prüft, was beim Gerät ankommt.

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electronPath from 'electron';
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
const MDNS_PORT = 18353;
// Eigene Mock-Geräte für die Raumplan-Schritte: Streifen, Bulb (1 LED), Matrix 16×8
const PLAN_PORTS = { desk: 18291, bulb: 18292, matrix: 18293 };
// Port, auf dem nichts lauscht: ein Gerät dort bleibt offline
const GONE_PORT = 18294;
const mock = spawn(
  process.execPath,
  [
    '--no-warnings',
    'scripts/mock-wled.mjs',
    '--mdns',
    String(MDNS_PORT),
    // Grenze des ESP8266: größere WebSocket-Nachrichten beantwortet der Mock mit {"error":9}
    '--ws-max',
    '528',
    `${PORTS.desk}:desk:Mock Desk`,
    `${PORTS.bedroom}:bedroom:Mock Bedroom`,
    `${PORTS.extra}:bedroom:Mock Extra`,
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
// Mock-Geräte der Raumplan-Schritte; startPlanMock() setzt ihn früh, damit auch der Watchdog ihn beenden kann
let planMock;
// Kein Schritt darf den Lauf unbegrenzt aufhalten (etwa ein Fenster, das sich nicht schließen lässt).
const WATCHDOG_MS = 8 * 60_000;
const watchdog = setTimeout(() => {
  console.log(`\nAbbruch: Test läuft länger als ${WATCHDOG_MS / 60_000} min`);
  mock.kill();
  planMock?.kill();
  process.exit(2);
}, WATCHDOG_MS);

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
writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ theme: 'dark', liveView: true, trayHintShown: true, language: 'de' }));
writeFileSync(path.join(userData, 'groups.json'), JSON.stringify([{ id: 'grp-e2e', name: 'E2E Gruppe', members: ['dev-desk', 'dev-bedroom'] }]));

let failures = 0;
const results = [];
/** Jedes Ergebnis sofort ausgeben — bleibt ein Lauf hängen, zeigt das Protokoll, wo. */
const report = (line) => {
  results.push(line);
  console.log(line);
};
async function step(name, fn) {
  try {
    await fn();
    report(`  ok   ${name}`);
  } catch (err) {
    failures++;
    report(`  FAIL ${name}\n       ${String(err?.message ?? err).split('\n')[0]}`);
  }
}

/** Protokolliert im Hauptprozess, wie weit das Beenden kommt (Ausgabe als „[app] quit: …“). */
async function traceQuit(electronApp) {
  await electronApp
    .evaluate(({ app, BrowserWindow }) => {
      const log = (msg) => process.stderr.write(`quit: ${msg}\n`);
      for (const ev of ['before-quit', 'will-quit', 'quit']) app.on(ev, () => log(ev));
      for (const w of BrowserWindow.getAllWindows()) {
        const name = `${w.getTitle()} (${w.webContents.getURL().split('/').pop()})`;
        w.on('close', (e) => setImmediate(() => log(`close ${name}${e.defaultPrevented ? ' VERHINDERT' : ''}`)));
        w.on('closed', () => log(`closed ${name}`));
        w.on('unresponsive', () => log(`unresponsive ${name}`));
        w.webContents.on('render-process-gone', (_e, d) => log(`render-process-gone ${name} ${d.reason}`));
      }
      log(`${BrowserWindow.getAllWindows().length} Fenster`);
    })
    .catch((err) => console.log(`  traceQuit: ${err.message}`));
}

/** Hält fest, was die hängende App gerade zeigt: Prozesse mit Fenstertiteln und ein Bild des Bildschirms. */
function captureHang(label) {
  try {
    console.log(execFileSync('tasklist', ['/v', '/fo', 'list', '/fi', 'imagename eq WLED Client.exe'], { encoding: 'utf8' }));
  } catch (err) {
    console.log(`  tasklist: ${err.message}`);
  }
  const file = path.join(SHOTS, `haenger-${label}.png`);
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)',
    `$bmp.Save('${file}')`,
  ].join('; ');
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore', timeout: 20_000 });
    console.log(`  Bildschirmfoto: ${file}`);
  } catch (err) {
    console.log(`  Bildschirmfoto fehlgeschlagen: ${err.message}`);
  }
}

/** Beendet die App. Reagiert sie nicht, wird festgehalten, woran es hängt, und der Prozessbaum beendet. */
const finished = new WeakSet();
async function closeApp(electronApp, label) {
  // Nach close() lässt sich das Objekt nicht mehr abfragen
  if (finished.has(electronApp)) return true;
  finished.add(electronApp);
  const proc = electronApp.process();
  const exited = proc.exitCode !== null ? Promise.resolve() : new Promise((r) => proc.once('exit', r));
  await traceQuit(electronApp);
  const started = Date.now();
  // Beenden wie über das Tray-Menü (app.quit im Hauptprozess) und auf das Prozessende warten.
  // Bewusst nicht über electronApp.close(): Damit blieb der Lauf zweimal hängen, obwohl die
  // App mit app.quit() auf GitHub wie lokal nach rund 200 ms endet (22 von 22 protokollierten Läufen).
  await electronApp.evaluate(({ app }) => app.quit()).catch(() => {});
  const closed = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 15_000))]);
  if (closed) {
    console.log(`  ${label}: beendet nach ${Date.now() - started} ms`);
    return true;
  }
  console.log(`  ${label}: reagiert nicht auf Beenden`);
  captureHang(label);
  try {
    execFileSync('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore' });
  } catch {
    proc.kill();
  }
  return false;
}

/** Löscht ein Testverzeichnis; Windows gibt Dateien eines eben beendeten Prozesses erst verzögert frei. */
const removeDir = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });

/** Startet die Mock-Geräte für den Raumplan in einem eigenen Prozess (ohne mDNS) als `planMock`. Scheitert schnell, wenn er endet (z. B. Port belegt). */
async function startPlanMock() {
  const proc = spawn(
    process.execPath,
    [
      '--no-warnings',
      'scripts/mock-wled.mjs',
      `${PLAN_PORTS.desk}:desk:Mock Desk`,
      `${PLAN_PORTS.bulb}:bedroom+bulb:Mock Bulb`,
      `${PLAN_PORTS.matrix}:desk+matrix=16x8:Mock Matrix`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  planMock = proc;
  await new Promise((resolve, reject) => {
    proc.once('exit', (code) => reject(new Error(`Raumplan-Mock endete vor dem Start (Code ${code}) – Ports ${PLAN_PORTS.desk}–${PLAN_PORTS.matrix} belegt?`)));
    proc.stdout.on('data', (d) => d.toString().includes(String(PLAN_PORTS.matrix)) && resolve());
  });
}

/** Profil für die Raumplan-Schritte: Plan-Geräte (Standard: drei), Live an, optional ein Plan. */
function planProfile(
  plan,
  devices = [
    { id: 'dev-desk', host: `127.0.0.1:${PLAN_PORTS.desk}` },
    { id: 'dev-bulb', host: `127.0.0.1:${PLAN_PORTS.bulb}` },
    { id: 'dev-matrix', host: `127.0.0.1:${PLAN_PORTS.matrix}` },
  ],
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wled-client-plan-'));
  writeFileSync(path.join(dir, 'devices.json'), JSON.stringify(devices));
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', liveView: true, trayHintShown: true, language: 'de', planOpen: true }));
  if (plan) writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan));
  return dir;
}

/** Hauptfenster einer gestarteten App, sobald beide Fenster da sind. */
async function mainWindow(electronApp) {
  await waitFor(async () => electronApp.windows().length >= 2, 'beide Fenster', 15000);
  return electronApp.windows().find((w) => w.url().includes('index.html'));
}

/**
 * Farben der LED-Ebene an Punkten der Bühne (CSS-Pixel relativ zur Bühne): je Punkt der hellste Wert aus 3×3 Pixeln
 * als [r, g, b] — bei gebrochenem Anzeigemaßstab trifft ein einzelnes Pixel sonst leicht die Lücke. Alle Punkte aus
 * demselben Bild der Ebene. Nicht bemalt (offline, außerhalb): [0, 0, 0].
 */
const ledPixels = (w, points) =>
  w.evaluate((pts) => {
    const c = document.querySelector('.plan-leds');
    const ctx = c.getContext('2d');
    const k = c.width / c.clientWidth;
    return pts.map(([px, py]) => {
      const data = ctx.getImageData(Math.round(px * k) - 1, Math.round(py * k) - 1, 3, 3).data;
      let best = [0, 0, 0];
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] + data[i + 1] + data[i + 2] > best[0] + best[1] + best[2]) best = [data[i], data[i + 1], data[i + 2]];
      }
      return best;
    });
  }, points);
const ledPixel = async (w, x, y) => (await ledPixels(w, [[x, y]]))[0];
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

// mDNS-Anfragen gehen an den Mock statt ins Netzwerk
const mainErrors = [];
const linkLog = [];
const launch = async (dataDir, extraArgs = []) => {
  const electronApp = await electron.launch({
    ...(EXE ? { executablePath: path.resolve(EXE), args: [...extraArgs] } : { args: ['.', ...extraArgs] }),
    env: {
      ...process.env,
      WLED_CLIENT_USER_DATA: dataDir,
      WLED_CLIENT_KEEP_FLYOUT: '1',
      WLED_CLIENT_MDNS_TARGET: `127.0.0.1:${MDNS_PORT}`,
    },
    colorScheme: 'dark',
    timeout: 60_000,
  });
  // Ausgaben des Hauptprozesses ins Protokoll; unerwartete Fehler lassen den Lauf scheitern
  electronApp.process().stderr?.on('data', (d) => {
    process.stderr.write(`  [app] ${d}`);
    if (String(d).includes('Unerwarteter Fehler im Hauptprozess')) mainErrors.push(String(d).trim().split('\n')[0]);
    for (const line of String(d).split('\n')) if (line.startsWith('[link] ')) linkLog.push(line.slice(7).trim());
  });
  return electronApp;
};

/** Öffnet einen Link wie Windows: zweiter Start mit demselben Profil, der ihn an die laufende App weiterreicht und endet. */
const openLink = (dataDir, url) =>
  new Promise((resolve, reject) => {
    const proc = spawn(EXE ? path.resolve(EXE) : electronPath, EXE ? [url] : ['.', url], {
      env: { ...process.env, WLED_CLIENT_USER_DATA: dataDir, WLED_CLIENT_MDNS_TARGET: `127.0.0.1:${MDNS_PORT}` },
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`zweiter Start endet nicht: ${url}`));
    }, 15_000);
    proc.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`zweiter Start nicht möglich: ${url} (${err.message})`));
    });
  });
console.log('  Mock läuft, starte App …');
const app = await launch(userData);
console.log('  App gestartet');
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
    // Das Hex-Feld behielte sonst den Fokus; der Klick auf den RGB-Knopf würde es beim Verlassen erneut senden.
    await win.keyboard.press('Tab');
  });

  await step('RGB-Regler auf Abruf, Zustand bleibt gemerkt', async () => {
    const red = win.locator('.slider[aria-label="Rot"]');
    const toggle = win.locator('.rgb-toggle');
    expect((await red.count()) === 0, 'RGB-Regler sind ohne Klick sichtbar');
    expect((await win.locator('.slider[aria-label="Weißkanal"]').count()) === 1, 'Weißkanal fehlt bei zugeklappten RGB-Reglern');
    expect((await toggle.getAttribute('aria-expanded')) === 'false', 'Knopf meldet nicht „zugeklappt“');
    await toggle.click();
    await red.fill('10');
    try {
      await waitFor(async () => {
        const c = (await state(PORTS.desk)).seg[0].col[0];
        return c[0] === 10 && c[1] === 102 && c[2] === 255 && c.length === 4;
      }, 'Rot = 10, Grün/Blau/W unverändert');
    } catch (err) {
      // Bei einer Zeitüberschreitung festhalten, was das Gerät tatsächlich sah.
      const seen = JSON.stringify((await state(PORTS.desk)).seg[0].col[0]);
      const lastCmds = JSON.stringify((await logOf(PORTS.desk)).slice(-5));
      throw new Error(`${err.message} (seg[0].col[0] = ${seen}; letzte 5 Befehle: ${lastCmds})`);
    }
    // Tab-Wechsel und Neuladen der Oberfläche: Die Regler bleiben offen
    await win.click('.tab:has-text("Effekte")');
    await win.click('.tab:has-text("Farben")');
    await win.waitForSelector('.slider[aria-label="Rot"]', { timeout: 3000 });
    await win.reload();
    await win.waitForSelector('.slider[aria-label="Rot"]', { timeout: 8000 });
    expect((await toggle.getAttribute('aria-expanded')) === 'true', 'Knopf meldet nach Neuladen nicht „aufgeklappt“');
    await toggle.click();
    await win.waitForSelector('.slider[aria-label="Rot"]', { state: 'detached', timeout: 3000 });
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

  await step('Kaputte Presets reißen die Oberfläche nicht mit', async () => {
    const good = await api(PORTS.desk, '/presets.json');
    await api(PORTS.desk, '/__presets', {
      ...good,
      90: { n: 123, ql: 7, playlist: {} },
      91: { n: { x: 1 }, playlist: { ps: 'kaputt' } },
      92: 'kein Objekt',
    });
    await win.waitForFunction(() => [...document.querySelectorAll('.preset-name')].some((e) => e.textContent === '123'), null, {
      timeout: 6000,
    });
    expect(!(await win.$('.error-boundary')), 'Fehleranzeige statt Presets');
    const ids = await win.$$eval('.preset-card .muted', (els) => els.map((e) => e.textContent));
    expect(ids.some((s) => s.startsWith('#91')) && !ids.some((s) => s.startsWith('#92')), `Presets: ${ids}`);
    await api(PORTS.desk, '/__presets', good);
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

  await step('Gruppe in Seitenleiste und Tray, Schalter schaltet alle', async () => {
    const row = win.locator('.group-row:has-text("E2E Gruppe")');
    await row.waitFor({ timeout: 5000 });
    await fly.locator('.group-row:has-text("E2E Gruppe")').waitFor({ timeout: 5000 });
    const members = await row.locator('.device-sub').textContent();
    expect(members === 'Mock Desk, Mock Bedroom', `Mitglieder: ${members}`);
    await api(PORTS.desk, '/json/state', { on: true });
    await api(PORTS.bedroom, '/json/state', { on: false });
    await win.waitForFunction(() => document.querySelector('.group-row .toggle')?.getAttribute('aria-checked') === 'true');
    await row.locator('.toggle').click();
    await waitFor(async () => !(await state(PORTS.desk)).on && !(await state(PORTS.bedroom)).on, 'beide aus');
    await row.locator('.toggle').click();
    await waitFor(async () => (await state(PORTS.desk)).on && (await state(PORTS.bedroom)).on, 'beide an');
  });

  await step('Gruppenregler dimmt anteilig, auch per Tastatur', async () => {
    const slider = win.locator('.group-row:has-text("E2E Gruppe") .slider');
    await api(PORTS.desk, '/json/state', { on: true, bri: 200 });
    await api(PORTS.bedroom, '/json/state', { on: true, bri: 100 });
    // Nicht auf den Gruppenregler warten: Der zeigte schon vorher 200 und verrät nicht, ob die neuen Werte angekommen sind.
    await win.waitForFunction(() => {
      const bri = (name) =>
        [...document.querySelectorAll('.device-row')].find((r) => r.querySelector('.device-name')?.textContent === name)?.querySelector('.slider')?.value;
      return bri('Mock Desk') === '200' && bri('Mock Bedroom') === '100';
    });
    await slider.fill('100');
    await waitFor(async () => (await state(PORTS.desk)).bri === 100 && (await state(PORTS.bedroom)).bri === 50, 'Desk 100, Bedroom 50');
    await win.waitForTimeout(1000); // Zug ist nach 800 ms ohne Änderung beendet
    await slider.focus();
    await win.keyboard.press('End');
    await waitFor(async () => (await state(PORTS.desk)).bri === 255 && (await state(PORTS.bedroom)).bri === 128, 'Ende: Desk 255, Bedroom 128');
    // Im selben Zug kommen die Verhältnisse zurück …
    await win.waitForTimeout(1000);
    await slider.fill('1');
    await slider.fill('255');
    await waitFor(async () => (await state(PORTS.desk)).bri === 255 && (await state(PORTS.bedroom)).bri === 128, 'selber Zug: Desk 255, Bedroom 128');
    // … nach dem Ende des Zugs nicht mehr
    await slider.fill('1');
    await waitFor(async () => (await state(PORTS.desk)).bri === 1 && (await state(PORTS.bedroom)).bri === 1, 'beide auf 1');
    await win.waitForTimeout(1000);
    await slider.fill('255');
    await waitFor(async () => (await state(PORTS.desk)).bri === 255 && (await state(PORTS.bedroom)).bri === 255, 'neuer Zug: beide 255');
  });

  await step('Gruppenregler schaltet eine ausgeschaltete Gruppe anteilig ein', async () => {
    await api(PORTS.desk, '/json/state', { on: false, bri: 200 });
    await api(PORTS.bedroom, '/json/state', { on: false, bri: 100 });
    await win.waitForFunction(() => document.querySelector('.group-row .toggle')?.getAttribute('aria-checked') === 'false');
    await win.waitForTimeout(1000);
    await win.locator('.group-row:has-text("E2E Gruppe") .slider').fill('100');
    await waitFor(async () => {
      const [d, b] = [await state(PORTS.desk), await state(PORTS.bedroom)];
      return d.on && b.on && d.bri === 100 && b.bri === 50;
    }, 'beide an mit 100 und 50');
  });

  await step('Gruppe anlegen, doppelter Name, umbenennen, löschen', async () => {
    const saved = () => JSON.parse(readFileSync(path.join(userData, 'groups.json'), 'utf8'));
    await win.click('.sidebar-foot .btn:has-text("Gruppe")');
    await win.fill('.modal .group-name input', 'e2e gruppe');
    await win.click('.modal .check:has-text("Mock Desk")');
    await win.click('.modal .btn.primary');
    await win.waitForFunction(() => document.querySelector('.modal .error')?.textContent?.includes('gibt es schon'));
    await win.fill('.modal .group-name input', 'Schreibtisch');
    await win.click('.modal .btn.primary');
    await win.waitForSelector('.modal', { state: 'detached' });
    await win.waitForSelector('.group-row:has-text("Schreibtisch")');
    await waitFor(() => saved().some((g) => g.name === 'Schreibtisch' && g.members.join() === 'dev-desk'), 'groups.json mit neuer Gruppe');
    await win.click('.group-row:has-text("Schreibtisch")', { button: 'right' });
    await win.fill('.modal .group-name input', 'Arbeitsplatz');
    await win.click('.modal .btn.primary');
    await win.waitForSelector('.group-row:has-text("Arbeitsplatz")');
    await waitFor(() => saved().some((g) => g.name === 'Arbeitsplatz'), 'groups.json umbenannt');
    win.once('dialog', (d) => d.accept());
    await win.click('.group-row:has-text("Arbeitsplatz")', { button: 'right' });
    await win.click('.modal .btn.danger');
    await win.waitForSelector('.group-row:has-text("Arbeitsplatz")', { state: 'detached' });
    await waitFor(() => saved().length === 1 && saved()[0].name === 'E2E Gruppe', 'groups.json nach dem Löschen');
  });

  /** Wartet, bis der Hauptprozess den Segmentzustand des Mocks kennt; danach kurz auf die Oberfläche. */
  const mainSeg = async (id, pred, msg) => {
    await waitFor(async () => {
      const snap = await win.evaluate(() => window.wled.getSnapshot());
      const seg = snap.devices.find((d) => d.id === id)?.state?.seg?.[0];
      return !!seg && pred(seg);
    }, msg, 6000);
    await win.waitForTimeout(300);
  };
  const rgb = (col) => col.map((c) => c.slice(0, 3).join(',')).join(' | ');

  await step('Look übertragen auf ein Gerät', async () => {
    const eff = await api(PORTS.desk, '/json/eff');
    const pal = await api(PORTS.desk, '/json/pal');
    const fx = eff.indexOf('Rainbow');
    const pl = pal.indexOf('Party');
    const col = [[10, 20, 30, 40], [50, 60, 70, 0], [80, 90, 100, 0]];
    await api(PORTS.desk, '/json/state', { seg: [{ id: 0, fx, pal: pl, sx: 77, ix: 99, col }] });
    await api(PORTS.bedroom, '/json/state', { on: true, bri: 42, seg: [{ id: 0, fx: 0, pal: 0, sx: 128, ix: 128 }] });
    await win.keyboard.press('Control+1');
    await win.waitForFunction(() => document.querySelector('.device-title')?.textContent === 'Mock Desk');
    await mainSeg('dev-desk', (s) => s.fx === fx && s.pal === pl && s.sx === 77, 'Desk-Look im Hauptprozess');
    await win.click('.chip-btn:has-text("Übertragen")');
    // Gezielt die Geräteliste: Die Mitgliederzeile der Gruppe enthält ebenfalls „Mock Bedroom“.
    await win.click('.popover .copy-devices .check:has-text("Mock Bedroom")');
    await win.click('.popover .btn.primary');
    await waitFor(async () => {
      const s = await state(PORTS.bedroom);
      const g = s.seg[0];
      return g.fx === fx && g.pal === pl && g.sx === 77 && g.ix === 99 && rgb(g.col) === rgb(col) && s.bri === 42 && s.on;
    }, 'Bedroom hat den Look, Helligkeit 42 und An bleiben');
    await win.waitForSelector('.toast:has-text("Look auf 1 Gerät übertragen")', { timeout: 4000 });
    // Toasts bleiben 3,5 s und verwerfen eine gleiche neue Meldung: erst abwarten, damit der nächste Schritt seine eigene sieht.
    await win.waitForSelector('.toast', { state: 'detached', timeout: 6000 });
  });

  await step('Look übertragen auf eine Gruppe mit der Quelle', async () => {
    const eff = await api(PORTS.desk, '/json/eff');
    const fx = eff.indexOf('Rainbow');
    await api(PORTS.bedroom, '/json/state', { seg: [{ id: 0, fx: 0 }] });
    const deskBefore = JSON.stringify((await state(PORTS.desk)).seg);
    await win.click('.chip-btn:has-text("Übertragen")');
    await win.click('.popover .copy-groups .check:has-text("E2E Gruppe")');
    await win.click('.popover .btn.primary');
    await waitFor(async () => (await state(PORTS.bedroom)).seg[0].fx === fx, 'Bedroom über die Gruppe');
    expect(JSON.stringify((await state(PORTS.desk)).seg) === deskBefore, 'Quelle hat sich verändert');
    await win.waitForSelector('.toast:has-text("Look auf 1 Gerät übertragen")', { timeout: 4000 });
  });

  await step('Look übertragen auf ein Gerät mit vier Segmenten (Fehler 9, Ersatzweg per HTTP)', async () => {
    // Die Meldung des vorigen Schritts muss weg sein: Eine gleiche neue würde verworfen.
    await win.waitForSelector('.toast', { state: 'detached', timeout: 6000 });
    const eff = await api(PORTS.desk, '/json/eff');
    const pal = await api(PORTS.desk, '/json/pal');
    const fx = eff.indexOf('Rainbow');
    const pl = pal.indexOf('Party');
    const col = [[10, 20, 30, 40], [50, 60, 70, 0], [80, 90, 100, 0]];
    await api(PORTS.desk, '/json/state', { seg: [{ id: 0, fx, pal: pl, sx: 77, ix: 99, col }] });
    await mainSeg('dev-desk', (s) => s.fx === fx && s.pal === pl && s.sx === 77 && s.ix === 99, 'Desk-Look im Hauptprozess');
    // Vier Segmente: Der Befehl wird mit rund 600 Byte größer als die 528 Byte, die der Mock (wie ein ESP8266)
    // noch per WebSocket annimmt. Er antwortet mit {"error":9} und führt nichts aus.
    const bed = (id, start, stop) => ({ id, start, stop, fx: 0, pal: 0, sx: 128, ix: 128 });
    await api(PORTS.bedroom, '/json/state', { seg: [bed(0, 0, 40), bed(1, 40, 80), bed(2, 80, 120), bed(3, 120, 150)] });
    await waitFor(async () => (await state(PORTS.bedroom)).seg.length === 4, 'Bedroom mit vier Segmenten');
    await waitFor(async () => {
      const snap = await win.evaluate(() => window.wled.getSnapshot());
      return snap.devices.find((d) => d.id === 'dev-bedroom')?.state?.seg?.length === 4;
    }, 'Hauptprozess kennt die vier Segmente', 6000);
    const restore = async () => {
      // Segment 0 wieder über die ganze Länge, die übrigen entfernen (stop 0)
      await api(PORTS.bedroom, '/json/state', { seg: [{ id: 3, stop: 0 }, { id: 2, stop: 0 }, { id: 1, stop: 0 }, { id: 0, start: 0, stop: 150 }] });
      await waitFor(async () => {
        const seg = (await state(PORTS.bedroom)).seg;
        return seg.length === 1 && seg[0].start === 0 && seg[0].stop === 150;
      }, 'Bedroom wieder mit einem Segment');
    };
    try {
      await win.click('.chip-btn:has-text("Übertragen")');
      await win.click('.popover .copy-devices .check:has-text("Mock Bedroom")');
      await win.click('.popover .btn.primary');
      await waitFor(async () => {
        const { seg } = await state(PORTS.bedroom);
        return (
          seg.length === 4 &&
          seg.every((g) => g.fx === fx && g.pal === pl && g.sx === 77 && g.ix === 99 && rgb(g.col) === rgb(col))
        );
      }, 'alle vier Bedroom-Segmente haben den Look');
      await win.waitForSelector('.toast:has-text("Look auf 1 Gerät übertragen")', { timeout: 4000 });
      await win.waitForSelector('.toast', { state: 'detached', timeout: 6000 });
    } catch (err) {
      await restore().catch(() => {});
      throw err;
    }
    await restore();
  });

  await step('Eigene Palette: Übertragen gesperrt, Grund steht im Popover', async () => {
    await api(PORTS.desk, '/json/state', { seg: [{ id: 0, pal: 255 }] });
    await mainSeg('dev-desk', (s) => s.pal === 255, 'Desk mit eigener Palette');
    await win.click('.chip-btn:has-text("Übertragen")');
    await win.waitForSelector('.popover .error:has-text("Eigene Paletten lassen sich nicht übertragen")');
    await win.click('.popover .copy-devices .check:has-text("Mock Bedroom")');
    expect(await win.locator('.popover .btn.primary').isDisabled(), '„Übertragen“ ist nicht gesperrt');
    await win.keyboard.press('Escape');
    await api(PORTS.desk, '/json/state', { seg: [{ id: 0, pal: 0 }] });
  });

  await step('Gruppenansicht: Klick auf die Gruppe zeigt Kopf und Mitglieder', async () => {
    await win.click('.group-row:has-text("E2E Gruppe") .device-name');
    await win.waitForFunction(() => document.querySelector('.group-view .device-title')?.textContent === 'E2E Gruppe');
    const cards = await win.$$eval('.member-card .device-name', (els) => els.map((e) => e.textContent));
    expect(cards.join('|') === 'Mock Desk|Mock Bedroom', `Karten: ${cards}`);
    expect(await win.locator('.group-row:has-text("E2E Gruppe")').evaluate((el) => el.classList.contains('active')), 'Gruppenzeile nicht markiert');
    const eff = await api(PORTS.desk, '/json/eff');
    const fxName = eff[(await state(PORTS.desk)).seg[0].fx];
    await win.waitForFunction((n) => document.querySelector('.member-card .member-look')?.textContent?.includes(n), fxName, { timeout: 5000 });
    // Ein/Aus im Kopf wie der Gruppenschalter: alle aus, dann alle an
    await api(PORTS.desk, '/json/state', { on: true });
    await win.waitForFunction(() => document.querySelector('.group-view .power-btn')?.getAttribute('aria-pressed') === 'true');
    await win.click('.group-view .power-btn');
    await waitFor(async () => !(await state(PORTS.desk)).on && !(await state(PORTS.bedroom)).on, 'beide aus');
    await win.click('.group-view .power-btn');
    await waitFor(async () => (await state(PORTS.desk)).on && (await state(PORTS.bedroom)).on, 'beide an');
  });

  await step('Gruppenansicht: bleibt nach Neuladen gewählt, „Öffnen →“ springt zum Gerät', async () => {
    await win.waitForTimeout(700); // die Auswahl wird nach 400 ms gespeichert
    await win.reload();
    await win.waitForFunction(() => document.querySelector('.group-view .device-title')?.textContent === 'E2E Gruppe', null, { timeout: 8000 });
    await win.click('.member-card:has-text("Mock Bedroom") .link-btn');
    await win.waitForFunction(() => document.querySelector('.device-title')?.textContent === 'Mock Bedroom');
    expect(!(await win.$('.group-view')), 'Gruppenansicht ist noch zu sehen');
  });

  await step('Gruppenansicht: Strg+1 und Tray wählen ein Gerät, gelöschte Gruppe fällt auf ein Gerät zurück', async () => {
    await win.click('.group-row:has-text("E2E Gruppe") .device-name');
    await win.waitForSelector('.group-view');
    await win.keyboard.press('Control+1');
    await win.waitForFunction(() => !document.querySelector('.group-view') && document.querySelector('.device-title')?.textContent === 'Mock Desk');
    await win.click('.group-row:has-text("E2E Gruppe") .device-name');
    await win.waitForSelector('.group-view');
    await fly.click('.flyout-row:has-text("Mock Bedroom") .device-meta');
    await win.waitForFunction(() => !document.querySelector('.group-view') && document.querySelector('.device-title')?.textContent === 'Mock Bedroom');
    // Vorübergehende Gruppe anlegen, wählen, löschen
    await win.click('.sidebar-foot .btn:has-text("Gruppe")');
    await win.fill('.modal .group-name input', 'Wegwerf');
    await win.click('.modal .check:has-text("Mock Desk")');
    await win.click('.modal .btn.primary');
    await win.click('.group-row:has-text("Wegwerf") .device-name');
    await win.waitForFunction(() => document.querySelector('.group-view .device-title')?.textContent === 'Wegwerf');
    win.once('dialog', (d) => d.accept());
    await win.click('.group-row:has-text("Wegwerf")', { button: 'right' });
    await win.click('.modal .btn.danger');
    await win.waitForFunction(() => !document.querySelector('.group-view') && !!document.querySelector('.device-view .device-title'));
  });

  await step('Für alle: Schnellfarbe, Effekt und Palette', async () => {
    await win.click('.group-row:has-text("E2E Gruppe") .device-name');
    await win.waitForSelector('.group-view .for-all');
    const eff = await api(PORTS.desk, '/json/eff');
    const pal = await api(PORTS.desk, '/json/pal');
    // Bedroom startet mit Palette 0, damit „beide Party“ die Palettenaktion wirklich belegt
    await api(PORTS.bedroom, '/json/state', { seg: [{ id: 0, pal: 0 }] });
    const before = { [PORTS.desk]: await state(PORTS.desk), [PORTS.bedroom]: await state(PORTS.bedroom) };
    await win.click('.for-all .quick-btn[title="Rot"]');
    await waitFor(async () => {
      for (const p of [PORTS.desk, PORTS.bedroom]) {
        const s = await state(p);
        if (s.seg[0].fx !== eff.indexOf('Solid') || s.seg[0].col[0].slice(0, 3).join() !== '255,0,0') return false;
      }
      return true;
    }, 'beide Solid in Rot');
    for (const p of [PORTS.desk, PORTS.bedroom]) {
      const s = await state(p);
      expect(s.bri === before[p].bri && s.on === before[p].on, `Port ${p}: Helligkeit oder An/Aus verändert`);
    }
    await win.waitForFunction(() => !document.querySelector('.for-all select')?.disabled);
    await win.selectOption('.for-all select[aria-label="Effekt für alle …"]', 'Rainbow');
    await waitFor(
      async () => (await state(PORTS.desk)).seg[0].fx === eff.indexOf('Rainbow') && (await state(PORTS.bedroom)).seg[0].fx === eff.indexOf('Rainbow'),
      'beide Rainbow',
    );
    await win.selectOption('.for-all select[aria-label="Palette für alle …"]', 'Party');
    await waitFor(
      async () => (await state(PORTS.desk)).seg[0].pal === pal.indexOf('Party') && (await state(PORTS.bedroom)).seg[0].pal === pal.indexOf('Party'),
      'beide Party',
    );
    expect((await win.$eval('.for-all select[aria-label="Effekt für alle …"]', (el) => el.value)) === '', 'Effektauswahl nicht zurückgesetzt');
    // Pfeiltaste auf der geschlossenen Liste ändert nur den Wert, angewendet wird erst mit Enter
    const effSel = '.for-all select[aria-label="Effekt für alle …"]';
    await win.waitForFunction(() => !document.querySelector('.for-all select')?.disabled);
    await win.focus(effSel);
    await win.keyboard.press('ArrowDown');
    await win.waitForTimeout(700);
    for (const p of [PORTS.desk, PORTS.bedroom]) {
      expect((await state(p)).seg[0].fx === eff.indexOf('Rainbow'), `Port ${p}: Pfeiltaste hat den Effekt schon angewendet`);
    }
    const first = await win.$eval(`${effSel} option:nth-child(2)`, (el) => el.value);
    expect(first !== 'Rainbow' && eff.includes(first), `erste Effektoption: ${first}`);
    await win.keyboard.press('Enter');
    await waitFor(
      async () => (await state(PORTS.desk)).seg[0].fx === eff.indexOf(first) && (await state(PORTS.bedroom)).seg[0].fx === eff.indexOf(first),
      `beide ${first} per Enter`,
    );
  });

  await step('Für alle: Look von Mock Desk', async () => {
    const eff = await api(PORTS.desk, '/json/eff');
    await api(PORTS.desk, '/json/state', { seg: [{ id: 0, fx: eff.indexOf('Aurora'), sx: 33 }] });
    await mainSeg('dev-desk', (s) => s.fx === eff.indexOf('Aurora') && s.sx === 33, 'Desk-Look im Hauptprozess');
    await win.selectOption('.for-all select[aria-label="Look von …"]', { label: 'Mock Desk' });
    await waitFor(async () => {
      const g = (await state(PORTS.bedroom)).seg[0];
      return g.fx === eff.indexOf('Aurora') && g.sx === 33;
    }, 'Bedroom hat den Look von Mock Desk');
    await win.waitForSelector('.toast:has-text("Look auf 1 Gerät übertragen")', { timeout: 4000 });
  });

  await step('Dialog sucht beim Öffnen per mDNS', async () => {
    await win.click('.sidebar-foot .btn:has-text("Gerät")');
    await win.waitForFunction(() => document.querySelectorAll('.scan-row').length === 3, null, { timeout: 8000 });
    await win.waitForFunction(() => !document.querySelector('.modal .discover-btn')?.disabled, null, { timeout: 8000 });
    const known = await win.$$eval('.scan-row .pill', (els) => els.length);
    expect(known === 2, `als vorhanden markiert: ${known}`);
    await win.screenshot({ path: path.join(SHOTS, '09-hinzufuegen.png') });
  });

  await step('Gerät hinzufügen per Adresse', async () => {
    await win.fill('.modal .inline-form input >> nth=0', `127.0.0.1:${PORTS.extra}`);
    await win.click('.modal .inline-form .btn.primary');
    await win.waitForFunction(() => document.querySelectorAll('.device-row').length === 3, null, { timeout: 6000 });
  });

  await step('Adressbereich durchsuchen', async () => {
    await win.click('.modal .sweep summary');
    await win.fill('.modal .sweep input', `127.0.0.1:${PORTS.desk}, 127.0.0.1:${PORTS.bedroom}, 127.0.0.1:${PORTS.extra}, 127.0.0.1:1`);
    await win.click('.modal .sweep-btn');
    await win.waitForFunction(() => document.querySelector('.modal .scan-status')?.textContent?.startsWith('Fertig'), null, { timeout: 8000 });
    const rows = await win.$$eval('.scan-row', (els) => els.length);
    const known = await win.$$eval('.scan-row .pill', (els) => els.length);
    expect(rows === 3 && known === 3, `Treffer ${rows}, vorhanden ${known}`);
    await win.screenshot({ path: path.join(SHOTS, '09b-adressbereich.png') });
    await win.keyboard.press('Escape');
  });

  await step('Entferntes Gerät fällt aus der Gruppe', async () => {
    const saved = () => JSON.parse(readFileSync(path.join(userData, 'groups.json'), 'utf8'));
    await win.click('.sidebar-foot .btn:has-text("Gruppe")');
    await win.fill('.modal .group-name input', 'Mit Extra');
    await win.click('.modal .check:has-text("Mock Desk")');
    await win.click('.modal .check:has-text("Mock Extra")');
    await win.click('.modal .btn.primary');
    await win.waitForSelector('.group-row:has-text("Mit Extra")');
    win.once('dialog', (d) => d.accept());
    await win.click('.device-row:has-text("Mock Extra")', { button: 'right' });
    await win.click('.modal .btn.danger');
    await win.waitForFunction(() => document.querySelectorAll('.device-row').length === 2, null, { timeout: 6000 });
    const members = await win.locator('.group-row:has-text("Mit Extra") .device-sub').textContent();
    expect(members === 'Mock Desk', `Mitglieder nach dem Entfernen: ${members}`);
    await waitFor(() => saved().some((g) => g.name === 'Mit Extra' && g.members.join() === 'dev-desk'), 'groups.json ohne Extra');
    win.once('dialog', (d) => d.accept());
    await win.click('.group-row:has-text("Mit Extra")', { button: 'right' });
    await win.click('.modal .btn.danger');
    await win.waitForSelector('.group-row:has-text("Mit Extra")', { state: 'detached' });
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

  await step('Sprachwechsel auf Englisch und zurück', async () => {
    await win.click('.sidebar-foot .settings-btn');
    await win.click('.modal .seg-switch button:has-text("English")');
    await win.waitForFunction(() => document.querySelector('.tab[data-tab="colors"]')?.textContent?.includes('Colors'));
    await fly.waitForFunction(() => /All (on|off)/.test(document.querySelector('.flyout-head .btn')?.textContent ?? ''));
    await win.screenshot({ path: path.join(SHOTS, '14-english.png') });
    await win.click('.sidebar-foot .settings-btn');
    await win.click('.modal .seg-switch button:has-text("Deutsch")');
    await win.waitForFunction(() => document.querySelector('.tab[data-tab="colors"]')?.textContent?.includes('Farben'));
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

  await step('Links: ausgeschaltet bewirken sie nichts, ein Start ohne Link zeigt das Fenster', async () => {
    await api(PORTS.desk, '/json/state', { on: true });
    await api(PORTS.bedroom, '/json/state', { on: true });
    const n = linkLog.length;
    await openLink(userData, 'wled-client://group/E2E%20Gruppe/off');
    await waitFor(() => linkLog.length > n, 'Protokollzeile zum Link', 8000);
    expect(linkLog.at(-1).includes('Links sind ausgeschaltet'), `Protokoll: ${linkLog.at(-1)}`);
    expect((await state(PORTS.desk)).on && (await state(PORTS.bedroom)).on, 'Link hat trotzdem geschaltet');
    // Zweiter Start ohne Link: Fenster wie bisher zeigen
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'))?.hide());
    await openLink(userData, '--kein-link');
    await waitFor(
      () => app.evaluate(({ BrowserWindow }) => !!BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'))?.isVisible()),
      'Fenster sichtbar nach zweitem Start',
      8000,
    );
  });

  await step('Links: Gruppe aus, Helligkeit, Farbe, Look übertragen, unbekannter Name', async () => {
    await win.evaluate(() => window.wled.setSettings({ allowLinks: true }));
    await openLink(userData, 'wled-client://group/E2E%20Gruppe/off');
    await waitFor(async () => !(await state(PORTS.desk)).on && !(await state(PORTS.bedroom)).on, 'Gruppe aus', 8000);
    await openLink(userData, 'wled-client://device/Mock%20Desk/brightness/50');
    await waitFor(async () => {
      const s = await state(PORTS.desk);
      return s.on && s.bri === 128;
    }, 'Desk an mit 50 %', 8000);
    const eff = await api(PORTS.desk, '/json/eff');
    await openLink(userData, 'wled-client://group/e2e%20gruppe/color/ff0000');
    await waitFor(async () => {
      for (const p of [PORTS.desk, PORTS.bedroom]) {
        const g = (await state(p)).seg[0];
        if (g.fx !== eff.indexOf('Solid') || g.col[0].slice(0, 3).join() !== '255,0,0') return false;
      }
      return true;
    }, 'Gruppe Solid in Rot', 8000);
    await api(PORTS.desk, '/json/state', { seg: [{ id: 0, fx: eff.indexOf('Rainbow'), sx: 99 }] });
    await mainSeg('dev-desk', (s) => s.fx === eff.indexOf('Rainbow') && s.sx === 99, 'Desk-Look im Hauptprozess');
    await openLink(userData, 'wled-client://device/Mock%20Bedroom/look-from/Mock%20Desk');
    await waitFor(async () => {
      const g = (await state(PORTS.bedroom)).seg[0];
      return g.fx === eff.indexOf('Rainbow') && g.sx === 99;
    }, 'Bedroom hat den Look von Mock Desk', 8000);
    const n = linkLog.length;
    await openLink(userData, 'wled-client://device/Unbekannt/off');
    await waitFor(() => linkLog.slice(n).some((l) => l.includes('Unbekannt')), 'Protokollzeile zum unbekannten Namen', 8000);
    const unknownLine = linkLog.slice(n).find((l) => l.includes('Unbekannt'));
    expect(unknownLine.includes('Gerät „Unbekannt“ gibt es nicht'), `Protokoll: ${unknownLine}`);
  });

  await step('App lässt sich beenden', async () => {
    expect(await closeApp(app, 'Hauptlauf'), 'App reagiert nicht auf Beenden');
  });
} finally {
  await closeApp(app, 'Hauptlauf');
  removeDir(userData);
}

await step('Erster Start übernimmt die Geräte aus der mDNS-Suche', async () => {
  const fresh = mkdtempSync(path.join(tmpdir(), 'wled-client-first-'));
  writeFileSync(path.join(fresh, 'settings.json'), JSON.stringify({ theme: 'dark', trayHintShown: true, language: 'de' }));
  const first = await launch(fresh);
  try {
    await waitFor(async () => first.windows().length >= 2, 'beide Fenster', 15000);
    const w = first.windows().find((x) => x.url().includes('index.html'));
    await w.waitForFunction(() => document.querySelectorAll('.device-row').length === 3, null, { timeout: 15000 });
    const names = await w.$$eval('.device-row .device-name', (els) => els.map((e) => e.textContent).sort());
    expect(names.join('|') === 'Mock Bedroom|Mock Desk|Mock Extra', `Namen: ${names}`);
    expect(await closeApp(first, 'Erster Start'), 'App reagiert nicht auf Beenden');
  } finally {
    await closeApp(first, 'Erster Start');
    removeDir(fresh);
  }
});
await step('Kaltstart per Link: App startet unsichtbar und führt den Link aus', async () => {
  const fresh = mkdtempSync(path.join(tmpdir(), 'wled-client-link-'));
  // Ohne gespeicherten Namen: Die App kennt „Mock Desk“ erst nach dem Verbinden.
  writeFileSync(path.join(fresh, 'devices.json'), JSON.stringify([{ id: 'dev-desk', host: `127.0.0.1:${PORTS.desk}` }]));
  writeFileSync(path.join(fresh, 'settings.json'), JSON.stringify({ theme: 'dark', trayHintShown: true, language: 'de', allowLinks: true }));
  await api(PORTS.desk, '/json/state', { on: true });
  const cold = await launch(fresh, ['wled-client://device/Mock%20Desk/off']);
  try {
    await waitFor(async () => !(await state(PORTS.desk)).on, 'Desk aus per Kaltstart-Link', 15000);
    // Erst prüfen, wenn die Oberfläche gerendert hat: Ein Fenster, das sich zeigen wollte, wäre jetzt längst sichtbar.
    await waitFor(() => cold.windows().some((w) => w.url().includes('index.html')), 'Hauptfenster geladen', 15000);
    const coldWin = cold.windows().find((w) => w.url().includes('index.html'));
    await coldWin.waitForFunction(() => document.querySelectorAll('.device-row').length === 1, null, { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 500));
    const visible = await cold.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((w) => w.isVisible() && w.webContents.getURL().includes('index.html')),
    );
    expect(!visible, 'Hauptfenster ist sichtbar');
    expect(await closeApp(cold, 'Kaltstart'), 'App reagiert nicht auf Beenden');
  } finally {
    await closeApp(cold, 'Kaltstart');
    removeDir(fresh);
  }
});
try {
  await startPlanMock();
} catch (err) {
  console.log(`\nAbbruch: ${err.message}`);
  mock.kill();
  process.exit(2);
}
const PLAN_SHOWN = {
  version: 1,
  rooms: [{ id: 'r1', name: 'Büro', x: 0, y: 0, w: 22, h: 12 }],
  items: [
    { deviceId: 'dev-desk', shape: 'line', points: [[2, 2], [14, 2], [14, 8]], reversed: false },
    { deviceId: 'dev-bulb', shape: 'point', at: [6, 9] },
    { deviceId: 'dev-matrix', shape: 'area', rect: { x: 16, y: 2, w: 4, h: 2 } },
  ],
};

await step('Raumplan: Anzeige, Live-Farben, Bedienfeld, Wechsel und Neustart', async () => {
  const dir = planProfile(PLAN_SHOWN);
  await api(PLAN_PORTS.desk, '/json/state', { on: true, bri: 255, seg: [{ id: 0, fx: 9 }] });
  // Matrix mit laufendem Effekt: Der Mock malt zeilenweise einen Regenbogen, oben und unten sehen also verschieden aus
  await api(PLAN_PORTS.matrix, '/json/state', { on: true, bri: 255, seg: [{ id: 0, fx: 9 }] });
  await api(PLAN_PORTS.bulb, '/json/state', { on: false });
  let pa = await launch(dir);
  try {
    let w = await mainWindow(pa);
    await w.waitForSelector('.plan-view', { timeout: 15000 });
    await w.waitForFunction(() => document.querySelectorAll('.plan-item').length === 3, null, { timeout: 15000 });
    expect((await w.locator('.plan-room-name').textContent()) === 'Büro', 'Raumname fehlt');
    // Formen aus dem Plan: Linie, Punkt, Fläche
    for (const [id, shape] of [['dev-desk', 'line'], ['dev-bulb', 'point'], ['dev-matrix', 'area']]) {
      expect(await w.locator(`.plan-item.plan-${shape}[data-device="${id}"]`).count() === 1, `${id} nicht als ${shape}`);
    }
    // Live: Am Anfang der Desk-Linie wechselt die Farbe (wandernder Regenbogen), statische Farben täten das nicht
    const anchor = async (id) => {
      const el = w.locator(`.plan-item[data-device="${id}"]`);
      return [Number(await el.getAttribute('data-x')), Number(await el.getAttribute('data-y'))];
    };
    const [dx, dy] = await anchor('dev-desk');
    let first;
    await waitFor(async () => {
      const p = await ledPixel(w, dx, dy);
      if (p[0] + p[1] + p[2] < 60) return false;
      first ??= p.join();
      return p.join() !== first;
    }, 'Live-Farben am Desk ändern sich', 10000);
    // Matrix: Das Pixelraster ist wirklich gezeichnet, wenn eine Zelle der obersten und eine der untersten Zeile hell
    // sind und sich unterscheiden (eine einfarbige Fläche aus den Segmentfarben täte das nicht)
    const cell = await w
      .locator('.plan-item[data-device="dev-matrix"] .plan-hit')
      .evaluate((e) => ({ x: Number(e.getAttribute('x')), y: Number(e.getAttribute('y')), w: Number(e.getAttribute('width')), h: Number(e.getAttribute('height')) }));
    // Mitte der vierten Zelle (von 16 Spalten) in Zeile 1 und Zeile 8 (von 8)
    const topCell = [cell.x + (cell.w * 3.5) / 16, cell.y + cell.h / 16];
    const bottomCell = [cell.x + (cell.w * 3.5) / 16, cell.y + cell.h - cell.h / 16];
    const bright = (p) => p[0] + p[1] + p[2] > 60;
    await waitFor(async () => {
      const [a, b] = await ledPixels(w, [topCell, bottomCell]);
      return bright(a) && bright(b) && Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 60;
    }, 'Matrix zeigt das Pixelraster (oben und unten helle, verschiedene Farben)', 10000);
    // Bedienfeld am Bulb: einschalten und Effekt setzen
    await w.click('.plan-item[data-device="dev-bulb"] .plan-hit');
    await w.waitForSelector('.plan-panel:has-text("Mock Bulb")');
    await w.click('.plan-panel .toggle');
    await waitFor(async () => (await state(PLAN_PORTS.bulb)).on, 'Bulb an über das Bedienfeld');
    const eff = await api(PLAN_PORTS.bulb, '/json/eff');
    await w.waitForFunction(() => !document.querySelector('.plan-panel select')?.disabled);
    await w.selectOption('.plan-panel select', 'Rainbow');
    await waitFor(async () => (await state(PLAN_PORTS.bulb)).seg[0].fx === eff.indexOf('Rainbow'), 'Bulb-Effekt Rainbow');
    const focused = () => w.evaluate(() => ({ role: document.activeElement?.getAttribute('role'), inPanel: !!document.activeElement?.closest('.plan-panel'), device: document.activeElement?.getAttribute('data-device') }));
    // Klick auf den Innenabstand des Bedienfelds: Der Fokus bleibt im Feld (tabIndex −1), und Esc bringt ihn zurück auf den Bulb
    const pbox = await w.locator('.plan-panel').boundingBox();
    await w.mouse.click(pbox.x + 4, pbox.y + pbox.height - 4);
    await waitFor(async () => (await focused()).inPanel, 'Fokus bleibt nach einem Klick auf den Rand im Bedienfeld');
    await w.keyboard.press('Escape');
    await w.waitForSelector('.plan-panel', { state: 'detached' });
    await waitFor(async () => (await focused()).device === 'dev-bulb', 'Fokus nach Esc zurück auf dem Bulb');
    // Tastatur: Fokus auf den Desk, Enter öffnet sein Bedienfeld und setzt den Fokus auf den Schalter darin;
    // Esc schließt und bringt den Fokus zurück auf den Desk
    await w.focus('.plan-item[data-device="dev-desk"]');
    await w.keyboard.press('Enter');
    await w.waitForSelector('.plan-panel:has-text("Mock Desk")');
    await waitFor(async () => {
      const f = await focused();
      return f.inPanel && f.role === 'switch';
    }, 'Fokus auf dem Schalter im Bedienfeld');
    await w.keyboard.press('Escape');
    await w.waitForSelector('.plan-panel', { state: 'detached' });
    await waitFor(async () => (await focused()).device === 'dev-desk', 'Fokus zurück auf dem Desk');
    // Leertaste öffnet wie Enter und schaltet den Schalter nicht gleich mit (der Bulb bleibt an)
    await w.focus('.plan-item[data-device="dev-bulb"]');
    await w.keyboard.press('Space');
    await w.waitForSelector('.plan-panel:has-text("Mock Bulb")');
    await waitFor(async () => (await focused()).inPanel, 'Fokus im Bedienfeld nach Leertaste');
    await w.waitForTimeout(400);
    expect((await state(PLAN_PORTS.bulb)).on, 'Leertaste hat den Schalter mitbetätigt');
    await w.keyboard.press('Escape');
    await w.waitForSelector('.plan-panel', { state: 'detached' });
    // Live-Bilder fordert der Hauptprozess an, solange der Plan sichtbar ist (GET /__live am Mock: empfängt ein Client welche?)
    const isLive = async (port) => (await api(port, '/__live')).live;
    await waitFor(async () => (await isLive(PLAN_PORTS.desk)) && (await isLive(PLAN_PORTS.bulb)) && (await isLive(PLAN_PORTS.matrix)), 'Im Plan senden alle drei Geräte Live-Bilder');
    // Strg+1 verlässt den Plan; die Wahl wird nach 400 ms gespeichert
    await w.keyboard.press('Control+1');
    await w.waitForSelector('.plan-view', { state: 'detached' });
    await w.waitForFunction(() => document.querySelector('.device-title')?.textContent === 'Mock Desk');
    // Die Geräteansicht braucht nur das Live-Bild ihres Geräts: Matrix und Bulb hören auf, der Desk bleibt live
    await waitFor(
      async () => (await isLive(PLAN_PORTS.desk)) && !(await isLive(PLAN_PORTS.bulb)) && !(await isLive(PLAN_PORTS.matrix)),
      'Nach dem Verlassen des Plans nur noch der Desk live (Matrix und Bulb nicht)',
    );
    await w.waitForTimeout(800);
    expect(await closeApp(pa, 'Raumplan verlassen'), 'App reagiert nicht auf Beenden');
    // Neustart: Das Profil beginnt mit planOpen: true — jetzt zeigt die App die Geräteansicht, also wurde das Verlassen gespeichert
    pa = await launch(dir);
    w = await mainWindow(pa);
    await w.waitForFunction(() => document.querySelector('.device-title')?.textContent === 'Mock Desk', null, { timeout: 15000 });
    await w.waitForTimeout(500); // ein spät geladener Zustand dürfte den Plan nicht doch noch öffnen
    expect((await w.locator('.plan-view').count()) === 0, 'Raumplan nach dem Verlassen wieder offen');
    // Der Eintrag in der Seitenleiste führt zurück; auch das wird gespeichert
    await w.click('.plan-row');
    await w.waitForSelector('.plan-view');
    await w.waitForTimeout(800);
    expect(await closeApp(pa, 'Raumplan Seitenleiste'), 'App reagiert nicht auf Beenden');
    // Neustart: Raumplan wieder gewählt, Plan unverändert
    pa = await launch(dir);
    w = await mainWindow(pa);
    await w.waitForSelector('.plan-view', { timeout: 15000 });
    await w.waitForFunction(() => document.querySelectorAll('.plan-item').length === 3, null, { timeout: 15000 });
    expect(await closeApp(pa, 'Raumplan Neustart'), 'App reagiert nicht auf Beenden');
  } finally {
    await closeApp(pa, 'Raumplan');
    removeDir(dir);
  }
});

await step('Raumplan: Offline-Gerät hat gestrichelte Kontur und „offline“, aber keine Farben', async () => {
  // Hinter dem Gerät lauscht nichts, es bleibt offline; der Bulb daneben leuchtet als Gegenprobe
  const dir = planProfile(
    {
      version: 1,
      rooms: [{ id: 'r1', name: 'Büro', x: 0, y: 0, w: 22, h: 12 }],
      items: [
        { deviceId: 'dev-gone', shape: 'line', points: [[2, 2], [14, 2]], reversed: false },
        { deviceId: 'dev-bulb', shape: 'point', at: [6, 9] },
      ],
    },
    [
      { id: 'dev-gone', host: `127.0.0.1:${GONE_PORT}`, alias: 'Mock Gone' },
      { id: 'dev-bulb', host: `127.0.0.1:${PLAN_PORTS.bulb}` },
    ],
  );
  await api(PLAN_PORTS.bulb, '/json/state', { on: true, bri: 255, seg: [{ id: 0, fx: 9 }] });
  const pa = await launch(dir);
  try {
    const w = await mainWindow(pa);
    await w.waitForSelector('.plan-view', { timeout: 15000 });
    const label = (id) => w.locator(`.plan-item[data-device="${id}"] .plan-label`).textContent();
    await waitFor(async () => (await label('dev-gone')) === 'Mock Gone (offline)', 'Name mit „(offline)“ am Offline-Gerät', 15000);
    expect((await label('dev-bulb')) === 'Mock Bulb', 'Online-Gerät trägt „(offline)“');
    const dash = await w.locator('.plan-item[data-device="dev-gone"] .plan-track').evaluate((e) => getComputedStyle(e).strokeDasharray);
    expect(dash !== 'none', 'Kontur des Offline-Geräts nicht gestrichelt');
    const at = async (id) => {
      const el = w.locator(`.plan-item[data-device="${id}"]`);
      return [Number(await el.getAttribute('data-x')), Number(await el.getAttribute('data-y'))];
    };
    const [gx, gy] = await at('dev-gone');
    const [bx, by] = await at('dev-bulb');
    await waitFor(async () => (await ledPixel(w, bx, by)).reduce((a, b) => a + b, 0) > 60, 'Bulb leuchtet live', 10000);
    await w.waitForTimeout(300);
    // „Aus“ malt dunkelgrau; offline bleibt die Ebene unbemalt
    const p = await ledPixel(w, gx, gy);
    expect(p.join() === '0,0,0', `Offline-Gerät ist bemalt: ${p}`);
    expect(await closeApp(pa, 'Raumplan offline'), 'App reagiert nicht auf Beenden');
  } finally {
    await closeApp(pa, 'Raumplan offline');
    removeDir(dir);
  }
});

/** Bildschirmpunkt (Viewport) zu Rastereinheiten des Plans, aus den Daten am SVG. */
const planPx = (w, ux, uy) =>
  w.evaluate(
    ([x, y]) => {
      const s = document.querySelector('.plan-svg');
      const r = s.getBoundingClientRect();
      const k = Number(s.dataset.scale);
      return [r.left + x * k + Number(s.dataset.ox), r.top + y * k + Number(s.dataset.oy)];
    },
    [ux, uy],
  );

/**
 * Wartet, bis der Ausschnitt des Plans nach dem Wechsel in den Bearbeitungsmodus steht: Die Seitenliste verkleinert die
 * Bühne, und der Plan passt sich erst danach an (Maßstab und Versatz am SVG bleiben zwei Abfragen lang gleich).
 */
const planSettled = async (w) => {
  await w.waitForSelector('.plan-side');
  let last = '';
  await waitFor(async () => {
    const now = await w.evaluate(() => {
      const s = document.querySelector('.plan-svg');
      return s ? [s.dataset.scale, s.dataset.ox, s.dataset.oy, s.getAttribute('width')].join() : '';
    });
    const same = !!now && now === last;
    last = now;
    return same;
  }, 'Ausschnitt des Plans steht', 6000);
};

await step('Raumplan: zeichnen, speichern, verwerfen, Rückfrage, gelöschtes Gerät', async () => {
  const dir = planProfile();
  const planFile = path.join(dir, 'plan.json');
  const saved = () => {
    try {
      return JSON.parse(readFileSync(planFile, 'utf8'));
    } catch {
      return null;
    }
  };
  const pa = await launch(dir);
  try {
    const w = await mainWindow(pa);
    await w.waitForSelector('.plan-view .empty', { timeout: 15000 });
    await w.click('.plan-edit-btn');
    await planSettled(w);
    await w.waitForFunction(() => document.querySelectorAll('.plan-side-item').length === 3);
    // Raum aufziehen und benennen
    await w.click('.plan-room-btn');
    const a = await planPx(w, 1, 1);
    const b = await planPx(w, 15, 10);
    await w.mouse.move(a[0], a[1]);
    await w.mouse.down();
    await w.mouse.move(b[0], b[1], { steps: 6 });
    await w.mouse.up();
    // Enter ohne Namen lässt das Feld stehen (Esc verwürfe den Raum)
    await w.waitForSelector('.plan-name-input');
    await w.keyboard.press('Enter');
    expect((await w.locator('.plan-name-input').count()) === 1, 'Enter ohne Namen hat das Feld geschlossen');
    await w.fill('.plan-name-input', 'Büro');
    await w.keyboard.press('Enter');
    await w.waitForSelector('.plan-room-name:has-text("Büro")');
    // Desk als Linie mit einem Knick
    await w.click('.plan-side-item:has-text("Mock Desk")');
    for (const [ux, uy] of [[2, 2], [12, 2]]) {
      const p = await planPx(w, ux, uy);
      await w.mouse.click(p[0], p[1]);
    }
    const end = await planPx(w, 12, 8);
    await w.mouse.dblclick(end[0], end[1]);
    // Bulb als Punkt, Matrix als Fläche
    await w.click('.plan-side-item:has-text("Mock Bulb")');
    const pb = await planPx(w, 6, 7);
    await w.mouse.click(pb[0], pb[1]);
    await w.click('.plan-side-item:has-text("Mock Matrix")');
    const pm = await planPx(w, 18, 5);
    await w.mouse.click(pm[0], pm[1]);
    await w.waitForFunction(() => document.querySelectorAll('.plan-side-item').length === 0);
    await w.click('.plan-done-btn');
    await waitFor(() => saved()?.items?.length === 3, 'plan.json mit drei Geräten', 6000);
    const plan = saved();
    expect(JSON.stringify(plan.rooms) === JSON.stringify([{ id: plan.rooms[0]?.id, name: 'Büro', x: 1, y: 1, w: 14, h: 9 }]), `Raum: ${JSON.stringify(plan.rooms)}`);
    const byId = Object.fromEntries(plan.items.map((i) => [i.deviceId, i]));
    expect(JSON.stringify(byId['dev-desk']) === JSON.stringify({ deviceId: 'dev-desk', shape: 'line', points: [[2, 2], [12, 2], [12, 8]], reversed: false }), `Desk: ${JSON.stringify(byId['dev-desk'])}`);
    expect(JSON.stringify(byId['dev-bulb']) === JSON.stringify({ deviceId: 'dev-bulb', shape: 'point', at: [6, 7] }), `Bulb: ${JSON.stringify(byId['dev-bulb'])}`);
    expect(JSON.stringify(byId['dev-matrix']) === JSON.stringify({ deviceId: 'dev-matrix', shape: 'area', rect: { x: 14, y: 3, w: 8, h: 4 } }), `Matrix: ${JSON.stringify(byId['dev-matrix'])}`);
    // Verwerfen: Raum verschieben und verwerfen → Datei und Anzeige unverändert
    const before = JSON.stringify(saved());
    await w.click('.plan-edit-btn');
    await planSettled(w);
    const r1 = await planPx(w, 8, 9.5);
    const r2 = await planPx(w, 10, 9.5);
    await w.mouse.move(r1[0], r1[1]);
    await w.mouse.down();
    await w.mouse.move(r2[0], r2[1], { steps: 4 });
    await w.mouse.up();
    // Der Zug hat wirklich etwas geändert (sonst verwürfe der Test nichts)
    expect(await w.locator('.plan-undo-btn').isEnabled(), 'Der Raum-Zug hat nichts geändert');
    await w.click('.plan-discard-btn');
    await w.waitForSelector('.plan-side', { state: 'detached' });
    await w.waitForTimeout(500);
    expect(JSON.stringify(saved()) === before, 'Verwerfen hat gespeichert');
    const itemAt = (id) =>
      w.evaluate((id) => {
        const el = document.querySelector(`.plan-item[data-device="${id}"]`);
        const r = document.querySelector('.plan-svg').getBoundingClientRect();
        return [r.left + Number(el.dataset.x), r.top + Number(el.dataset.y)];
      }, id);
    // Rückgängig: Desk wählen (an der ersten LED — die Mitte des Umrisses einer L-Linie liegt nicht auf ihr), Entf, Strg+Z
    await w.click('.plan-edit-btn');
    await planSettled(w);
    const deskAt = await itemAt('dev-desk');
    await w.mouse.click(deskAt[0], deskAt[1]);
    await w.keyboard.press('Delete');
    await w.waitForFunction(() => !document.querySelector('.plan-item[data-device="dev-desk"]'));
    await w.keyboard.press('Control+z');
    await w.waitForSelector('.plan-item[data-device="dev-desk"]');
    // Ein Zug nach einem früheren Schritt bleibt ein eigener Schritt: Bulb schieben, dann den Raum langsam ziehen
    // (der erste Zwischenschritt ändert nichts); ein Strg+Z nimmt nur den Zug zurück, der Bulb-Schritt bleibt
    await w.click('.plan-item[data-device="dev-bulb"] .plan-hit');
    await w.keyboard.press('ArrowRight');
    const q1 = await planPx(w, 8, 9.5);
    const q2 = await planPx(w, 10, 9.5);
    await w.mouse.move(q1[0], q1[1]);
    await w.mouse.down();
    await w.mouse.move(q2[0], q2[1], { steps: 10 });
    await w.mouse.up();
    await w.keyboard.press('Control+z');
    expect(await w.locator('.plan-undo-btn').isEnabled(), 'Strg+Z nach dem Zug hat auch den Schritt davor zurückgenommen');
    // Nur Strg+Z macht rückgängig, Strg+Umschalt+Z nicht
    await w.keyboard.press('Control+Shift+z');
    expect(await w.locator('.plan-undo-btn').isEnabled(), 'Strg+Umschalt+Z hat rückgängig gemacht');
    // Rückfrage beim Verlassen mit Änderungen
    await w.click('.plan-item[data-device="dev-bulb"] .plan-hit');
    await w.keyboard.press('ArrowRight');
    await w.keyboard.press('Control+1');
    await w.waitForSelector('.modal:has-text("Änderungen speichern?")');
    await w.click('.modal .btn.ghost');
    await w.waitForSelector('.modal', { state: 'detached' });
    expect(await w.locator('.plan-side').count() === 1, 'Abbrechen hat den Plan verlassen');
    await w.keyboard.press('Control+1');
    await w.click('.modal .btn:has-text("Verwerfen")');
    await w.waitForFunction(() => document.querySelector('.device-title')?.textContent === 'Mock Desk');
    expect(JSON.stringify(saved()) === before, 'Verwerfen über die Rückfrage hat gespeichert');
    // Rückfrage mit „Speichern“: Bulb um eine Einheit schieben, Strg+1, speichern → Geräteansicht und plan.json
    const bulbSaved = () => JSON.stringify(saved()?.items?.find((i) => i.deviceId === 'dev-bulb'));
    await w.click('.plan-row');
    await w.waitForSelector('.plan-view');
    await w.click('.plan-edit-btn');
    await planSettled(w);
    await w.click('.plan-item[data-device="dev-bulb"] .plan-hit');
    await w.keyboard.press('ArrowRight');
    await w.keyboard.press('Control+1');
    await w.waitForSelector('.modal:has-text("Änderungen speichern?")');
    await w.click('.modal .btn.primary');
    await w.waitForFunction(() => document.querySelector('.device-title')?.textContent === 'Mock Desk');
    await waitFor(() => bulbSaved() === JSON.stringify({ deviceId: 'dev-bulb', shape: 'point', at: [7, 7] }), 'Bulb über die Rückfrage gespeichert', 6000);
    // „Neu zeichnen“ zeichnet gleich eine Linie, auch bei einem Gerät mit einer LED (die Liste käme mit der Punktform zurück)
    await w.click('.plan-row');
    await w.waitForSelector('.plan-view');
    await w.click('.plan-edit-btn');
    await planSettled(w);
    const bc = await planPx(w, 7, 7);
    await w.mouse.click(bc[0], bc[1], { button: 'right' });
    await w.click('.plan-menu button:has-text("Als Linie darstellen")');
    await w.mouse.click(bc[0], bc[1], { button: 'right' });
    await w.click('.plan-menu button:has-text("Neu zeichnen")');
    expect((await w.locator('.plan-side-item:has-text("Mock Bulb")').count()) === 0, 'Das Gerät steht beim Neuzeichnen in der Liste');
    for (const [ux, uy] of [[3, 8], [9, 8]]) {
      const p = await planPx(w, ux, uy);
      await w.mouse.click(p[0], p[1]);
    }
    // Fertig mit unfertiger Linie (zwei Punkte) speichert sie mit
    await w.click('.plan-done-btn');
    await waitFor(() => bulbSaved() === JSON.stringify({ deviceId: 'dev-bulb', shape: 'line', points: [[3, 8], [9, 8]], reversed: false }), 'Bulb als neu gezeichnete Linie', 6000);
    // Eine Linie in Arbeit zählt als Änderung: Desk aus dem Plan nehmen, neu zeichnen (zwei Punkte), Strg+1 fragt, Speichern legt sie an
    await w.click('.plan-edit-btn');
    await planSettled(w);
    const dk = await itemAt('dev-desk');
    await w.mouse.click(dk[0], dk[1]);
    await w.keyboard.press('Delete');
    await w.click('.plan-done-btn');
    await waitFor(() => saved()?.items?.length === 2, 'Desk aus dem Plan genommen', 6000);
    await w.click('.plan-edit-btn');
    await planSettled(w);
    await w.click('.plan-side-item:has-text("Mock Desk")');
    for (const [ux, uy] of [[4, 9], [10, 9]]) {
      const p = await planPx(w, ux, uy);
      await w.mouse.click(p[0], p[1]);
    }
    await w.keyboard.press('Control+1');
    await w.waitForSelector('.modal:has-text("Änderungen speichern?")');
    await w.click('.modal .btn.primary');
    await w.waitForFunction(() => document.querySelector('.device-title')?.textContent === 'Mock Desk');
    const deskSaved = () => JSON.stringify(saved()?.items?.find((i) => i.deviceId === 'dev-desk'));
    await waitFor(() => deskSaved() === JSON.stringify({ deviceId: 'dev-desk', shape: 'line', points: [[4, 9], [10, 9]], reversed: false }), 'Linie in Arbeit über die Rückfrage gespeichert', 6000);
    // Gerät in der App gelöscht, während der Plan bearbeitet wird → verschwindet sofort, auch mit Strg+Z nicht wieder da
    await w.click('.plan-row');
    await w.waitForSelector('.plan-view');
    await w.click('.plan-edit-btn');
    await planSettled(w);
    // Ziehen aus „Noch nicht im Plan“: Matrix aus dem Plan nehmen und aus der Liste an dieselbe Stelle ziehen
    const ma = await planPx(w, 18, 5);
    await w.mouse.click(ma[0], ma[1], { button: 'right' });
    await w.click('.plan-menu button:has-text("Aus dem Plan entfernen")');
    await w.waitForFunction(() => !document.querySelector('.plan-item[data-device="dev-matrix"]'));
    const stageBox = await w.locator('.plan-stage').boundingBox();
    await w.locator('.plan-side-item:has-text("Mock Matrix")').dragTo(w.locator('.plan-stage'), { targetPosition: { x: ma[0] - stageBox.x, y: ma[1] - stageBox.y } });
    await w.waitForSelector('.plan-item[data-device="dev-matrix"]', { timeout: 4000 });
    const dropped = await itemAt('dev-matrix');
    expect(Math.abs(dropped[0] - ma[0]) < 3 && Math.abs(dropped[1] - ma[1]) < 3, `Die Matrix liegt nach dem Ziehen bei ${dropped.map(Math.round)}, nicht bei ${ma.map(Math.round)}`);
    expect((await w.locator('.plan-side-item:has-text("Mock Matrix")').count()) === 0, 'Die Matrix steht nach dem Ziehen noch in der Liste');
    // Das Kontextmenü bleibt in der Bühne, auch am rechten Rand (die Matrix reicht bis Einheit 22)
    const mx = await planPx(w, 21.5, 6.5);
    await w.mouse.click(mx[0], mx[1], { button: 'right' });
    await w.waitForSelector('.plan-menu');
    const inStage = await w.evaluate(() => {
      const m = document.querySelector('.plan-menu').getBoundingClientRect();
      const st = document.querySelector('.plan-stage').getBoundingClientRect();
      return m.left >= st.left && m.top >= st.top && m.right <= st.right && m.bottom <= st.bottom;
    });
    expect(inStage, 'Das Kontextmenü ragt aus der Bühne');
    await w.keyboard.press('Escape');
    await w.waitForSelector('.plan-menu', { state: 'detached' });
    const bm = await planPx(w, 7, 8);
    await w.mouse.click(bm[0], bm[1]);
    await w.keyboard.press('ArrowDown');
    await w.evaluate(() => window.wled.removeDevice('dev-bulb'));
    await w.waitForFunction(() => !document.querySelector('.plan-item[data-device="dev-bulb"]'), null, { timeout: 6000 });
    await w.keyboard.press('Control+z');
    await w.waitForTimeout(300);
    expect((await w.locator('.plan-item[data-device="dev-bulb"]').count()) === 0, 'Strg+Z hat das gelöschte Gerät zurückgebracht');
    await w.click('.plan-done-btn');
    await waitFor(() => saved()?.items?.length === 2, 'Bulb aus plan.json entfernt', 6000);
    // Erst wenn das Bearbeiten beendet ist, darf Strg+1 kommen (sonst fragt es noch nach Änderungen)
    await w.waitForSelector('.plan-side', { state: 'detached' });
    // Die hineingezogene Matrix liegt genau dort, wo sie vorher lag (Einrasten aufs Raster, wie beim Anklicken)
    const matrixRect = JSON.stringify(saved().items.find((i) => i.deviceId === 'dev-matrix')?.rect);
    expect(matrixRect === JSON.stringify({ x: 14, y: 3, w: 8, h: 4 }), `Matrix nach dem Ziehen: ${matrixRect}`);
    // Ohne Bearbeiten: ein gelöschtes Gerät verschwindet ebenfalls aus dem Plan
    await w.keyboard.press('Control+1');
    await w.waitForFunction(() => document.querySelector('.device-title')?.textContent === 'Mock Desk');
    await w.evaluate(() => window.wled.removeDevice('dev-matrix'));
    await waitFor(() => saved()?.items?.length === 1, 'Matrix aus plan.json entfernt', 6000);
    await w.click('.plan-row');
    await w.waitForFunction(() => document.querySelectorAll('.plan-item').length === 1);
    // Speichern scheitert (der Hauptprozess antwortet mit einem Fehler): Meldung, die Bearbeitung bleibt offen, und
    // auch die Rückfrage hängt danach nicht. Der Handler bleibt ersetzt — das ist das Ende des Schritts.
    const deskLine = JSON.stringify(saved().items[0]);
    await w.click('.plan-edit-btn');
    await planSettled(w);
    const d1 = await itemAt('dev-desk');
    await w.mouse.click(d1[0], d1[1]);
    await w.keyboard.press('ArrowRight');
    await pa.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('plan-set');
      ipcMain.handle('plan-set', () => {
        throw new Error('Test');
      });
    });
    await w.click('.plan-done-btn');
    await w.waitForSelector('.toasts:has-text("Speichern fehlgeschlagen")');
    expect((await w.locator('.plan-side').count()) === 1, 'Fertig hat trotz Fehler beim Speichern beendet');
    await w.keyboard.press('Control+1');
    await w.waitForSelector('.modal:has-text("Änderungen speichern?")');
    await w.click('.modal .btn.primary');
    await w.waitForSelector('.modal', { state: 'detached' });
    expect((await w.locator('.plan-side').count()) === 1, 'Die Rückfrage hat trotz Fehler beim Speichern den Plan verlassen');
    expect(JSON.stringify(saved().items[0]) === deskLine, 'Fehlgeschlagenes Speichern hat die Datei geändert');
    expect(await closeApp(pa, 'Raumplan zeichnen'), 'App reagiert nicht auf Beenden');
  } finally {
    await closeApp(pa, 'Raumplan zeichnen');
    removeDir(dir);
  }
});

await step('Keine unerwarteten Fehler im Hauptprozess', async () => {
  expect(!mainErrors.length, `${mainErrors.length}× – ${mainErrors[0]}`);
});
mock.kill();
planMock.kill();
clearTimeout(watchdog);

console.log(`\n${results.join('\n')}`);
if (consoleErrors.length) {
  console.log(`\nKonsolenfehler (${consoleErrors.length}):`);
  for (const e of [...new Set(consoleErrors)].slice(0, 10)) console.log('  ' + e);
}
console.log(`\nScreenshots: ${SHOTS}`);
console.log(failures ? `\n${failures} Schritt(e) fehlgeschlagen` : '\nAlle Schritte bestanden');
process.exit(failures ? 1 : 0);
