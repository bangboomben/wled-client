import { useEffect, useRef, useState } from 'react';
import { t } from '../../shared/i18n';
import { commonNames, failureSummary } from '../../shared/look';
import type { DeviceSnapshot, PlanPoint } from '../../shared/types';
import { useStatic, wled } from '../lib/store';
import { toast } from './controls';
import { ActionSelect } from './GroupView';
import { DeviceDot, QuickControls, deviceAccent, statusText } from './Sidebar';

const PANEL_W = 260;
const PANEL_H = 210;

/** Kleines Bedienfeld neben einem Gerät im Raumplan: Schalter, Helligkeit, Effekt, Öffnen. */
export function PlanPanel({
  device,
  at,
  width,
  height,
  focusFirst,
  onOpen,
  onClose,
}: {
  device: DeviceSnapshot;
  /** Klickpunkt in Pixeln relativ zur Bühne. */
  at: PlanPoint;
  width: number;
  height: number;
  /** Per Tastatur geöffnet: Fokus gleich auf das erste bedienbare Element. */
  focusFirst: boolean;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const st = useStatic(device);
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const online = device.status === 'online';
  const effects = st ? commonNames([st.effects]) : [];

  // `at` ändert sich bei jedem erneuten Öffnen; so greift der Fokus auch dann, wenn das Feld schon offen war
  useEffect(() => {
    if (!focusFirst) return;
    ref.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')?.focus();
  }, [focusFirst, at]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = e.target as Element;
      // Klick auf ein anderes Gerät öffnet dessen Feld (über die Bühne) — nicht hier schließen.
      if (ref.current?.contains(el) || el.closest?.('[data-kind="item"]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Lag der Fokus im Feld, geht er zurück auf das Gerät — sonst fiele er mit dem Feld auf die Seite.
      const inside = !!ref.current?.contains(document.activeElement);
      const item = ref.current?.parentElement?.querySelector<SVGElement>(`.plan-item[data-device="${CSS.escape(device.id)}"]`);
      onClose();
      if (inside) item?.focus();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, device.id]);

  const apply = async (name: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const msg = failureSummary(await wled.applyAll({ kind: 'effect', name }, [device.id]), () => device.name);
      if (msg) toast(msg);
    } catch {
      toast(t('Übertragen fehlgeschlagen'));
    } finally {
      setBusy(false);
    }
  };

  const left = Math.max(8, Math.min(at[0] + 12, width - PANEL_W - 8));
  const top = Math.max(8, Math.min(at[1] + 12, height - PANEL_H - 8));
  return (
    <div className="plan-panel" ref={ref} tabIndex={-1} role="dialog" aria-label={device.name} style={{ left, top, width: PANEL_W, ...deviceAccent(device) }}>
      <div className="member-head">
        <DeviceDot device={device} />
        <span className="device-name">{device.name}</span>
      </div>
      <div className="muted small">{statusText(device)}</div>
      <div className="plan-panel-controls">
        <QuickControls device={device} />
      </div>
      <ActionSelect
        label={t('Effekt …')}
        disabled={!online || !effects.length || busy}
        options={effects.map((n) => ({ value: n, label: n }))}
        onPick={(n) => void apply(n)}
      />
      <button className="link-btn" onClick={() => onOpen(device.id)}>
        {t('Öffnen')} →
      </button>
    </div>
  );
}
