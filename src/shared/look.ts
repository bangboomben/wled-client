// „Look" eines Segments: Effekt, Palette, Farben und Effekt-Regler — übertragbar auf andere Geräte.
// Effekt und Palette laufen beim Namen, weil sich die Nummern zwischen Firmware-Ständen unterscheiden.
// Ohne Electron, damit Oberfläche und Hauptprozess dieselbe Rechnung nutzen und sie testbar bleibt.

import { t } from './i18n';
import type { Color, DeviceGroup, DeviceSnapshot, DeviceStatic, WledSegment, WledState } from './types';

export interface Look {
  fx: string;
  /** null: eigene Palette der Quelle — deren Inhalt ist auf jedem Gerät ein anderer. */
  pal: string | null;
  /** Drei Farbslots, je [r, g, b, w]. */
  col: [Color, Color, Color];
  sx: number;
  ix: number;
  c1: number;
  c2: number;
  c3: number;
  o1: boolean;
  o2: boolean;
  o3: boolean;
}

export interface CopyResult {
  id: string;
  ok: boolean;
  /** Übersetzter Grund, wenn das Ziel übersprungen wurde oder abgelehnt hat. */
  reason?: string;
}

const SLIDERS = ['sx', 'ix', 'c1', 'c2', 'c3'] as const;
const OPTIONS = ['o1', 'o2', 'o3'] as const;
const NAME_MAX = 64;

/** Farbe auf vier Werte; ohne Weißkanal ist w = 0. */
const rgbw = (c: Color | undefined): Color => {
  const [r = 0, g = 0, b = 0, w = 0] = c ?? [];
  return [r, g, b, w];
};

/** Look des angezeigten Segments; null, solange die Effektliste fehlt oder der Effekt keinen Namen hat. */
export function lookFrom(seg: WledSegment, st: DeviceStatic | null): Look | null {
  const fx = st?.effects[seg.fx];
  if (!st || !fx) return null;
  return {
    fx,
    pal: seg.pal < st.palettes.length ? (st.palettes[seg.pal] ?? null) : null,
    col: [rgbw(seg.col[0]), rgbw(seg.col[1]), rgbw(seg.col[2])],
    // Ältere Firmware kennt nicht alle Regler.
    sx: seg.sx ?? 128,
    ix: seg.ix ?? 128,
    c1: seg.c1 ?? 0,
    c2: seg.c2 ?? 0,
    c3: seg.c3 ?? 0,
    o1: seg.o1 ?? false,
    o2: seg.o2 ?? false,
    o3: seg.o3 ?? false,
  };
}

const isByte = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255;
const isName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= NAME_MAX;

/** Prüft einen Look aus der Oberfläche; null bei allem, was nicht genau passt. */
export function cleanLook(raw: unknown): Look | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isName(r.fx) || !(r.pal === null || isName(r.pal))) return null;
  if (!Array.isArray(r.col) || r.col.length !== 3) return null;
  const col: Color[] = [];
  for (const c of r.col as unknown[]) {
    if (!Array.isArray(c) || (c.length !== 3 && c.length !== 4) || !c.every(isByte)) return null;
    col.push(rgbw(c));
  }
  if (!SLIDERS.every((k) => isByte(r[k])) || !OPTIONS.every((k) => typeof r[k] === 'boolean')) return null;
  return {
    fx: r.fx,
    pal: r.pal as string | null,
    col: col as [Color, Color, Color],
    sx: r.sx as number,
    ix: r.ix as number,
    c1: r.c1 as number,
    c2: r.c2 as number,
    c3: r.c3 as number,
    o1: r.o1 as boolean,
    o2: r.o2 as boolean,
    o3: r.o3 as boolean,
  };
}

/**
 * Befehl, der den Look auf alle Segmente eines Ziels setzt — oder der Grund, warum das Ziel unverändert
 * bleibt. Kein halber Look: Fehlt Effekt oder Palette, wird gar nichts gesendet.
 */
export function lookPatch(look: Look, state: WledState, st: DeviceStatic | null): { patch: Record<string, unknown> } | { reason: string } {
  if (!st) return { reason: t('Effektliste noch nicht geladen') };
  if (look.pal === null) return { reason: t('Eigene Paletten lassen sich nicht übertragen') };
  const fx = st.effects.indexOf(look.fx);
  if (fx < 0) return { reason: t('Effekt „{name}“ gibt es dort nicht', { name: look.fx }) };
  const pal = st.palettes.indexOf(look.pal);
  if (pal < 0) return { reason: t('Palette „{name}“ gibt es dort nicht', { name: look.pal }) };
  const { sx, ix, c1, c2, c3, o1, o2, o3 } = look;
  return {
    patch: {
      seg: state.seg.map((s) => ({ id: s.id, fx, pal, sx, ix, c1, c2, c3, o1, o2, o3, col: look.col.map((c) => [...c]) })),
    },
  };
}

/** Gewählte Geräte plus Mitglieder gewählter Gruppen — einmal je Gerät, ohne Quelle, nur mit Verbindung. */
export function copyTargets(
  pick: { devices: string[]; groups: string[] },
  groups: DeviceGroup[],
  devices: DeviceSnapshot[],
  sourceId: string,
): string[] {
  const wanted = new Set(pick.devices);
  for (const g of groups) if (pick.groups.includes(g.id)) for (const m of g.members) wanted.add(m);
  return devices.filter((d) => wanted.has(d.id) && d.id !== sourceId && d.status === 'online').map((d) => d.id);
}

/** Ein Hinweis für alle Ergebnisse: Anzahl der Erfolge, dann je übersprungenem Ziel der Grund. */
export function copySummary(results: CopyResult[], nameOf: (id: string) => string): string {
  const ok = results.filter((r) => r.ok).length;
  const head =
    ok === 0 ? t('Look nicht übertragen') : ok === 1 ? t('Look auf 1 Gerät übertragen') : t('Look auf {n} Geräte übertragen', { n: ok });
  const fails = results.filter((r) => !r.ok).map((r) => t('{name}: {reason}', { name: nameOf(r.id), reason: r.reason ?? '' }));
  return [head, ...fails].join(' · ');
}
