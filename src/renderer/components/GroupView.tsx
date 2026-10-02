import { groupMembers } from '../../shared/groups';
import { t } from '../../shared/i18n';
import type { DeviceGroup, DeviceSnapshot, DeviceStatic } from '../../shared/types';
import { useStatics } from '../lib/store';
import { pct, viewSeg } from '../lib/wled';
import { Slider } from './controls';
import { useGroupControls } from './Groups';
import { Icon } from './Icon';
import { DeviceDot, QuickControls, deviceAccent, statusText } from './Sidebar';

/** Effekt und Palette des angezeigten Segments — oder der Name des aktiven Presets. */
function lookText(device: DeviceSnapshot, st: DeviceStatic | null): string {
  const state = device.state;
  if (!state || !st) return '';
  const preset = state.ps > 0 ? st.presets[String(state.ps)]?.n : undefined;
  if (preset) return preset;
  if (!state.seg.length) return '';
  const seg = viewSeg(state);
  const fx = st.effects[seg.fx] ?? '';
  const pal = seg.pal < st.palettes.length ? (st.palettes[seg.pal] ?? '') : t('Eigene Palette');
  return [fx, pal].filter(Boolean).join(' · ');
}

function MemberCard({ device, st, onOpen }: { device: DeviceSnapshot; st: DeviceStatic | null; onOpen: (id: string) => void }) {
  const online = device.status === 'online';
  return (
    <div className={`member-card${online ? '' : ' offline'}`} style={deviceAccent(device)}>
      <div className="member-head">
        <DeviceDot device={device} />
        <span className="device-name">{device.name}</span>
      </div>
      <div className="member-look">{online ? lookText(device, st) || '—' : t('Offline')}</div>
      <div className="member-state muted small">{statusText(device)}</div>
      <div className="member-controls">
        <QuickControls device={device} />
      </div>
      <button className="link-btn" onClick={() => onOpen(device.id)}>
        {t('Öffnen')} →
      </button>
    </div>
  );
}

/** Ansicht einer Gruppe: Kopf mit Ein/Aus und anteiliger Helligkeit, darunter die Mitglieder. */
export function GroupView({
  group,
  devices,
  onEdit,
  onOpen,
}: {
  group: DeviceGroup;
  devices: DeviceSnapshot[];
  onEdit: () => void;
  onOpen: (deviceId: string) => void;
}) {
  const members = groupMembers(group, devices);
  const statics = useStatics(members);
  const c = useGroupControls(members);
  const count = members.length === 1 ? t('Gruppe · 1 Gerät') : t('Gruppe · {n} Geräte', { n: members.length });

  return (
    <div className="device-view group-view">
      <header className="titlebar drag">
        <h1 className="device-title">{group.name}</h1>
        <span className="pill">{count}</span>
      </header>
      {members.length === 0 ? (
        <div className="empty">
          <Icon name="layers" size={40} />
          <h2>{t('Diese Gruppe hat keine Geräte.')}</h2>
          <button className="btn" onClick={onEdit}>
            <Icon name="edit" size={16} />
            {t('Bearbeiten')}
          </button>
        </div>
      ) : (
        <div className="device-body">
          {!c.usable && (
            <div className="banner">
              <Icon name="wifi" size={16} />
              {t('Kein Gerät der Gruppe ist erreichbar.')}
            </div>
          )}
          <section className="hero">
            <button
              className={`power-btn${c.view.lit ? ' on' : ''}`}
              disabled={!c.usable}
              onClick={() => c.setPower(!c.view.lit)}
              aria-pressed={c.view.lit}
              aria-label={c.view.lit ? t('Ausschalten') : t('Einschalten')}
              title={c.view.lit ? t('Ausschalten') : t('Einschalten')}
            >
              <Icon name="power" size={26} />
            </button>
            <div className="hero-bri" onPointerDownCapture={c.onPointerDownCapture}>
              <div className="hero-bri-label">
                <Icon name="sun" size={16} />
                {t('Helligkeit')}
                <span className="hero-pct">{c.view.lit ? t('{n} %', { n: pct(c.view.bri) }) : t('aus')}</span>
              </div>
              <Slider
                variant="big"
                min={1}
                value={c.view.bri}
                disabled={!c.usable}
                label={t('Helligkeit')}
                onChange={c.setBrightness}
                onCommit={c.endGesture}
              />
            </div>
          </section>
          <div className="toolbar">
            <button className="chip-btn" onClick={onEdit}>
              <Icon name="edit" size={16} />
              {t('Bearbeiten')}
            </button>
          </div>
          <div className="group-scroll">
            <div className="member-grid">
              {members.map((d, i) => (
                <MemberCard key={d.id} device={d} st={statics[i]} onOpen={onOpen} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
