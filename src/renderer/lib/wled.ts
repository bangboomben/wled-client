import { key, t } from '../../shared/i18n';
import type { Color, DeviceSnapshot, PalxEntry, WledInfo, WledSegment, WledState } from '../../shared/types';
import { viewSeg } from '../../shared/segments';

export { viewSeg } from '../../shared/segments';

// ------------------------------------------------------------------ Segmente

/**
 * Patch für „aktuelle Auswahl“: ohne id wirkt er in WLED auf alle ausgewählten Segmente.
 * Ist keines ausgewählt, gezielt auf das Hauptsegment.
 */
export function segPatch(state: WledState, fields: Record<string, unknown>): Record<string, unknown> {
  if (state.seg.some((s) => s.sel)) return { seg: fields };
  return { seg: { id: state.mainseg ?? 0, ...fields } };
}

/** Farbslot-Patch: leere Arrays lassen die anderen Slots unverändert. */
export function colPatch(slot: number, color: Color): Color[] {
  const col: Color[] = [[], [], []];
  col[slot] = color;
  return col.slice(0, slot + 1);
}

export function lightCaps(seg: WledSegment | undefined, info: WledInfo | undefined) {
  const lc = (seg?.lc as number | undefined) ?? info?.leds.lc ?? 1;
  return { rgb: (lc & 1) !== 0 || lc === 0, white: (lc & 2) !== 0, cct: (lc & 4) !== 0 };
}

// ------------------------------------------------------------------ Effekt-Metadaten (/json/fxdata)

export type SliderKey = 'sx' | 'ix' | 'c1' | 'c2' | 'c3';
export type OptionKey = 'o1' | 'o2' | 'o3';

export interface FxMeta {
  sliders: Array<{ key: SliderKey; label: string }>;
  options: Array<{ key: OptionKey; label: string }>;
  colors: Array<{ slot: number; label: string }>;
  usesPalette: boolean;
  paletteLabel: string;
  flags: string;
}

const SLIDER_KEYS: SliderKey[] = ['sx', 'ix', 'c1', 'c2', 'c3'];
const SLIDER_LABELS = [key('Geschwindigkeit'), key('Intensität'), key('Regler 1'), key('Regler 2'), key('Regler 3')];
const OPTION_KEYS: OptionKey[] = ['o1', 'o2', 'o3'];
const COLOR_LABELS = [key('Farbe 1'), key('Farbe 2'), key('Farbe 3')];

/**
 * Liest den Metadaten-String eines Effekts („Regler;Farben;Palette;Flags“) so aus,
 * wie es die WLED-Weboberfläche tut (setEffectParameters in index.js).
 */
export function parseFx(fx: number, fxdata: string[]): FxMeta {
  let raw: string | undefined = fxdata[fx];
  if (fx === 0) raw = ';!;'; // „Solid“: nur Farbe 1, wie in der Weboberfläche
  const defined = !!raw;
  const parts = raw ? raw.split(';') : [];
  const sl = parts[0] ? parts[0].split(',') : [];
  const co = parts[1] ? parts[1].split(',') : [];
  const pa = parts[2] ? parts[2].split(',') : [];
  const flags = parts[3] || '1';

  const sliders = SLIDER_KEYS.flatMap((key, i) => {
    const name = sl[i];
    if ((!defined && i < 2) || (name !== undefined && name !== '')) {
      return [{ key, label: name && name !== '!' ? name : SLIDER_LABELS[i] }];
    }
    return [];
  });

  const options = OPTION_KEYS.flatMap((key, i) => {
    const name = sl[5 + i];
    return name ? [{ key, label: name === '!' ? `Option ${i + 1}` : name.slice(0, 24) }] : [];
  });

  const colors = [0, 1, 2].flatMap((slot) => {
    const name = co[slot];
    if (name !== undefined && name !== '') return [{ slot, label: name !== '!' ? name : COLOR_LABELS[slot] }];
    if (!defined) return [{ slot, label: COLOR_LABELS[slot] }];
    return [];
  });

  let pal = pa[0] ?? '';
  if (pal.includes('=')) pal = pal.slice(0, pal.indexOf('='));
  const usesPalette = !defined || (pal !== '' && Number.isNaN(Number(pal)));

  return {
    sliders,
    options,
    colors: colors.length ? colors : [{ slot: 0, label: COLOR_LABELS[0] }],
    usesPalette,
    paletteLabel: pal && pal !== '!' ? pal : 'Palette',
    flags,
  };
}

export interface EffectEntry {
  id: number;
  name: string;
  flags: string;
  palette: boolean;
}

