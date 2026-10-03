// Links wled-client://<ziel>/<aktion>[/<wert>] — fürs Stream Deck und für Automationen.
// Reine Funktionen ohne Electron: zerlegen, Namen auflösen, Helligkeit und Presets ausrechnen.

import { t } from './i18n';
import type { Color } from './types';

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
