import { describe, expect, it } from 'vitest';
import { brightnessBase, groupMembers, groupView, powerTargets, scaleBrightness } from './groups';
import type { DeviceGroup, DeviceSnapshot, WledState } from './types';

/** Gerät mit dem Nötigsten: Verbindung, an/aus, Helligkeit. */
function dev(id: string, opts: { status?: DeviceSnapshot['status']; on?: boolean; bri?: number; noState?: boolean } = {}): DeviceSnapshot {
  const { status = 'online', on = true, bri = 128, noState = false } = opts;
  return {
    id,
    host: '192.0.2.10',
    name: `Lampe ${id}`,
    status,
    state: noState ? undefined : ({ on, bri } as WledState),
    staticRev: 0,
  };
}

describe('groupMembers', () => {
  it('liefert die Mitglieder in der Reihenfolge der Geräteliste und überspringt unbekannte IDs', () => {
    const group: DeviceGroup = { id: 'g', name: 'Abend', members: ['c', 'x', 'a'] };
    const members = groupMembers(group, [dev('a'), dev('b'), dev('c')]);
    expect(members.map((d) => d.id)).toEqual(['a', 'c']);
  });
});

describe('groupView', () => {
  it('ist an, sobald ein erreichbares Mitglied leuchtet; Bezug ist die hellste leuchtende Lampe', () => {
    expect(groupView([dev('a', { on: true, bri: 80 }), dev('b', { on: false, bri: 250 })])).toEqual({ lit: true, bri: 80, reachable: 2 });
  });

  it('nimmt ohne leuchtendes Mitglied die höchste Helligkeit der erreichbaren', () => {
    expect(groupView([dev('a', { on: false, bri: 90 }), dev('b', { on: false, bri: 40 })])).toEqual({ lit: false, bri: 90, reachable: 2 });
  });

  it('lässt Mitglieder ohne Verbindung außen vor', () => {
    const members = [dev('a', { status: 'offline', on: true, bri: 255 }), dev('b', { on: true, bri: 60 }), dev('c', { status: 'connecting', noState: true })];
    expect(groupView(members)).toEqual({ lit: true, bri: 60, reachable: 1 });
  });

  it('meldet ohne erreichbare Mitglieder aus, Bezug 128', () => {
    expect(groupView([])).toEqual({ lit: false, bri: 128, reachable: 0 });
    expect(groupView([dev('a', { status: 'offline' })])).toEqual({ lit: false, bri: 128, reachable: 0 });
  });
});

describe('powerTargets', () => {
  it('schaltet alle erreichbaren Mitglieder, egal ob an oder aus', () => {
    expect(powerTargets([dev('a', { on: true }), dev('b', { status: 'offline' }), dev('c', { on: false })])).toEqual(['a', 'c']);
  });
});

describe('brightnessBase', () => {
  it('nimmt nur leuchtende erreichbare Mitglieder', () => {
    const members = [dev('a', { on: true, bri: 200 }), dev('b', { on: false, bri: 50 }), dev('c', { on: true, bri: 100 })];
    expect(brightnessBase(members)).toEqual([
      { id: 'a', bri: 200 },
      { id: 'c', bri: 100 },
    ]);
  });

  it('nimmt alle erreichbaren, wenn keins leuchtet', () => {
    const members = [dev('a', { on: false, bri: 90 }), dev('b', { status: 'offline', bri: 30 }), dev('c', { on: false, bri: 40 })];
    expect(brightnessBase(members)).toEqual([
      { id: 'a', bri: 90 },
      { id: 'c', bri: 40 },
    ]);
  });

  it('ist ohne erreichbare Mitglieder leer', () => {
    expect(brightnessBase([dev('a', { status: 'offline' })])).toEqual([]);
  });
});

describe('scaleBrightness', () => {
  const base = [
    { id: 'a', bri: 200 },
    { id: 'b', bri: 100 },
  ];

  it('hält das Verhältnis: die hellste Lampe bekommt genau v', () => {
    expect(scaleBrightness(base, 100)).toEqual([
      { id: 'a', bri: 100 },
      { id: 'b', bri: 50 },
    ]);
    expect(scaleBrightness(base, 255)).toEqual([
      { id: 'a', bri: 255 },
      { id: 'b', bri: 128 },
    ]);
  });

  it('rundet auf ganze Werte', () => {
    expect(scaleBrightness([{ id: 'a', bri: 200 }, { id: 'b', bri: 33 }], 50)).toEqual([
      { id: 'a', bri: 50 },
      { id: 'b', bri: 8 },
    ]);
  });

  it('geht nie unter 1 und nie über 255', () => {
    expect(scaleBrightness([{ id: 'a', bri: 200 }, { id: 'b', bri: 10 }], 5)).toEqual([
      { id: 'a', bri: 5 },
      { id: 'b', bri: 1 },
    ]);
    expect(scaleBrightness([{ id: 'a', bri: 200 }], 300)).toEqual([{ id: 'a', bri: 255 }]);
  });

  it('bringt aus demselben Ausgangsstand die Verhältnisse zurück', () => {
    expect(scaleBrightness(base, 2)).toEqual([
      { id: 'a', bri: 2 },
      { id: 'b', bri: 1 },
    ]);
    expect(scaleBrightness(base, 200)).toEqual(base);
  });

  it('verliert die Unterschiede, wenn der Ausgangsstand schon gleich ist', () => {
    expect(scaleBrightness([{ id: 'a', bri: 1 }, { id: 'b', bri: 1 }], 200)).toEqual([
      { id: 'a', bri: 200 },
      { id: 'b', bri: 200 },
    ]);
  });

  it('gibt für einen leeren Stand nichts zurück', () => {
    expect(scaleBrightness([], 100)).toEqual([]);
  });
});
