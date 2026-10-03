import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, checkGroup, cleanDevices, cleanGroups, cleanSettings } from './store-data';

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
    expect(DEFAULT_SETTINGS).toEqual({ closeToTray: true, startWithWindows: false, liveView: false, theme: 'system', language: 'system', autoUpdate: true, allowLinks: false });
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
