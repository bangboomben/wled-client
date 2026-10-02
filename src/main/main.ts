import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  nativeTheme,
  dialog,
  screen,
  session,
  shell,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import path from 'node:path';
import { key, resolveLanguage, setLanguage, t } from '../shared/i18n';
import { groupMembers, groupView, powerTargets } from '../shared/groups';
import { cleanLook } from '../shared/look';
import type { AppSettings, DeviceGroup, DevicePage, DeviceSnapshot, ScanResult, UpdateState } from '../shared/types';
import { DeviceManager } from './devices';
import { Scanner, localSubnets } from './discovery';
import { GroupManager } from './groups';
import { Store } from './store';
import { cleanSettings } from './store-data';
import { Updater } from './updater';

// Ein unerwarteter Fehler im Hauptprozess wird protokolliert, statt Electrons modales Fehlerfenster
// zu öffnen: Das blockiert den Hauptprozess, und die App lässt sich nicht mehr beenden.
process.on('uncaughtException', (err) => console.error('Unerwarteter Fehler im Hauptprozess:', err));

// Für Tests: eigenes Datenverzeichnis, damit eine installierte Instanz unberührt bleibt.
if (process.env.WLED_CLIENT_USER_DATA) app.setPath('userData', process.env.WLED_CLIENT_USER_DATA);

// Nur in der Entwicklung: Die installierte App lädt ihre Oberfläche nie von einer fremden Adresse.
const DEV_URL = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL;
const RENDERER_DIR = path.join(__dirname, '../dist/renderer');
const RESOURCES = path.join(__dirname, '../resources');
const PRELOAD = path.join(__dirname, 'preload.cjs');
const startHidden = process.argv.includes('--hidden');

const FLYOUT_WIDTH = 344;
const THEME = {
  dark: { bg: '#0f1115', fg: '#e8eaf0' },
  light: { bg: '#f4f5f7', fg: '#15181e' },
};

const PAGE_PATHS: Record<DevicePage, [string, string]> = {
  ui: ['/', key('Weboberfläche')],
  settings: ['/settings', key('Einstellungen')],
  wifi: ['/settings/wifi', key('WLAN')],
  leds: ['/settings/leds', key('LED-Einstellungen')],
  '2D': ['/settings/2D', key('2D-Konfiguration')],
  'ui-settings': ['/settings/ui', key('Oberfläche')],
  sync: ['/settings/sync', key('Sync-Schnittstellen')],
  time: ['/settings/time', key('Zeit & Makros')],
  sec: ['/settings/sec', key('Sicherheit & Updates')],
  um: ['/settings/um', key('Usermods')],
  cpal: ['/cpal.htm', key('Paletten-Editor')],
  edit: ['/edit', key('Datei-Editor')],
  update: ['/update', key('Firmware-Update')],
};

let store: Store;
let manager: DeviceManager;
let groups: GroupManager;
let updater: Updater;
const scanner = new Scanner();
let mainWin: BrowserWindow | null = null;
let flyoutWin: BrowserWindow | null = null;
let tray: Tray | null = null;
const pageWindows = new Map<string, BrowserWindow>();
let quitting = false;
let lastFlyoutHide = 0;
let liveRequest: string | null = null;
let trayTimer: NodeJS.Timeout | null = null;

const theme = () => (nativeTheme.shouldUseDarkColors ? THEME.dark : THEME.light);
const appIcon = () => nativeImage.createFromPath(path.join(RESOURCES, 'icon.ico'));

function loadPage(win: BrowserWindow, page: 'index' | 'flyout'): void {
  if (DEV_URL) void win.loadURL(`${DEV_URL}/${page}.html`);
  else void win.loadFile(path.join(RENDERER_DIR, `${page}.html`));
}

function secureWebContents(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    });
  }
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of [mainWin, flyoutWin]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}

// ------------------------------------------------------------------ Hauptfenster

