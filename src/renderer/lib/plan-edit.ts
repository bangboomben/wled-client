// Bearbeitungsmodus des Raumplans: reine Änderungen am Plan mit Rückgängig-Stapel (ohne Oberfläche, testbar).

import { AREA_MIN, PLAN_COORD_MAX, PLAN_POINTS_MAX, ROOM_MIN, lineLength, pointAt, round1 } from '../../shared/plan';
import type { PlanItem, PlanPoint, PlanRect, PlanRoom, RoomPlan } from '../../shared/types';

export const UNDO_MAX = 50;

export interface EditState {
  plan: RoomPlan;
  /** Frühere Stände, der jüngste zuletzt. */
  undo: RoomPlan[];
}

export type PlanEdit = (
  | { type: 'addRoom'; room: PlanRoom }
  | { type: 'updateRoom'; id: string; changes: Partial<Omit<PlanRoom, 'id'>> }
  | { type: 'removeRoom'; id: string }
  | { type: 'place'; item: PlanItem }
  | { type: 'moveItem'; deviceId: string; dx: number; dy: number }
  | { type: 'movePoint'; deviceId: string; index: number; to: PlanPoint }
  | { type: 'insertPoint'; deviceId: string; after: number; at: PlanPoint }
  | { type: 'removePoint'; deviceId: string; index: number }
  | { type: 'reverse'; deviceId: string }
  | { type: 'resizeArea'; deviceId: string; rect: PlanRect }
  | { type: 'setShape'; deviceId: string; shape: 'line' | 'point' }
  | { type: 'removeItem'; deviceId: string }
) & {
  /** Fortsetzung eines Zugs (Ziehen): ändert den Plan, legt aber keinen neuen Rückgängig-Schritt an. */
  coalesce?: boolean;
};

export const startEdit = (plan: RoomPlan): EditState => ({ plan, undo: [] });

const shift = (p: PlanPoint, dx: number, dy: number): PlanPoint => [round1(p[0] + dx), round1(p[1] + dy)];

function moved(item: PlanItem, dx: number, dy: number): PlanItem {
  if (item.shape === 'line') return { ...item, points: item.points.map((p) => shift(p, dx, dy)) };
  if (item.shape === 'point') return { ...item, at: shift(item.at, dx, dy) };
  return { ...item, rect: { ...item.rect, x: round1(item.rect.x + dx), y: round1(item.rect.y + dy) } };
}

/** Mitte eines Eintrags: bei Linien die Mitte entlang der Länge, bei Flächen der Mittelpunkt. */
const center = (item: PlanItem): PlanPoint =>
  item.shape === 'line'
    ? pointAt(item.points, lineLength(item.points) / 2)
    : item.shape === 'point'
      ? item.at
      : [item.rect.x + item.rect.w / 2, item.rect.y + item.rect.h / 2];

/** Andere Form für ein Gerät: Punkt in der Mitte der Linie bzw. Fläche, aus einem Punkt eine kurze waagrechte Linie. */
function reshaped(item: PlanItem, shape: 'line' | 'point'): PlanItem | null {
  if (item.shape === shape) return null;
  const [x, y] = center(item);
  if (shape === 'point') return { deviceId: item.deviceId, shape: 'point', at: [round1(x), round1(y)] };
  return { deviceId: item.deviceId, shape: 'line', points: [[round1(x - 2), round1(y)], [round1(x + 2), round1(y)]], reversed: false };
}

// Wie beim Speichern (cleanPlan): Was über ±PLAN_COORD_MAX hinausragt, würde dort still verworfen. Die Bearbeitung
// lehnt es deshalb schon beim Ändern ab — sonst schöbe z. B. eine gehaltene Pfeiltaste etwas aus dem Plan.
const inRange = (v: number) => Math.abs(v) <= PLAN_COORD_MAX;
const rectInRange = (r: PlanRect) => [r.x, r.y, r.x + r.w, r.y + r.h].every(inRange);
const roomInRange = (r: PlanRoom) => rectInRange(r);
const itemInRange = (it: PlanItem) =>
  it.shape === 'line' ? it.points.every((p) => inRange(p[0]) && inRange(p[1])) : it.shape === 'point' ? it.at.every(inRange) : rectInRange(it.rect);

/** Ist p einer der Punkte? (Koordinaten sind auf 0,1 gerundet, ein Vergleich genügt.) */
const sameAs = (p: PlanPoint, ...others: PlanPoint[]) => others.some((o) => o[0] === p[0] && o[1] === p[1]);

