// Prüft gespeicherte Geräte, Gruppen, Raumplan und Einstellungen (devices.json, groups.json, plan.json, settings.json und
// Änderungen aus der Oberfläche). Ohne Electron, damit es sich ohne App testen lässt.

import fs from 'node:fs';
import { t } from '../shared/i18n';
import { GROUP_NAME_MAX } from '../shared/groups';
import { AREA_MIN, PLAN_COORD_MAX, PLAN_POINTS_MAX, PLAN_ROOMS_MAX, ROOM_MIN, ROOM_NAME_MAX, emptyPlan, round1 } from '../shared/plan';
import type { AppSettings, DeviceConfig, DeviceGroup, PlanItem, PlanPoint, PlanRect, PlanRoom, RoomPlan } from '../shared/types';

export const DEFAULT_SETTINGS: AppSettings = {
  closeToTray: true,
  startWithWindows: false,
  liveView: false,
  theme: 'system',
  language: 'system',
  autoUpdate: true,
  allowLinks: false,
  planOpen: false,
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
  for (const k of ['closeToTray', 'startWithWindows', 'liveView', 'autoUpdate', 'allowLinks', 'planOpen', 'trayHintShown'] as const) {
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

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (v: number) => Math.abs(v) <= PLAN_COORD_MAX;

function cleanPoint(raw: unknown): PlanPoint | null {
  if (!Array.isArray(raw) || raw.length !== 2 || !finite(raw[0]) || !finite(raw[1])) return null;
  const p: PlanPoint = [round1(raw[0]), round1(raw[1])];
  return inRange(p[0]) && inRange(p[1]) ? p : null;
}

function cleanRect(raw: unknown, min: number): PlanRect | null {
  if (!isObj(raw) || !finite(raw.x) || !finite(raw.y) || !finite(raw.w) || !finite(raw.h)) return null;
  const r = { x: round1(raw.x), y: round1(raw.y), w: round1(raw.w), h: round1(raw.h) };
  if (r.w < min || r.h < min) return null;
  return [r.x, r.y, r.x + r.w, r.y + r.h].every(inRange) ? r : null;
}

function cleanItem(raw: unknown, known: ReadonlySet<string>): PlanItem | null {
  if (!isObj(raw) || typeof raw.deviceId !== 'string' || !known.has(raw.deviceId)) return null;
  const deviceId = raw.deviceId;
  if (raw.shape === 'line') {
    if (!Array.isArray(raw.points) || raw.points.length < 2 || raw.points.length > PLAN_POINTS_MAX) return null;
    const points = raw.points.map(cleanPoint);
    if (points.some((p) => !p)) return null;
    return { deviceId, shape: 'line', points: points as PlanPoint[], reversed: raw.reversed === true };
  }
  if (raw.shape === 'point') {
    const at = cleanPoint(raw.at);
    return at ? { deviceId, shape: 'point', at } : null;
  }
  if (raw.shape === 'area') {
    const rect = cleanRect(raw.rect, AREA_MIN);
    return rect ? { deviceId, shape: 'area', rect } : null;
  }
  return null;
}

/**
 * Raumplan aus plan.json oder der Oberfläche: Unbrauchbares fällt weg (Räume ohne Namen, zu klein oder außerhalb
 * des Bereichs, unbekannte Geräte, kaputte Formen); je Raum-id und je Gerät gilt der erste Eintrag.
 */
export function cleanPlan(raw: unknown, deviceIds: readonly string[]): RoomPlan {
  if (!isObj(raw) || raw.version !== 1) return emptyPlan();
  const roomIds = new Set<string>();
  const rooms: PlanRoom[] = [];
  for (const r of Array.isArray(raw.rooms) ? raw.rooms : []) {
    if (rooms.length >= PLAN_ROOMS_MAX) break;
    if (!isObj(r) || typeof r.id !== 'string' || !r.id || r.id.length >= 100 || roomIds.has(r.id) || typeof r.name !== 'string') continue;
    const name = r.name.trim().slice(0, ROOM_NAME_MAX).trim();
    const rect = cleanRect(r, ROOM_MIN);
    if (!name || !rect) continue;
    roomIds.add(r.id);
    rooms.push({ id: r.id, name, ...rect });
  }
  const known = new Set(deviceIds);
  const placed = new Set<string>();
  const items: PlanItem[] = [];
  for (const it of Array.isArray(raw.items) ? raw.items : []) {
    const item = cleanItem(it, known);
    if (!item || placed.has(item.deviceId)) continue;
    placed.add(item.deviceId);
    items.push(item);
  }
  return { version: 1, rooms, items };
}

/** Liest plan.json. Fehlt sie → leerer Plan. Ist sie kein JSON → als plan.json.broken beiseitelegen, leerer Plan. */
export function readPlanFile(file: string, deviceIds: readonly string[]): RoomPlan {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return emptyPlan();
  }
  try {
    return cleanPlan(JSON.parse(text), deviceIds);
  } catch {
    try {
      fs.renameSync(file, `${file}.broken`);
    } catch {
      // Bleibt liegen und wird beim nächsten Speichern ersetzt.
    }
    return emptyPlan();
  }
}
