import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import path from 'node:path';
import type { AppSettings, DevicePage, DeviceSnapshot } from '../shared/types';
import { DeviceManager } from './devices';
import { Scanner, localSubnets } from './discovery';
import { Store } from './store';

// Für Tests: eigenes Datenverzeichnis, damit eine installierte Instanz unberührt bleibt.
if (process.env.WLED_CLIENT_USER_DATA) app.setPath('userData', process.env.WLED_CLIENT_USER_DATA);

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
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
  ui: ['/', 'Weboberfläche'],
  settings: ['/settings', 'Einstellungen'],
  wifi: ['/settings/wifi', 'WLAN'],
  leds: ['/settings/leds', 'LED-Einstellungen'],
  '2D': ['/settings/2D', '2D-Konfiguration'],
  'ui-settings': ['/settings/ui', 'Oberfläche'],
  sync: ['/settings/sync', 'Sync-Schnittstellen'],
  time: ['/settings/time', 'Zeit & Makros'],
  sec: ['/settings/sec', 'Sicherheit & Updates'],
  um: ['/settings/um', 'Usermods'],
  cpal: ['/cpal.htm', 'Paletten-Editor'],
  edit: ['/edit', 'Datei-Editor'],
  update: ['/update', 'Firmware-Update'],
};

let store: Store;
let manager: DeviceManager;
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
    title: 'WLED Client läuft weiter',
    content: 'Klick auf das Symbol im Infobereich: Ein/Aus und Helligkeit aller Geräte. Rechtsklick: Menü und Beenden.',
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

