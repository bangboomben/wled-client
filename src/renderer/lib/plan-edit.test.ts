import { describe, expect, it } from 'vitest';
import type { PlanItem, RoomPlan } from '../../shared/types';
import { addDrawPoint, editPlan, isDirty, startEdit, UNDO_MAX, type EditState, type PlanEdit } from './plan-edit';

const room = { id: 'r1', name: 'Office', x: 0, y: 0, w: 10, h: 8 };
const line: PlanItem = { deviceId: 'a', shape: 'line', points: [[0, 0], [10, 0], [10, 10]], reversed: false };
const point: PlanItem = { deviceId: 'b', shape: 'point', at: [5, 5] };
const area: PlanItem = { deviceId: 'c', shape: 'area', rect: { x: 1, y: 1, w: 4, h: 2 } };
const base: RoomPlan = { version: 1, rooms: [room], items: [line, point, area] };

const run = (...edits: Array<PlanEdit | { type: 'undo' }>): EditState => edits.reduce(editPlan, startEdit(base));
const item = (s: EditState, id: string) => s.plan.items.find((i) => i.deviceId === id);

describe('Räume', () => {
  it('anlegen mit getrimmtem Namen', () => {
    const s = run({ type: 'addRoom', room: { id: 'r2', name: ' Hall ', x: 20, y: 0, w: 4, h: 4 } });
    expect(s.plan.rooms[1]).toEqual({ id: 'r2', name: 'Hall', x: 20, y: 0, w: 4, h: 4 });
  });
  it('zu klein, ohne Namen oder doppelte id → keine Änderung, kein Rückgängig-Schritt', () => {
    const s = run(
      { type: 'addRoom', room: { id: 'r2', name: 'Hall', x: 0, y: 0, w: 1, h: 4 } },
      { type: 'addRoom', room: { id: 'r3', name: ' ', x: 0, y: 0, w: 4, h: 4 } },
      { type: 'addRoom', room: { ...room } },
    );
    expect(s.plan).toBe(base);
    expect(s.undo).toEqual([]);
  });
  it('ändern (verschieben, umbenennen), Mindestmaß bleibt', () => {
    expect(run({ type: 'updateRoom', id: 'r1', changes: { x: 2, name: 'Studio' } }).plan.rooms[0]).toEqual({ ...room, x: 2, name: 'Studio' });
    expect(run({ type: 'updateRoom', id: 'r1', changes: { w: 1 } }).plan).toBe(base);
  });
  it('löschen', () => {
    expect(run({ type: 'removeRoom', id: 'r1' }).plan.rooms).toEqual([]);
  });
});

