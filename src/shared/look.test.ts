import { describe, expect, it } from 'vitest';
import { actionPatch, cleanAction, cleanLook, commonNames, copySummary, copyTargets, failureSummary, lookFrom, lookPatch, type Look } from './look';
import type { DeviceGroup, DeviceSnapshot, DeviceStatic, WledSegment, WledState } from './types';

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

/** Ziel mit anderer Reihenfolge der Namen als die Quelle (anderer Firmware-Stand). */
const TARGET: DeviceStatic = {
  effects: ['Solid', 'Aurora', 'Rainbow'],
  palettes: ['Default', 'Sunset', 'Party'],
  fxdata: [],
  presets: {},
};

const targetState = { on: true, bri: 42, seg: [seg({ id: 0, start: 0, stop: 20 }), seg({ id: 3, start: 20, stop: 60 })] } as WledState;

describe('lookPatch', () => {
  it('bildet Effekt und Palette beim Namen ab und setzt den Look auf alle Segmente, ohne Helligkeit und Grenzen', () => {
    const part = { fx: 1, pal: 1, sx: 10, ix: 20, c1: 30, c2: 40, c3: 50, o1: true, o2: false, o3: true };
    const col = [[255, 0, 0, 0], [0, 255, 0, 10], [0, 0, 255, 0]];
    expect(lookPatch(LOOK, targetState, TARGET)).toEqual({
      patch: { seg: [{ id: 0, ...part, col }, { id: 3, ...part, col }] },
    });
  });

  it('nennt die Gründe in fester Reihenfolge', () => {
    expect(lookPatch({ ...LOOK, pal: null }, targetState, null)).toEqual({ reason: 'Effektliste noch nicht geladen' });
    expect(lookPatch({ ...LOOK, fx: 'Blink', pal: null }, targetState, TARGET)).toEqual({ reason: 'Eigene Paletten lassen sich nicht übertragen' });
    expect(lookPatch({ ...LOOK, fx: 'Blink', pal: 'Ocean' }, targetState, TARGET)).toEqual({ reason: 'Effekt „Blink“ gibt es dort nicht' });
    expect(lookPatch({ ...LOOK, pal: 'Ocean' }, targetState, TARGET)).toEqual({ reason: 'Palette „Ocean“ gibt es dort nicht' });
  });
});

/** Gerät mit Verbindungsstatus; der Rest ist für die Zielauswahl egal. */
const dev = (id: string, status: DeviceSnapshot['status'] = 'online'): DeviceSnapshot => ({ id, host: '192.0.2.10', name: `Lampe ${id}`, status, staticRev: 0 });

describe('copyTargets', () => {
  const devices = [dev('a'), dev('b'), dev('c', 'offline'), dev('d')];
  const groups: DeviceGroup[] = [
    { id: 'g1', name: 'Abend', members: ['b', 'c', 'a'] },
    { id: 'g2', name: 'Nur Quelle', members: ['a'] },
  ];

  it('löst Gruppen auf, nimmt jedes Gerät einmal, ohne Quelle und ohne Geräte ohne Verbindung, in Listenreihenfolge', () => {
    expect(copyTargets({ devices: ['d', 'a'], groups: ['g1'] }, groups, devices, 'a')).toEqual(['b', 'd']);
  });

  it('liefert für eine Gruppe, die außer der Quelle niemanden erreicht, nichts', () => {
    expect(copyTargets({ devices: [], groups: ['g2'] }, groups, devices, 'a')).toEqual([]);
  });
});

