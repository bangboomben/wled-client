// Links wled-client://<ziel>/<aktion>[/<wert>] — fürs Stream Deck und für Automationen.
// Reine Funktionen ohne Electron: zerlegen, Namen auflösen, Helligkeit und Presets ausrechnen.

import { brightnessBase, groupMembers, scaleBrightness, type BriTarget } from './groups';
import { t } from './i18n';
import type { Color, DeviceGroup, DeviceSnapshot, Presets } from './types';

export type LinkTarget = { kind: 'device' | 'group'; name: string } | { kind: 'all' };

export type LinkAction =
  | { type: 'power'; mode: 'on' | 'off' | 'toggle' }
  | { type: 'brightness'; value: number; relative: boolean }
  | { type: 'preset'; ref: string }
  | { type: 'color'; color: Color }
  | { type: 'effect'; name: string }
  | { type: 'palette'; name: string }
  | { type: 'lookFrom'; source: string };

export interface LinkCommand {
  target: LinkTarget;
  action: LinkAction;
}

const LINK_MAX = 512;
const NAME_MAX = 64;
const POWER = ['on', 'off', 'toggle'];
const WITH_VALUE = ['brightness', 'preset', 'color', 'effect', 'palette', 'look-from'];

/** Zerlegt einen Link streng; alles Unpassende ergibt einen übersetzten Grund statt eines Befehls. */
export function parseLink(text: string): LinkCommand | { error: string } {
  const invalid = { error: t('Ungültiger Link') };
  if (typeof text !== 'string') return invalid; // Links kommen aus fremden Quellen
  if (text.length > LINK_MAX) return invalid;
  const m = /^wled-client:(?:\/\/)?(.*)$/i.exec(text.trim());
  if (!m) return invalid;
  let parts: string[];
  try {
    parts = m[1]
      .replace(/\/$/, '') // höchstens ein abschließender Schrägstrich
      .split('/')
      .map((p) => decodeURIComponent(p).trim());
  } catch {
    return invalid;
  }

  const kind = parts[0]?.toLowerCase();
  let target: LinkTarget;
  let rest: string[];
  if (kind === 'all') {
    target = { kind: 'all' };
    rest = parts.slice(1);
  } else if (kind === 'device' || kind === 'group') {
    const name = parts[1] ?? '';
    if (!name || name.length > NAME_MAX) return { error: t('Name fehlt oder ist zu lang') };
    target = { kind, name };
    rest = parts.slice(2);
  } else {
    return invalid;
  }

  const [verbRaw, value, ...extra] = rest;
  const verb = verbRaw?.toLowerCase();
  if (!verb) return invalid;
  if (POWER.includes(verb)) {
    if (value !== undefined) return invalid;
    return { target, action: { type: 'power', mode: verb as 'on' | 'off' | 'toggle' } };
  }
  if (!WITH_VALUE.includes(verb)) return { error: t('Unbekannte Aktion „{name}“', { name: verbRaw }) };
  if (!value || extra.length) return invalid;

  if (verb === 'brightness') {
    const b = /^([+-])?(\d{1,3})$/.exec(value);
    const n = b ? Number(b[2]) : NaN;
    if (!b || n < 1 || n > 100) return { error: t('Helligkeit muss zwischen 1 und 100 liegen') };
    return { target, action: { type: 'brightness', value: b[1] === '-' ? -n : n, relative: !!b[1] } };
  }
  if (verb === 'color') {
    if (!/^[0-9a-f]{6}$/i.test(value)) return { error: t('Farbe als sechs Hex-Ziffern angeben, z. B. ff0000') };
    const n = parseInt(value, 16);
    return { target, action: { type: 'color', color: [(n >> 16) & 255, (n >> 8) & 255, n & 255] } };
  }
  if (verb === 'preset' && target.kind !== 'device') return { error: t('Presets gibt es nur für einzelne Geräte') };
  if (value.length > NAME_MAX) return { error: t('Name fehlt oder ist zu lang') };
  if (verb === 'preset') return { target, action: { type: 'preset', ref: value } };
  if (verb === 'look-from') return { target, action: { type: 'lookFrom', source: value } };
  return { target, action: { type: verb as 'effect' | 'palette', name: value } };
}

/** Geräte zum Ziel: Namen ohne Rücksicht auf Groß-/Kleinschreibung, Gruppen in der Reihenfolge der Geräteliste. */
export function resolveTarget(target: LinkTarget, devices: DeviceSnapshot[], groups: DeviceGroup[]): { ids: string[] } | { error: string } {
  if (target.kind === 'all') return devices.length ? { ids: devices.map((d) => d.id) } : { error: t('Keine Geräte') };
  const lower = target.name.toLowerCase();
  if (target.kind === 'group') {
    const g = groups.find((x) => x.name.toLowerCase() === lower);
    if (!g) return { error: t('Gruppe „{name}“ gibt es nicht', { name: target.name }) };
    const ids = groupMembers(g, devices).map((d) => d.id);
    return ids.length ? { ids } : { error: t('Diese Gruppe hat keine Geräte.') };
  }
  const found = devices.filter((d) => d.name.toLowerCase() === lower);
  if (found.length === 1) return { ids: [found[0].id] };
  return {
    error: found.length ? t('Mehrere Geräte heißen „{name}“', { name: target.name }) : t('Gerät „{name}“ gibt es nicht', { name: target.name }),
  };
}

const toBri = (pct: number) => Math.min(255, Math.max(1, Math.round((pct * 255) / 100)));

/**
 * Helligkeit in Prozent, fest oder als Schritt — für Gruppen anteilig wie der Gruppenregler: Bezug ist die hellste
 * leuchtende Lampe, ausgeschaltete bleiben aus; leuchtet keine, gehen alle erreichbaren anteilig an.
 */
export function planBrightness(members: DeviceSnapshot[], value: number, relative: boolean): BriTarget[] {
  const base = brightnessBase(members);
  if (!base.length) return [];
  const current = Math.round((Math.max(...base.map((b) => b.bri)) * 100) / 255);
  const pct = relative ? Math.min(100, Math.max(1, current + value)) : value;
  return scaleBrightness(base, toBri(pct));
}

/** Preset beim Namen (ohne Groß-/Kleinschreibung), sonst bei der Nummer; Preset 0 ist WLEDs Platzhalter. */
export function findPreset(presets: Presets, ref: string): number | null {
  const lower = ref.toLowerCase();
  for (const [id, p] of Object.entries(presets)) {
    if (Number(id) > 0 && p?.n?.toLowerCase() === lower) return Number(id);
  }
  return /^\d+$/.test(ref) && Number(ref) > 0 && presets[String(Number(ref))] ? Number(ref) : null;
}
