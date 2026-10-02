import { useEffect, useRef, type PointerEvent } from 'react';
import { brightnessBase, groupMembers, groupView, powerTargets, scaleBrightness, type BriTarget, type GroupView } from '../../shared/groups';
import { t } from '../../shared/i18n';
import type { DeviceGroup, DeviceSnapshot } from '../../shared/types';
import { send } from '../lib/store';
import { Slider, Toggle } from './controls';
import { Icon } from './Icon';

/** Nach so langer Pause ohne Änderung gilt ein Zug per Tastatur als beendet. */
const GESTURE_IDLE_MS = 800;

function memberText(members: DeviceSnapshot[]): string {
  if (!members.length) return t('Keine Geräte');
  return members.map((d) => (d.status === 'offline' ? t('{name} (offline)', { name: d.name }) : d.name)).join(', ');
}

/** Ein/Aus und anteilige Helligkeit einer Gruppe — gemeinsam für Gruppenzeile und Gruppenansicht. */
export function useGroupControls(members: DeviceSnapshot[]): {
  view: GroupView;
  usable: boolean;
  setPower: (on: boolean) => void;
  setBrightness: (v: number) => void;
  endGesture: () => void;
  onPointerDownCapture: (e: PointerEvent) => void;
} {
  const view = groupView(members);
  // Stand bei Zugbeginn: Zieht man im selben Zug wieder hoch, kommen die Verhältnisse zurück.
  const base = useRef<BriTarget[] | null>(null);
  const idle = useRef<number | undefined>(undefined);
  // Maus oder Stift halten den Regler: Der Zug endet beim Loslassen (onCommit), nie über die Pause.
  const dragging = useRef(false);
  useEffect(() => () => window.clearTimeout(idle.current), []);

  const endGesture = () => {
    window.clearTimeout(idle.current);
    dragging.current = false;
    base.current = null;
  };

  const setBrightness = (v: number) => {
    base.current ??= brightnessBase(members);
    for (const { id, bri } of scaleBrightness(base.current, v)) send(id, { bri }, 'bri');
    window.clearTimeout(idle.current);
    // Tastatur: Der Zug endet nach einer Pause ohne Änderung.
    if (!dragging.current) idle.current = window.setTimeout(endGesture, GESTURE_IDLE_MS);
  };

  const setPower = (on: boolean) => {
    for (const id of powerTargets(members)) send(id, { on });
  };

  // Capture-Phase am umgebenden Element: Der Regler hält pointerdown selbst an.
  const onPointerDownCapture = (e: PointerEvent) => {
    // Nur ein Druck auf den Regler selbst startet einen Mauszug (sonst käme nie ein onCommit).
    if (!(e.target instanceof HTMLInputElement)) return;
    window.clearTimeout(idle.current);
    dragging.current = true;
  };

  return { view, usable: view.reachable > 0, setPower, setBrightness, endGesture, onPointerDownCapture };
}

/** Eine Gruppe: Ein/Aus und anteilige Helligkeit für alle Mitglieder — in Seitenleiste und Tray-Fenster. */
export function GroupRow({ group, devices, onEdit }: { group: DeviceGroup; devices: DeviceSnapshot[]; onEdit?: (id: string) => void }) {
  const members = groupMembers(group, devices);
  const c = useGroupControls(members);
  const memberLine = memberText(members);

  return (
    <div
      className={`group-row${c.usable ? '' : ' offline'}`}
      onContextMenu={
        onEdit
          ? (e) => {
              e.preventDefault();
              onEdit(group.id);
            }
          : undefined
      }
    >
      <Icon name="layers" size={16} className="group-icon" />
      <div className="device-meta">
        <div className="device-name">{group.name}</div>
        <div className="device-sub" title={memberLine}>
          {memberLine}
        </div>
      </div>
      <Toggle checked={c.view.lit} disabled={!c.usable} label={t('Gruppe {name} ein- oder ausschalten', { name: group.name })} onChange={c.setPower} />
      {/* Capture-Phase: Der Regler hält pointerdown selbst an. */}
      <div className="row-slider" onPointerDownCapture={c.onPointerDownCapture}>
        <Slider
          variant="mini"
          value={c.view.bri}
          min={1}
          disabled={!c.usable}
          fillColor={c.view.lit ? undefined : 'var(--muted)'}
          label={t('Helligkeit Gruppe {name}', { name: group.name })}
          onChange={c.setBrightness}
          onCommit={c.endGesture}
        />
      </div>
    </div>
  );
}
