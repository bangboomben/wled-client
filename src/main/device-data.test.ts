import { describe, expect, it } from 'vitest';
import { cleanPalx, cleanPresets, cleanState, isWledInfo } from './device-data';

/** Antwort von /json/info mit den Pflichtfeldern, einzelne Felder überschreibbar. */
const info = (fields: Record<string, unknown> = {}) => ({ ver: '0.15.0', name: 'Testlampe', mac: 'aabbccddeeff', leds: { count: 30 }, ...fields });

describe('isWledInfo', () => {
  it('erkennt eine Antwort von /json/info', () => {
    expect(isWledInfo(info())).toBe(true);
  });

  it('kommt ohne mac aus', () => {
    expect(isWledInfo(info({ mac: undefined }))).toBe(true);
  });

  it('lehnt Antworten ohne Pflichtfelder oder mit falschen Typen ab', () => {
    const bad = [null, [], 'x', {}, info({ ver: 15 }), info({ name: undefined }), info({ mac: 1 }), info({ leds: undefined }), info({ leds: [] }), info({ leds: { count: '30' } })];
    for (const v of bad) expect(isWledInfo(v)).toBe(false);
  });
});

describe('cleanState', () => {
  it('lehnt Zustände ohne Segmentliste ab', () => {
    for (const raw of [null, [], 'x', {}, { seg: {} }]) expect(cleanState(raw)).toBeUndefined();
  });

  it('setzt fehlende Felder auf Ersatzwerte', () => {
    expect(cleanState({ seg: [] })).toEqual({
      on: false,
      bri: 128,
      transition: 7,
      ps: -1,
      pl: -1,
      mainseg: 0,
      seg: [],
      nl: { on: false, dur: 60, mode: 1, tbri: 0, rem: -1 },
      udpn: { send: false, recv: false },
    });
  });

  it('nimmt on nur bei true als eingeschaltet', () => {
    expect(cleanState({ on: true, seg: [] })?.on).toBe(true);
    for (const on of [1, 'true', 'on']) expect(cleanState({ on, seg: [] })?.on).toBe(false);
  });

  it('übernimmt nur endliche Zahlen', () => {
    expect(cleanState({ bri: 200, transition: 0, ps: 3, pl: 2, mainseg: 1, seg: [] })).toMatchObject({ bri: 200, transition: 0, ps: 3, pl: 2, mainseg: 1 });
    expect(cleanState({ bri: Number.NaN, transition: Infinity, ps: '3', seg: [] })).toMatchObject({ bri: 128, transition: 7, ps: -1 });
  });

  it('behält nur Segmente als Objekt, ohne Farbliste mit leerer Liste', () => {
    const state = cleanState({ seg: [null, 5, [1], { id: 0, col: [[1, 2, 3]] }, { id: 1 }] });
    expect(state?.seg).toEqual([{ id: 0, col: [[1, 2, 3]] }, { id: 1, col: [] }]);
  });

  it('ersetzt Farbslots, die keine Liste sind, durch Schwarz und behält die Positionen', () => {
    const state = cleanState({ seg: [{ id: 0, col: [[1, 2, 3], 'x', [4, 5, 6], null] }] });
    expect(state?.seg[0].col).toEqual([[1, 2, 3], [0, 0, 0], [4, 5, 6], [0, 0, 0]]);
  });

  it('ergänzt Nachtlicht und Sync und behält deren übrige Felder', () => {
    const state = cleanState({ seg: [], nl: { on: true, dur: 'x', fade: 1 }, udpn: { send: 1, recv: true, sgrp: 2 } });
    expect(state?.nl).toEqual({ on: true, dur: 60, mode: 1, tbri: 0, rem: -1, fade: 1 });
    expect(state?.udpn).toEqual({ send: false, recv: true, sgrp: 2 });
  });

  it('reicht unbekannte Felder durch', () => {
    expect(cleanState({ seg: [], lor: 0, foo: 'bar' })).toMatchObject({ lor: 0, foo: 'bar' });
  });
});

describe('cleanPresets', () => {
  it('gibt ohne Objekt nichts zurück', () => {
    for (const raw of [null, [], 'x']) expect(cleanPresets(raw)).toEqual({});
  });

  it('behält nur positive ganzzahlige IDs', () => {
    const p = { n: 'Abend' };
    expect(Object.keys(cleanPresets({ '0': p, '1': p, '01': p, '-1': p, x: p, '1.5': p, '250': p }))).toEqual(['1', '250']);
  });

  it('verwirft leere Presets und solche, die kein Objekt sind', () => {
    expect(cleanPresets({ '1': {}, '2': 5, '3': [], '4': null, '5': { on: true } })).toEqual({ '5': { on: true } });
  });

  it('macht Name und Schnellwahl zu Text oder entfernt sie', () => {
    expect(cleanPresets({ '1': { n: 5, ql: 7 } })).toEqual({ '1': { n: '5', ql: '7' } });
    expect(cleanPresets({ '2': { n: {}, ql: true, on: true } })).toEqual({ '2': { on: true } });
  });

  it('reicht die übrigen Felder durch', () => {
    const preset = { n: 'Abend', bri: 80, seg: [{ fx: 3 }] };
    expect(cleanPresets({ '1': preset })).toEqual({ '1': preset });
  });

  it('bereinigt Playlists', () => {
    const raw = { '1': { n: 'Liste', playlist: { ps: [1, 'x', 2], dur: [10, 'y'], transition: 5, repeat: 2, end: 3, r: true, extra: 1 } } };
    expect(cleanPresets(raw)['1'].playlist).toEqual({ ps: [1, 2], dur: [10], transition: 5, repeat: 2, end: 3, r: true });
  });

  it('setzt in Playlists fehlende Dauer und Übergangszeit auf Ersatzwerte', () => {
    expect(cleanPresets({ '1': { playlist: { ps: [1], dur: 'x' } } })['1'].playlist).toEqual({ ps: [1], dur: 100, transition: 7 });
  });

  it('entfernt unbrauchbare Playlists und behält das Preset', () => {
    expect(cleanPresets({ '1': { n: 'Kaputt', playlist: { ps: [] } }, '2': { n: 'Auch', playlist: 5 } })).toEqual({
      '1': { n: 'Kaputt' },
      '2': { n: 'Auch' },
    });
  });
});

describe('cleanPalx', () => {
  it('behält nur Einträge, die Listen sind', () => {
    const raw = { '0': [[0, 255, 0, 0], [255, 0, 0, 255]], '1': 'x', '2': null, '3': ['r', 'c1'] };
    expect(cleanPalx(raw)).toEqual({ '0': raw['0'], '3': raw['3'] });
  });

  it('gibt ohne Objekt nichts zurück', () => {
    for (const raw of [null, [], 'x']) expect(cleanPalx(raw)).toEqual({});
  });
});
