import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { t } from '../../shared/i18n';
import { areaForMatrix, fitView, planBounds, shapeFor, snapPoint, toScreen, toUnits, type PlanView } from '../../shared/plan';
import type { DeviceSnapshot, PlanPoint, PlanRect } from '../../shared/types';
import { addDrawPoint, editPlan, isDirty, startEdit, type EditState, type PlanEdit } from '../lib/plan-edit';
import { usePlan, useSettings, wled } from '../lib/store';
import { Icon } from './Icon';
import { PlanCanvas, type Drawing, type PlanSelection } from './PlanCanvas';
import { PlanPanel } from './PlanPanel';

/** Was die App vor dem Verlassen des Plans fragt: ungespeicherte Änderungen speichern oder verwerfen. */
export interface PlanGuard {
  dirty(): boolean;
  save(): Promise<void>;
  discard(): void;
}

/** Größe eines Elements, nachgeführt über einen ResizeObserver. */
function useSize(): [(el: HTMLDivElement | null) => void, { w: number; h: number }] {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    if (!el) return;
    ro.current = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.current.observe(el);
  }, []);
  return [ref, size];
}

const isTyping = (el: EventTarget | null) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;

const shapeIcon = { line: 'strip', point: 'bulb', area: 'matrix' } as const;

export function RoomPlan({
  devices,
  onOpen,
  guard,
}: {
  devices: DeviceSnapshot[];
  onOpen: (id: string) => void;
  guard: MutableRefObject<PlanGuard | null>;
}) {
  const saved = usePlan();
  const settings = useSettings();
  const [stageRef, size] = useSize();
  const [edit, setEdit] = useState<EditState | null>(null);
  const original = useRef(saved);
  const [tool, setTool] = useState<'select' | 'room'>('select');
  const [selection, setSelection] = useState<PlanSelection>(null);
  const [drawing, setDrawing] = useState<Drawing>(null);
  const [placing, setPlacing] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ deviceId: string; at: PlanPoint; keyboard: boolean } | null>(null);
  const [naming, setNaming] = useState<{ rect?: PlanRect; roomId?: string; name: string } | null>(null);
  const [menu, setMenu] = useState<{ deviceId: string; at: PlanPoint } | null>(null);
  // Beim Bearbeiten steht der Ausschnitt still (sonst spränge er beim Zeichnen) — mit Rand zum Weiterzeichnen.
  const [frozen, setFrozen] = useState<PlanView | null>(null);
  const editing = !!edit;
  const plan = edit?.plan ?? saved;
  const view = editing && frozen ? frozen : fitView(planBounds(plan), size.w, size.h, 1);
  const empty = !plan.rooms.length && !plan.items.length;
  const panelDevice = panel ? devices.find((d) => d.id === panel.deviceId) : undefined;
  const menuItem = menu ? plan.items.find((i) => i.deviceId === menu.deviceId) : undefined;
  const unplaced = devices.filter((d) => !plan.items.some((i) => i.deviceId === d.id) && d.id !== drawing?.deviceId);
  const closePanel = useCallback(() => setPanel(null), []);

  const dispatch = (a: PlanEdit | { type: 'undo' }) => setEdit((s) => (s ? editPlan(s, a) : s));

  const reset = () => {
    setTool('select');
    setSelection(null);
    setDrawing(null);
    setPlacing(null);
    setNaming(null);
    setMenu(null);
  };
  const startEditing = () => {
    original.current = saved;
    setPanel(null);
    reset();
    setEdit(startEdit(saved));
  };
  const stopEditing = () => {
    reset();
    setEdit(null);
  };
  const finish = async (state: EditState | null = edit) => {
    if (state) await wled.setPlan(state.plan);
    stopEditing();
  };

  useEffect(() => {
    wled.setPlanLive(true);
    return () => wled.setPlanLive(false);
  }, []);

  useEffect(() => {
    setFrozen(editing ? fitView(planBounds(original.current), size.w, size.h, 4) : null);
  }, [editing, size.w, size.h]);

  // Rückfrage der App beim Verlassen: nur während des Bearbeitens.
  useEffect(() => {
    guard.current = edit
      ? { dirty: () => isDirty(edit, original.current), save: () => finish(edit), discard: stopEditing }
      : null;
  });
  useEffect(() => () => void (guard.current = null), [guard]);

  const place = (deviceId: string, at: PlanPoint) => {
    const d = devices.find((x) => x.id === deviceId);
    setPlacing(null);
    if (!d) return;
    const shape = shapeFor(d.info);
    setSelection({ kind: 'item', deviceId });
    if (shape === 'point') dispatch({ type: 'place', item: { deviceId, shape: 'point', at } });
    else if (shape === 'area' && d.info?.leds.matrix) dispatch({ type: 'place', item: { deviceId, shape: 'area', rect: areaForMatrix(d.info.leds.matrix, at) } });
    else setDrawing({ deviceId, points: [at] });
  };
  const drawEnd = () => {
    if (drawing && drawing.points.length >= 2) {
      dispatch({ type: 'place', item: { deviceId: drawing.deviceId, shape: 'line', points: drawing.points, reversed: false } });
    }
    setDrawing(null);
  };

  // Tastatur im Bearbeitungsmodus (der Handler wird nach jedem Rendern neu gesetzt und sieht so den aktuellen Stand)
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      // Liegt ein Dialog darüber (etwa die Rückfrage beim Verlassen), gehören die Tasten ihm
      if (isTyping(e.target) || naming || document.querySelector('.modal-backdrop')) return;
      if (e.ctrlKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        dispatch({ type: 'undo' });
        return;
      }
      if (e.key === 'Escape') return reset();
      if (e.key === 'Enter' && drawing) {
        e.preventDefault();
        return drawEnd();
      }
      // Mit Strg/Alt/Meta gehören Pfeile und Entf anderen Kürzeln (Strg+↑/↓ wechselt das Gerät und fragt dann nach)
      if (!selection || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === 'Delete') {
        e.preventDefault();
        dispatch(selection.kind === 'room' ? { type: 'removeRoom', id: selection.id } : { type: 'removeItem', deviceId: selection.deviceId });
        setSelection(null);
        return;
      }
      const step = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
      if (!step) return;
      e.preventDefault();
      if (selection.kind === 'item') dispatch({ type: 'moveItem', deviceId: selection.deviceId, dx: step[0], dy: step[1] });
      else {
        const r = plan.rooms.find((x) => x.id === selection.id);
        if (r) dispatch({ type: 'updateRoom', id: r.id, changes: { x: r.x + step[0], y: r.y + step[1] } });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Kontextmenü schließt bei Klick daneben
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.('.plan-menu')) setMenu(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  // Enter und das anschließende Blur dürfen den Raum nicht zweimal anlegen: Der erste Aufruf leert die Marke.
  const namingRef = useRef(naming);
  namingRef.current = naming;
  const commitName = () => {
    const n = namingRef.current;
    if (!n) return;
    namingRef.current = null;
    const name = n.name.trim();
    if (name && n.rect) dispatch({ type: 'addRoom', room: { id: crypto.randomUUID(), name, ...n.rect } });
    if (name && n.roomId) dispatch({ type: 'updateRoom', id: n.roomId, changes: { name } });
    setNaming(null);
    setTool('select');
  };
  const namingAt = (): PlanPoint => {
    if (naming?.rect) return toScreen(view, [naming.rect.x, naming.rect.y]);
    const r = plan.rooms.find((x) => x.id === naming?.roomId);
    return r ? toScreen(view, [r.x, r.y]) : [12, 12];
  };

  const menuAction = (fn: () => void) => {
    fn();
    setMenu(null);
  };

  return (
    <div className="device-view plan-view">
      <header className="titlebar drag">
        <h1 className="device-title">{t('Raumplan')}</h1>
        {editing && <span className="pill">{t('Bearbeiten')}</span>}
      </header>
      {empty && !editing ? (
        <div className="empty">
          <Icon name="map" size={40} />
          <h2>{t('Räume und Lampen einzeichnen')}</h2>
          <p className="muted">{t('Räume als Kästen zeichnen, Lampen hineinlegen — dann leuchten sie hier live.')}</p>
          <button className="btn primary plan-edit-btn" onClick={startEditing}>
            <Icon name="edit" size={16} />
            {t('Plan anlegen')}
          </button>
        </div>
      ) : (
        <div className="device-body">
          <div className="toolbar">
            {editing ? (
              <>
                <button className={`chip-btn plan-room-btn${tool === 'room' ? ' on' : ''}`} onClick={() => setTool(tool === 'room' ? 'select' : 'room')}>
                  <Icon name="plus" size={16} />
                  {t('Raum')}
                </button>
                <button className="chip-btn plan-undo-btn" disabled={!edit?.undo.length} onClick={() => dispatch({ type: 'undo' })} title={t('Rückgängig (Strg+Z)')}>
                  <Icon name="undo" size={16} />
                  {t('Rückgängig')}
                </button>
                <span className="spacer" />
                <button className="chip-btn plan-discard-btn" onClick={stopEditing}>
                  {t('Verwerfen')}
                </button>
                <button className="btn primary small plan-done-btn" onClick={() => void finish()}>
                  <Icon name="check" size={16} />
                  {t('Fertig')}
                </button>
              </>
            ) : (
              <>
                <button
                  className={`chip-btn${settings.liveView ? ' on' : ''}`}
                  onClick={() => void wled.setSettings({ liveView: !settings.liveView })}
                  title={t('Live-Vorschau der LEDs')}
                >
                  <Icon name="eye" size={16} />
                  Live
                </button>
                <button className="chip-btn plan-edit-btn" onClick={startEditing}>
                  <Icon name="edit" size={16} />
                  {t('Bearbeiten')}
                </button>
              </>
            )}
          </div>
          <div className="plan-body">
            <div
              className="plan-stage"
              ref={stageRef}
              onDragOver={(e) => {
                if (editing && e.dataTransfer.types.includes('text/wled-plan-device')) e.preventDefault();
              }}
              onDrop={(e) => {
                const id = e.dataTransfer.getData('text/wled-plan-device');
                if (!editing || !id) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                place(id, snapPoint(toUnits(view, [e.clientX - r.left, e.clientY - r.top]), plan.rooms, e.shiftKey));
              }}
            >
              {size.w > 0 && (
                <PlanCanvas
                  plan={plan}
                  devices={devices}
                  view={view}
                  width={size.w}
                  height={size.h}
                  live={settings.liveView}
                  editing={editing}
                  tool={tool}
                  selection={selection}
                  drawing={drawing}
                  placing={placing}
                  onSelect={setSelection}
                  onEdit={dispatch}
                  onOpenPanel={(deviceId, at, viaKeyboard) => setPanel({ deviceId, at, keyboard: !!viaKeyboard })}
                  onRoomDrawn={(rect) => setNaming({ rect, name: '' })}
                  onPlace={place}
                  onDrawPoint={(at) => setDrawing((d) => (d ? { ...d, points: addDrawPoint(d.points, at) } : d))}
                  onDrawEnd={drawEnd}
                  onContext={(deviceId, at) => setMenu({ deviceId, at })}
                  onRename={(roomId) => setNaming({ roomId, name: plan.rooms.find((r) => r.id === roomId)?.name ?? '' })}
                />
              )}
              {!editing && panel && panelDevice && (
                <PlanPanel
                  key={panel.deviceId}
                  device={panelDevice}
                  at={panel.at}
                  width={size.w}
                  height={size.h}
                  focusFirst={panel.keyboard}
                  onOpen={onOpen}
                  onClose={closePanel}
                />
              )}
              {naming && (
                <input
                  className="plan-name-input"
                  autoFocus
                  value={naming.name}
                  placeholder={t('Name des Raums')}
                  maxLength={40}
                  aria-label={t('Name des Raums')}
                  style={{ left: namingAt()[0] + 6, top: namingAt()[1] + 6 }}
                  onChange={(e) => setNaming({ ...naming, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitName();
                    if (e.key === 'Escape') {
                      setNaming(null);
                      setTool('select');
                    }
                  }}
                  onBlur={commitName}
                />
              )}
              {menu && menuItem && (
                <div className="plan-menu" role="menu" style={{ left: menu.at[0], top: menu.at[1] }}>
                  {menuItem.shape === 'line' && (
                    <>
                      <button role="menuitem" onClick={() => menuAction(() => dispatch({ type: 'reverse', deviceId: menu.deviceId }))}>
                        {t('Richtung umkehren')}
                      </button>
                      <button
                        role="menuitem"
                        onClick={() =>
                          menuAction(() => {
                            dispatch({ type: 'removeItem', deviceId: menu.deviceId });
                            setPlacing(menu.deviceId);
                          })
                        }
                      >
                        {t('Neu zeichnen')}
                      </button>
                    </>
                  )}
                  {menuItem.shape !== 'line' && (
                    <button role="menuitem" onClick={() => menuAction(() => dispatch({ type: 'setShape', deviceId: menu.deviceId, shape: 'line' }))}>
                      {t('Als Linie darstellen')}
                    </button>
                  )}
                  {menuItem.shape !== 'point' && (
                    <button role="menuitem" onClick={() => menuAction(() => dispatch({ type: 'setShape', deviceId: menu.deviceId, shape: 'point' }))}>
                      {t('Als Punkt darstellen')}
                    </button>
                  )}
                  <button role="menuitem" onClick={() => menuAction(() => dispatch({ type: 'removeItem', deviceId: menu.deviceId }))}>
                    {t('Aus dem Plan entfernen')}
                  </button>
                </div>
              )}
            </div>
            {editing && (
              <aside className="plan-side">
                <div className="list-heading">{t('Noch nicht im Plan')}</div>
                {unplaced.map((d) => (
                  <button
                    key={d.id}
                    className={`plan-side-item${placing === d.id ? ' active' : ''}`}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/wled-plan-device', d.id)}
                    onClick={() => setPlacing(placing === d.id ? null : d.id)}
                  >
                    <Icon name={shapeIcon[shapeFor(d.info)]} size={16} />
                    <span className="device-name">{d.name}</span>
                  </button>
                ))}
                {!unplaced.length && <p className="muted small">{t('Alle Geräte sind im Plan.')}</p>}
                <p className="muted small plan-help">{t('Gerät anklicken oder in den Plan ziehen. Linien: Klick setzt Knickpunkte, Doppelklick oder Enter beendet.')}</p>
              </aside>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
