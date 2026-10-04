import { describe, expect, it } from 'vitest';
import type { RoomPlan } from '../shared/types';
import { PlanManager, type PlanStore } from './plan';

/** Ersatz-Store im Speicher; zählt, wie oft gespeichert wurde. */
function setup(initial: RoomPlan = { version: 1, rooms: [], items: [] }, ids = ['a', 'b']) {
  const saved = { plan: initial, count: 0 };
  const store: PlanStore = {
    getPlan: () => structuredClone(saved.plan),
    setPlan: (plan) => {
      saved.plan = structuredClone(plan);
      saved.count++;
    },
  };
  const pm = new PlanManager(store, () => ids);
  const events: RoomPlan[] = [];
  pm.on('plan', (p: RoomPlan) => events.push(p));
  return { saved, pm, events };
}

const withAB: RoomPlan = {
  version: 1,
  rooms: [],
  items: [
    { deviceId: 'a', shape: 'point', at: [1, 1] },
    { deviceId: 'b', shape: 'point', at: [2, 2] },
  ],
};

describe('PlanManager', () => {
  it('lädt den Plan aus dem Store', () => {
    expect(setup(withAB).pm.get()).toEqual(withAB);
  });

  it('set prüft, speichert, meldet und gibt den gespeicherten Plan zurück', () => {
    const { saved, pm, events } = setup();
    const out = pm.set({ ...withAB, items: [...withAB.items, { deviceId: 'gelöscht', shape: 'point', at: [3, 3] }] });
    expect(out).toEqual(withAB);
    expect(saved.plan).toEqual(withAB);
    expect(saved.count).toBe(1);
    expect(events).toEqual([withAB]);
  });

  it('set mit Unbrauchbarem (null, Text) speichert und meldet einen leeren Plan', () => {
    for (const raw of [null, 'kaputt']) {
      const { saved, pm, events } = setup(withAB);
      expect(pm.set(raw)).toEqual({ version: 1, rooms: [], items: [] });
      expect(saved.plan).toEqual({ version: 1, rooms: [], items: [] });
      expect(saved.count).toBe(1);
      expect(events).toEqual([{ version: 1, rooms: [], items: [] }]);
    }
  });

  it('placedIds nennt alle platzierten Geräte', () => {
    expect(setup(withAB).pm.placedIds()).toEqual(['a', 'b']);
  });

  it('pruneDevices nimmt gelöschte Geräte heraus; ohne Änderung kein Speichern', () => {
    const { saved, pm, events } = setup(withAB);
    pm.pruneDevices(['a', 'b']);
    expect(saved.count).toBe(0);
    pm.pruneDevices(['b']);
    expect(saved.plan.items).toEqual([{ deviceId: 'b', shape: 'point', at: [2, 2] }]);
    expect(events).toHaveLength(1);
  });

  it('get gibt eine Kopie heraus', () => {
    const { pm } = setup(withAB);
    pm.get().items.pop();
    expect(pm.get().items).toHaveLength(2);
  });
});
