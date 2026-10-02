import { describe, expect, it } from 'vitest';
import { applySegmentPatch, applyStatePatch, defaultSegment, hexToColor, mergeColors } from './merge';
import type { Color, WledSegment, WledState } from './types';

/** Segment mit Firmware-Standardwerten (0–30), einzelne Felder überschreibbar. */
const seg = (fields: Partial<WledSegment> = {}): WledSegment => ({ ...defaultSegment(0, 0, 30), ...fields });

/** Gerätezustand mit einem Segment, einzelne Felder überschreibbar. */
const state = (fields: Partial<WledState> = {}): WledState => ({
  on: true,
  bri: 128,
  transition: 7,
  ps: -1,
  pl: -1,
  nl: { on: false, dur: 60, mode: 1, tbri: 0, rem: -1 },
  udpn: { send: false, recv: true },
  mainseg: 0,
  seg: [seg()],
  ...fields,
});

/** Zwei Segmente: 0 (ausgewählt) und 1. */
const twoSegs = (fields: Partial<WledState> = {}): WledState =>
  state({ seg: [seg({ id: 0, sel: true }), seg({ id: 1, start: 30, stop: 60, len: 30 })], ...fields });

describe('hexToColor', () => {
  it('liest RRGGBB mit und ohne #, in Groß- und Kleinschreibung', () => {
    expect(hexToColor('ff8000')).toEqual([255, 128, 0]);
    expect(hexToColor('#FF8000')).toEqual([255, 128, 0]);
  });

  it('liest 8 Stellen als WWRRGGBB und gibt [r, g, b, w] zurück', () => {
    expect(hexToColor('10ff8000')).toEqual([255, 128, 0, 16]);
  });

  it('setzt unlesbare Kanäle auf 0', () => {
    expect(hexToColor('zz8000')).toEqual([0, 128, 0]);
  });
});

describe('mergeColors', () => {
  const current = (): Color[] => [[1, 2, 3], [4, 5, 6], [7, 8, 9]];

  it('ersetzt die Farbslots, die der Patch angibt', () => {
    expect(mergeColors(current(), [[10, 20, 30]])).toEqual([[10, 20, 30], [4, 5, 6], [7, 8, 9]]);
  });

  it('lässt Slots mit leerer Liste unverändert', () => {
    expect(mergeColors(current(), [[], [40, 50, 60]])).toEqual([[1, 2, 3], [40, 50, 60], [7, 8, 9]]);
  });

  it('klemmt Kanäle auf 0–255 und macht Unlesbares zu 0', () => {
    expect(mergeColors(current(), [[300, -5, '7']])[0]).toEqual([255, 0, 7]);
    expect(mergeColors(current(), [['x', 1, 2]])[0]).toEqual([0, 1, 2]);
  });

  it('behält einen vierten Kanal (Weiß)', () => {
    expect(mergeColors(current(), [[1, 2, 3, 4]])[0]).toEqual([1, 2, 3, 4]);
  });

  it('nimmt Hex-Werte mit 6 oder 8 Stellen', () => {
    expect(mergeColors(current(), ['#ff0000', '00ff00', 'ff000000'])).toEqual([[255, 0, 0], [0, 255, 0], [0, 0, 0, 255]]);
  });

  it('ignoriert ungültige Einträge (zu kurze Listen, Kurz-Hex, Farbnamen)', () => {
    expect(mergeColors(current(), [[1, 2], '#abc', 'red'])).toEqual(current());
  });

  it('gibt bei einem Patch ohne Liste eine Kopie zurück', () => {
    const cur = current();
    const out = mergeColors(cur, 'x');
    expect(out).toEqual(cur);
    expect(out).not.toBe(cur);
    expect(out[0]).not.toBe(cur[0]);
  });

  it('verändert die übergebenen Farben nicht', () => {
    const cur = current();
    mergeColors(cur, [[9, 9, 9]]);
    expect(cur).toEqual(current());
  });
});