function createMainWindow(): BrowserWindow {
  const t = theme();
  const win = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'WLED Client',
    icon: appIcon(),
    backgroundColor: t.bg,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: t.bg, symbolColor: t.fg, height: 44 },
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  secureWebContents(win);
  loadPage(win, 'index');

  win.once('ready-to-show', () => {
    if (!startHidden) win.show();
  });
  win.on('close', (e) => {
    if (quitting) return;
    if (store.getSettings().closeToTray) {
      e.preventDefault();
      win.hide();
      showTrayHintOnce();
    } else {
      quitApp();
    }
  });
  win.on('closed', () => {
    mainWin = null;
  });
  for (const ev of ['show', 'hide', 'minimize', 'restore'] as const) win.on(ev as 'show', updateLive);
  return win;
}

function showMain(deviceId?: string): void {
  if (!mainWin || mainWin.isDestroyed()) mainWin = createMainWindow();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
  if (deviceId) mainWin.webContents.send('select', deviceId);
  flyoutWin?.hide();
}

function showTrayHintOnce(): void {
  if (store.getSettings().trayHintShown || !tray) return;
  store.setSettings({ trayHintShown: true });
  tray.displayBalloon({
    iconType: 'info',
    title: t('WLED Client läuft weiter'),
    content: t('Klick auf das Symbol im Infobereich: Ein/Aus und Helligkeit aller Geräte. Rechtsklick: Menü und Beenden.'),
  });
}

function updateLive(): void {
  const visible = !!mainWin && mainWin.isVisible() && !mainWin.isMinimized();
  manager.setLive(visible && store.getSettings().liveView ? liveRequest : null);
}

// ------------------------------------------------------------------ Schnellzugriff (Tray)