export function effectList(effects: string[], fxdata: string[]): EffectEntry[] {
  const list: EffectEntry[] = [];
  effects.forEach((name, id) => {
    if (!name || name === '-' || name.includes('RSVD')) return;
    const meta = fxdata.length ? parseFx(id, fxdata) : null;
    list.push({ id, name, flags: meta?.flags ?? '1', palette: meta?.usesPalette ?? true });
  });
  return list.sort((a, b) => (a.id === 0 ? -1 : b.id === 0 ? 1 : a.name.localeCompare(b.name, 'de')));
}

export interface PaletteEntry {
  id: number;
  name: string;
}

export function paletteList(palettes: string[], info?: WledInfo): PaletteEntry[] {
  const list: PaletteEntry[] = palettes.map((name, id) => ({ id, name })).filter((p) => p.name && p.name !== '-');
  for (let i = 0; i < (info?.cpalcount ?? 0); i++) list.push({ id: 255 - i, name: t('~ Eigene {n} ~', { n: i }) });
  const rank = (p: PaletteEntry) => (p.id === 0 ? 0 : p.name.startsWith('*') ? 1 : p.name.startsWith('~') ? 3 : 2);
  return list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'de'));
}

// ------------------------------------------------------------------ Farben

export const rgbCss = (c: Color | undefined): string => {
  if (!c || c.length < 3) return 'rgb(0,0,0)';
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
};

export function toHex(c: Color): string {
  return c
    .slice(0, 3)
    .map((v) => Math.round(v).toString(16).padStart(2, '0'))
    .join('');
}

export function fromHex(hex: string): Color | null {
  const h = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

export function rgbToHsv([r, g, b]: Color): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max];
}

export function hsvToRgb(h: number, s: number, v: number): Color {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((n) => Math.round((n + m) * 255));
}

const luminance = ([r, g, b]: Color) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** Akzentfarbe für die Oberfläche aus der aktuellen Gerätefarbe — zu dunkle Farben werden angehoben. */
export function accentFor(device: DeviceSnapshot | undefined): { accent: string; contrast: string; raw: Color } {
  const fallback: Color = [245, 165, 36];
  const seg = device?.state ? viewSeg(device.state) : undefined;
  let c: Color = seg?.col?.[0]?.slice(0, 3) ?? fallback;
  const w = seg?.col?.[0]?.[3] ?? 0;
  if (Math.max(...c) < 40 && w > 40) c = [255, 226, 180]; // reines Weiß über den W-Kanal
  if (Math.max(...c) < 40) c = fallback;
  const [h, s, v] = rgbToHsv(c);
  const lifted = v < 0.75 ? hsvToRgb(h, s, 0.75) : c;
  return { accent: rgbCss(lifted), contrast: luminance(lifted) > 0.55 ? '#111318' : '#ffffff', raw: c };
}

/** Farbe für Punkt und Vorschau: tatsächliche Farbe, Weißkanal als warmes Weiß. */
export function displayColor(c: Color | undefined): string {
  if (!c) return 'rgb(90,90,90)';
  const [r, g, b, w = 0] = c;
  if (w > 0) {
    const mix = (v: number, t: number) => Math.min(255, Math.round(v + (t * w) / 255));
    return `rgb(${mix(r, 255)}, ${mix(g, 228)}, ${mix(b, 190)})`;
  }
  return `rgb(${r}, ${g}, ${b})`;
}

// ------------------------------------------------------------------ Paletten-Vorschau

function seededColor(seed: number): Color {
  return hsvToRgb((seed * 137.508) % 360, 0.85, 1);
}

export function paletteGradient(entry: PalxEntry | undefined, seg?: WledSegment): string {
  if (!entry || !entry.length) return 'linear-gradient(90deg, var(--panel-3), var(--panel-2))';
  const stops = entry.map((e, i) => {
    if (Array.isArray(e)) return `rgb(${e[1]}, ${e[2]}, ${e[3]}) ${((e[0] / 255) * 100).toFixed(1)}%`;
    const pos = entry.length === 1 ? 0 : (i / (entry.length - 1)) * 100;
    let c: Color = seededColor(i + 1);
    if (e === 'c1' || e === 'c2' || e === 'c3') c = seg?.col?.[Number(e[1]) - 1] ?? [0, 0, 0];
    return `${rgbCss(c)} ${pos.toFixed(1)}%`;
  });
  if (stops.length === 1) stops.push(stops[0].replace(/[\d.]+%$/, '100%'));
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

// ------------------------------------------------------------------ Sonstiges

export const pct = (bri: number) => Math.max(1, Math.round((bri / 255) * 100));

export function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return t('{d} T {h} Std', { d, h });
  if (h) return t('{h} Std {m} Min', { h, m });
  return t('{m} Min', { m });
}
