// Wendet einen JSON-API-Patch auf einen WLED-Zustand an — so, wie die Firmware es tut.
// Der Hauptprozess nutzt das für sofortige Rückmeldung (bevor das Gerät antwortet),
// der Mock-Server (scripts/mock-wled.mjs) als eigentliche Logik. Deshalb nur
// typ-löschbare TypeScript-Syntax: Node lädt die Datei dort ohne Build.

import type { Color, WledSegment, WledState } from './types';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Felder, die einen Befehl auslösen, aber nicht zum Zustand gehören. */
const COMMAND_KEYS = new Set(['psave', 'pdel', 'rb', 'v', 'lv', 'tt', 'time', 'np', 'ib', 'sb', 'sc', 'ql', 'n', 'o', 'playlist', 'nn']);

export function hexToColor(hex: string): Color {
  const h = hex.replace('#', '');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) || 0;
  return h.length >= 8 ? [n(2), n(4), n(6), n(0)] : [n(0), n(2), n(4)];
}

export function mergeColors(current: Color[], patch: unknown): Color[] {
  const out = (current ?? []).map((c) => [...c]);
  if (!Array.isArray(patch)) return out;
  patch.forEach((c, i) => {
    if (Array.isArray(c) && c.length >= 3) out[i] = c.map((x) => clamp(Number(x) || 0, 0, 255));
    else if (typeof c === 'string' && /^#?[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c)) out[i] = hexToColor(c);
    // leeres Array = Farbslot unverändert lassen
  });
  return out;
}

export function applySegmentPatch(seg: WledSegment, patch: Obj): WledSegment {
  const next: WledSegment = { ...seg, col: seg.col.map((c) => [...c]) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id' || k === 'fxdef') continue;
    if (k === 'col') next.col = mergeColors(seg.col, v);
    else if (v === 't' && typeof seg[k] === 'boolean') next[k] = !seg[k];
    else next[k] = v;
  }
  if (typeof next.start === 'number' && typeof next.stop === 'number') next.len = Math.max(0, next.stop - next.start);
  return next;
}

export function defaultSegment(id: number, start: number, stop: number): WledSegment {
  return {
    id, start, stop, len: stop - start, grp: 1, spc: 0, of: 0, on: true, frz: false, bri: 255, cct: 127,
    col: [[255, 160, 0], [0, 0, 0], [0, 0, 0]], fx: 0, sx: 128, ix: 128, pal: 0, c1: 128, c2: 128, c3: 16,
    sel: false, rev: false, mi: false, o1: false, o2: false, o3: false,
  };
}

export interface ApplyOptions {
  /** Unbekannte Segment-IDs mit start/stop anlegen (Mock-Server). */
  createSegments?: boolean;
  /** Farbslot-Länge für neue Segmente (4 bei RGBW). */
  channels?: number;
}

export function applyStatePatch(state: WledState, patch: Obj, opts: ApplyOptions = {}): WledState {
  const next: WledState = { ...state, seg: state.seg.map((s) => ({ ...s })) };

  for (const [k, v] of Object.entries(patch)) {
    if (k === 'seg' || COMMAND_KEYS.has(k)) continue;
    switch (k) {
      case 'on':
        next.on = v === 't' ? !state.on : Boolean(v);
        break;
      case 'bri': {
        // Wie die Firmware: Helligkeit > 0 schaltet ein, 0 schaltet aus — außer „on“ steht explizit im Patch.
        const b = Number(v);
        if (b > 0) next.bri = clamp(Math.round(b), 1, 255);
        if (!('on' in patch)) next.on = b > 0;
        break;
      }
      case 'transition':
      case 'mainseg':
      case 'ps':
      case 'pl':
        next[k] = Number(v);
        break;
      default: {
        const cur = state[k];
        if (isObj(cur) && isObj(v)) {
          const merged: Obj = { ...cur };
          for (const [ik, iv] of Object.entries(v)) merged[ik] = iv === 't' && typeof cur[ik] === 'boolean' ? !cur[ik] : iv;
          next[k] = merged;
        }
      }
    }
  }

  // Eine Segmentänderung von Hand beendet das aktive Preset (Helligkeit und Ein/Aus nicht).
  if ('seg' in patch && !('ps' in patch)) next.ps = -1;

  const sp = patch.seg;
  if (sp !== undefined) {
    const list = Array.isArray(sp) ? sp : [sp];
    list.forEach((item, idx) => {
      if (!isObj(item)) return;
      const id = typeof item.id === 'number' ? item.id : Array.isArray(sp) ? idx : -1;
      if (id < 0) {
        next.seg = next.seg.map((s) => (s.sel ? applySegmentPatch(s, item) : s));
        return;
      }
      const at = next.seg.findIndex((s) => s.id === id);
      if (item.stop === 0) {
        if (at >= 0 && next.seg.length > 1) next.seg.splice(at, 1);
        return;
      }
      if (at >= 0) {
        next.seg[at] = applySegmentPatch(next.seg[at], item);
      } else if (opts.createSegments && typeof item.start === 'number' && typeof item.stop === 'number') {
        const base = defaultSegment(id, item.start, item.stop);
        if (opts.channels === 4) base.col = base.col.map((c) => [...c, 0]);
        next.seg.push(applySegmentPatch(base, item));
        next.seg.sort((a, b) => a.id - b.id);
      }
    });
  }

  return next;
}