function createFlyout(): BrowserWindow {
  const win = new BrowserWindow({
    width: FLYOUT_WIDTH,
    height: 320,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: theme().bg,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  secureWebContents(win);
  loadPage(win, 'flyout');
  win.on('blur', () => {
    if (process.env.WLED_CLIENT_KEEP_FLYOUT) return;
    win.hide();
    lastFlyoutHide = Date.now();
  });
  win.on('closed', () => {
    flyoutWin = null;
  });
  return win;
}

function positionFlyout(height = flyoutWin?.getBounds().height ?? 320): void {
  if (!flyoutWin) return;
  const tb = tray?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 };
  const point = tb.width ? { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 } : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const wa = display.workArea;
  const b = display.bounds;
  const gap = 12;
  const w = FLYOUT_WIDTH;
  let x = Math.round(point.x - w / 2);
  let y = wa.y + wa.height - height - gap; // Taskleiste unten (Standard)
  if (wa.y > b.y) y = wa.y + gap; // oben
  else if (wa.x > b.x) {
    x = wa.x + gap; // links
    y = Math.round(point.y - height / 2);
  } else if (wa.width < b.width) {
    x = wa.x + wa.width - w - gap; // rechts
    y = Math.round(point.y - height / 2);
  }
  x = Math.min(Math.max(x, wa.x + gap), wa.x + wa.width - w - gap);
  y = Math.min(Math.max(y, wa.y + gap), wa.y + wa.height - height - gap);
  flyoutWin.setBounds({ x, y, width: w, height });
}

function toggleFlyout(): void {
  if (!flyoutWin || flyoutWin.isDestroyed()) flyoutWin = createFlyout();
  if (flyoutWin.isVisible()) {
    flyoutWin.hide();
    return;
  }
  // Der Klick aufs Tray-Symbol hat den Flyout eben per Fokusverlust geschlossen.
  if (Date.now() - lastFlyoutHide < 300) return;
  positionFlyout();
  flyoutWin.show();
  flyoutWin.focus();
}

function trayIcon(anyOn: boolean) {
  return nativeImage.createFromPath(path.join(RESOURCES, anyOn ? 'tray-on.ico' : 'tray-off.ico'));
}

/** Windows liest „&“ in Menütexten als Tastenkürzel-Markierung; „&&“ zeigt ein echtes „&“. */
const menuLabel = (s: string) => s.replace(/&/g, '&&');

function buildTrayMenu(): Menu {
  const devices = manager.list();
  const groupItems = groups.list().map((g): MenuItemConstructorOptions => {
    const members = groupMembers(g, devices);
    const view = groupView(members);
    return {
      label: menuLabel(g.name),
      type: 'checkbox',
      checked: view.lit,
      enabled: view.reachable > 0,
      click: () => {
        for (const id of powerTargets(members)) void manager.send(id, { on: !view.lit });
      },
    };
  });
  const items: MenuItemConstructorOptions[] = [
    { label: t('WLED Client öffnen'), click: () => showMain() },
    { type: 'separator' },
    ...groupItems,
    ...(groupItems.length ? [{ type: 'separator' } as const] : []),
    ...devices.map(
      (d): MenuItemConstructorOptions => ({
        label: d.status === 'online' ? menuLabel(d.name) : t('{name} (offline)', { name: menuLabel(d.name) }),
        type: 'checkbox',
        checked: d.status === 'online' && !!d.state?.on,
        enabled: d.status === 'online',
        click: () => void manager.send(d.id, { on: !d.state?.on }),
      }),
    ),
  ];
  if (devices.length) items.push({ type: 'separator' });
  items.push(
    { label: t('Alle einschalten'), enabled: devices.length > 0, click: () => manager.sendAll({ on: true }) },
    { label: t('Alle ausschalten'), enabled: devices.length > 0, click: () => manager.sendAll({ on: false }) },
    { type: 'separator' },
    { label: t('Beenden'), click: () => quitApp() },
  );
  return Menu.buildFromTemplate(items);
}

function updateTray(): void {
  if (trayTimer) return;
  trayTimer = setTimeout(() => {
    trayTimer = null;
    if (!tray) return;
    const devices = manager.list();
    const online = devices.filter((d) => d.status === 'online');
    const on = online.filter((d) => d.state?.on);
    tray.setImage(trayIcon(on.length > 0));
    tray.setToolTip(
      devices.length
        ? online.length < devices.length
          ? t('WLED Client — {on} von {total} an, {off} offline', { on: on.length, total: devices.length, off: devices.length - online.length })
          : t('WLED Client — {on} von {total} an', { on: on.length, total: devices.length })
        : 'WLED Client',
    );
  }, 150);
}

function createTray(): void {
  tray = new Tray(trayIcon(false));
  tray.setToolTip('WLED Client');
  tray.on('click', toggleFlyout);
  tray.on('right-click', () => tray?.popUpContextMenu(buildTrayMenu()));
  updateTray();
}

// ------------------------------------------------------------------ Geräteseiten (WLED-Weboberfläche)

/**
 * Die Seiten der Geräte kommen aus dem Netzwerk und laufen in einer eigenen Sitzung mit nur den
 * Rechten, die die WLED-Oberfläche braucht — vor allem ohne „openExternal“, über das eine Seite
 * andere Programme per Link-Protokoll starten könnte. Die eigenen Fenster brauchen gar keine.
 */
const DEVICE_PARTITION = 'persist:device-pages';
const DEVICE_PERMISSIONS = new Set<string>(['clipboard-sanitized-write', 'local-network-access', 'local-network', 'loopback-network']);

function restrictPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const pages = session.fromPartition(DEVICE_PARTITION);
  pages.setPermissionRequestHandler((_wc, permission, callback) => callback(DEVICE_PERMISSIONS.has(permission)));
  pages.setPermissionCheckHandler((_wc, permission) => DEVICE_PERMISSIONS.has(permission));
}

/**
 * Öffnet http(s)-Links aus einer Geräteseite im Browser — aber nur kurz nach einer Eingabe im
 * Fenster, damit eine Seite nicht von sich aus Browserfenster öffnen kann.
 */
