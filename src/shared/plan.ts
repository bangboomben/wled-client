// Raumplan: reine Geometrie ohne Oberfläche — Einrasten, LED-Verteilung auf Linien, Ausschnitt.
// Koordinaten sind Rastereinheiten; die Oberfläche rechnet sie mit fitView in Pixel um.

import { t } from './i18n';
import type { DeviceSnapshot, PlanPoint, PlanRect, PlanRoom, PlanShape, RoomPlan, WledInfo } from './types';

export const PLAN_COORD_MAX = 1000;
export const PLAN_ROOMS_MAX = 100;
export const PLAN_POINTS_MAX = 100;
export const ROOM_NAME_MAX = 40;
export const ROOM_MIN = 2;
export const AREA_MIN = 1;
/** Näher als so viele Einheiten an einer Raumecke oder -kante rastet ein Punkt dort ein. */
export const SNAP_DIST = 0.6;
const SCALE_MIN = 4;
const SCALE_MAX = 60;
const SCALE_EMPTY = 24;

export const emptyPlan = (): RoomPlan => ({ version: 1, rooms: [], items: [] });
/** Auf 0,1 gerundet; „+ 0“ macht aus −0 eine 0 (sonst unterscheiden toEqual und Object.is −0 von 0). */
export const round1 = (v: number) => Math.round(v * 10) / 10 + 0;

/** Form aus den LED-Daten: Matrix → Fläche, eine LED (Bulb, einfacher RGB-Streifen) → Punkt, sonst Linie. */
export function shapeFor(info: WledInfo | undefined): PlanShape {
  if (info?.leds.matrix) return 'area';
  if (info?.leds.count === 1) return 'point';
  return 'line';
}

const dist = (a: PlanPoint, b: PlanPoint) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Nächster Punkt auf der Strecke a–b. */
function project(p: PlanPoint, a: PlanPoint, b: PlanPoint): PlanPoint {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const k = len2 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return [a[0] + k * dx, a[1] + k * dy];
}

/** Ecken im Uhrzeigersinn ab oben links (Index wie bei resizeRect). */
export const corners = (r: PlanRect): PlanPoint[] => [
  [r.x, r.y],
  [r.x + r.w, r.y],
  [r.x + r.w, r.y + r.h],
  [r.x, r.y + r.h],
];

/**
 * Rastet einen Punkt ein: an eine nahe Raumecke, sonst an eine nahe Raumkante (entlang der Kante aufs Raster),
 * sonst aufs Raster. `free` (Umschalt gedrückt): nur auf 0,1 runden.
 */
export function snapPoint(p: PlanPoint, rooms: readonly PlanRoom[], free: boolean): PlanPoint {
  if (free) return [round1(p[0]), round1(p[1])];
  for (const r of rooms) for (const c of corners(r)) if (dist(p, c) < SNAP_DIST) return c;
  for (const r of rooms) {
    const cs = corners(r);
    for (let i = 0; i < 4; i++) {
      const a = cs[i];
      const b = cs[(i + 1) % 4];
      const q = project(p, a, b);
      if (dist(p, q) < SNAP_DIST) return a[1] === b[1] ? [Math.round(q[0]), a[1]] : [a[0], Math.round(q[1])];
    }
  }
  return [Math.round(p[0]), Math.round(p[1])];
}

