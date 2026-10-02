import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, DeviceConfig } from '../shared/types';
import { DEFAULT_SETTINGS, cleanDevices, cleanSettings } from './store-data';

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
    this.devices = cleanDevices(readJson<unknown>(this.devicesFile, []));
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
