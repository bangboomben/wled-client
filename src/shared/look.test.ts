import { describe, expect, it } from 'vitest';
import { cleanLook, lookFrom, type Look } from './look';
import type { DeviceStatic, WledSegment } from './types';

const ST: DeviceStatic = {
  effects: ['Solid', 'Blink', 'Rainbow', 'Aurora'],
  palettes: ['Default', 'Party', 'Sunset'],
  fxdata: [],
  presets: {},
};

/** Segment mit dem Nötigsten; alles Übrige ist für den Look egal. */
function seg(fields: Partial<WledSegment>): WledSegment {
  return {
    id: 0, start: 0, stop: 30, grp: 1, spc: 0, of: 0, on: true, frz: false, bri: 255, cct: 127,
    col: [[255, 0, 0], [0, 0, 0], [0, 0, 0]], fx: 0, sx: 128, ix: 128, pal: 0, c1: 0, c2: 0, c3: 0,
    sel: true, rev: false, mi: false, o1: false, o2: false, o3: false,
    ...fields,
  };
}

const LOOK: Look = {
  fx: 'Aurora',
  pal: 'Sunset',
  col: [[255, 0, 0, 0], [0, 255, 0, 10], [0, 0, 255, 0]],
  sx: 10, ix: 20, c1: 30, c2: 40, c3: 50,
  o1: true, o2: false, o3: true,
};

describe('lookFrom', () => {
  it('nimmt Effekt und Palette beim Namen und füllt Farben auf vier Werte auf', () => {
    const s = seg({ fx: 3, pal: 2, col: [[255, 0, 0], [0, 255, 0, 10], [0, 0, 255]], sx: 10, ix: 20, c1: 30, c2: 40, c3: 50, o1: true, o3: true });
    expect(lookFrom(s, ST)).toEqual(LOOK);
  });

  it('macht aus einer eigenen Palette (Nummer jenseits der Liste) pal: null', () => {
    expect(lookFrom(seg({ fx: 2, pal: 255 }), ST)?.pal).toBeNull();
  });

  it('ergänzt fehlende Farbslots als [0, 0, 0, 0]', () => {
    expect(lookFrom(seg({ col: [[1, 2, 3]] }), ST)?.col).toEqual([[1, 2, 3, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  });

  it('gibt ohne Namenslisten oder bei unbekanntem Effekt nichts zurück', () => {
    expect(lookFrom(seg({ fx: 1 }), null)).toBeNull();
    expect(lookFrom(seg({ fx: 9 }), ST)).toBeNull();
  });
});

describe('cleanLook', () => {
  it('lässt einen gültigen Look durch', () => {
    expect(cleanLook(LOOK)).toEqual(LOOK);
    expect(cleanLook({ ...LOOK, pal: null })).toEqual({ ...LOOK, pal: null });
  });

  it('füllt Farben mit drei Werten auf vier auf', () => {
    expect(cleanLook({ ...LOOK, col: [[1, 2, 3], [4, 5, 6], [7, 8, 9]] })?.col).toEqual([[1, 2, 3, 0], [4, 5, 6, 0], [7, 8, 9, 0]]);
  });

  it('verwirft alles Unpassende', () => {
    const bad: unknown[] = [
      null,
      [],
      'Aurora',
      { ...LOOK, fx: '' },
      { ...LOOK, fx: 'x'.repeat(65) },
      { ...LOOK, pal: 5 },
      { ...LOOK, col: [[1, 2, 3, 0], [1, 2, 3, 0]] },
      { ...LOOK, col: [[1, 2], [1, 2, 3], [1, 2, 3]] },
      { ...LOOK, col: [[1, 2, 256], [1, 2, 3], [1, 2, 3]] },
      { ...LOOK, sx: 1.5 },
      { ...LOOK, ix: -1 },
      { ...LOOK, c3: 300 },
      { ...LOOK, o1: 'ja' },
    ];
    for (const raw of bad) expect(cleanLook(raw)).toBeNull();
  });
});