describe('copySummary', () => {
  const nameOf = (id: string) => `Lampe ${id}`;

  it('zählt Erfolge und hängt Gründe an', () => {
    const results = [{ id: 'a', ok: true }, { id: 'b', ok: true }, { id: 'c', ok: false, reason: 'Effekt „X“ gibt es dort nicht' }];
    expect(copySummary(results, nameOf)).toBe('Look auf 2 Geräte übertragen · Lampe c: Effekt „X“ gibt es dort nicht');
  });

  it('nutzt die Einzahl für ein Gerät', () => {
    expect(copySummary([{ id: 'a', ok: true }], nameOf)).toBe('Look auf 1 Gerät übertragen');
  });

  it('meldet, wenn nichts übertragen wurde', () => {
    expect(copySummary([{ id: 'b', ok: false, reason: 'Offline' }], nameOf)).toBe('Look nicht übertragen · Lampe b: Offline');
    expect(copySummary([], nameOf)).toBe('Look nicht übertragen');
  });
});

describe('cleanAction', () => {
  it('lässt gültige Aktionen durch und wirft Unbekanntes weg', () => {
    expect(cleanAction({ kind: 'solid', color: [255, 0, 0] })).toEqual({ kind: 'solid', color: [255, 0, 0] });
    expect(cleanAction({ kind: 'effect', name: 'Rainbow' })).toEqual({ kind: 'effect', name: 'Rainbow' });
    expect(cleanAction({ kind: 'palette', name: 'Party', extra: 1 })).toEqual({ kind: 'palette', name: 'Party' });
  });

  it('verwirft alles Unpassende', () => {
    const bad: unknown[] = [
      null,
      [],
      'solid',
      { kind: 'blink', name: 'x' },
      { kind: 'solid', color: [255, 0] },
      { kind: 'solid', color: [255, 0, 0, 0] },
      { kind: 'solid', color: [256, 0, 0] },
      { kind: 'solid', color: [1.5, 0, 0] },
      { kind: 'effect', name: '' },
      { kind: 'palette', name: 'x'.repeat(65) },
      { kind: 'effect' },
    ];
    for (const raw of bad) expect(cleanAction(raw)).toBeNull();
  });
});

/** „Solid“ steht hier nicht an erster Stelle — die Abbildung muss beim Namen gehen. */
const SOLID_ELSEWHERE: DeviceStatic = { effects: ['Blink', 'Solid', 'Rainbow'], palettes: ['Party', 'Default'], fxdata: [], presets: {} };

