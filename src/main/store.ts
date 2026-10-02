import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, DeviceConfig } from '../shared/types';

const DEFAULT_SETTINGS: AppSettings = {
  closeToTray: true,
  startWithWindows: false,
  liveView: false,
  theme: 'system',
  language: 'system',
  autoUpdate: true,
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function cleanDevice(raw: unknown): DeviceConfig | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id || typeof raw.host !== 'string' || !raw.host) return null;
  const device: DeviceConfig = { id: raw.id, host: raw.host };
  for (const k of ['mac', 'alias', 'lastName'] as const) if (typeof raw[k] === 'string') device[k] = raw[k];
  return device;
}

/** Nur bekannte Einstellungen mit gültigem Wert — für Dateien von der Platte und Änderungen aus der Oberfläche. */
export function cleanSettings(raw: unknown): Partial<AppSettings> {
  const out: Partial<AppSettings> = {};
  if (!isObj(raw)) return out;
  for (const k of ['closeToTray', 'startWithWindows', 'liveView', 'autoUpdate', 'trayHintShown'] as const) {
    const v = raw[k];
    if (typeof v === 'boolean') out[k] = v;
  }
  if (raw.theme === 'system' || raw.theme === 'dark' || raw.theme === 'light') out.theme = raw.theme;
  if (raw.language === 'system' || raw.language === 'de' || raw.language === 'en') out.language = raw.language;
  if (typeof raw.selectedId === 'string') out.selectedId = raw.selectedId;
  return out;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Schreibt erst in eine Temp-Datei und benennt dann um, damit ein Absturz nie eine halbe Datei hinterlässt. */
function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export class Store {
  private readonly devicesFile: string;
  private readonly settingsFile: string;
  private devices: DeviceConfig[];
  private settings: AppSettings;
  private saveTimer: NodeJS.Timeout | null = null;
  readonly firstRun: boolean;

  constructor() {
    const dir = app.getPath('userData');
    this.devicesFile = path.join(dir, 'devices.json');
    this.settingsFile = path.join(dir, 'settings.json');
    this.firstRun = !fs.existsSync(this.devicesFile);
    // Von Hand bearbeitete oder beschädigte Dateien: Unbrauchbares fällt weg, statt den Start zu verhindern.
    const devices = readJson<unknown>(this.devicesFile, []);
    const ids = new Set<string>();
    this.devices = (Array.isArray(devices) ? devices : []).flatMap((raw) => {
      const d = cleanDevice(raw);
      if (!d || ids.has(d.id)) return [];
      ids.add(d.id);
      return [d];
    });
    this.settings = { ...DEFAULT_SETTINGS, ...cleanSettings(readJson<unknown>(this.settingsFile, {})) };
  }

  getDevices(): DeviceConfig[] {
    return this.devices.map((d) => ({ ...d }));
  }

  setDevices(devices: DeviceConfig[]): void {
    this.devices = devices.map((d) => ({ ...d }));
    this.scheduleSave();
  }

  getSettings(): AppSettings {
    return { ...this.settings };
  }

  setSettings(patch: Partial<AppSettings>): AppSettings {
    this.settings = { ...this.settings, ...patch };
    this.scheduleSave();
    return this.getSettings();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 300);
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      writeJsonAtomic(this.devicesFile, this.devices);
      writeJsonAtomic(this.settingsFile, this.settings);
    } catch (err) {
      console.error('Speichern fehlgeschlagen', err);
    }
  }
}
