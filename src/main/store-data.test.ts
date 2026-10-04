import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, checkGroup, cleanDevices, cleanGroups, cleanPlan, cleanSettings, readPlanFile } from './store-data';

describe('cleanDevices', () => {
  it('gibt ohne Liste eine leere Liste zurück', () => {
    for (const raw of [undefined, null, {}, 'x', 5]) expect(cleanDevices(raw)).toEqual([]);
  });

  it('behält gültige Geräte mit ihren optionalen Textfeldern', () => {
    const device = { id: 'a1', host: '192.0.2.10', mac: 'aabbccddeeff', alias: 'Testlampe', lastName: 'WLED' };
    expect(cleanDevices([device])).toEqual([device]);
  });

  it('lässt unbekannte Felder und optionale Felder ohne Text weg', () => {
    expect(cleanDevices([{ id: 'a1', host: '192.0.2.10', alias: 5, mac: null, extra: true }])).toEqual([{ id: 'a1', host: '192.0.2.10' }]);
  });

  it('verwirft Einträge ohne gültige id oder host', () => {
    const raw = [
      null,
      'x',
      [],
      { host: '192.0.2.10' },
      { id: '', host: '192.0.2.10' },
      { id: 1, host: '192.0.2.10' },
      { id: 'a1' },
      { id: 'a1', host: '' },
      { id: 'a1', host: 5 },
    ];
    expect(cleanDevices(raw)).toEqual([]);
  });

  it('behält bei doppelter id den ersten Eintrag', () => {
    const raw = [
      { id: 'a1', host: '192.0.2.10' },
      { id: 'a1', host: '192.0.2.11' },
      { id: 'b2', host: '192.0.2.12' },
    ];
    expect(cleanDevices(raw)).toEqual([{ id: 'a1', host: '192.0.2.10' }, { id: 'b2', host: '192.0.2.12' }]);
  });

  it('lässt einen verworfenen Eintrag keine id belegen', () => {
    expect(cleanDevices([{ id: 'a1' }, { id: 'a1', host: '192.0.2.11' }])).toEqual([{ id: 'a1', host: '192.0.2.11' }]);
  });
});

describe('cleanSettings', () => {
  it('gibt ohne Objekt nichts zurück', () => {
    for (const raw of [undefined, null, [], 'x', 5]) expect(cleanSettings(raw)).toEqual({});
  });

  it('übernimmt Ein/Aus-Einstellungen nur als Boolean', () => {
    const flags = { closeToTray: false, startWithWindows: true, liveView: true, autoUpdate: false, trayHintShown: true };
    expect(cleanSettings(flags)).toEqual(flags);
    expect(cleanSettings({ closeToTray: 'nein', liveView: 1 })).toEqual({});
  });

  it('übernimmt allowLinks nur als Boolean', () => {
    expect(cleanSettings({ allowLinks: true })).toEqual({ allowLinks: true });
    expect(cleanSettings({ allowLinks: 'ja' })).toEqual({});
  });

  it('übernimmt planOpen nur als Boolean', () => {
    expect(cleanSettings({ planOpen: true })).toEqual({ planOpen: true });
    expect(cleanSettings({ planOpen: 1 })).toEqual({});
  });

  it('übernimmt Design und Sprache nur mit erlaubten Werten', () => {
    expect(cleanSettings({ theme: 'dark', language: 'en' })).toEqual({ theme: 'dark', language: 'en' });
    expect(cleanSettings({ theme: 'light', language: 'system' })).toEqual({ theme: 'light', language: 'system' });
    expect(cleanSettings({ theme: 'blau', language: 'fr' })).toEqual({});
  });

  it('übernimmt selectedId nur als Text', () => {
    expect(cleanSettings({ selectedId: 'a1' })).toEqual({ selectedId: 'a1' });
    expect(cleanSettings({ selectedId: 3 })).toEqual({});
  });

  it('übernimmt selectedGroupId nur als Text, auch leer (= keine Gruppe gewählt)', () => {
    expect(cleanSettings({ selectedGroupId: 'g1' })).toEqual({ selectedGroupId: 'g1' });
    expect(cleanSettings({ selectedGroupId: '' })).toEqual({ selectedGroupId: '' });
    expect(cleanSettings({ selectedGroupId: 5 })).toEqual({});
  });

  it('lässt unbekannte Schlüssel weg', () => {
    expect(cleanSettings({ theme: 'system', foo: 1 })).toEqual({ theme: 'system' });
  });
});

