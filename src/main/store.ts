import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, DeviceConfig, DeviceGroup, RoomPlan } from '../shared/types';
import { DEFAULT_SETTINGS, cleanDevices, cleanGroups, cleanSettings, readPlanFile } from './store-data';

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
  private readonly groupsFile: string;
  private readonly planFile: string;
  private devices: DeviceConfig[];
  private settings: AppSettings;
  private groups: DeviceGroup[];
  private plan: RoomPlan;
  private saveTimer: NodeJS.Timeout | null = null;
  readonly firstRun: boolean;

  constructor() {
    const dir = app.getPath('userData');
    this.devicesFile = path.join(dir, 'devices.json');
    this.settingsFile = path.join(dir, 'settings.json');
    this.groupsFile = path.join(dir, 'groups.json');
    this.planFile = path.join(dir, 'plan.json');
    this.firstRun = !fs.existsSync(this.devicesFile);
    // Von Hand bearbeitete oder beschädigte Dateien: Unbrauchbares fällt weg, statt den Start zu verhindern.
    this.devices = cleanDevices(readJson<unknown>(this.devicesFile, []));
    this.settings = { ...DEFAULT_SETTINGS, ...cleanSettings(readJson<unknown>(this.settingsFile, {})) };
    // Mitglieder, die es als Gerät nicht (mehr) gibt, fallen schon beim Laden weg.
    this.groups = cleanGroups(readJson<unknown>(this.groupsFile, []), this.devices.map((d) => d.id));
    // Unlesbare plan.json wird beiseitegelegt (plan.json.broken), damit nichts verloren geht.
    this.plan = readPlanFile(this.planFile, this.devices.map((d) => d.id));
  }

  getDevices(): DeviceConfig[] {
    return this.devices.map((d) => ({ ...d }));
  }

  setDevices(devices: DeviceConfig[]): void {
    this.devices = devices.map((d) => ({ ...d }));
    this.scheduleSave();
  }

  getGroups(): DeviceGroup[] {
    return this.groups.map((g) => ({ ...g, members: [...g.members] }));
  }

  setGroups(groups: DeviceGroup[]): void {
    this.groups = groups.map((g) => ({ ...g, members: [...g.members] }));
    this.scheduleSave();
  }

  getPlan(): RoomPlan {
    return structuredClone(this.plan);
  }

  setPlan(plan: RoomPlan): void {
    this.plan = structuredClone(plan);
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
      writeJsonAtomic(this.groupsFile, this.groups);
      writeJsonAtomic(this.planFile, this.plan);
    } catch (err) {
      console.error('Speichern fehlgeschlagen', err);
    }
  }
}