function linkOpener(wc: WebContents): (url: string) => void {
  let lastInput = 0;
  wc.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown') lastInput = Date.now();
  });
  wc.on('before-mouse-event', (_e, mouse) => {
    if (mouse.type === 'mouseDown') lastInput = Date.now();
  });
  return (url) => {
    if (/^https?:\/\//i.test(url) && Date.now() - lastInput < 2000) void shell.openExternal(url);
  };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function openDevicePage(id: string, page: DevicePage): void {
  const conn = manager.get(id);
  if (!conn || !Object.hasOwn(PAGE_PATHS, page)) return;
  const [urlPath, label] = PAGE_PATHS[page];
  let win = pageWindows.get(id);
  if (!win || win.isDestroyed()) {
    const w = new BrowserWindow({
      width: 1040,
      height: 840,
      title: `${conn.displayName} — ${t(label)}`,
      icon: appIcon(),
      autoHideMenuBar: true,
      backgroundColor: '#111111',
      webPreferences: { partition: DEVICE_PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    w.setMenuBarVisibility(false);
    w.on('page-title-updated', (e) => e.preventDefault());
    const openLink = linkOpener(w.webContents);
    // Die Adresse wird bei jeder Prüfung neu gelesen: Sie kann sich ändern, während das Fenster offen ist.
    const onDevice = (url: string) => {
      try {
        return new URL(url).origin === new URL(`http://${conn.host}`).origin;
      } catch {
        return false;
      }
    };
    w.webContents.setWindowOpenHandler(({ url }) => {
      openLink(url);
      return { action: 'deny' };
    });
    // Jeder Rahmen (auch iframes) bleibt auf dem Gerät; Links nach außen öffnet der Browser.
    w.webContents.on('will-frame-navigate', (e) => {
      if (onDevice(e.url) || e.url === 'about:blank' || e.url === 'about:srcdoc') return;
      e.preventDefault();
      if (e.isMainFrame) openLink(e.url);
    });
    w.webContents.on('will-redirect', (e) => {
      if (!onDevice(e.url)) e.preventDefault();
    });
    w.webContents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
      // -3: abgebrochen, etwa durch eine neue Navigation oder einen blockierten Link
      if (!isMainFrame || code === -3) return;
      const text = t('{host} antwortet nicht ({reason}).', { host: conn.host, reason: description });
      const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#111;color:#bbb;font:15px 'Segoe UI',sans-serif"><p>${escapeHtml(text)}</p>`;
      void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    });
    w.on('closed', () => {
      pageWindows.delete(id);
      // Einstellungen können LED-Zahl, Name, Paletten oder Presets geändert haben.
      void conn.loadStatic();
    });
    pageWindows.set(id, w);
    win = w;
  }
  win.setTitle(`${conn.displayName} — ${t(label)}`);
  void win.loadURL(`http://${conn.host}${urlPath}`);
  win.show();
  win.focus();
}

// ------------------------------------------------------------------ Einstellungen

function applySettings(patch: unknown): AppSettings {
  const clean = cleanSettings(patch);
  const next = store.setSettings(clean);
  if (clean.theme) nativeTheme.themeSource = next.theme;
  if (clean.startWithWindows !== undefined && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: next.startWithWindows, args: ['--hidden'] });
  }
  if (clean.liveView !== undefined) updateLive();
  if (clean.autoUpdate !== undefined) updater.schedule(next.autoUpdate);
  if (clean.language) {
    applyLanguage();
    updateTray();
  }
  broadcast('settings', next);
  return next;
}

function applyLanguage(): void {
  setLanguage(resolveLanguage(store.getSettings().language, app.getLocale()));
}

function applyTheme(): void {
  const t = theme();
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.setTitleBarOverlay({ color: t.bg, symbolColor: t.fg, height: 44 });
    mainWin.setBackgroundColor(t.bg);
  }
  flyoutWin?.setBackgroundColor(t.bg);
}

