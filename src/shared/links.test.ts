import { describe, expect, it } from 'vitest';
import { findPreset, parseLink, planBrightness, resolveTarget } from './links';
import type { DeviceGroup, DeviceSnapshot, WledState } from './types';

describe('parseLink', () => {
  it('zerlegt Ziel und Schalt-Aktion', () => {
    expect(parseLink('wled-client://device/Regal/off')).toEqual({ target: { kind: 'device', name: 'Regal' }, action: { type: 'power', mode: 'off' } });
    expect(parseLink('wled-client:group/Am%20Sofa/toggle/')).toEqual({ target: { kind: 'group', name: 'Am Sofa' }, action: { type: 'power', mode: 'toggle' } });
    expect(parseLink('WLED-CLIENT://ALL/ON')).toEqual({ target: { kind: 'all' }, action: { type: 'power', mode: 'on' } });
  });

  it('liest Helligkeit fest und schrittweise, Namen URL-dekodiert', () => {
    expect(parseLink('wled-client://device/Fl%C3%BCgel/brightness/50')).toEqual({
      target: { kind: 'device', name: 'Flügel' },
      action: { type: 'brightness', value: 50, relative: false },
    });
    expect(parseLink('wled-client://all/brightness/+10')).toEqual({ target: { kind: 'all' }, action: { type: 'brightness', value: 10, relative: true } });
    expect(parseLink('wled-client://all/brightness/-25')).toEqual({ target: { kind: 'all' }, action: { type: 'brightness', value: -25, relative: true } });
  });

  it('liest Preset, Farbe, Effekt, Palette und look-from', () => {
    expect(parseLink('wled-client://device/Regal/preset/Abend')).toEqual({ target: { kind: 'device', name: 'Regal' }, action: { type: 'preset', ref: 'Abend' } });
    expect(parseLink('wled-client://all/color/FF8000')).toEqual({ target: { kind: 'all' }, action: { type: 'color', color: [255, 128, 0] } });
    expect(parseLink('wled-client://group/Abend/effect/Rainbow')).toEqual({ target: { kind: 'group', name: 'Abend' }, action: { type: 'effect', name: 'Rainbow' } });
    expect(parseLink('wled-client://group/Abend/palette/Party')).toEqual({ target: { kind: 'group', name: 'Abend' }, action: { type: 'palette', name: 'Party' } });
    expect(parseLink('wled-client://device/Sofa/look-from/Regal')).toEqual({ target: { kind: 'device', name: 'Sofa' }, action: { type: 'lookFrom', source: 'Regal' } });
  });

  it('lehnt kaputte Links ab', () => {
    const invalid = { error: 'Ungültiger Link' };
    for (const text of [
      'http://example/all/off',
      `wled-client://device/${'a'.repeat(600)}/off`,
      'wled-client://room/Abend/off',
      'wled-client://device/Regal',
      'wled-client://all/off/mehr',
      'wled-client://all/brightness',
      'wled-client://all/effect/',
      'wled-client://device/%E0%A4%A/off',
      'wled-client://all/off//',
      'wled-client://device/Regal/off//',
    ]) {
      expect(parseLink(text)).toEqual(invalid);
    }
    expect(parseLink(undefined as unknown as string)).toEqual(invalid);
  });

  it('nennt den genauen Grund', () => {
    expect(parseLink('wled-client://all/blink')).toEqual({ error: 'Unbekannte Aktion „blink“' });
    expect(parseLink('wled-client://device//off')).toEqual({ error: 'Name fehlt oder ist zu lang' });
    expect(parseLink(`wled-client://group/${'x'.repeat(65)}/off`)).toEqual({ error: 'Name fehlt oder ist zu lang' });
    expect(parseLink(`wled-client://all/effect/${'x'.repeat(65)}`)).toEqual({ error: 'Name fehlt oder ist zu lang' });
    for (const v of ['0', '101', '1.5', 'abc', '+0', '+101']) {
      expect(parseLink(`wled-client://all/brightness/${v}`)).toEqual({ error: 'Helligkeit muss zwischen 1 und 100 liegen' });
    }
    for (const v of ['ff00', 'gg0000', '%23ff0000']) {
      expect(parseLink(`wled-client://all/color/${v}`)).toEqual({ error: 'Farbe als sechs Hex-Ziffern angeben, z. B. ff0000' });
    }
    expect(parseLink('wled-client://group/Abend/preset/x')).toEqual({ error: 'Presets gibt es nur für einzelne Geräte' });
    expect(parseLink('wled-client://all/preset/1')).toEqual({ error: 'Presets gibt es nur für einzelne Geräte' });
  });
});

