import { useRef, useState } from 'react';
import { groupMembers } from '../../shared/groups';
import { t } from '../../shared/i18n';
import { commonNames, copySummary, failureSummary, lookFrom, type GroupAction } from '../../shared/look';
import type { DeviceGroup, DeviceSnapshot, DeviceStatic } from '../../shared/types';
import { useStatics, wled } from '../lib/store';
import { pct, rgbCss, viewSeg } from '../lib/wled';
import { Slider, toast } from './controls';
import { useGroupControls } from './Groups';
import { Icon } from './Icon';
import { DeviceDot, QuickControls, deviceAccent, statusText } from './Sidebar';
import { QUICK } from './tabs/ColorsTab';

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
      <div className="member-look">{(online && lookText(device, st)) || '—'}</div>
      <div className="member-state muted small">{statusText(device)}</div>
      <div className="member-controls">
        <QuickControls device={device} />
      </div>
      <button className="link-btn" aria-label={t('{name} öffnen', { name: device.name })} onClick={() => onOpen(device.id)}>
        {t('Öffnen')} →
      </button>
    </div>
  );
}

/**
 * Auswahlliste als Aktion: Nach dem Setzen zeigt sie wieder ihren Platzhalter.
 * Unter Windows löst schon ein Pfeil- oder Buchstabentastendruck auf der geschlossenen Liste „change“ aus —
 * ein Tastendruck würde sonst sofort alle Lampen überschreiben. Darum: Mit der Maus gewählt, gilt die
 * Auswahl sofort; per Tastatur wird sie nur vorgemerkt und erst mit Enter angewendet.
 * Als Tastatur zählt allein ein keydown; jede angewendete oder verworfene Wahl setzt die Marke zurück,
 * eine Änderung ohne Tastendruck (z. B. aus Tests) wendet also sofort an.
 */
export function ActionSelect({
  label,
  disabled,
  options,
  onPick,
}: {
  label: string;
  disabled: boolean;
  options: Array<{ value: string; label: string }>;
  onPick: (value: string) => void;
}) {
  const [pending, setPending] = useState('');
  const last = useRef<'keyboard' | 'pointer'>('pointer');

  const discard = () => {
    last.current = 'pointer';
    setPending('');
  };

  return (
    <select
      value={pending}
      disabled={disabled}
      aria-label={label}
      onPointerDown={() => {
        last.current = 'pointer';
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') return discard();
        if (e.key !== 'Enter') {
          last.current = 'keyboard';
          return;
        }
        if (!pending) return;
        e.preventDefault();
        const value = pending;
        discard();
        onPick(value);
      }}
      onBlur={discard}
      onChange={(e) => {
        const value = e.target.value;
        if (last.current === 'keyboard') return setPending(value);
        discard();
        if (value) onPick(value);
      }}
    >
      <option value="">{label}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** „Für alle“: Schnellfarbe, Effekt, Palette oder Look eines Mitglieds auf alle erreichbaren Mitglieder. */
function ForAll({ members, statics }: { members: DeviceSnapshot[]; statics: Array<DeviceStatic | null> }) {
  const [busy, setBusy] = useState(false);
  const reach = members.filter((d) => d.status === 'online' && d.state);
  const ids = reach.map((d) => d.id);
  const reachStatics = reach.map((d) => statics[members.indexOf(d)]);
  // Auswahllisten erst, wenn alle Namenslisten da sind — sonst wäre die Schnittmenge falsch.
  const ready = reach.length > 0 && reachStatics.every((s) => !!s);
  const effects = ready ? commonNames(reachStatics.map((s) => s!.effects)) : [];
  const palettes = ready ? commonNames(reachStatics.map((s) => s!.palettes)) : [];
  const nameOf = (id: string) => members.find((d) => d.id === id)?.name ?? id;

  const apply = async (action: GroupAction) => {
    if (!ids.length || busy) return;
    setBusy(true);
    try {
      const msg = failureSummary(await wled.applyAll(action, ids), nameOf);
      if (msg) toast(msg);
    } catch {
      toast(t('Übertragen fehlgeschlagen'));
    } finally {
      setBusy(false);
    }
  };

  const copyFrom = async (sourceId: string) => {
    const src = reach.find((d) => d.id === sourceId);
    const st = src ? statics[members.indexOf(src)] : null;
    const look = src?.state?.seg.length ? lookFrom(viewSeg(src.state), st) : null;
    if (!look) return toast(t('Look nicht übertragen'));
    if (look.pal === null) return toast(t('Eigene Paletten lassen sich nicht übertragen'));
    if (busy) return;
    setBusy(true);
    try {
      toast(copySummary(await wled.copyLook(look, ids.filter((id) => id !== sourceId)), nameOf));
    } catch {
      toast(t('Übertragen fehlgeschlagen'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel for-all">
      <div className="panel-head">
        <h3>{t('Für alle')}</h3>
        <span className="muted small">{t('Helligkeit und An/Aus bleiben, wie sie sind.')}</span>
      </div>
      <div className="quick">
        {QUICK.map((q) => (
          <button
            key={q.label}
            className="quick-btn"
            title={t(q.label)}
            aria-label={t(q.label)}
            style={{ background: rgbCss(q.c) }}
            disabled={!ids.length || busy}
            onClick={() => void apply({ kind: 'solid', color: q.c.slice(0, 3) })}
          />
        ))}
      </div>
      <div className="for-all-row">
        <ActionSelect
          label={t('Effekt für alle …')}
          disabled={!ready || busy}
          options={effects.map((n) => ({ value: n, label: n }))}
          onPick={(name) => void apply({ kind: 'effect', name })}
        />
        <ActionSelect
          label={t('Palette für alle …')}
          disabled={!ready || busy}
          options={palettes.map((n) => ({ value: n, label: n }))}
          onPick={(name) => void apply({ kind: 'palette', name })}
        />
        <ActionSelect
          label={t('Look von …')}
          disabled={!ready || reach.length < 2 || busy}
          options={reach.map((d) => ({ value: d.id, label: d.name }))}
          onPick={(id) => void copyFrom(id)}
        />
      </div>
    </section>
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
  // Beim Start verbinden sich die Mitglieder noch: Dann gibt es keinen Hinweis auf „nicht erreichbar“.
  const connecting = members.some((d) => d.status === 'connecting');
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
          {!c.usable && !connecting && (
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
            <ForAll members={members} statics={statics} />
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
