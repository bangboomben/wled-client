import { useEffect, useRef } from 'react';
import { brightnessBase, groupMembers, groupView, powerTargets, scaleBrightness, type BriTarget } from '../../shared/groups';
import { t } from '../../shared/i18n';
import type { DeviceGroup, DeviceSnapshot } from '../../shared/types';
import { send } from '../lib/store';
import { Slider, Toggle } from './controls';
import { Icon } from './Icon';

/** Nach so langer Pause ohne Änderung gilt ein Zug per Tastatur als beendet. */
const GESTURE_IDLE_MS = 800;

function memberText(members: DeviceSnapshot[]): string {
  if (!members.length) return t('Keine Geräte');
  return members.map((d) => (d.status === 'online' ? d.name : t('{name} (offline)', { name: d.name }))).join(', ');
}

/** Eine Gruppe: Ein/Aus und anteilige Helligkeit für alle Mitglieder — in Seitenleiste und Tray-Fenster. */
export function GroupRow({ group, devices, onEdit }: { group: DeviceGroup; devices: DeviceSnapshot[]; onEdit?: (id: string) => void }) {
  const members = groupMembers(group, devices);
  const view = groupView(members);
  const usable = view.reachable > 0;
  // Stand bei Zugbeginn: Zieht man im selben Zug wieder hoch, kommen die Verhältnisse zurück.
  const base = useRef<BriTarget[] | null>(null);
  const idle = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(idle.current), []);

  const endGesture = () => {
    window.clearTimeout(idle.current);
    base.current = null;
  };

  const setBrightness = (v: number) => {
    base.current ??= brightnessBase(members);
    for (const { id, bri } of scaleBrightness(base.current, v)) send(id, { bri }, 'bri');
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(endGesture, GESTURE_IDLE_MS);
  };

  const setPower = (on: boolean) => {
    for (const id of powerTargets(members)) send(id, { on });
  };

  return (
    <div
      className={`group-row${usable ? '' : ' offline'}`}
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
        <div className="device-sub">{memberText(members)}</div>
      </div>
      <Toggle checked={view.lit} disabled={!usable} label={t('Gruppe {name} ein- oder ausschalten', { name: group.name })} onChange={setPower} />
      <div className="row-slider">
        <Slider
          variant="mini"
          value={view.bri}
          min={1}
          disabled={!usable}
          fillColor={view.lit ? undefined : 'var(--muted)'}
          label={t('Helligkeit Gruppe {name}', { name: group.name })}
          onChange={setBrightness}
          onCommit={endGesture}
        />
      </div>
    </div>
  );
}