function buildTrayMenu(): Menu {
  const devices = manager.list();
  const items: MenuItemConstructorOptions[] = [
    { label: 'WLED Client öffnen', click: () => showMain() },
    { type: 'separator' },
    ...devices.map(
      (d): MenuItemConstructorOptions => ({
        label: d.status === 'online' ? d.name : `${d.name} (offline)`,
        type: 'checkbox',
        checked: d.status === 'online' && !!d.state?.on,
        enabled: d.status === 'online',
        click: () => void manager.send(d.id, { on: !d.state?.on }),
      }),
    ),
  ];
  if (devices.length) items.push({ type: 'separator' });
  items.push(
    { label: 'Alle einschalten', enabled: devices.length > 0, click: () => manager.sendAll({ on: true }) },
    { label: 'Alle ausschalten', enabled: devices.length > 0, click: () => manager.sendAll({ on: false }) },
    { type: 'separator' },
    { label: 'Beenden', click: () => quitApp() },
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
        ? `WLED Client — ${on.length} von ${devices.length} an${online.length < devices.length ? `, ${devices.length - online.length} offline` : ''}`
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

function openDevicePage(id: string, page: DevicePage): void {
  const conn = manager.get(id);
  const target = PAGE_PATHS[page];
  if (!conn || !target) return;
  const [urlPath, label] = target;
  const host = conn.host;
  let win = pageWindows.get(id);
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({
      width: 1040,
      height: 840,
      title: `${conn.displayName} — ${label}`,
      icon: appIcon(),
      autoHideMenuBar: true,
      backgroundColor: '#111111',
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.setMenuBarVisibility(false);
    win.on('page-title-updated', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      try {
        if (new URL(url).host === host) return;
      } catch {
        /* ungültige URL */
      }
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    });
    win.on('closed', () => {
      pageWindows.delete(id);
      // Einstellungen können LED-Zahl, Name, Paletten oder Presets geändert haben.
      void conn.loadStatic();
    });
    pageWindows.set(id, win);
  }
  win.setTitle(`${conn.displayName} — ${label}`);
  void win.loadURL(`http://${host}${urlPath}`);
  win.show();
  win.focus();
}

// ------------------------------------------------------------------ Einstellungen

function applySettings(patch: Partial<AppSettings>): AppSettings {
  const clean: Partial<AppSettings> = {};
  if (typeof patch.closeToTray === 'boolean') clean.closeToTray = patch.closeToTray;
  if (typeof patch.startWithWindows === 'boolean') clean.startWithWindows = patch.startWithWindows;
  if (typeof patch.liveView === 'boolean') clean.liveView = patch.liveView;
  if (patch.theme === 'system' || patch.theme === 'dark' || patch.theme === 'light') clean.theme = patch.theme;
  if (typeof patch.selectedId === 'string') clean.selectedId = patch.selectedId;
  const next = store.setSettings(clean);
  if (clean.theme) nativeTheme.themeSource = next.theme;
  if (clean.startWithWindows !== undefined && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: next.startWithWindows, args: ['--hidden'] });
  }
  if (clean.liveView !== undefined) updateLive();
  broadcast('settings', next);
  return next;
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
  ipcMain.handle('snapshot', () => ({ devices: manager.list(), settings: store.getSettings(), version: app.getVersion() }));
  ipcMain.handle('static', (_e, id: unknown) => (isId(id) ? (manager.get(id)?.staticData ?? null) : null));
  ipcMain.handle('palettes', (_e, id: unknown) => (isId(id) ? (manager.get(id)?.loadPalettes() ?? null) : null));
  ipcMain.on('send', (_e, id: unknown, patch: unknown, key: unknown) => {
    if (isId(id) && isPatch(patch)) void manager.send(id, patch, typeof key === 'string' ? key : undefined);
  });
  ipcMain.on('send-all', (_e, patch: unknown) => {
    if (isPatch(patch)) manager.sendAll(patch);
  });
  ipcMain.handle('command', (_e, id: unknown, patch: unknown) =>
    isId(id) && isPatch(patch) ? manager.send(id, patch) : { ok: false, error: 'Ungültiger Befehl' },
  );
  ipcMain.handle('refresh', async (_e, id: unknown) => {
    if (isId(id)) await manager.get(id)?.loadStatic();
  });
  ipcMain.handle('add', (_e, host: unknown) => manager.add(String(host ?? '')));
  ipcMain.handle('remove', (_e, id: unknown) => {
    if (isId(id)) manager.remove(id);
  });
  ipcMain.handle('update', (_e, id: unknown, changes: unknown) =>
    isId(id) && isPatch(changes)
      ? manager.update(id, changes as { alias?: string; host?: string })
      : { ok: false, error: 'Ungültig' },
  );
  ipcMain.handle('reorder', (_e, ids: unknown) => {
    if (Array.isArray(ids)) manager.reorder(ids.filter(isId));
  });
  ipcMain.handle('subnets', () => localSubnets());
  ipcMain.handle('scan', async (_e, targets: unknown) => {
    if (!Array.isArray(targets)) return;
    const known = manager.all();
    const macToId = new Map(known.filter((c) => c.config.mac).map((c) => [c.config.mac!, c.id]));
    const knownHosts = known.filter((c) => c.status === 'online').map((c) => c.host);
    await scanner.run(targets.map(String), knownHosts, macToId);
  });
  ipcMain.on('scan-cancel', () => scanner.cancel());
  ipcMain.on('live', (_e, id: unknown) => {
    liveRequest = isId(id) ? id : null;
    updateLive();
  });
  ipcMain.on('page', (_e, id: unknown, page: unknown) => {
    if (isId(id) && typeof page === 'string' && page in PAGE_PATHS) openDevicePage(id, page as DevicePage);
  });
  ipcMain.handle('settings-get', () => store.getSettings());
  ipcMain.handle('settings-set', (_e, patch: unknown) => applySettings(isPatch(patch) ? patch : {}));
  ipcMain.on('show-main', (_e, id: unknown) => showMain(isId(id) ? id : undefined));
  ipcMain.on('flyout-resize', (_e, h: unknown) => {
    if (!flyoutWin || typeof h !== 'number' || !Number.isFinite(h)) return;
    positionFlyout(Math.min(Math.max(Math.ceil(h), 140), 680));
  });
  ipcMain.on('flyout-hide', () => flyoutWin?.hide());
  ipcMain.on('quit', () => quitApp());
}

// ------------------------------------------------------------------ Start

async function firstRunDiscovery(): Promise<void> {
  const subnets = localSubnets();
  if (!subnets.length) return;
  const found = await scanner.run(subnets, [], new Map());
  for (const r of found) await manager.add(r.host);
}

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
    store = new Store();
    nativeTheme.themeSource = store.getSettings().theme;
    nativeTheme.on('updated', applyTheme);
    manager = new DeviceManager(store);
    manager.on('device', (snap: DeviceSnapshot) => {
      broadcast('device', snap);
      updateTray();
    });
    manager.on('list', (list: DeviceSnapshot[]) => {
      broadcast('devices', list);
      updateTray();
    });
    manager.on('toast', (msg: string) => mainWin?.webContents.send('toast', msg));
    manager.on('live', (id: string, frame: Uint8Array) => {
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('live', id, frame);
    });
    scanner.on('progress', (p) => broadcast('scan', p));
    registerIpc();
    manager.init();
    createTray();
    mainWin = createMainWindow();
    flyoutWin = createFlyout();
    if (store.firstRun && manager.size === 0) {
      mainWin.webContents.once('did-finish-load', () => void firstRunDiscovery());
    }
  });
}
