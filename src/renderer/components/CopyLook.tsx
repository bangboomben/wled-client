import { useState } from 'react';
import { groupMembers } from '../../shared/groups';
import { t } from '../../shared/i18n';
import { copySummary, copyTargets, lookFrom } from '../../shared/look';
import type { DeviceSnapshot, DeviceStatic, WledState } from '../../shared/types';
import { useDevices, useGroups, wled } from '../lib/store';
import { viewSeg } from '../lib/wled';
import { Check, Popover, toast } from './controls';
import { Icon } from './Icon';

const toggled = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));

/** „Übertragen“: Effekt, Palette, Farben und Effekt-Regler des angezeigten Segments auf andere Geräte und Gruppen. */
export function CopyLookPopover({ device, state, st }: { device: DeviceSnapshot; state: WledState; st: DeviceStatic | null }) {
  const devices = useDevices();
  const groups = useGroups();
  const [pickDevices, setPickDevices] = useState<string[]>([]);
  const [pickGroups, setPickGroups] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const online = device.status === 'online';
  const look = lookFrom(viewSeg(state), st);
  const targets = copyTargets({ devices: pickDevices, groups: pickGroups }, groups, devices, device.id);
  const nameOf = (id: string) => devices.find((d) => d.id === id)?.name ?? id;
  // Eine eigene Palette hat auf jedem Gerät anderen Inhalt — gleich sagen, statt jedes Ziel zu überspringen.
  const customPalette = look?.pal === null;

  const run = async (close: () => void) => {
    if (!look || busy || !targets.length) return;
    setBusy(true);
    const results = await wled.copyLook(look, targets);
    setBusy(false);
    toast(copySummary(results, nameOf));
    setPickDevices([]);
    setPickGroups([]);
    close();
  };

  return (
    <Popover
      trigger={(open, toggle) => (
        <button
          className={`chip-btn${open ? ' open' : ''}`}
          disabled={!online || !look}
          onClick={toggle}
          title={t('Look auf andere Geräte übertragen')}
        >
          <Icon name="copy" size={16} />
          {t('Übertragen')}
        </button>
      )}
    >
      {(close) => (
        <div className="pop-form copy-look">
          <strong>{t('Look von „{name}“ übertragen', { name: device.name })}</strong>
          <p className="muted small">{t('Effekt, Palette, Farben und Effekt-Regler. Helligkeit und An/Aus bleiben, wie sie sind.')}</p>
          {customPalette && <p className="error">{t('Eigene Paletten lassen sich nicht übertragen')}</p>}
          {groups.length > 0 && <div className="pop-label">{t('Gruppen')}</div>}
          <div className="copy-groups">
            {groups.map((g) => {
              const reachable = copyTargets({ devices: [], groups: [g.id] }, groups, devices, device.id).length > 0;
              const members = groupMembers(g, devices).map((d) => d.name).join(', ');
              return (
                <Check key={g.id} checked={pickGroups.includes(g.id)} disabled={!reachable} onChange={(on) => setPickGroups((l) => toggled(l, g.id, on))}>
                  {g.name} <span className="muted small">· {members || t('Keine Geräte')}</span>
                </Check>
              );
            })}
          </div>
          <div className="pop-label">{t('Geräte')}</div>
          <div className="copy-devices">
            {devices
              .filter((d) => d.id !== device.id)
              .map((d) => (
                <Check
                  key={d.id}
                  checked={pickDevices.includes(d.id)}
                  disabled={d.status !== 'online'}
                  onChange={(on) => setPickDevices((l) => toggled(l, d.id, on))}
                >
                  {d.status === 'online' ? d.name : t('{name} (offline)', { name: d.name })}
                </Check>
              ))}
          </div>
          <div className="pop-actions">
            <button className="btn ghost small" onClick={close}>
              {t('Abbrechen')}
            </button>
            <button
              className="btn primary small"
              disabled={busy || !online || !look || customPalette || !targets.length}
              onClick={() => void run(close)}
            >
              {t('Übertragen')}
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}