describe('applySegmentPatch', () => {
  it('übernimmt einfache Felder', () => {
    expect(applySegmentPatch(seg(), { fx: 5, sx: 200 })).toMatchObject({ fx: 5, sx: 200 });
  });

  it('schaltet Ein/Aus-Felder mit "t" um', () => {
    expect(applySegmentPatch(seg({ on: true, rev: false }), { on: 't', rev: 't' })).toMatchObject({ on: false, rev: true });
  });

  it('ignoriert id und fxdef', () => {
    const next = applySegmentPatch(seg({ id: 0 }), { id: 3, fxdef: true });
    expect(next.id).toBe(0);
    expect('fxdef' in next).toBe(false);
  });

  it('führt Farben über mergeColors zusammen', () => {
    expect(applySegmentPatch(seg(), { col: [[1, 2, 3]] }).col).toEqual([[1, 2, 3], [0, 0, 0], [0, 0, 0]]);
  });

  it('berechnet len aus start und stop, nie negativ', () => {
    expect(applySegmentPatch(seg(), { start: 10, stop: 25 }).len).toBe(15);
    expect(applySegmentPatch(seg(), { start: 40 }).len).toBe(0);
  });

  it('verändert das übergebene Segment nicht', () => {
    const s = seg();
    applySegmentPatch(s, { on: false, col: [[1, 2, 3]], start: 5 });
    expect(s).toEqual(seg());
  });
});