// ------------------------------------------------------------------ IPC

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length < 100;
const isPatch = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function registerIpc(): void {
  ipcMain.handle('snapshot', () => ({
    devices: manager.list(),
    groups: groups.list(),
    settings: store.getSettings(),
    version: app.getVersion(),
    update: updater.state,
  }));
  ipcMain.on('update-check', () => updater.check());
  ipcMain.on('update-install', () => updater.install());
  ipcMain.handle('static', (_e, id: unknown) => (isId(id) ? (manager.get(id)?.staticData ?? null) : null));
  ipcMain.handle('palettes', (_e, id: unknown) => (isId(id) ? (manager.get(id)?.loadPalettes() ?? null) : null));
  ipcMain.on('send', (_e, id: unknown, patch: unknown, key: unknown) => {
    if (isId(id) && isPatch(patch)) void manager.send(id, patch, typeof key === 'string' ? key : undefined);
  });
  ipcMain.on('send-all', (_e, patch: unknown) => {
    if (isPatch(patch)) manager.sendAll(patch);
  });
  ipcMain.handle('command', (_e, id: unknown, patch: unknown) =>
    isId(id) && isPatch(patch) ? manager.send(id, patch, undefined, true) : { ok: false, error: t('Ungültiger Befehl') },
  );
  ipcMain.handle('refresh', async (_e, id: unknown) => {
    if (isId(id)) await manager.get(id)?.loadStatic();
  });
  ipcMain.handle('add', (_e, host: unknown) => manager.add(String(host ?? '')));
  ipcMain.handle('remove', (_e, id: unknown) => {
    if (isId(id)) manager.remove(id);
  });
  ipcMain.handle('update', (_e, id: unknown, changes: unknown) => {
    if (!isId(id) || !isPatch(changes)) return { ok: false, error: t('Ungültig') };
    const { alias, host } = changes;
    if (![alias, host].every((v) => v === undefined || typeof v === 'string')) return { ok: false, error: t('Ungültig') };
    return manager.update(id, { alias: alias as string | undefined, host: host as string | undefined });
  });
  ipcMain.handle('reorder', (_e, ids: unknown) => {
    if (Array.isArray(ids)) manager.reorder(ids.filter(isId));
  });
  ipcMain.handle('group-create', (_e, input: unknown) =>
    isPatch(input) ? groups.create({ name: input.name, members: input.members }) : { ok: false, error: t('Ungültig') },
  );
  ipcMain.handle('group-update', (_e, id: unknown, input: unknown) =>
    isId(id) && isPatch(input) ? groups.update(id, { name: input.name, members: input.members }) : { ok: false, error: t('Ungültig') },
  );
  ipcMain.handle('group-remove', (_e, id: unknown) => {
    if (isId(id)) groups.remove(id);
  });
  ipcMain.handle('copy-look', (_e, look: unknown, ids: unknown) => {
    const clean = cleanLook(look);
    if (!clean || !Array.isArray(ids)) return [];
    return manager.copyLook(clean, [...new Set(ids.filter(isId))]);
  });
  ipcMain.handle('subnets', () => localSubnets());
  ipcMain.handle('discover', async () => {
    const { online, macToId } = knownDevices();
    await adoptMoved(await scanner.discover(online, macToId));
  });
  ipcMain.handle('scan', async (_e, targets: unknown) => {
    if (!Array.isArray(targets)) return;
    const { online, macToId } = knownDevices();
    await adoptMoved(await scanner.sweep(targets.map(String), online, macToId));
  });
  ipcMain.on('scan-cancel', () => scanner.cancel());
  ipcMain.on('live', (_e, id: unknown) => {
    liveRequest = isId(id) ? id : null;
    updateLive();
  });
  ipcMain.on('page', (_e, id: unknown, page: unknown) => {
    if (isId(id) && typeof page === 'string' && Object.hasOwn(PAGE_PATHS, page)) openDevicePage(id, page as DevicePage);
  });
  ipcMain.handle('settings-get', () => store.getSettings());
  ipcMain.handle('settings-set', (_e, patch: unknown) => applySettings(patch));
  ipcMain.on('show-main', (_e, id: unknown) => showMain(isId(id) ? id : undefined));
  ipcMain.on('flyout-resize', (_e, h: unknown) => {
    if (!flyoutWin || typeof h !== 'number' || !Number.isFinite(h)) return;
    positionFlyout(Math.min(Math.max(Math.ceil(h), 140), 680));
  });
  ipcMain.on('flyout-hide', () => flyoutWin?.hide());
  ipcMain.on('quit', () => quitApp());
}