describe('actionPatch', () => {
  it('setzt „Solid“ beim Namen und nur Farbe 1 mit Weiß 0 auf alle Segmente', () => {
    expect(actionPatch({ kind: 'solid', color: [255, 0, 0] }, targetState, SOLID_ELSEWHERE)).toEqual({
      patch: {
        seg: [
          { id: 0, fx: 1, col: [[255, 0, 0, 0]] },
          { id: 3, fx: 1, col: [[255, 0, 0, 0]] },
        ],
      },
    });
  });

  it('setzt Effekt bzw. Palette beim Namen, sonst nichts', () => {
    expect(actionPatch({ kind: 'effect', name: 'Rainbow' }, targetState, SOLID_ELSEWHERE)).toEqual({
      patch: { seg: [{ id: 0, fx: 2 }, { id: 3, fx: 2 }] },
    });
    expect(actionPatch({ kind: 'palette', name: 'Default' }, targetState, SOLID_ELSEWHERE)).toEqual({
      patch: { seg: [{ id: 0, pal: 1 }, { id: 3, pal: 1 }] },
    });
  });

  it('findet Effekt und Palette ohne Rücksicht auf Groß-/Kleinschreibung', () => {
    expect(actionPatch({ kind: 'effect', name: 'rainbow' }, targetState, SOLID_ELSEWHERE)).toEqual({
      patch: { seg: [{ id: 0, fx: 2 }, { id: 3, fx: 2 }] },
    });
    expect(actionPatch({ kind: 'palette', name: 'DEFAULT' }, targetState, SOLID_ELSEWHERE)).toEqual({
      patch: { seg: [{ id: 0, pal: 1 }, { id: 3, pal: 1 }] },
    });
  });

  it('nimmt den genauen Namen vor dem, der sich nur in der Schreibweise unterscheidet', () => {
    const both: DeviceStatic = { effects: ['Solid', 'rainbow', 'Rainbow'], palettes: ['party', 'Party'], fxdata: [], presets: {} };
    expect(actionPatch({ kind: 'effect', name: 'Rainbow' }, targetState, both)).toEqual({ patch: { seg: [{ id: 0, fx: 2 }, { id: 3, fx: 2 }] } });
    expect(actionPatch({ kind: 'palette', name: 'Party' }, targetState, both)).toEqual({ patch: { seg: [{ id: 0, pal: 1 }, { id: 3, pal: 1 }] } });
    // Ohne genauen Treffer gewinnt der erste, der sich nur in der Schreibweise unterscheidet.
    expect(actionPatch({ kind: 'effect', name: 'RAINBOW' }, targetState, both)).toEqual({ patch: { seg: [{ id: 0, fx: 1 }, { id: 3, fx: 1 }] } });
  });

  it('nennt den Namen, wie er getippt wurde, wenn es ihn auch ohne Rücksicht auf die Schreibweise nicht gibt', () => {
    expect(actionPatch({ kind: 'effect', name: 'aurora' }, targetState, SOLID_ELSEWHERE)).toEqual({ reason: 'Effekt „aurora“ gibt es dort nicht' });
    expect(actionPatch({ kind: 'palette', name: 'sunset' }, targetState, SOLID_ELSEWHERE)).toEqual({ reason: 'Palette „sunset“ gibt es dort nicht' });
  });

  it('nennt die Gründe', () => {
    expect(actionPatch({ kind: 'effect', name: 'Rainbow' }, targetState, null)).toEqual({ reason: 'Effektliste noch nicht geladen' });
    expect(actionPatch({ kind: 'solid', color: [1, 2, 3] }, targetState, { ...SOLID_ELSEWHERE, effects: ['Blink'] })).toEqual({
      reason: 'Effekt „Solid“ gibt es dort nicht',
    });
    expect(actionPatch({ kind: 'effect', name: 'Aurora' }, targetState, SOLID_ELSEWHERE)).toEqual({ reason: 'Effekt „Aurora“ gibt es dort nicht' });
    expect(actionPatch({ kind: 'palette', name: 'Sunset' }, targetState, SOLID_ELSEWHERE)).toEqual({ reason: 'Palette „Sunset“ gibt es dort nicht' });
  });
});

describe('commonNames', () => {
  it('liefert die gemeinsamen Namen in der Reihenfolge der ersten Liste', () => {
    expect(commonNames([['Solid', 'Blink', 'Rainbow', 'Aurora'], ['Aurora', 'Solid', 'Rainbow']])).toEqual(['Solid', 'Rainbow', 'Aurora']);
  });

  it('lässt Platzhalter, leere Namen und Doppelte weg', () => {
    expect(commonNames([['Solid', '-', 'RSVD', 'Solid', '', 'Rainbow'], ['Rainbow', 'Solid', '-', 'RSVD', '']])).toEqual(['Solid', 'Rainbow']);
  });

  it('gibt ohne Listen nichts zurück, mit einer Liste deren Namen', () => {
    expect(commonNames([])).toEqual([]);
    expect(commonNames([['Solid', 'Blink']])).toEqual(['Solid', 'Blink']);
  });
});

describe('failureSummary', () => {
  const nameOf = (id: string) => `Lampe ${id}`;

  it('meldet nichts, wenn alles geklappt hat', () => {
    expect(failureSummary([{ id: 'a', ok: true }], nameOf)).toBeNull();
    expect(failureSummary([], nameOf)).toBeNull();
  });

  it('nennt die gescheiterten Geräte mit Grund', () => {
    expect(failureSummary([{ id: 'a', ok: true }, { id: 'b', ok: false, reason: 'Offline' }], nameOf)).toBe('Nicht übernommen · Lampe b: Offline');
  });
});
