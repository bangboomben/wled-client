import { describe, expect, it } from 'vitest';
import {
  areaForMatrix,
  directionAt,
  emptyPlan,
  fitView,
  ledPositions,
  lineLength,
  nearLine,
  planBounds,
  planLabel,
  pointAt,
  rectFrom,
  resizeKeepRatio,
  resizeRect,
  round1,
  segmentTicks,
  shapeFor,
  snapPoint,
  toScreen,
  toUnits,
} from './plan';
import type { DeviceSnapshot, PlanRoom, WledInfo, WledState } from './types';

const info = (leds: Partial<WledInfo['leds']>) => ({ leds: { count: 30, maxseg: 32, ...leds } }) as WledInfo;
const room: PlanRoom = { id: 'r', name: 'Office', x: 0, y: 0, w: 10, h: 8 };

describe('round1', () => {
  it('rundet auf 0,1', () => {
    expect(round1(1.04)).toBe(1);
    expect(round1(2.06)).toBe(2.1);
  });
  it('gibt nie −0 zurück', () => {
    expect(Object.is(round1(-0.04), 0)).toBe(true);
    expect(Object.is(round1(-0), 0)).toBe(true);
  });
});

describe('shapeFor', () => {
  it('Matrix → Fläche, 1 LED → Punkt, sonst Linie', () => {
    expect(shapeFor(info({ count: 128, matrix: { w: 16, h: 8 } }))).toBe('area');
    expect(shapeFor(info({ count: 1 }))).toBe('point');
    expect(shapeFor(info({ count: 400 }))).toBe('line');
  });
  it('ohne Gerätedaten: Linie', () => {
    expect(shapeFor(undefined)).toBe('line');
  });
});

describe('snapPoint', () => {
  it('frei: nur auf 0,1 gerundet', () => {
    expect(snapPoint([3.14, 2.06], [room], true)).toEqual([3.1, 2.1]);
  });
  it('rastet an einer nahen Ecke ein', () => {
    expect(snapPoint([0.3, 0.4], [room], false)).toEqual([0, 0]);
  });
  it('Ecke vor Kante', () => {
    expect(snapPoint([9.8, 7.7], [room], false)).toEqual([10, 8]);
    // Abstand zur Ecke ≈ 0,559 < 0,6; allein die obere Kante ergäbe [1, 0]
    expect(snapPoint([0.55, 0.1], [room], false)).toEqual([0, 0]);
  });
  it('rastet an einer nahen Kante ein und entlang der Kante aufs Raster', () => {
    expect(snapPoint([5.3, 0.4], [room], false)).toEqual([5, 0]);
    expect(snapPoint([9.7, 4.4], [room], false)).toEqual([10, 4]);
  });
  it('sonst aufs Raster', () => {
    expect(snapPoint([3.4, 3.6], [room], false)).toEqual([3, 4]);
    expect(snapPoint([3.4, 3.6], [], false)).toEqual([3, 4]);
  });
});

describe('Linien', () => {
  const L = [
    [0, 0],
    [3, 4],
    [3, 10],
  ] as [number, number][];

  it('Länge über alle Knicke', () => {
    expect(lineLength(L)).toBe(11);
  });
  it('Punkt in Abstand d, begrenzt auf Anfang und Ende', () => {
    expect(pointAt(L, 5)).toEqual([3, 4]);
    expect(pointAt(L, 8)).toEqual([3, 7]);
    expect(pointAt(L, -1)).toEqual([0, 0]);
    expect(pointAt(L, 99)).toEqual([3, 10]);
  });
  it('Richtung an der Stelle d', () => {
    expect(directionAt(L, 8)).toEqual([0, 1]);
    expect(directionAt([[0, 0], [0, 0]], 0)).toEqual([1, 0]);
  });
  it('Richtung bei doppeltem Endpunkt: das letzte Teilstück mit Länge', () => {
    expect(directionAt([[0, 0], [0, 10], [0, 10]], 99)).toEqual([0, 1]);
    expect(directionAt([[0, 0], [0, 10], [0, 10]], 10)).toEqual([0, 1]);
  });
  it('verteilt n LEDs gleichmäßig von Anfang bis Ende', () => {
    expect(ledPositions([[0, 0], [10, 0]], 3, false)).toEqual([[0, 0], [5, 0], [10, 0]]);
    expect(ledPositions([[0, 0], [4, 0], [4, 4]], 3, false)).toEqual([[0, 0], [4, 0], [4, 4]]);
  });
  it('umgekehrt: LED 1 am Linienende', () => {
    expect(ledPositions([[0, 0], [10, 0]], 3, true)).toEqual([[10, 0], [5, 0], [0, 0]]);
  });
  it('eine LED in der Mitte, keine LED oder zu kurze Linie → leer', () => {
    expect(ledPositions([[0, 0], [10, 0]], 1, false)).toEqual([[5, 0]]);
    expect(ledPositions([[0, 0], [10, 0]], 0, false)).toEqual([]);
    expect(ledPositions([[0, 0]], 5, false)).toEqual([]);
  });
  it('Linie der Länge 0: alle LEDs auf dem Punkt', () => {
    expect(ledPositions([[2, 2], [2, 2]], 3, false)).toEqual([[2, 2], [2, 2], [2, 2]]);
  });
});

