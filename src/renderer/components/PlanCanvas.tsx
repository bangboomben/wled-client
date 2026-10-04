import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { t } from '../../shared/i18n';
import {
  corners,
  directionAt,
  ledPositions,
  lineLength,
  nearLine,
  planLabel,
  rectFrom,
  resizeKeepRatio,
  resizeRect,
  ROOM_MIN,
  round1,
  segmentTicks,
  snapPoint,
  toScreen,
  toUnits,
  type PlanView,
} from '../../shared/plan';
import type { DeviceSnapshot, PlanItem, PlanPoint, PlanRect, RoomPlan } from '../../shared/types';
import { parseFrame, rgbCss, staticColors, type LiveFrame, type Rgb } from '../lib/plan-colors';
import { changesPlan, type PlanEdit } from '../lib/plan-edit';
import { wled } from '../lib/store';

export type PlanSelection = { kind: 'room'; id: string } | { kind: 'item'; deviceId: string } | null;
/** Linie, die gerade gezeichnet wird: Gerät und bisherige Knickpunkte (beim Neuzeichnen zuerst keine). */
export type Drawing = { deviceId: string; points: PlanPoint[] } | null;

/** Klickfläche um Linien und Punkte in Pixeln. */
const HIT_PX = 8;

type Gesture =
  | { kind: 'rubber'; start: PlanPoint; last: PlanPoint }
  | { kind: 'room-move'; id: string; start: PlanPoint; origin: PlanRect; moved: boolean }
  | { kind: 'room-resize'; id: string; corner: number; origin: PlanRect; moved: boolean }
  | { kind: 'item-move'; id: string; start: PlanPoint; last: PlanPoint; moved: boolean; insert: boolean }
  | { kind: 'point'; id: string; index: number; moved: boolean }
  | { kind: 'area-resize'; id: string; corner: number; origin: PlanRect; moved: boolean };

const pointRadius = (v: PlanView) => Math.min(14, Math.max(6, v.scale * 0.6));

/** Live-Werte unter dieser Helligkeit (r+g+b) malt der Plan wie „aus“ — reines Schwarz verschwindet auf dunklem Grund. */
const LIVE_DARK = 24;
const liveCss = (c: Rgb, dark: string) => (c[0] + c[1] + c[2] < LIVE_DARK ? dark : rgbCss(c));

/** Raster im Bearbeitungsmodus: jede Einheit, bei kleinem Maßstab jede fünfte. */
function Grid({ view, width, height }: { view: PlanView; width: number; height: number }) {
  const step = view.scale >= 10 ? 1 : 5;
  const [ux0, uy0] = toUnits(view, [0, 0]);
  const [ux1, uy1] = toUnits(view, [width, height]);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let u = Math.ceil(ux0 / step) * step; u <= ux1; u += step) xs.push(u * view.scale + view.x);
  for (let u = Math.ceil(uy0 / step) * step; u <= uy1; u += step) ys.push(u * view.scale + view.y);
  return (
    <g className="plan-grid">
      {xs.map((x) => (
        <line key={`x${x}`} x1={x} y1={0} x2={x} y2={height} />
      ))}
      {ys.map((y) => (
        <line key={`y${y}`} x1={0} y1={y} x2={width} y2={y} />
      ))}
    </g>
  );
}

/** Anker eines Geräts in Einheiten: erste LED (Linie), Mitte (Punkt, Fläche). */
function anchorUnits(item: PlanItem): PlanPoint {
  if (item.shape === 'line') return item.reversed ? item.points[item.points.length - 1] : item.points[0];
  if (item.shape === 'point') return item.at;
  return [item.rect.x + item.rect.w / 2, item.rect.y + item.rect.h / 2];
}

const anchorOf = (item: PlanItem, view: PlanView): PlanPoint => toScreen(view, anchorUnits(item));

/** Tab-Reihenfolge: von oben links nach unten rechts. */
function readingOrder(items: readonly PlanItem[]): PlanItem[] {
  return [...items].sort((a, b) => {
    const pa = anchorUnits(a);
    const pb = anchorUnits(b);
    return pa[1] - pb[1] || pa[0] - pb[0];
  });
}

