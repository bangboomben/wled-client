import { useRef, useState, type CSSProperties } from 'react';
import { t } from '../../shared/i18n';
import type { DeviceSnapshot } from '../../shared/types';
import { send, sendAll, wled } from '../lib/store';
import { accentFor, displayColor, pct, viewSeg } from '../lib/wled';
import { Slider, Toggle } from './controls';
import { Icon, Logo } from './Icon';

export function statusText(d: DeviceSnapshot): string {
  if (d.status === 'connecting') return t('Verbinde …');
  if (d.status === 'offline') return t('Offline');
  return d.state?.on ? t('An · {n} %', { n: pct(d.state.bri) }) : t('Aus');
}

export function DeviceDot({ device, size = 12 }: { device: DeviceSnapshot; size?: number }) {
  const on = device.status === 'online' && !!device.state?.on;
  const seg = device.state ? viewSeg(device.state) : undefined;
  return (
    <span
      className={`dot${on ? ' lit' : ''}${device.status !== 'online' ? ' dead' : ''}`}
      style={{ '--c': displayColor(seg?.col?.[0]), width: size, height: size } as CSSProperties}
    />
  );
}

/** Jede Gerätezeile zeigt Schalter und Regler in der eigenen Gerätefarbe. */
export function deviceAccent(device: DeviceSnapshot): CSSProperties {
  const a = accentFor(device);
  return { '--accent': a.accent, '--accent-contrast': a.contrast } as CSSProperties;
}

/** Ein/Aus und Helligkeit für ein Gerät — in Seitenleiste und Tray-Fenster identisch. */
export function QuickControls({ device }: { device: DeviceSnapshot }) {
  const online = device.status === 'online';
  const on = online && !!device.state?.on;
  return (
    <>
      <Toggle checked={on} disabled={!online} label={t('{name} ein- oder ausschalten', { name: device.name })} onChange={(v) => send(device.id, { on: v })} />
      <div className="row-slider">
        <Slider
          variant="mini"
          value={device.state?.bri ?? 128}
          min={1}
          disabled={!online}
          fillColor={on ? undefined : 'var(--muted)'}
          label={t('Helligkeit {name}', { name: device.name })}
          onChange={(v) => send(device.id, { bri: v }, 'bri')}
        />
      </div>
    </>
  );
}

function DeviceRow({
  device,
  index,
  active,
  onSelect,
  onEdit,
  onMove,
}: {
  device: DeviceSnapshot;
  index: number;
  active: boolean;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onMove: (fromId: string, toIndex: number) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [dropHint, setDropHint] = useState<'before' | 'after' | null>(null);
  const online = device.status === 'online';

  return (
    <div
      ref={row}
      role="option"
      aria-selected={active}
      tabIndex={0}
      title={index < 9 ? t('Strg+{n}', { n: index + 1 }) : undefined}
      className={`device-row${active ? ' active' : ''}${online ? '' : ' offline'}${dropHint ? ` drop-${dropHint}` : ''}`}
      style={deviceAccent(device)}
      onClick={() => onSelect(device.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) onSelect(device.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onEdit(device.id);
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/wled-device', device.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => {
        if (row.current) row.current.draggable = false;
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('text/wled-device')) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        setDropHint(e.clientY < r.top + r.height / 2 ? 'before' : 'after');
      }}
      onDragLeave={() => setDropHint(null)}
      onDrop={(e) => {
        const from = e.dataTransfer.getData('text/wled-device');
        const hint = dropHint;
        setDropHint(null);
        if (from && from !== device.id) onMove(from, hint === 'after' ? index + 1 : index);
      }}
    >
      <DeviceDot device={device} />
      {/* Ziehen am Namen sortiert die Liste um; der Regler bleibt frei bedienbar. */}
      <div
        className="device-meta"
        onMouseDown={() => {
          if (row.current) row.current.draggable = true;
        }}
        onMouseUp={() => {
          if (row.current) row.current.draggable = false;
        }}
      >
        <div className="device-name">{device.name}</div>
        <div className="device-sub">{statusText(device)}</div>
      </div>
      <QuickControls device={device} />
    </div>
  );
}

export function Sidebar({
  devices,
  selectedId,
  onSelect,
  onAdd,
  onSettings,
  onEdit,
}: {
  devices: DeviceSnapshot[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onSettings: () => void;
  onEdit: (id: string) => void;
}) {
  const anyOn = devices.some((d) => d.status === 'online' && d.state?.on);

  const move = (fromId: string, toIndex: number) => {
    const ids = devices.map((d) => d.id);
    const from = ids.indexOf(fromId);
    if (from < 0) return;
    ids.splice(from, 1);
    ids.splice(from < toIndex ? toIndex - 1 : toIndex, 0, fromId);
    void wled.reorderDevices(ids);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head drag">
        <Logo />
        <span className="app-title">WLED Client</span>
      </div>
      <div className="device-list" role="listbox" aria-label={t('Geräte')}>
        {devices.map((d, i) => (
          <DeviceRow
            key={d.id}
            device={d}
            index={i}
            active={d.id === selectedId}
            onSelect={onSelect}
            onEdit={onEdit}
            onMove={move}
          />
        ))}
        {devices.length === 0 && <p className="sidebar-empty">{t('Noch keine Geräte.')}</p>}
      </div>
      <div className="sidebar-foot">
        <button className="btn ghost" onClick={onAdd}>
          <Icon name="plus" size={16} />
          {t('Gerät')}
        </button>
        <button className="btn ghost" disabled={!devices.length} onClick={() => sendAll({ on: !anyOn })}>
          <Icon name="power" size={16} />
          {anyOn ? t('Alle aus') : t('Alle an')}
        </button>
        <span className="spacer" />
        <button className="icon-btn" onClick={onSettings} aria-label={t('App-Einstellungen')} title={t('App-Einstellungen')}>
          <Icon name="gear" />
        </button>
      </div>
    </aside>
  );
}