describe('segmentTicks', () => {
  const segs = [
    { start: 0, stop: 40 },
    { start: 40, stop: 100 },
  ];
  it('Querstrich an jeder Segmentgrenze', () => {
    expect(segmentTicks([[0, 0], [10, 0]], segs, 100, false)).toEqual([{ at: [4, 0], dir: [1, 0] }]);
  });
  it('umgekehrt von hinten gezählt', () => {
    expect(segmentTicks([[0, 0], [10, 0]], segs, 100, true)).toEqual([{ at: [6, 0], dir: [1, 0] }]);
  });
  it('ein Segment oder doppelte Anfänge: keine bzw. nur ein Strich', () => {
    expect(segmentTicks([[0, 0], [10, 0]], [{ start: 0, stop: 100 }], 100, false)).toEqual([]);
    expect(segmentTicks([[0, 0], [10, 0]], [...segs, { start: 40, stop: 60 }], 100, false)).toHaveLength(1);
  });
});

describe('nearLine', () => {
  const pts = [
    [0, 0],
    [10, 0],
    [10, 10],
  ] as [number, number][];
  it('findet das nächste Teilstück innerhalb der Toleranz', () => {
    const a = nearLine([5, 0.3], pts, 0.5);
    expect(a?.index).toBe(0);
    expect(a?.dist).toBeCloseTo(0.3);
    expect(nearLine([9.8, 5], pts, 0.5)?.index).toBe(1);
  });
  it('zu weit weg → null', () => {
    expect(nearLine([5, 5], pts, 0.5)).toBeNull();
  });
});

describe('Rechtecke', () => {
  it('rectFrom ordnet die Ecken', () => {
    expect(rectFrom([5, 5], [1, 2])).toEqual({ x: 1, y: 2, w: 4, h: 3 });
  });
  it('resizeRect zieht eine Ecke, Mindestmaß bleibt', () => {
    expect(resizeRect({ x: 0, y: 0, w: 10, h: 8 }, 2, [12, 9], 2)).toEqual({ x: 0, y: 0, w: 12, h: 9 });
    expect(resizeRect({ x: 0, y: 0, w: 10, h: 8 }, 0, [9, 7], 2)).toEqual({ x: 8, y: 6, w: 2, h: 2 });
  });
  it('resizeRect: Ecke 1 (oben rechts) und Ecke 3 (unten links), die Gegenecke bleibt', () => {
    expect(resizeRect({ x: 0, y: 0, w: 10, h: 8 }, 1, [12, -1], 2)).toEqual({ x: 0, y: -1, w: 12, h: 9 });
    expect(resizeRect({ x: 0, y: 0, w: 10, h: 8 }, 1, [-5, 20], 2)).toEqual({ x: 0, y: 6, w: 2, h: 2 });
    expect(resizeRect({ x: 0, y: 0, w: 10, h: 8 }, 3, [3, 11], 2)).toEqual({ x: 3, y: 0, w: 7, h: 11 });
    expect(resizeRect({ x: 0, y: 0, w: 10, h: 8 }, 3, [20, -4], 2)).toEqual({ x: 8, y: 0, w: 2, h: 2 });
  });
  it('resizeKeepRatio hält das Seitenverhältnis, die gegenüberliegende Ecke bleibt', () => {
    expect(resizeKeepRatio({ x: 0, y: 0, w: 8, h: 4 }, 2, [12, 3])).toEqual({ x: 0, y: 0, w: 12, h: 6 });
    expect(resizeKeepRatio({ x: 0, y: 0, w: 8, h: 4 }, 0, [4, 3])).toEqual({ x: 4, y: 2, w: 4, h: 2 });
  });
  it('resizeKeepRatio: Ecke 1 (oben rechts) und Ecke 3 (unten links), die Gegenecke bleibt', () => {
    expect(resizeKeepRatio({ x: 0, y: 0, w: 8, h: 4 }, 1, [12, 1])).toEqual({ x: 0, y: -2, w: 12, h: 6 });
    expect(resizeKeepRatio({ x: 0, y: 0, w: 8, h: 4 }, 3, [4, 3])).toEqual({ x: 2, y: 0, w: 6, h: 3 });
  });
  it('areaForMatrix: längere Seite 8, Mitte am Punkt', () => {
    expect(areaForMatrix({ w: 16, h: 8 }, [10, 10])).toEqual({ x: 6, y: 8, w: 8, h: 4 });
    expect(areaForMatrix({ w: 8, h: 16 }, [10, 10])).toEqual({ x: 8, y: 6, w: 4, h: 8 });
  });
});

