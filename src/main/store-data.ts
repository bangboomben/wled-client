// Prüft gespeicherte Geräte, Gruppen und Einstellungen (devices.json, groups.json, settings.json und
// Änderungen aus der Oberfläche). Ohne Electron, damit es sich ohne App testen lässt.

import { t } from '../shared/i18n';
import { GROUP_NAME_MAX } from '../shared/groups';
import type { AppSettings, DeviceConfig, DeviceGroup } from '../shared/types';

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
  if (typeof raw.selectedGroupId === 'string') out.selectedGroupId = raw.selectedGroupId;
  return out;
}

/** Texte ohne Doppelte, die zu bekannten Geräten gehören — Reihenfolge wie übergeben. */
function knownMembers(raw: unknown, deviceIds: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set(deviceIds);
  return [...new Set(raw.filter((m): m is string => typeof m === 'string' && known.has(m)))];
}

/** Gruppen aus groups.json: Unbrauchbares fällt weg; bei doppelter id oder doppeltem Namen gilt der erste Eintrag. */
export function cleanGroups(raw: unknown, deviceIds: readonly string[]): DeviceGroup[] {
  const ids = new Set<string>();
  const names = new Set<string>();
  return (Array.isArray(raw) ? raw : []).flatMap((item) => {
    if (!isObj(item) || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string') return [];
    const name = item.name.trim().slice(0, GROUP_NAME_MAX).trim();
    const lower = name.toLowerCase();
    if (!name || ids.has(item.id) || names.has(lower)) return [];
    ids.add(item.id);
    names.add(lower);
    return [{ id: item.id, name, members: knownMembers(item.members, deviceIds) }];
  });
}

export type GroupCheck = { ok: true; name: string; members: string[] } | { ok: false; error: string };

/** Prüft Name und Mitglieder aus dem Dialog; `ownId` ist die Gruppe, die gerade bearbeitet wird. */
export function checkGroup(
  input: { name: unknown; members: unknown },
  groups: readonly DeviceGroup[],
  deviceIds: readonly string[],
  ownId?: string,
): GroupCheck {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return { ok: false, error: t('Bitte einen Namen eingeben.') };
  if (name.length > GROUP_NAME_MAX) return { ok: false, error: t('Der Name darf höchstens {n} Zeichen haben.', { n: GROUP_NAME_MAX }) };
  const lower = name.toLowerCase();
  if (groups.some((g) => g.id !== ownId && g.name.toLowerCase() === lower)) {
    return { ok: false, error: t('Eine Gruppe „{name}“ gibt es schon.', { name }) };
  }
  const members = knownMembers(input.members, deviceIds);
  if (!members.length) return { ok: false, error: t('Bitte mindestens ein Gerät auswählen.') };
  return { ok: true, name, members };
}
