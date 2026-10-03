// Ende-zu-Ende-Test gegen simulierte Geräte (scripts/mock-wled.mjs) — keine echten Lampen.
//   npm run build && npm run e2e [-- --shots <ordner>]
// Startet die gebaute App über Playwright mit eigenem Datenverzeichnis, klickt die
// Hauptwege durch und prüft, was beim Gerät ankommt.

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const MDNS_PORT = 18353;
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
// Kein Schritt darf den Lauf unbegrenzt aufhalten (etwa ein Fenster, das sich nicht schließen lässt).
const WATCHDOG_MS = 8 * 60_000;
const watchdog = setTimeout(() => {
  console.log(`\nAbbruch: Test läuft länger als ${WATCHDOG_MS / 60_000} min`);
  mock.kill();
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
const launch = async (dataDir) => {
  const electronApp = await electron.launch({
    ...(EXE ? { executablePath: path.resolve(EXE), args: [] } : { args: ['.'] }),
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
  });
  return electronApp;
};
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
await step('Keine unerwarteten Fehler im Hauptprozess', async () => {
  expect(!mainErrors.length, `${mainErrors.length}× – ${mainErrors[0]}`);
});
mock.kill();
clearTimeout(watchdog);

console.log(`\n${results.join('\n')}`);
if (consoleErrors.length) {
  console.log(`\nKonsolenfehler (${consoleErrors.length}):`);
  for (const e of [...new Set(consoleErrors)].slice(0, 10)) console.log('  ' + e);
}
console.log(`\nScreenshots: ${SHOTS}`);
console.log(failures ? `\n${failures} Schritt(e) fehlgeschlagen` : '\nAlle Schritte bestanden');
process.exit(failures ? 1 : 0);
