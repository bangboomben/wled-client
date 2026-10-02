import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, cleanDevices, cleanSettings } from './store-data';

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

  it('übernimmt Design und Sprache nur mit erlaubten Werten', () => {
    expect(cleanSettings({ theme: 'dark', language: 'en' })).toEqual({ theme: 'dark', language: 'en' });
    expect(cleanSettings({ theme: 'light', language: 'system' })).toEqual({ theme: 'light', language: 'system' });
    expect(cleanSettings({ theme: 'blau', language: 'fr' })).toEqual({});
  });

  it('übernimmt selectedId nur als Text', () => {
    expect(cleanSettings({ selectedId: 'a1' })).toEqual({ selectedId: 'a1' });
    expect(cleanSettings({ selectedId: 3 })).toEqual({});
  });

  it('lässt unbekannte Schlüssel weg', () => {
    expect(cleanSettings({ theme: 'system', foo: 1 })).toEqual({ theme: 'system' });
  });
});

describe('DEFAULT_SETTINGS', () => {
  it('hat die bisherigen Standardwerte', () => {
    expect(DEFAULT_SETTINGS).toEqual({ closeToTray: true, startWithWindows: false, liveView: false, theme: 'system', language: 'system', autoUpdate: true });
  });

  it('besteht die eigene Prüfung unverändert', () => {
    expect(cleanSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });
});
