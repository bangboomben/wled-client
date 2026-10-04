import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { t } from '../../shared/i18n';
import { fitView, planBounds } from '../../shared/plan';
import type { DeviceSnapshot, PlanPoint } from '../../shared/types';
import { usePlan, useSettings, wled } from '../lib/store';
import { Icon } from './Icon';
import { PlanCanvas } from './PlanCanvas';
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

export function RoomPlan({
  devices,
  onOpen,
  guard,
}: {
  devices: DeviceSnapshot[];
  onOpen: (id: string) => void;
  guard: MutableRefObject<PlanGuard | null>;
}) {
  const plan = usePlan();
  const settings = useSettings();
  const [stageRef, size] = useSize();
  const [panel, setPanel] = useState<{ deviceId: string; at: PlanPoint } | null>(null);
  const view = fitView(planBounds(plan), size.w, size.h, 1);
  const empty = !plan.rooms.length && !plan.items.length;
  const panelDevice = panel ? devices.find((d) => d.id === panel.deviceId) : undefined;
  const closePanel = useCallback(() => setPanel(null), []);

  // Solange der Plan sichtbar ist, schicken alle platzierten Geräte Live-Bilder.
  useEffect(() => {
    wled.setPlanLive(true);
    return () => wled.setPlanLive(false);
  }, []);
  useEffect(() => {
    guard.current = null;
  });

  return (
    <div className="device-view plan-view">
      <header className="titlebar drag">
        <h1 className="device-title">{t('Raumplan')}</h1>
      </header>
      {empty ? (
        <div className="empty">
          <Icon name="map" size={40} />
          <h2>{t('Räume und Lampen einzeichnen')}</h2>
          <p className="muted">{t('Räume als Kästen zeichnen, Lampen hineinlegen — dann leuchten sie hier live.')}</p>
        </div>
      ) : (
        <div className="device-body">
          <div className="toolbar">
            <button
              className={`chip-btn${settings.liveView ? ' on' : ''}`}
              onClick={() => void wled.setSettings({ liveView: !settings.liveView })}
              title={t('Live-Vorschau der LEDs')}
            >
              <Icon name="eye" size={16} />
              Live
            </button>
          </div>
          <div className="plan-body">
            <div className="plan-stage" ref={stageRef}>
              {size.w > 0 && (
                <PlanCanvas
                  plan={plan}
                  devices={devices}
                  view={view}
                  width={size.w}
                  height={size.h}
                  live={settings.liveView}
                  editing={false}
                  tool="select"
                  selection={null}
                  drawing={null}
                  placing={null}
                  onSelect={() => {}}
                  onEdit={() => {}}
                  onOpenPanel={(deviceId, at) => setPanel({ deviceId, at })}
                  onRoomDrawn={() => {}}
                  onPlace={() => {}}
                  onDrawPoint={() => {}}
                  onDrawEnd={() => {}}
                  onContext={() => {}}
                  onRename={() => {}}
                />
              )}
              {panel && panelDevice && (
                <PlanPanel device={panelDevice} at={panel.at} width={size.w} height={size.h} onOpen={onOpen} onClose={closePanel} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
