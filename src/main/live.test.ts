import { describe, expect, it } from 'vitest';
import { liveIds } from './live';

const base = { visible: true, liveView: true, device: null, plan: false, placed: ['a', 'b'] };

describe('liveIds', () => {
  it('Geräteansicht: nur das gewählte Gerät', () => {
    expect(liveIds({ ...base, device: 'x' })).toEqual(['x']);
  });
  it('Raumplan sichtbar: alle platzierten Geräte', () => {
    expect(liveIds({ ...base, plan: true })).toEqual(['a', 'b']);
  });
  it('beides: Vereinigung ohne Doppelte', () => {
    expect(liveIds({ ...base, plan: true, device: 'a' })).toEqual(['a', 'b']);
  });
  it('Fenster versteckt oder Live-Vorschau aus: keine', () => {
    expect(liveIds({ ...base, plan: true, visible: false })).toEqual([]);
    expect(liveIds({ ...base, plan: true, liveView: false })).toEqual([]);
  });
  it('Plan nicht sichtbar: platzierte Geräte zählen nicht', () => {
    expect(liveIds(base)).toEqual([]);
  });
});