describe('applyStatePatch', () => {
  describe('Ein/Aus und Helligkeit', () => {
    it('setzt on und schaltet mit "t" um', () => {
      expect(applyStatePatch(state({ on: true }), { on: false }).on).toBe(false);
      expect(applyStatePatch(state({ on: true }), { on: 't' }).on).toBe(false);
      expect(applyStatePatch(state({ on: false }), { on: 't' }).on).toBe(true);
    });

    it('schaltet bei Helligkeit > 0 ein', () => {
      expect(applyStatePatch(state({ on: false, bri: 50 }), { bri: 200 })).toMatchObject({ on: true, bri: 200 });
    });

    it('schaltet bei Helligkeit 0 aus und behält die alte Helligkeit', () => {
      expect(applyStatePatch(state({ on: true, bri: 50 }), { bri: 0 })).toMatchObject({ on: false, bri: 50 });
    });

    it('lässt ein ausdrückliches on im Patch gelten', () => {
      expect(applyStatePatch(state({ on: false }), { bri: 0, on: true }).on).toBe(true);
      expect(applyStatePatch(state({ on: true }), { on: false, bri: 100 })).toMatchObject({ on: false, bri: 100 });
    });

    it('rundet die Helligkeit und klemmt sie auf 1–255', () => {
      expect(applyStatePatch(state(), { bri: 300 }).bri).toBe(255);
      expect(applyStatePatch(state(), { bri: 12.6 }).bri).toBe(13);
      expect(applyStatePatch(state(), { bri: 0.4 }).bri).toBe(1);
    });
  });

  describe('übrige Felder', () => {
    it('nimmt transition, mainseg, ps und pl als Zahl', () => {
      expect(applyStatePatch(state(), { transition: '10', mainseg: 1, ps: 3, pl: 2 })).toMatchObject({ transition: 10, mainseg: 1, ps: 3, pl: 2 });
    });

    it('ignoriert reine Befehlsfelder', () => {
      const patch = { psave: 3, pdel: 4, rb: true, v: true, lv: true, tt: 5, time: 1, np: true, ib: true, sb: true, sc: true, ql: 'x', n: 'x', o: true, playlist: {}, nn: 1 };
      expect(applyStatePatch(state(), patch)).toEqual(state());
    });

    it('führt verschachtelte Objekte zusammen und schaltet darin mit "t" um', () => {
      const next = applyStatePatch(state(), { nl: { on: true, dur: 30 }, udpn: { send: 't' } });
      expect(next.nl).toEqual({ on: true, dur: 30, mode: 1, tbri: 0, rem: -1 });
      expect(next.udpn).toEqual({ send: true, recv: true });
    });

    it('ignoriert Felder, die der Zustand nicht als Objekt kennt', () => {
      expect(applyStatePatch(state(), { foo: 1, bar: { x: 1 }, nl: 5 })).toEqual(state());
    });
  });

  describe('Segmente', () => {
    it('ändert das Segment mit der angegebenen id', () => {
      expect(applyStatePatch(twoSegs(), { seg: { id: 1, fx: 9 } }).seg.map((s) => s.fx)).toEqual([0, 9]);
    });

    it('ändert ohne id alle ausgewählten Segmente', () => {
      expect(applyStatePatch(twoSegs(), { seg: { fx: 9 } }).seg.map((s) => s.fx)).toEqual([9, 0]);
    });

    it('nimmt in einer Liste ohne id die Position als id', () => {
      expect(applyStatePatch(twoSegs(), { seg: [{ fx: 1 }, { fx: 2 }] }).seg.map((s) => s.fx)).toEqual([1, 2]);
    });

    it('zählt Platzhalter und Nicht-Objekte in der Liste als Position mit', () => {
      expect(applyStatePatch(twoSegs(), { seg: [{}, { fx: 2 }] }).seg.map((s) => s.fx)).toEqual([0, 2]);
      expect(applyStatePatch(twoSegs(), { seg: [5, { fx: 2 }] }).seg.map((s) => s.fx)).toEqual([0, 2]);
    });

    it('löscht ein Segment mit stop: 0, aber nie das letzte', () => {
      expect(applyStatePatch(twoSegs(), { seg: { id: 1, stop: 0 } }).seg.map((s) => s.id)).toEqual([0]);
      expect(applyStatePatch(state(), { seg: { id: 0, stop: 0 } }).seg).toHaveLength(1);
    });

    it('ignoriert unbekannte ids ohne createSegments', () => {
      expect(applyStatePatch(state(), { seg: { id: 5, start: 0, stop: 10 } }).seg).toHaveLength(1);
    });

    it('legt mit createSegments neue Segmente an, sortiert nach id', () => {
      const base = state({ seg: [seg({ id: 0 }), seg({ id: 2, start: 60, stop: 90 })] });
      const next = applyStatePatch(base, { seg: { id: 1, start: 30, stop: 60, fx: 3 } }, { createSegments: true });
      expect(next.seg.map((s) => s.id)).toEqual([0, 1, 2]);
      expect(next.seg[1]).toMatchObject({ id: 1, start: 30, stop: 60, len: 30, fx: 3, col: [[255, 160, 0], [0, 0, 0], [0, 0, 0]] });
    });

    it('legt mit channels: 4 neue Segmente mit Weißkanal an', () => {
      const next = applyStatePatch(state(), { seg: { id: 1, start: 30, stop: 60 } }, { createSegments: true, channels: 4 });
      expect(next.seg[1].col).toEqual([[255, 160, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    });

    it('legt ohne start und stop kein Segment an', () => {
      expect(applyStatePatch(state(), { seg: { id: 1, fx: 3 } }, { createSegments: true }).seg).toHaveLength(1);
    });

    it('beendet bei einer Segmentänderung das aktive Preset', () => {
      expect(applyStatePatch(state({ ps: 3 }), { seg: { id: 0, fx: 1 } }).ps).toBe(-1);
      expect(applyStatePatch(state({ ps: 3 }), { ps: 4, seg: { id: 0, fx: 1 } }).ps).toBe(4);
      expect(applyStatePatch(state({ ps: 3 }), { bri: 10, on: true }).ps).toBe(3);
    });
  });

  it('verändert den übergebenen Zustand nicht', () => {
    const s = twoSegs({ ps: 3 });
    const before = structuredClone(s);
    applyStatePatch(s, { on: 't', bri: 3, nl: { on: true }, seg: [{ fx: 4, col: [[1, 2, 3]] }, { id: 1, stop: 0 }] });
    expect(s).toEqual(before);
  });
});