describe('DEFAULT_SETTINGS', () => {
  it('hat die bisherigen Standardwerte', () => {
    expect(DEFAULT_SETTINGS).toEqual({ closeToTray: true, startWithWindows: false, liveView: false, theme: 'system', language: 'system', autoUpdate: true, allowLinks: false, planOpen: false });
  });

  it('besteht die eigene Prüfung unverändert', () => {
    expect(cleanSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('cleanGroups', () => {
  const ids = ['a', 'b'];

  it('gibt ohne Liste eine leere Liste zurück', () => {
    for (const raw of [undefined, null, {}, 'x', 5]) expect(cleanGroups(raw, ids)).toEqual([]);
  });

  it('trimmt den Namen und behält nur bekannte Mitglieder ohne Doppelte', () => {
    expect(cleanGroups([{ id: 'g1', name: '  Abend ', members: ['a', 'x', 'a', 5, 'b'] }], ids)).toEqual([
      { id: 'g1', name: 'Abend', members: ['a', 'b'] },
    ]);
  });

  it('lässt unbekannte Felder weg und macht aus fehlenden Mitgliedern eine leere Liste', () => {
    expect(cleanGroups([{ id: 'g1', name: 'Abend', members: 'a', extra: true }], ids)).toEqual([{ id: 'g1', name: 'Abend', members: [] }]);
  });

  it('verwirft Einträge ohne gültige id oder Namen', () => {
    const raw = [null, 'x', [], { name: 'A' }, { id: '', name: 'A' }, { id: 'g', name: 5 }, { id: 'g', name: '   ' }];
    expect(cleanGroups(raw, ids)).toEqual([]);
  });

  it('kürzt zu lange Namen auf 40 Zeichen', () => {
    expect(cleanGroups([{ id: 'g1', name: 'x'.repeat(50), members: [] }], ids)).toEqual([{ id: 'g1', name: 'x'.repeat(40), members: [] }]);
  });

  it('behält bei doppelter id oder doppeltem Namen (ohne Groß-/Kleinschreibung) den ersten Eintrag', () => {
    const raw = [
      { id: 'g1', name: 'Abend', members: [] },
      { id: 'g1', name: 'Nacht', members: [] },
      { id: 'g2', name: 'ABEND', members: [] },
      { id: 'g3', name: 'Nacht', members: [] },
    ];
    expect(cleanGroups(raw, ids)).toEqual([
      { id: 'g1', name: 'Abend', members: [] },
      { id: 'g3', name: 'Nacht', members: [] },
    ]);
  });
});

describe('checkGroup', () => {
  const ids = ['a', 'b'];
  const groups = [{ id: 'g1', name: 'Abend', members: ['a'] }];

  it('übernimmt getrimmten Namen und bekannte Mitglieder ohne Doppelte, in Eingabereihenfolge', () => {
    expect(checkGroup({ name: '  Nacht ', members: ['b', 'a', 'b', 'x'] }, groups, ids)).toEqual({ ok: true, name: 'Nacht', members: ['b', 'a'] });
  });

  it('verlangt einen Namen', () => {
    for (const name of ['', '   ', 5, undefined]) {
      expect(checkGroup({ name, members: ['a'] }, groups, ids)).toEqual({ ok: false, error: 'Bitte einen Namen eingeben.' });
    }
  });

  it('erlaubt höchstens 40 Zeichen', () => {
    expect(checkGroup({ name: 'x'.repeat(41), members: ['a'] }, groups, ids)).toEqual({ ok: false, error: 'Der Name darf höchstens 40 Zeichen haben.' });
    expect(checkGroup({ name: 'x'.repeat(40), members: ['a'] }, groups, ids).ok).toBe(true);
  });

  it('lehnt einen schon vergebenen Namen ab, ohne Rücksicht auf Groß-/Kleinschreibung', () => {
    expect(checkGroup({ name: 'ABEND', members: ['a'] }, groups, ids)).toEqual({ ok: false, error: 'Eine Gruppe „ABEND“ gibt es schon.' });
  });

  it('erlaubt der bearbeiteten Gruppe ihren eigenen Namen', () => {
    expect(checkGroup({ name: 'abend', members: ['b'] }, groups, ids, 'g1')).toEqual({ ok: true, name: 'abend', members: ['b'] });
  });

  it('verlangt mindestens ein bekanntes Gerät', () => {
    for (const members of [[], ['x'], 'a', undefined]) {
      expect(checkGroup({ name: 'Nacht', members }, groups, ids)).toEqual({ ok: false, error: 'Bitte mindestens ein Gerät auswählen.' });
    }
  });
});

describe('cleanPlan', () => {
  const ids = ['a', 'b', 'c'];
  const room = { id: 'r1', name: ' Office ', x: 0, y: 0, w: 10, h: 8 };

  it('übernimmt einen gültigen Plan und rundet auf 0,1', () => {
    const raw = {
      version: 1,
      rooms: [room],
      items: [
        { deviceId: 'a', shape: 'line', points: [[1.04, 2], [5, 2.06]], reversed: true },
        { deviceId: 'b', shape: 'point', at: [3, 4] },
        { deviceId: 'c', shape: 'area', rect: { x: 1, y: 1, w: 2, h: 1 } },
      ],
    };
    expect(cleanPlan(raw, ids)).toEqual({
      version: 1,
      rooms: [{ id: 'r1', name: 'Office', x: 0, y: 0, w: 10, h: 8 }],
      items: [
        { deviceId: 'a', shape: 'line', points: [[1, 2], [5, 2.1]], reversed: true },
        { deviceId: 'b', shape: 'point', at: [3, 4] },
        { deviceId: 'c', shape: 'area', rect: { x: 1, y: 1, w: 2, h: 1 } },
      ],
    });
  });

  it('kein Objekt oder falsche Version → leerer Plan', () => {
    expect(cleanPlan(null, ids)).toEqual({ version: 1, rooms: [], items: [] });
    expect(cleanPlan({ version: 2, rooms: [room], items: [] }, ids)).toEqual({ version: 1, rooms: [], items: [] });
  });

  it('Räume: ohne Namen, zu klein, außerhalb des Bereichs oder doppelte id fallen weg; Name höchstens 40 Zeichen', () => {
    const rooms = [
      { ...room, id: 'x1', name: '  ' },
      { ...room, id: 'x2', w: 1.9 },
      { ...room, id: 'x3', x: 995 },
      room,
      { ...room, name: 'Doppelt' },
      { ...room, id: 'x4', name: 'N'.repeat(50) },
    ];
    const out = cleanPlan({ version: 1, rooms, items: [] }, ids).rooms;
    expect(out.map((r) => r.id)).toEqual(['r1', 'x4']);
    expect(out[1].name).toHaveLength(40);
  });

  it('höchstens 100 Räume', () => {
    const rooms = Array.from({ length: 120 }, (_, i) => ({ ...room, id: `r${i}` }));
    expect(cleanPlan({ version: 1, rooms, items: [] }, ids).rooms).toHaveLength(100);
  });

  it('Geräte: unbekannt, doppelt, kaputte Form oder zu viele Punkte fallen weg', () => {
    const items = [
      { deviceId: 'zz', shape: 'point', at: [1, 1] },
      { deviceId: 'a', shape: 'point', at: [1, 1] },
      { deviceId: 'a', shape: 'point', at: [2, 2] },
      { deviceId: 'b', shape: 'line', points: [[1, 1]] },
      { deviceId: 'c', shape: 'line', points: Array.from({ length: 101 }, (_, i) => [i, 0]) },
    ];
    expect(cleanPlan({ version: 1, rooms: [], items }, ids).items).toEqual([{ deviceId: 'a', shape: 'point', at: [1, 1] }]);
  });

  it('Typfehler und Werte außerhalb −1000…1000 fallen weg', () => {
    const items = [
      { deviceId: 'a', shape: 'point', at: ['1', 1] },
      { deviceId: 'b', shape: 'point', at: [1001, 0] },
      { deviceId: 'c', shape: 'area', rect: { x: 0, y: 0, w: 0.5, h: 1 } },
    ];
    expect(cleanPlan({ version: 1, rooms: [], items }, ids).items).toEqual([]);
  });

  it('NaN und Infinity als Koordinaten fallen weg', () => {
    const items = [
      { deviceId: 'a', shape: 'point', at: [NaN, 1] },
      { deviceId: 'b', shape: 'point', at: [1, Infinity] },
      { deviceId: 'c', shape: 'line', points: [[0, 0], [-Infinity, 1]] },
    ];
    const rooms = [{ ...room, id: 'n1', x: NaN }, { ...room, id: 'n2', w: Infinity }];
    expect(cleanPlan({ version: 1, rooms, items }, ids)).toEqual({ version: 1, rooms: [], items: [] });
  });

  it('Grenzwerte werden angenommen: Punkt bei ±1000, Linie mit 100 Punkten, Raum 2 × 2, Raum bis 1000', () => {
    const line = Array.from({ length: 100 }, (_, i) => [i, 0]);
    const raw = {
      version: 1,
      rooms: [
        { id: 'min', name: 'Min', x: 0, y: 0, w: 2, h: 2 },
        { id: 'edge', name: 'Edge', x: 990, y: -1000, w: 10, h: 2 },
      ],
      items: [
        { deviceId: 'a', shape: 'point', at: [1000, -1000] },
        { deviceId: 'b', shape: 'point', at: [-1000, 1000] },
        { deviceId: 'c', shape: 'line', points: line },
      ],
    };
    const out = cleanPlan(raw, ids);
    expect(out.rooms.map((r) => r.id)).toEqual(['min', 'edge']);
    expect(out.items.map((i) => i.deviceId)).toEqual(['a', 'b', 'c']);
    expect(out.items[2]).toMatchObject({ shape: 'line' });
    expect((out.items[2] as { points: unknown[] }).points).toHaveLength(100);
  });

  it('reversed fehlt → false', () => {
    const items = [{ deviceId: 'a', shape: 'line', points: [[0, 0], [1, 0]] }];
    expect(cleanPlan({ version: 1, rooms: [], items }, ids).items[0]).toEqual({ deviceId: 'a', shape: 'line', points: [[0, 0], [1, 0]], reversed: false });
  });
});

describe('readPlanFile', () => {
  const dirs: string[] = [];
  const dir = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'wled-plan-'));
    dirs.push(d);
    return d;
  };
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('fehlende Datei → leerer Plan', () => {
    expect(readPlanFile(path.join(dir(), 'plan.json'), [])).toEqual({ version: 1, rooms: [], items: [] });
  });

  it('liest und prüft eine vorhandene Datei', () => {
    const file = path.join(dir(), 'plan.json');
    writeFileSync(file, JSON.stringify({ version: 1, rooms: [], items: [{ deviceId: 'a', shape: 'point', at: [1, 2] }, { deviceId: 'x', shape: 'point', at: [1, 2] }] }));
    expect(readPlanFile(file, ['a']).items).toEqual([{ deviceId: 'a', shape: 'point', at: [1, 2] }]);
  });

  it('kaputtes JSON → leerer Plan, Datei als plan.json.broken beiseitegelegt', () => {
    const file = path.join(dir(), 'plan.json');
    writeFileSync(file, '{ kaputt');
    expect(readPlanFile(file, [])).toEqual({ version: 1, rooms: [], items: [] });
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.broken`, 'utf8')).toBe('{ kaputt');
  });

  it('gültiges JSON, aber kein Plan oder andere Version → leerer Plan, Datei als plan.json.broken beiseitegelegt', () => {
    for (const text of ['[]', 'null', '5', JSON.stringify({ version: 2, rooms: [], items: [] })]) {
      const file = path.join(dir(), 'plan.json');
      writeFileSync(file, text);
      expect(readPlanFile(file, [])).toEqual({ version: 1, rooms: [], items: [] });
      expect(existsSync(file)).toBe(false);
      expect(readFileSync(`${file}.broken`, 'utf8')).toBe(text);
    }
  });

  it('ein brauchbarer Plan bleibt liegen', () => {
    const file = path.join(dir(), 'plan.json');
    writeFileSync(file, JSON.stringify({ version: 1, rooms: [], items: [] }));
    readPlanFile(file, []);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.broken`)).toBe(false);
  });
});