function ItemShape({
  item,
  device,
  view,
  editing,
  selected,
  onKeyOpen,
}: {
  item: PlanItem;
  device: DeviceSnapshot | undefined;
  view: PlanView;
  editing: boolean;
  selected: boolean;
  onKeyOpen: (deviceId: string, at: PlanPoint) => void;
}) {
  const off = device?.status !== 'online';
  // Offline steht sichtbar am Namen; beim Verbinden bleibt es beim Namen (nur die gestrichelte Kontur)
  const name = device?.status === 'offline' ? t('{name} (offline)', { name: device.name }) : (device?.name ?? '');
  const anchor = anchorOf(item, view);
  const px = (p: PlanPoint) => toScreen(view, p);
  const common = {
    className: `plan-item plan-${item.shape}${off ? ' offline' : ''}${selected ? ' selected' : ''}`,
    'data-device': item.deviceId,
    'data-x': Math.round(anchor[0]),
    'data-y': Math.round(anchor[1]),
    tabIndex: editing ? -1 : 0,
    role: 'button',
    'aria-label': device ? planLabel(device) : name,
    onKeyDown: (e: ReactKeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === ' ') && !editing) {
        // Leertaste sonst: Seite scrollt
        e.preventDefault();
        onKeyOpen(item.deviceId, anchor);
      }
    },
  };

  if (item.shape === 'line') {
    const pts = item.points.map(px);
    const str = pts.map((p) => p.join(',')).join(' ');
    const len = lineLength(item.points);
    const d0 = directionAt(item.points, item.reversed ? len : 0);
    const dir: PlanPoint = item.reversed ? [-d0[0], -d0[1]] : d0;
    const ticks = device?.state && device.info ? segmentTicks(item.points, device.state.seg, device.info.leds.count, item.reversed) : [];
    // Richtungspfeil an LED 1: kleines Dreieck in Laufrichtung
    const tip: PlanPoint = [anchor[0] + dir[0] * 12, anchor[1] + dir[1] * 12];
    const side: PlanPoint = [-dir[1] * 5, dir[0] * 5];
    const arrow = [tip, [anchor[0] + side[0], anchor[1] + side[1]], [anchor[0] - side[0], anchor[1] - side[1]]].map((p) => p.join(',')).join(' ');
    return (
      <g {...common}>
        <polyline className="plan-track" points={str} />
        {ticks.map(({ at, dir: td }, i) => {
          const c = px(at);
          return <line key={i} className="plan-tick" x1={c[0] - td[1] * 7} y1={c[1] + td[0] * 7} x2={c[0] + td[1] * 7} y2={c[1] - td[0] * 7} />;
        })}
        <polygon className="plan-arrow" points={arrow} />
        <text className="plan-label" x={anchor[0] + 10} y={anchor[1] - 10}>
          {name}
        </text>
        <polyline className="plan-hit" points={str} style={{ strokeWidth: HIT_PX * 2 }} data-kind="item" data-id={item.deviceId} />
        {editing &&
          selected &&
          pts.map((p, i) => <circle key={i} className="plan-handle" cx={p[0]} cy={p[1]} r={6} data-kind="handle" data-id={item.deviceId} data-index={i} />)}
      </g>
    );
  }

  if (item.shape === 'point') {
    const [x, y] = px(item.at);
    const r = pointRadius(view);
    return (
      <g {...common}>
        <circle className="plan-point" cx={x} cy={y} r={r + 3} />
        <text className="plan-label" x={x + r + 8} y={y + 4}>
          {name}
        </text>
        <circle className="plan-hit" cx={x} cy={y} r={r + HIT_PX} data-kind="item" data-id={item.deviceId} />
      </g>
    );
  }

  const [x, y] = px([item.rect.x, item.rect.y]);
  const w = item.rect.w * view.scale;
  const h = item.rect.h * view.scale;
  return (
    <g {...common}>
      <rect className="plan-area" x={x - 2} y={y - 2} width={w + 4} height={h + 4} />
      <text className="plan-label" x={x} y={y - 8}>
        {name}
      </text>
      <rect className="plan-hit" x={x} y={y} width={w} height={h} data-kind="item" data-id={item.deviceId} />
      {editing &&
        selected &&
        corners(item.rect).map((c, i) => {
          const p = px(c);
          return <circle key={i} className="plan-handle" cx={p[0]} cy={p[1]} r={6} data-kind="area-corner" data-id={item.deviceId} data-index={i} />;
        })}
    </g>
  );
}

