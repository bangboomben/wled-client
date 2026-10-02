// Prüft Daten, die vom Gerät kommen (JSON-API), bevor App und Oberfläche sie nutzen. Eine von Hand
// bearbeitete Datei oder eine ungewöhnliche Firmware soll die App nicht mitreißen.

import type { PalxEntry, Presets, WledInfo, WledPlaylist, WledPreset, WledState } from '../shared/types';

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function isWledInfo(v: unknown): v is WledInfo {
  return (
    isObj(v) &&
    typeof v.ver === 'string' &&
    typeof v.name === 'string' &&
    (v.mac === undefined || typeof v.mac === 'string') &&
    isObj(v.leds) &&
    typeof v.leds.count === 'number'
  );
}

export const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numbers = (v: unknown): number[] => (Array.isArray(v) ? v.filter(finite) : []);

function cleanPlaylist(raw: unknown): WledPlaylist | undefined {
  if (!isObj(raw)) return undefined;
  const ps = numbers(raw.ps);
  if (!ps.length) return undefined;
  const pl: WledPlaylist = {
    ps,
    dur: finite(raw.dur) ? raw.dur : Array.isArray(raw.dur) ? numbers(raw.dur) : 100,
    transition: finite(raw.transition) ? raw.transition : Array.isArray(raw.transition) ? numbers(raw.transition) : 7,
  };
  if (finite(raw.repeat)) pl.repeat = raw.repeat;
  if (finite(raw.end)) pl.end = raw.end;
  if (typeof raw.r === 'boolean' || finite(raw.r)) pl.r = raw.r;
  return pl;
}

/**
 * Presets aus presets.json in der Form, die die Oberfläche erwartet: Name und Schnellwahl als
 * Text, Playlists mit einer Liste von Preset-Nummern. Die Datei lässt sich am Gerät von Hand
 * bearbeiten — ein kaputter Eintrag soll nicht die ganze Oberfläche mitreißen.
 */
export function cleanPresets(raw: unknown): Presets {
  const out: Presets = {};
  if (!isObj(raw)) return out;
  const text = (v: unknown) => (typeof v === 'string' ? v : finite(v) ? String(v) : undefined);
  for (const [id, p] of Object.entries(raw)) {
    if (!/^[1-9]\d*$/.test(id) || !isObj(p) || Object.keys(p).length === 0) continue;
    const preset: WledPreset = { ...p };
    for (const k of ['n', 'ql'] as const) {
      const v = text(p[k]);
      if (v === undefined) delete preset[k];
      else preset[k] = v;
    }
    const playlist = 'playlist' in p ? cleanPlaylist(p.playlist) : undefined;
    if (playlist) preset.playlist = playlist;
    else delete preset.playlist;
    out[id] = preset;
  }
  return out;
}

/** Zustand vom Gerät, mit Segmenten, Nachtlicht und Sync in der Form, die Oberfläche und merge.ts erwarten. */
export function cleanState(raw: unknown): WledState | undefined {
  if (!isObj(raw) || !Array.isArray(raw.seg)) return undefined;
  const seg = raw.seg.filter(isObj).map((sg) => ({
    ...sg,
    col: Array.isArray(sg.col) ? sg.col.filter((c): c is number[] => Array.isArray(c)) : [],
  }));
  const num = (v: unknown, fallback: number) => (finite(v) ? v : fallback);
  const nl = isObj(raw.nl) ? raw.nl : {};
  const udpn = isObj(raw.udpn) ? raw.udpn : {};
  // Geprüft ist, was Oberfläche und merge.ts voraussetzen; die übrigen Felder reicht die App durch.
  return {
    ...raw,
    on: raw.on === true,
    bri: num(raw.bri, 128),
    transition: num(raw.transition, 7),
    ps: num(raw.ps, -1),
    pl: num(raw.pl, -1),
    mainseg: num(raw.mainseg, 0),
    seg: seg as unknown as WledState['seg'],
    nl: { ...nl, on: nl.on === true, dur: num(nl.dur, 60), mode: num(nl.mode, 1), tbri: num(nl.tbri, 0), rem: num(nl.rem, -1) },
    udpn: { ...udpn, send: udpn.send === true, recv: udpn.recv === true },
  };
}

/** Paletten aus /json/palx: nur Einträge, die Listen sind. */
export function cleanPalx(raw: unknown): Record<string, PalxEntry> {
  const out: Record<string, PalxEntry> = {};
  if (isObj(raw)) for (const [id, e] of Object.entries(raw)) if (Array.isArray(e)) out[id] = e as PalxEntry;
  return out;
}