export function lineLength(points: readonly PlanPoint[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += dist(points[i - 1], points[i]);
  return len;
}

/** Punkt im Abstand d vom Anfang entlang der Linie (auf Anfang und Ende begrenzt). */
export function pointAt(points: readonly PlanPoint[], d: number): PlanPoint {
  if (!points.length) return [0, 0];
  let rest = Math.max(0, d);
  for (let i = 1; i < points.length; i++) {
    const seg = dist(points[i - 1], points[i]);
    if (seg > 0 && rest <= seg) {
      const k = rest / seg;
      return [points[i - 1][0] + k * (points[i][0] - points[i - 1][0]), points[i - 1][1] + k * (points[i][1] - points[i - 1][1])];
    }
    rest -= seg;
  }
  const last = points[points.length - 1];
  return [last[0], last[1]];
}

/**
 * Richtung (Einheitsvektor) der Linie an der Stelle d; hinter dem Ende die des letzten Teilstücks mit Länge
 * (auch bei doppeltem Endpunkt), ohne jede Länge nach rechts.
 */
export function directionAt(points: readonly PlanPoint[], d: number): PlanPoint {
  let rest = Math.max(0, d);
  let dir: PlanPoint = [1, 0];
  for (let i = 1; i < points.length; i++) {
    const seg = dist(points[i - 1], points[i]);
    if (seg > 0) {
      dir = [(points[i][0] - points[i - 1][0]) / seg, (points[i][1] - points[i - 1][1]) / seg];
      if (rest <= seg) return dir;
    }
    rest -= seg;
  }
  return dir;
}

/**
 * Positionen für n LED-Werte, gleichmäßig von LED 1 bis zur letzten (WLED schickt bei langen Streifen eine
 * gleichmäßige Auswahl — die gezeichnete Länge ist deshalb frei). `reversed`: LED 1 am Linienende.
 */
export function ledPositions(points: readonly PlanPoint[], n: number, reversed: boolean): PlanPoint[] {
  if (n <= 0 || points.length < 2) return [];
  const len = lineLength(points);
  const out: PlanPoint[] = [];
  for (let i = 0; i < n; i++) {
    const f = n === 1 ? 0.5 : i / (n - 1);
    out.push(pointAt(points, (reversed ? 1 - f : f) * len));
  }
  return out;
}

/** Querstriche an den Segmentgrenzen (nur bei mehr als einem Segment): Ort und Richtung der Linie dort. */
export function segmentTicks(
  points: readonly PlanPoint[],
  segs: ReadonlyArray<{ start: number; stop: number }>,
  count: number,
  reversed: boolean,
): Array<{ at: PlanPoint; dir: PlanPoint }> {
  if (segs.length < 2 || count <= 0 || points.length < 2) return [];
  const len = lineLength(points);
  const starts = [...new Set(segs.map((s) => s.start))].filter((s) => s > 0 && s < count).sort((a, b) => a - b);
  return starts.map((s) => {
    const d = (reversed ? 1 - s / count : s / count) * len;
    return { at: pointAt(points, d), dir: directionAt(points, d) };
  });
}

/** Nächstes Teilstück der Linie zu p, wenn näher als tol: Index seines Anfangspunkts und Abstand. */
export function nearLine(p: PlanPoint, points: readonly PlanPoint[], tol: number): { index: number; dist: number } | null {
  let best: { index: number; dist: number } | null = null;
  for (let i = 1; i < points.length; i++) {
    const d = dist(p, project(p, points[i - 1], points[i]));
    if (d <= tol && (!best || d < best.dist)) best = { index: i - 1, dist: d };
  }
  return best;
}

export function rectFrom(a: PlanPoint, b: PlanPoint): PlanRect {
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
}

/** Zieht eine Ecke auf p; die gegenüberliegende Ecke bleibt, Breite und Höhe nie unter `min`. */
export function resizeRect(o: PlanRect, corner: number, p: PlanPoint, min: number): PlanRect {
  let x1 = o.x;
  let y1 = o.y;
  let x2 = o.x + o.w;
  let y2 = o.y + o.h;
  if (corner === 0 || corner === 3) x1 = Math.min(p[0], x2 - min);
  else x2 = Math.max(p[0], x1 + min);
  if (corner === 0 || corner === 1) y1 = Math.min(p[1], y2 - min);
  else y2 = Math.max(p[1], y1 + min);
  return { x: round1(x1), y: round1(y1), w: round1(x2 - x1), h: round1(y2 - y1) };
}

/** Wie resizeRect, aber mit festem Seitenverhältnis (Matrix-Fläche). */
export function resizeKeepRatio(o: PlanRect, corner: number, p: PlanPoint, min = AREA_MIN): PlanRect {
  const ratio = o.w / o.h;
  const left = corner === 0 || corner === 3;
  const top = corner === 0 || corner === 1;
  const ax = left ? o.x + o.w : o.x;
  const ay = top ? o.y + o.h : o.y;
  let w = Math.max(min, Math.abs(p[0] - ax), Math.abs(p[1] - ay) * ratio);
  let h = w / ratio;
  if (h < min) {
    h = min;
    w = h * ratio;
  }
  w = round1(w);
  h = round1(h);
  return { x: round1(left ? ax - w : ax), y: round1(top ? ay - h : ay), w, h };
}

/** Startrechteck einer Matrix: längere Seite 8 Einheiten, Seitenverhältnis wie w:h, Mitte bei `center`. */
export function areaForMatrix(matrix: { w: number; h: number }, center: PlanPoint): PlanRect {
  const ratio = matrix.w / Math.max(1, matrix.h);
  const w = Math.max(AREA_MIN, round1(ratio >= 1 ? 8 : 8 * ratio));
  const h = Math.max(AREA_MIN, round1(ratio >= 1 ? 8 / ratio : 8));
  return { x: round1(center[0] - w / 2), y: round1(center[1] - h / 2), w, h };
}

/** Umriss aller Räume und Geräte; leer → null. Ein Punkt zählt mit einer Einheit Rand. */
export function planBounds(plan: RoomPlan): PlanRect | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const add = (x: number, y: number) => {
    xs.push(x);
    ys.push(y);
  };
  for (const r of plan.rooms) {
    add(r.x, r.y);
    add(r.x + r.w, r.y + r.h);
  }
  for (const it of plan.items) {
    if (it.shape === 'line') for (const p of it.points) add(p[0], p[1]);
    else if (it.shape === 'point') {
      add(it.at[0] - 1, it.at[1] - 1);
      add(it.at[0] + 1, it.at[1] + 1);
    } else {
      add(it.rect.x, it.rect.y);
      add(it.rect.x + it.rect.w, it.rect.y + it.rect.h);
    }
  }
  if (!xs.length) return null;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Umrechnung Einheit → Pixel: Pixel = Einheit · scale + x (bzw. y). */
export interface PlanView {
  scale: number;
  x: number;
  y: number;
}

/** Ausschnitt, in dem alles mit `margin` Einheiten Rand zu sehen ist, mittig; Maßstab 4–60 px je Einheit. */
export function fitView(bounds: PlanRect | null, width: number, height: number, margin: number): PlanView {
  if (!bounds || width <= 0 || height <= 0) return { scale: SCALE_EMPTY, x: margin * SCALE_EMPTY, y: margin * SCALE_EMPTY };
  const scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.min(width / (bounds.w + 2 * margin), height / (bounds.h + 2 * margin))));
  return { scale, x: (width - bounds.w * scale) / 2 - bounds.x * scale, y: (height - bounds.h * scale) / 2 - bounds.y * scale };
}

export const toScreen = (v: PlanView, p: PlanPoint): PlanPoint => [p[0] * v.scale + v.x, p[1] * v.scale + v.y];
export const toUnits = (v: PlanView, p: PlanPoint): PlanPoint => [(p[0] - v.x) / v.scale, (p[1] - v.y) / v.scale];

/** Beschriftung für Screenreader, z. B. „Desk, an, 82 %“. */
export function planLabel(d: DeviceSnapshot): string {
  if (d.status === 'offline') return t('{name}, offline', { name: d.name });
  if (d.status === 'connecting') return t('{name}, verbindet', { name: d.name });
  if (!d.state?.on) return t('{name}, aus', { name: d.name });
  return t('{name}, an, {n} %', { name: d.name, n: Math.max(1, Math.round((d.state.bri / 255) * 100)) });
}