describe('Geräte', () => {
  it('platzieren ersetzt einen vorhandenen Eintrag desselben Geräts', () => {
    const s = run({ type: 'place', item: { deviceId: 'b', shape: 'point', at: [1, 1] } });
    expect(s.plan.items.filter((i) => i.deviceId === 'b')).toEqual([{ deviceId: 'b', shape: 'point', at: [1, 1] }]);
  });
  it('verschieben bewegt alle Punkte, Punkt und Fläche', () => {
    const s = run({ type: 'moveItem', deviceId: 'a', dx: 1, dy: 2 }, { type: 'moveItem', deviceId: 'b', dx: -1, dy: 0 }, { type: 'moveItem', deviceId: 'c', dx: 0.5, dy: 0.5 });
    expect(item(s, 'a')).toEqual({ ...line, points: [[1, 2], [11, 2], [11, 12]] });
    expect(item(s, 'b')).toEqual({ ...point, at: [4, 5] });
    expect(item(s, 'c')).toEqual({ ...area, rect: { x: 1.5, y: 1.5, w: 4, h: 2 } });
  });
  it('Knickpunkt verschieben, einfügen, entfernen (nicht unter 2)', () => {
    const s = run({ type: 'movePoint', deviceId: 'a', index: 1, to: [8, 1] }, { type: 'insertPoint', deviceId: 'a', after: 0, at: [4, 0] });
    expect((item(s, 'a') as typeof line).points).toEqual([[0, 0], [4, 0], [8, 1], [10, 10]]);
    // Nach dem Entfernen von Index 1 bleiben zwei Punkte; das zweite Entfernen scheitert (nicht unter 2).
    const t = run({ type: 'removePoint', deviceId: 'a', index: 1 }, { type: 'removePoint', deviceId: 'a', index: 0 });
    expect((item(t, 'a') as typeof line).points).toEqual([[0, 0], [10, 10]]);
  });
  it('umkehren nur bei Linien', () => {
    expect(item(run({ type: 'reverse', deviceId: 'a' }), 'a')).toEqual({ ...line, reversed: true });
    expect(run({ type: 'reverse', deviceId: 'b' }).plan).toBe(base);
  });
  it('Fläche: Größe ändern, nicht unter 1', () => {
    expect(item(run({ type: 'resizeArea', deviceId: 'c', rect: { x: 1, y: 1, w: 6, h: 3 } }), 'c')).toEqual({ ...area, rect: { x: 1, y: 1, w: 6, h: 3 } });
    expect(run({ type: 'resizeArea', deviceId: 'c', rect: { x: 1, y: 1, w: 0.5, h: 3 } }).plan).toBe(base);
  });
  it('Form wechseln: Linie → Punkt in der Mitte, Punkt → kurze Linie', () => {
    expect(item(run({ type: 'setShape', deviceId: 'a', shape: 'point' }), 'a')).toEqual({ deviceId: 'a', shape: 'point', at: [10, 0] });
    expect(item(run({ type: 'setShape', deviceId: 'b', shape: 'line' }), 'b')).toEqual({ deviceId: 'b', shape: 'line', points: [[3, 5], [7, 5]], reversed: false });
    expect(run({ type: 'setShape', deviceId: 'b', shape: 'point' }).plan).toBe(base);
  });
  it('aus dem Plan entfernen', () => {
    expect(item(run({ type: 'removeItem', deviceId: 'a' }), 'a')).toBeUndefined();
  });
  it('unbekanntes Gerät → keine Änderung', () => {
    expect(run({ type: 'moveItem', deviceId: 'zz', dx: 1, dy: 1 }).plan).toBe(base);
  });
});

describe('Rückgängig', () => {
  it('macht Schritte der Reihe nach rückgängig', () => {
    const s = run({ type: 'removeRoom', id: 'r1' }, { type: 'removeItem', deviceId: 'a' }, { type: 'undo' });
    expect(s.plan.rooms).toEqual([]);
    expect(item(s, 'a')).toEqual(line);
    expect(editPlan(s, { type: 'undo' }).plan).toBe(base);
  });
  it('ohne Schritte: nichts', () => {
    const s = startEdit(base);
    expect(editPlan(s, { type: 'undo' })).toBe(s);
  });
  it('coalesce fasst einen Zug zu einem Schritt zusammen', () => {
    const s = run(
      { type: 'moveItem', deviceId: 'b', dx: 1, dy: 0 },
      { type: 'moveItem', deviceId: 'b', dx: 1, dy: 0, coalesce: true },
      { type: 'moveItem', deviceId: 'b', dx: 1, dy: 0, coalesce: true },
    );
    expect(item(s, 'b')).toEqual({ ...point, at: [8, 5] });
    expect(s.undo).toHaveLength(1);
    expect(editPlan(s, { type: 'undo' }).plan).toBe(base);
  });
  it(`höchstens ${UNDO_MAX} Schritte`, () => {
    let s = startEdit(base);
    for (let i = 0; i < UNDO_MAX + 10; i++) s = editPlan(s, { type: 'moveItem', deviceId: 'b', dx: 1, dy: 0 });
    expect(s.undo).toHaveLength(UNDO_MAX);
  });
  it('isDirty vergleicht mit dem Stand beim Öffnen', () => {
    const s = run({ type: 'moveItem', deviceId: 'b', dx: 1, dy: 0 });
    expect(isDirty(s, base)).toBe(true);
    expect(isDirty(editPlan(s, { type: 'undo' }), base)).toBe(false);
  });
});

describe('addDrawPoint', () => {
  it('hängt an, aber nicht denselben Punkt zweimal (Doppelklick)', () => {
    expect(addDrawPoint([[0, 0]], [2, 0])).toEqual([[0, 0], [2, 0]]);
    expect(addDrawPoint([[0, 0], [2, 0]], [2, 0])).toEqual([[0, 0], [2, 0]]);
  });
  it('höchstens 100 Punkte', () => {
    const many = Array.from({ length: 100 }, (_, i) => [i, 0] as [number, number]);
    expect(addDrawPoint(many, [500, 0])).toHaveLength(100);
  });
});