/** Plan nach der Änderung — oder null, wenn sie nichts bewirkt oder ungültig ist. */
function apply(plan: RoomPlan, a: PlanEdit): RoomPlan | null {
  const withItem = (deviceId: string, fn: (item: PlanItem) => PlanItem | null): RoomPlan | null => {
    const i = plan.items.findIndex((x) => x.deviceId === deviceId);
    const next = i < 0 ? null : fn(plan.items[i]);
    return next && itemInRange(next) ? { ...plan, items: plan.items.map((x, j) => (j === i ? next : x)) } : null;
  };
  switch (a.type) {
    case 'addRoom': {
      const name = a.room.name.trim();
      if (a.room.w < ROOM_MIN || a.room.h < ROOM_MIN || !name || !roomInRange(a.room) || plan.rooms.some((r) => r.id === a.room.id)) return null;
      return { ...plan, rooms: [...plan.rooms, { ...a.room, name }] };
    }
    case 'updateRoom': {
      const r = plan.rooms.find((x) => x.id === a.id);
      if (!r) return null;
      const next = { ...r, ...a.changes, name: (a.changes.name ?? r.name).trim() };
      if (next.w < ROOM_MIN || next.h < ROOM_MIN || !next.name || !roomInRange(next)) return null;
      return { ...plan, rooms: plan.rooms.map((x) => (x.id === a.id ? next : x)) };
    }
    case 'removeRoom':
      return plan.rooms.some((r) => r.id === a.id) ? { ...plan, rooms: plan.rooms.filter((r) => r.id !== a.id) } : null;
    case 'place':
      return !itemInRange(a.item) ? null : { ...plan, items: [...plan.items.filter((x) => x.deviceId !== a.item.deviceId), a.item] };
    case 'moveItem':
      return a.dx || a.dy ? withItem(a.deviceId, (it) => moved(it, a.dx, a.dy)) : null;
    case 'movePoint':
      return withItem(a.deviceId, (it) =>
        it.shape === 'line' && a.index >= 0 && a.index < it.points.length ? { ...it, points: it.points.map((p, j) => (j === a.index ? a.to : p)) } : null,
      );
    case 'insertPoint':
      return withItem(a.deviceId, (it) =>
        it.shape === 'line' && a.after >= 0 && a.after < it.points.length - 1 && it.points.length < PLAN_POINTS_MAX && !sameAs(a.at, it.points[a.after], it.points[a.after + 1])
          ? { ...it, points: [...it.points.slice(0, a.after + 1), a.at, ...it.points.slice(a.after + 1)] }
          : null,
      );
    case 'removePoint':
      return withItem(a.deviceId, (it) =>
        it.shape === 'line' && it.points.length > 2 && a.index >= 0 && a.index < it.points.length
          ? { ...it, points: it.points.filter((_, j) => j !== a.index) }
          : null,
      );
    case 'reverse':
      return withItem(a.deviceId, (it) => (it.shape === 'line' ? { ...it, reversed: !it.reversed } : null));
    case 'resizeArea':
      return withItem(a.deviceId, (it) => (it.shape === 'area' && a.rect.w >= AREA_MIN && a.rect.h >= AREA_MIN ? { ...it, rect: a.rect } : null));
    case 'setShape':
      return withItem(a.deviceId, (it) => reshaped(it, a.shape));
    case 'removeItem':
      return plan.items.some((x) => x.deviceId === a.deviceId) ? { ...plan, items: plan.items.filter((x) => x.deviceId !== a.deviceId) } : null;
  }
}

const samePlan = (a: RoomPlan, b: RoomPlan) => JSON.stringify(a) === JSON.stringify(b);

/** Ändert die Bearbeitung den Plan wirklich? Ungültiges und Gleichbleibendes (Zittern beim Anklicken) zählen nicht. */
export function changesPlan(plan: RoomPlan, a: PlanEdit): boolean {
  const next = apply(plan, a);
  return !!next && !samePlan(next, plan);
}

export function editPlan(state: EditState, a: PlanEdit | { type: 'undo' }): EditState {
  if (a.type === 'undo') {
    if (!state.undo.length) return state;
    return { plan: state.undo[state.undo.length - 1], undo: state.undo.slice(0, -1) };
  }
  const next = apply(state.plan, a);
  // Ungültig oder nichts geändert: kein neuer Stand und kein Rückgängig-Schritt
  if (!next || samePlan(next, state.plan)) return state;
  if (a.coalesce && state.undo.length) return { plan: next, undo: state.undo };
  return { plan: next, undo: [...state.undo, state.plan].slice(-UNDO_MAX) };
}

export const isDirty = (state: EditState, original: RoomPlan) => JSON.stringify(state.plan) !== JSON.stringify(original);

/** Knickpunkt beim Zeichnen anhängen — nicht zweimal derselbe (Doppelklick zum Beenden), höchstens 100. */
export function addDrawPoint(points: PlanPoint[], at: PlanPoint): PlanPoint[] {
  const last = points[points.length - 1];
  if (last && last[0] === at[0] && last[1] === at[1]) return points;
  return points.length >= PLAN_POINTS_MAX ? points : [...points, at];
}
