import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { EventEmitter } from 'node:events';
import type { UpdateState } from '../shared/types';

const FIRST_CHECK_MS = Number(process.env.WLED_CLIENT_UPDATE_DELAY ?? 15_000);
const INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Automatische Updates über die GitHub-Releases (electron-updater, Konfiguration in
 * package.json → build.publish). Lädt im Hintergrund und installiert beim nächsten
 * Beenden oder auf Knopfdruck.
 *
 * Für Tests lässt sich die Quelle per WLED_CLIENT_UPDATE_URL auf einen lokalen Ordner
 * mit latest.yml umlenken (Provider „generic“).
 */
export class Updater extends EventEmitter {
  state: UpdateState;
  private timer: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private readonly enabled: boolean;

  constructor() {
    super();
    const testUrl = process.env.WLED_CLIENT_UPDATE_URL;
    this.enabled = app.isPackaged || !!testUrl;
    this.state = { status: this.enabled ? 'idle' : 'unsupported', current: app.getVersion() };
    if (!this.enabled) return;

    if (testUrl) autoUpdater.setFeedURL({ provider: 'generic', url: testUrl });
    autoUpdater.autoDownload = true;
    // Test-Quelle: nie still beim Beenden installieren — sonst überschreibt ein Test die echte Installation.
    autoUpdater.autoInstallOnAppQuit = !testUrl;
    autoUpdater.logger = null;

    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'latest', version: undefined }));
    autoUpdater.on('update-available', (info) => this.set({ status: 'downloading', version: info.version, progress: 0 }));
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', progress: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version, progress: 100 }));
    autoUpdater.on('error', (err) => this.set({ status: 'error', error: err?.message ?? String(err) }));
  }

  /** Startet die regelmäßige Prüfung (oder stoppt sie). */
  schedule(auto: boolean): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    this.timer = null;
    this.interval = null;
    if (!this.enabled || !auto) return;
    this.timer = setTimeout(() => this.check(), FIRST_CHECK_MS);
    this.interval = setInterval(() => this.check(), INTERVAL_MS);
  }

  check(): void {
    if (!this.enabled || this.state.status === 'downloading' || this.state.status === 'ready') return;
    autoUpdater.checkForUpdates().catch((err: Error) => this.set({ status: 'error', error: err.message }));
  }

  /** Beendet die App, installiert still und startet neu. */
  install(): void {
    if (this.state.status !== 'ready') return;
    this.emit('before-install');
    autoUpdater.quitAndInstall(true, true);
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    if (patch.status && patch.status !== 'error') this.state.error = undefined;
    this.emit('state', this.state);
  }
}