// ------------------------------------------------------------------ Suche

/** Verbundene Geräte als fertige Suchergebnisse und die MAC-Zuordnung aller gespeicherten Geräte. */
function knownDevices(): { online: ScanResult[]; macToId: Map<string, string> } {
  const all = manager.all();
  const online = all.flatMap((c) =>
    c.status === 'online' && c.info
      ? [{ host: c.host, name: c.info.name, mac: c.info.mac, ver: c.info.ver, leds: c.info.leds.count, knownId: c.id }]
      : [],
  );
  return { online, macToId: new Map(all.filter((c) => c.config.mac).map((c) => [c.config.mac!, c.id])) };
}

/**
 * Gespeicherte Geräte, die gerade nicht erreichbar sind und die Suche unter einer neuen Adresse
 * findet (neue IP vom Router), ziehen dorthin um. Erreichbare Geräte bleiben, wie sie sind —
 * wer einen Hostnamen eingetragen hat, behält ihn.
 */
async function adoptMoved(found: ScanResult[]): Promise<void> {
  for (const r of found) {
    const conn = r.knownId ? manager.get(r.knownId) : undefined;
    if (conn && conn.status !== 'online' && conn.host !== r.host) await manager.add(r.host);
  }
}

/** Erster Start ohne Geräte: alles übernehmen, was sich im Netzwerk meldet. */
async function firstRunDiscovery(): Promise<void> {
  const found = await scanner.discover([], new Map());
  for (const r of found) await manager.add(r.host);
}

// ------------------------------------------------------------------ Start

function quitApp(): void {
  quitting = true;
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('io.github.bangboomben.wled-client');
  app.on('second-instance', () => showMain());
  app.on('before-quit', () => {
    quitting = true;
    store?.flush();
    manager?.stopAll();
  });
  // Tray-App: Schließen des letzten Fensters beendet nicht.
  app.on('window-all-closed', () => {});

  void app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    restrictPermissions();
    store = new Store();
    applyLanguage();
    nativeTheme.themeSource = store.getSettings().theme;
    nativeTheme.on('updated', applyTheme);
    manager = new DeviceManager(store);
    groups = new GroupManager(store, () => manager.list().map((d) => d.id));
    groups.on('groups', (list: DeviceGroup[]) => broadcast('groups', list));
    manager.on('device', (snap: DeviceSnapshot) => {
      broadcast('device', snap);
      updateTray();
    });
    manager.on('list', (list: DeviceSnapshot[]) => {
      broadcast('devices', list);
      // Entfernte Geräte fallen aus allen Gruppen.
      groups.pruneDevices(list.map((d) => d.id));
      updateTray();
    });
    manager.on('toast', (msg: string) => mainWin?.webContents.send('toast', msg));
    manager.on('live', (id: string, frame: Uint8Array) => {
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('live', id, frame);
    });
    scanner.on('progress', (p) => broadcast('scan', p));
    updater = new Updater();
    updater.on('state', (state: UpdateState) => {
      broadcast('update', state);
      if (state.status === 'ready') {
        tray?.displayBalloon({
          iconType: 'info',
          title: t('Update bereit'),
          content: t('WLED Client {version} wird beim nächsten Beenden installiert — oder jetzt über die App.', { version: state.version ?? '' }),
        });
      }
    });
    updater.on('before-install', () => {
      quitting = true;
    });
    updater.schedule(store.getSettings().autoUpdate);
    registerIpc();
    manager.init();
    createTray();
    mainWin = createMainWindow();
    flyoutWin = createFlyout();
    if (store.firstRun && manager.size === 0) {
      mainWin.webContents.once('did-finish-load', () => void firstRunDiscovery());
    }
  }).catch((err: unknown) => {
    // Ohne Fenster und Tray liefe die App unsichtbar weiter und blockierte jeden neuen Start.
    console.error('Start fehlgeschlagen', err);
    dialog.showErrorBox('WLED Client', t('Start fehlgeschlagen: {reason}', { reason: err instanceof Error ? err.message : String(err) }));
    app.exit(1);
  });
}