describe('Ausschnitt', () => {
  it('planBounds: leer → null, sonst alles umfassend', () => {
    expect(planBounds(emptyPlan())).toBeNull();
    expect(planBounds({ version: 1, rooms: [room], items: [{ deviceId: 'a', shape: 'point', at: [12, 3] }] })).toEqual({ x: 0, y: 0, w: 13, h: 8 });
  });
  it('fitView passt mit Rand ein und zentriert', () => {
    const v = fitView({ x: 0, y: 0, w: 10, h: 10 }, 400, 200, 1);
    expect(v.scale).toBeCloseTo(16.667, 2);
    expect(v.x).toBeCloseTo(116.667, 2);
    expect(v.y).toBeCloseTo(16.667, 2);
  });
  it('fitView mit Ursprung ≠ 0: Versatz um −Ursprung · Maßstab', () => {
    const v = fitView({ x: 10, y: 5, w: 10, h: 10 }, 400, 200, 1);
    expect(v.scale).toBeCloseTo(16.667, 2);
    expect(v.x).toBeCloseTo(-50, 2);
    expect(v.y).toBeCloseTo(-66.667, 2);
    // der Ausschnitt liegt trotzdem mittig: Mitte der Grenzen (15, 10) landet in der Mitte der Fläche
    const m = toScreen(v, [15, 10]);
    expect(m[0]).toBeCloseTo(200, 2);
    expect(m[1]).toBeCloseTo(100, 2);
  });
  it('fitView: untere Maßstabsgrenze 4', () => {
    const v = fitView({ x: 0, y: 0, w: 200, h: 200 }, 100, 100, 1);
    expect(v.scale).toBe(4);
    expect(v.x).toBeCloseTo(-350, 2);
    expect(v.y).toBeCloseTo(-350, 2);
  });
  it('fitView begrenzt den Maßstab und kommt mit leerem Plan und Größe 0 zurecht', () => {
    expect(fitView({ x: 0, y: 0, w: 0, h: 0 }, 400, 400, 1).scale).toBe(60);
    expect(fitView(null, 400, 200, 1)).toEqual({ scale: 24, x: 24, y: 24 });
    const z = fitView({ x: 0, y: 0, w: 10, h: 10 }, 0, 0, 1);
    expect([z.scale, z.x, z.y].every(Number.isFinite)).toBe(true);
  });
  it('toScreen und toUnits sind Umkehrungen', () => {
    const v = { scale: 20, x: 5, y: 7 };
    expect(toScreen(v, [2, 3])).toEqual([45, 67]);
    expect(toUnits(v, [45, 67])).toEqual([2, 3]);
  });
});

describe('planLabel', () => {
  const dev = (patch: Partial<DeviceSnapshot>): DeviceSnapshot => ({ id: 'a', host: 'h', name: 'Desk', status: 'online', staticRev: 0, ...patch });
  it('beschreibt Zustand und Helligkeit', () => {
    expect(planLabel(dev({ state: { on: true, bri: 209 } as WledState }))).toBe('Desk, an, 82 %');
    expect(planLabel(dev({ state: { on: false, bri: 209 } as WledState }))).toBe('Desk, aus');
    expect(planLabel(dev({ status: 'offline' }))).toBe('Desk, offline');
    expect(planLabel(dev({ status: 'connecting' }))).toBe('Desk, verbindet');
  });
});
