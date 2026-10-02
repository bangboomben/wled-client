import { describe, expect, it } from 'vitest';
import type { DeviceGroup } from '../shared/types';
import { GroupManager, type GroupStore } from './groups';

/** Ersatz-Store im Speicher; zählt, wie oft gespeichert wurde. */
function setup(initial: DeviceGroup[] = []) {
  const saved = { groups: initial, count: 0 };
  const store: GroupStore = {
    getGroups: () => saved.groups.map((g) => ({ ...g, members: [...g.members] })),
    setGroups: (groups) => {
      saved.groups = groups;
      saved.count++;
    },
  };
  const gm = new GroupManager(store, () => ['a', 'b', 'c']);
  const events: DeviceGroup[][] = [];
  gm.on('groups', (list: DeviceGroup[]) => events.push(list));
  return { saved, gm, events };
}

const abend: DeviceGroup = { id: 'g1', name: 'Abend', members: ['a', 'b'] };

describe('GroupManager', () => {
  it('lädt die Gruppen aus dem Store', () => {
    expect(setup([abend]).gm.list()).toEqual([abend]);
  });

  it('legt eine Gruppe an, speichert sie und meldet die neue Liste', () => {
    const { saved, gm, events } = setup([abend]);
    const r = gm.create({ name: ' Nacht ', members: ['c'] });
    expect(r.ok).toBe(true);
    expect(typeof r.id).toBe('string');
    const expected = [abend, { id: r.id, name: 'Nacht', members: ['c'] }];
    expect(gm.list()).toEqual(expected);
    expect(saved.groups).toEqual(expected);
    expect(events).toEqual([expected]);
  });

  it('speichert und meldet nichts bei ungültiger Eingabe', () => {
    const { saved, gm, events } = setup([abend]);
    expect(gm.create({ name: 'abend', members: ['c'] })).toEqual({ ok: false, error: 'Eine Gruppe „abend“ gibt es schon.' });
    expect(saved.count).toBe(0);
    expect(events).toEqual([]);
  });

  it('ändert Name und Mitglieder einer Gruppe', () => {
    const { saved, gm, events } = setup([abend]);
    expect(gm.update('g1', { name: 'Spät', members: ['c', 'a'] })).toEqual({ ok: true });
    expect(saved.groups).toEqual([{ id: 'g1', name: 'Spät', members: ['c', 'a'] }]);
    expect(events).toHaveLength(1);
  });

  it('meldet beim Ändern einer unbekannten Gruppe einen Fehler', () => {
    const { saved, gm } = setup([abend]);
    expect(gm.update('nope', { name: 'X', members: ['a'] })).toEqual({ ok: false, error: 'Gruppe nicht gefunden' });
    expect(saved.count).toBe(0);
  });

  it('löscht eine Gruppe; eine unbekannte id ändert nichts', () => {
    const { saved, gm, events } = setup([abend]);
    gm.remove('nope');
    expect(saved.count).toBe(0);
    gm.remove('g1');
    expect(saved.groups).toEqual([]);
    expect(events).toEqual([[]]);
  });

  it('nimmt entfernte Geräte aus allen Gruppen, leere Gruppen bleiben stehen', () => {
    const { saved, gm, events } = setup([abend, { id: 'g2', name: 'Nur b', members: ['b'] }]);
    gm.pruneDevices(['a', 'c']);
    expect(saved.groups).toEqual([
      { id: 'g1', name: 'Abend', members: ['a'] },
      { id: 'g2', name: 'Nur b', members: [] },
    ]);
    expect(events).toHaveLength(1);
  });

  it('meldet beim Aufräumen nichts, wenn alle Mitglieder noch da sind', () => {
    const { saved, gm, events } = setup([abend]);
    gm.pruneDevices(['a', 'b', 'c']);
    expect(saved.count).toBe(0);
    expect(events).toEqual([]);
  });

  it('gibt Kopien heraus, die den eigenen Stand nicht verändern', () => {
    const { gm } = setup([abend]);
    gm.list()[0].members.push('c');
    expect(gm.list()[0].members).toEqual(['a', 'b']);
  });
});
