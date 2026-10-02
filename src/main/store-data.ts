// Prüft gespeicherte Geräte und Einstellungen (devices.json, settings.json und Änderungen aus der
// Oberfläche). Ohne Electron, damit es sich ohne App testen lässt.

import type { AppSettings, DeviceConfig } from '../shared/types';

export const DEFAULT_SETTINGS: AppSettings = {
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

/** Geräteliste: Unbrauchbares fällt weg, bei doppelter ID gilt der erste Eintrag. */
export function cleanDevices(raw: unknown): DeviceConfig[] {
  const ids = new Set<string>();
  return (Array.isArray(raw) ? raw : []).flatMap((item) => {
    const d = cleanDevice(item);
    if (!d || ids.has(d.id)) return [];
    ids.add(d.id);
    return [d];
  });
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
