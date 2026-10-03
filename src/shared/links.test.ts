import { describe, expect, it } from 'vitest';
import { parseLink } from './links';

describe('parseLink', () => {
  it('zerlegt Ziel und Schalt-Aktion', () => {
    expect(parseLink('wled-client://device/Tisch/off')).toEqual({ target: { kind: 'device', name: 'Tisch' }, action: { type: 'power', mode: 'off' } });
    expect(parseLink('wled-client:group/Am%20Bett/toggle/')).toEqual({ target: { kind: 'group', name: 'Am Bett' }, action: { type: 'power', mode: 'toggle' } });
    expect(parseLink('WLED-CLIENT://ALL/ON')).toEqual({ target: { kind: 'all' }, action: { type: 'power', mode: 'on' } });
  });

  it('liest Helligkeit fest und schrittweise, Namen URL-dekodiert', () => {
    expect(parseLink('wled-client://device/K%C3%BCche/brightness/50')).toEqual({
      target: { kind: 'device', name: 'Küche' },
      action: { type: 'brightness', value: 50, relative: false },
    });
    expect(parseLink('wled-client://all/brightness/+10')).toEqual({ target: { kind: 'all' }, action: { type: 'brightness', value: 10, relative: true } });
    expect(parseLink('wled-client://all/brightness/-25')).toEqual({ target: { kind: 'all' }, action: { type: 'brightness', value: -25, relative: true } });
  });

  it('liest Preset, Farbe, Effekt, Palette und look-from', () => {
    expect(parseLink('wled-client://device/Tisch/preset/Abend')).toEqual({ target: { kind: 'device', name: 'Tisch' }, action: { type: 'preset', ref: 'Abend' } });
    expect(parseLink('wled-client://all/color/FF8000')).toEqual({ target: { kind: 'all' }, action: { type: 'color', color: [255, 128, 0] } });
    expect(parseLink('wled-client://group/Abend/effect/Rainbow')).toEqual({ target: { kind: 'group', name: 'Abend' }, action: { type: 'effect', name: 'Rainbow' } });
    expect(parseLink('wled-client://group/Abend/palette/Party')).toEqual({ target: { kind: 'group', name: 'Abend' }, action: { type: 'palette', name: 'Party' } });
    expect(parseLink('wled-client://device/Bett/look-from/Tisch')).toEqual({ target: { kind: 'device', name: 'Bett' }, action: { type: 'lookFrom', source: 'Tisch' } });
  });

  it('lehnt kaputte Links ab', () => {
    const invalid = { error: 'Ungültiger Link' };
    for (const text of [
      'http://example/all/off',
      `wled-client://device/${'a'.repeat(600)}/off`,
      'wled-client://room/Abend/off',
      'wled-client://device/Tisch',
      'wled-client://all/off/mehr',
      'wled-client://all/brightness',
      'wled-client://all/effect/',
      'wled-client://device/%E0%A4%A/off',
    ]) {
      expect(parseLink(text)).toEqual(invalid);
    }
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