/** Malt die LEDs eines Geräts auf die Canvas-Ebene. `dark`: Farbe für „aus“. */
function paintItem(ctx: CanvasRenderingContext2D, item: PlanItem, d: DeviceSnapshot, frame: LiveFrame | undefined, view: PlanView, dark: string) {
  const css = (c: string | null | undefined) => c ?? dark;
  if (item.shape === 'line') {
    const n = frame ? frame.colors.length : Math.min(Math.max(1, d.info?.leds.count ?? 30), 256);
    const colors = frame ? frame.colors.map((c) => liveCss(c, dark)) : staticColors(d, n);
    const pts = ledPositions(item.points, n, item.reversed).map((p) => toScreen(view, p));
    const spacing = n > 1 ? (lineLength(item.points) * view.scale) / (n - 1) : 8;
    if (spacing < 2) {
      // Dicht: durchgehender Verlauf aus kurzen Strichen
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      for (let i = 1; i < pts.length; i++) {
        ctx.strokeStyle = css(colors[i]);
        ctx.beginPath();
        ctx.moveTo(pts[i - 1][0], pts[i - 1][1]);
        ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.stroke();
      }
      return;
    }
    const r = Math.min(4, Math.max(1, spacing * 0.35));
    for (let i = 0; i < pts.length; i++) {
      ctx.fillStyle = css(colors[i]);
      ctx.beginPath();
      ctx.arc(pts[i][0], pts[i][1], r, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  if (item.shape === 'point') {
    const [x, y] = toScreen(view, item.at);
    ctx.fillStyle = css(frame ? liveCss(frame.colors[0], dark) : staticColors(d, 1)[0]);
    ctx.beginPath();
    ctx.arc(x, y, pointRadius(view), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const [x, y] = toScreen(view, [item.rect.x, item.rect.y]);
  const w = item.rect.w * view.scale;
  const h = item.rect.h * view.scale;
  // Pixelraster nur, wenn Breite × Höhe zur Zahl der Farben passt (parseFrame prüft das nicht)
  if (frame?.w && frame.h && frame.w * frame.h === frame.colors.length) {
    const cw = w / frame.w;
    const ch = h / frame.h;
    for (let row = 0; row < frame.h; row++) {
      for (let col = 0; col < frame.w; col++) {
        const c = frame.colors[row * frame.w + col];
        if (!c) continue;
        ctx.fillStyle = liveCss(c, dark);
        ctx.fillRect(x + col * cw, y + row * ch, Math.ceil(cw), Math.ceil(ch));
      }
    }
    return;
  }
  ctx.fillStyle = css(staticColors(d, 1)[0]);
  ctx.fillRect(x, y, w, h);
}

export function PlanCanvas({
  plan,
  devices,
  view,
  width,
  height,
  live,
  editing,
  tool,
  selection,
  drawing,
  placing,
  onSelect,
  onEdit,
  onOpenPanel,
  onRoomDrawn,
  onPlace,
  onDrawPoint,
  onDrawEnd,
  onContext,
  onRename,
}: {
  plan: RoomPlan;
  devices: DeviceSnapshot[];
  view: PlanView;
  width: number;
  height: number;
  /** Live-Vorschau an: Farben aus den Live-Bildern, sonst Segmentfarben. */
  live: boolean;
  editing: boolean;
  tool: 'select' | 'room';
  selection: PlanSelection;
  drawing: Drawing;
  /** Gerät aus der Liste, das der nächste Klick setzt. */
  placing: string | null;
  onSelect: (sel: PlanSelection) => void;
  onEdit: (edit: PlanEdit) => void;
  /** Bedienfeld öffnen; `at` in Pixeln relativ zur Bühne, `viaKeyboard`: per Enter oder Leertaste geöffnet. */
  onOpenPanel: (deviceId: string, at: PlanPoint, viaKeyboard?: boolean) => void;
  onRoomDrawn: (rect: PlanRect) => void;
  onPlace: (deviceId: string, at: PlanPoint) => void;
  onDrawPoint: (at: PlanPoint) => void;
  onDrawEnd: () => void;
  onContext: (deviceId: string, at: PlanPoint) => void;
  onRename: (roomId: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [rubber, setRubber] = useState<PlanRect | null>(null);
  const [hover, setHover] = useState<PlanPoint | null>(null);
  const frames = useRef(new Map<string, LiveFrame>());
  const raf = useRef(0);
  const latest = useRef({ plan, devices, view, live, width, height });
  latest.current = { plan, devices, view, live, width, height };

  const paint = () => {
    raf.current = 0;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const s = latest.current;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(s.width * dpr));
    const ch = Math.max(1, Math.round(s.height * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, s.width, s.height);
    const dark = getComputedStyle(canvas).getPropertyValue('--panel-3').trim() || '#2a2f3a';
    for (const item of s.plan.items) {
      const d = s.devices.find((x) => x.id === item.deviceId);
      // Gerät gelöscht, Plan noch nicht nachgezogen: überspringen. Offline (oder beim Verbinden): keine Farben,
      // nur die gestrichelte Kontur der SVG-Ebene — „aus“ sieht anders aus (dunkelgrau).
      if (!d || d.status !== 'online') continue;
      paintItem(ctx, item, d, s.live ? frames.current.get(d.id) : undefined, s.view, dark);
    }
  };
  const schedule = () => {
    if (!raf.current) raf.current = requestAnimationFrame(paint);
  };
  // Nach jedem Rendern (Plan, Geräte, Ausschnitt) neu malen — höchstens einmal pro Bild.
  useEffect(schedule);
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      // Sonst hielte ein erneut eingehängter Effekt (Strict Mode) das abgebrochene Bild für geplant
      raf.current = 0;
    },
    [],
  );
  useEffect(() => {
    if (!live) {
      frames.current.clear();
      return;
    }
    return wled.onLive((id, data) => {
      const f = parseFrame(data);
      if (!f) return;
      frames.current.set(id, f);
      schedule();
    });
  }, [live]);

  const local = (e: { clientX: number; clientY: number }): PlanPoint => {
    const r = svgRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const unitsAt = (e: { clientX: number; clientY: number }) => toUnits(view, local(e));

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const target = (e.target as Element).closest<SVGElement>('[data-kind]');
    const kind = target?.dataset.kind;
    const id = target?.dataset.id ?? '';
    const index = Number(target?.dataset.index ?? -1);
    const u = unitsAt(e);
    if (!editing) {
      if (kind === 'item') onOpenPanel(id, local(e));
      return;
    }
    if (drawing) return onDrawPoint(snapPoint(u, plan.rooms, e.shiftKey));
    if (placing) return onPlace(placing, snapPoint(u, plan.rooms, e.shiftKey));
    svgRef.current?.setPointerCapture(e.pointerId);
    if (tool === 'room') {
      const p = snapPoint(u, [], false);
      gesture.current = { kind: 'rubber', start: p, last: p };
      setRubber(rectFrom(p, p));
      return;
    }
    const room = plan.rooms.find((r) => r.id === id);
    const item = plan.items.find((i) => i.deviceId === id);
    if (kind === 'room' && room) {
      onSelect({ kind: 'room', id });
      gesture.current = { kind: 'room-move', id, start: u, origin: { x: room.x, y: room.y, w: room.w, h: room.h }, moved: false };
    } else if (kind === 'room-corner' && room) {
      gesture.current = { kind: 'room-resize', id, corner: index, origin: { x: room.x, y: room.y, w: room.w, h: room.h }, moved: false };
    } else if (kind === 'handle') {
      gesture.current = { kind: 'point', id, index, moved: false };
    } else if (kind === 'area-corner' && item?.shape === 'area') {
      gesture.current = { kind: 'area-resize', id, corner: index, origin: item.rect, moved: false };
    } else if (kind === 'item' && item) {
      const already = selection?.kind === 'item' && selection.deviceId === id;
      if (!already) onSelect({ kind: 'item', deviceId: id });
      gesture.current = { kind: 'item-move', id, start: u, last: [0, 0], moved: false, insert: already && item.shape === 'line' };
    } else {
      onSelect(null);
    }
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const u = unitsAt(e);
    if (drawing) setHover(snapPoint(u, plan.rooms, e.shiftKey));
    const g = gesture.current;
    if (!g) return;
    // Ein Zug meldet nur Änderungen, die den Plan wirklich ändern; die erste legt den Rückgängig-Schritt an, die
    // folgenden gehören dazu. Zittern beim Anklicken (Änderung ohne Wirkung) fängt den Zug sonst nicht an und ließe
    // die erste echte Änderung im Schritt davor aufgehen.
    const drag = (z: { moved: boolean }, edit: PlanEdit) => {
      if (!z.moved && !changesPlan(plan, edit)) return;
      onEdit({ ...edit, coalesce: z.moved });
      z.moved = true;
    };
    switch (g.kind) {
      case 'rubber': {
        g.last = snapPoint(u, [], false);
        setRubber(rectFrom(g.start, g.last));
        break;
      }
      case 'room-move': {
        const dx = Math.round(u[0] - g.start[0]);
        const dy = Math.round(u[1] - g.start[1]);
        drag(g, { type: 'updateRoom', id: g.id, changes: { x: g.origin.x + dx, y: g.origin.y + dy } });
        break;
      }
      case 'room-resize': {
        drag(g, { type: 'updateRoom', id: g.id, changes: resizeRect(g.origin, g.corner, snapPoint(u, [], false), ROOM_MIN) });
        break;
      }
      case 'item-move': {
        const step = e.shiftKey ? round1 : Math.round;
        const d: PlanPoint = [step(u[0] - g.start[0]), step(u[1] - g.start[1])];
        const dx = round1(d[0] - g.last[0]);
        const dy = round1(d[1] - g.last[1]);
        if (!dx && !dy) return;
        onEdit({ type: 'moveItem', deviceId: g.id, dx, dy, coalesce: g.moved });
        g.last = d;
        g.moved = true;
        break;
      }
      case 'point': {
        drag(g, { type: 'movePoint', deviceId: g.id, index: g.index, to: snapPoint(u, plan.rooms, e.shiftKey) });
        break;
      }
      case 'area-resize': {
        drag(g, { type: 'resizeArea', deviceId: g.id, rect: resizeKeepRatio(g.origin, g.corner, u) });
        break;
      }
    }
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.kind === 'rubber') {
      setRubber(null);
      const r = rectFrom(g.start, g.last);
      if (r.w >= ROOM_MIN && r.h >= ROOM_MIN) onRoomDrawn(r);
      return;
    }
    // Klick (ohne Ziehen) auf eine schon gewählte Linie: dort einen Knickpunkt einfügen
    if (g.kind === 'item-move' && g.insert && !g.moved) {
      const item = plan.items.find((i) => i.deviceId === g.id);
      if (item?.shape !== 'line') return;
      const u = unitsAt(e);
      const near = nearLine(u, item.points, (HIT_PX * 1.5) / view.scale);
      if (near) onEdit({ type: 'insertPoint', deviceId: g.id, after: near.index, at: snapPoint(u, plan.rooms, e.shiftKey) });
    }
  };

  const onDoubleClick = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (!editing) return;
    if (drawing) return onDrawEnd();
    const target = (e.target as Element).closest<SVGElement>('[data-kind="room"]');
    if (target?.dataset.id) onRename(target.dataset.id);
  };

  const onContextMenu = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (!editing) return;
    e.preventDefault();
    const target = (e.target as Element).closest<SVGElement>('[data-kind]');
    const id = target?.dataset.id ?? '';
    if (target?.dataset.kind === 'handle') onEdit({ type: 'removePoint', deviceId: id, index: Number(target.dataset.index) });
    else if (target?.dataset.kind === 'item') {
      onSelect({ kind: 'item', deviceId: id });
      onContext(id, local(e));
    }
  };

  const crosshair = editing && (tool === 'room' || !!placing || !!drawing);
  const drawn = drawing ? [...drawing.points, ...(hover ? [hover] : [])].map((p) => toScreen(view, p)) : [];

  return (
    <>
      <svg
        ref={svgRef}
        className={`plan-svg${editing ? ' editing' : ''}${crosshair ? ' crosshair' : ''}`}
        width={width}
        height={height}
        data-scale={view.scale}
        data-ox={view.x}
        data-oy={view.y}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        {editing && <Grid view={view} width={width} height={height} />}
        {plan.rooms.map((r) => {
          const [x, y] = toScreen(view, [r.x, r.y]);
          const sel = selection?.kind === 'room' && selection.id === r.id;
          return (
            <g key={r.id} role="group" aria-label={r.name} className={`plan-room-g${sel ? ' selected' : ''}`}>
              <rect className="plan-room" x={x} y={y} width={r.w * view.scale} height={r.h * view.scale} data-kind="room" data-id={r.id} />
              <text className="plan-room-name" x={x + 8} y={y + 18}>
                {r.name}
              </text>
              {editing &&
                sel &&
                corners(r).map((c, i) => {
                  const p = toScreen(view, c);
                  return <circle key={i} className="plan-handle" cx={p[0]} cy={p[1]} r={6} data-kind="room-corner" data-id={r.id} data-index={i} />;
                })}
            </g>
          );
        })}
        {readingOrder(plan.items).map((item) => (
          <ItemShape
            key={item.deviceId}
            item={item}
            device={devices.find((d) => d.id === item.deviceId)}
            view={view}
            editing={editing}
            selected={selection?.kind === 'item' && selection.deviceId === item.deviceId}
            onKeyOpen={(deviceId, at) => onOpenPanel(deviceId, at, true)}
          />
        ))}
        {drawn.length > 0 && <polyline className="plan-drawing" points={drawn.map((p) => p.join(',')).join(' ')} />}
        {rubber && (
          <rect className="plan-rubber" x={rubber.x * view.scale + view.x} y={rubber.y * view.scale + view.y} width={rubber.w * view.scale} height={rubber.h * view.scale} />
        )}
      </svg>
      <canvas ref={canvasRef} className="plan-leds" style={{ width, height }} />
    </>
  );
}