/** Gerät mit Name, Verbindung, An/Aus und Helligkeit. */
function dev(id: string, name: string, opts: { status?: DeviceSnapshot['status']; on?: boolean; bri?: number } = {}): DeviceSnapshot {
  const { status = 'online', on = true, bri = 128 } = opts;
  return { id, host: '192.0.2.10', name, status, staticRev: 1, state: { on, bri, seg: [] } as unknown as WledState };
}

describe('resolveTarget', () => {
  const devices = [dev('a', 'Regal'), dev('b', 'Sofa'), dev('c', 'Sofa'), dev('d', 'Fenster')];
  const groups: DeviceGroup[] = [
    { id: 'g', name: 'Abend', members: ['d', 'a'] },
    { id: 'h', name: 'Leer', members: [] },
  ];

  it('findet Geräte und Gruppen ohne Rücksicht auf Groß-/Kleinschreibung', () => {
    expect(resolveTarget({ kind: 'device', name: 'regal' }, devices, groups)).toEqual({ ids: ['a'] });
    expect(resolveTarget({ kind: 'group', name: 'ABEND' }, devices, groups)).toEqual({ ids: ['a', 'd'] });
    expect(resolveTarget({ kind: 'all' }, devices, groups)).toEqual({ ids: ['a', 'b', 'c', 'd'] });
  });

  it('nennt den Grund, wenn es nicht eindeutig klappt', () => {
    expect(resolveTarget({ kind: 'device', name: 'Sofa' }, devices, groups)).toEqual({ error: 'Mehrere Geräte heißen „Sofa“' });
    expect(resolveTarget({ kind: 'device', name: 'Nix' }, devices, groups)).toEqual({ error: 'Gerät „Nix“ gibt es nicht' });
    expect(resolveTarget({ kind: 'group', name: 'Nix' }, devices, groups)).toEqual({ error: 'Gruppe „Nix“ gibt es nicht' });
    expect(resolveTarget({ kind: 'group', name: 'leer' }, devices, groups)).toEqual({ error: 'Diese Gruppe hat keine Geräte.' });
    expect(resolveTarget({ kind: 'all' }, [], groups)).toEqual({ error: 'Keine Geräte' });
  });
});

describe('planBrightness', () => {
  it('setzt ein Gerät fest oder schrittweise', () => {
    expect(planBrightness([dev('a', 'Regal', { bri: 200 })], 50, false)).toEqual([{ id: 'a', bri: 128 }]);
    expect(planBrightness([dev('a', 'Regal', { bri: 128 })], 10, true)).toEqual([{ id: 'a', bri: 153 }]);
    expect(planBrightness([dev('a', 'Regal', { bri: 128 })], -100, true)).toEqual([{ id: 'a', bri: 3 }]);
    expect(planBrightness([dev('a', 'Regal', { bri: 250 })], 100, true)).toEqual([{ id: 'a', bri: 255 }]);
  });

  it('dimmt Gruppen anteilig, ausgeschaltete bleiben aus', () => {
    expect(planBrightness([dev('a', 'Regal', { bri: 200 }), dev('b', 'Sofa', { bri: 100 })], 50, false)).toEqual([
      { id: 'a', bri: 128 },
      { id: 'b', bri: 64 },
    ]);
    expect(planBrightness([dev('a', 'Regal', { bri: 200 }), dev('b', 'Sofa', { on: false, bri: 100 })], 50, false)).toEqual([{ id: 'a', bri: 128 }]);
  });

  it('schaltet eine ganz ausgeschaltete Gruppe anteilig ein, ohne erreichbare nichts', () => {
    expect(planBrightness([dev('a', 'Regal', { on: false, bri: 200 }), dev('b', 'Sofa', { on: false, bri: 100 })], 100, false)).toEqual([
      { id: 'a', bri: 255 },
      { id: 'b', bri: 128 },
    ]);
    expect(planBrightness([dev('a', 'Regal', { status: 'offline' })], 50, false)).toEqual([]);
  });
});

describe('findPreset', () => {
  const presets = { '0': {}, '3': { n: 'Abend' }, '7': { n: '7' }, '12': {} };

  it('sucht beim Namen, sonst bei der Nummer', () => {
    expect(findPreset(presets, 'abend')).toBe(3);
    expect(findPreset(presets, '12')).toBe(12);
    expect(findPreset(presets, '7')).toBe(7);
  });

  it('bevorzugt den Namen vor der Nummer', () => {
    expect(findPreset({ '2': { n: '5' }, '5': { n: 'Nacht' } }, '5')).toBe(2);
  });

  it('gibt für Unbekanntes und Preset 0 nichts zurück', () => {
    for (const ref of ['Morgen', '99', '0']) expect(findPreset(presets, ref)).toBeNull();
  });
});
