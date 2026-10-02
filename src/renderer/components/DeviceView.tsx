import { useEffect, useRef, useState } from 'react';
import { key, t } from '../../shared/i18n';
import type { DevicePage, DeviceSnapshot, WledState } from '../../shared/types';
import { readLocal, send, useSettings, useStatic, wled, writeLocal } from '../lib/store';
import { displayColor, pct } from '../lib/wled';
import { ErrorBoundary, Popover, Slider, Toggle } from './controls';
import { CopyLookPopover } from './CopyLook';
import { InfoDialog } from './dialogs';
import { Icon } from './Icon';
import { ColorsTab } from './tabs/ColorsTab';
import { EffectsTab } from './tabs/EffectsTab';
import { PresetsTab } from './tabs/PresetsTab';
import { SegmentsTab } from './tabs/SegmentsTab';

type TabId = 'colors' | 'effects' | 'segments' | 'presets';

const TABS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: 'colors', label: key('Farben'), icon: 'droplet' },
  { id: 'effects', label: key('Effekte'), icon: 'sparkles' },
  { id: 'segments', label: key('Segmente'), icon: 'layers' },
  { id: 'presets', label: key('Presets'), icon: 'bookmark' },
];

const PAGES: Array<{ page: DevicePage; label: string }> = [
  { page: 'settings', label: key('Übersicht') },
  { page: 'wifi', label: key('WLAN') },
  { page: 'leds', label: key('LED-Einstellungen') },
  { page: '2D', label: key('2D-Konfiguration') },
  { page: 'ui-settings', label: key('Oberfläche') },
  { page: 'sync', label: key('Sync-Schnittstellen') },
  { page: 'time', label: key('Zeit & Makros') },
  { page: 'um', label: key('Usermods') },
  { page: 'sec', label: key('Sicherheit & Updates') },
  { page: 'cpal', label: key('Paletten-Editor') },
  { page: 'edit', label: key('Datei-Editor') },
];

const NL_MODES = [key('Sofort'), key('Ausblenden'), key('Farbe überblenden'), key('Sonnenaufgang')];

const STATUS_LABEL = { online: key('Verbunden'), connecting: key('Verbinde …'), offline: key('Offline') } as const;

function formatRemaining(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m}:${String(s).padStart(2, '0')} min` : `${s} s`;
}

function NightlightPopover({ device, state }: { device: DeviceSnapshot; state: WledState }) {
  const nl = state.nl;
  const sendNl = (fields: Record<string, unknown>, key?: string) => send(device.id, { nl: fields }, key);
  const [dur, setDur] = useState(String(nl.dur));
  useEffect(() => setDur(String(nl.dur)), [nl.dur]);
  return (
    <Popover
      trigger={(open, toggle) => (
        <button className={`chip-btn${nl.on ? ' on' : ''}${open ? ' open' : ''}`} onClick={toggle} title={t('Nachtlicht (Timer)')}>
          <Icon name="moon" size={16} />
          {nl.on && nl.rem > 0 ? formatRemaining(nl.rem) : t('Nachtlicht')}
        </button>
      )}
    >
      {() => (
        <div className="pop-form">
          <div className="pop-row">
            <strong>{t('Nachtlicht')}</strong>
            <Toggle checked={nl.on} label={t('Nachtlicht')} onChange={(on) => sendNl({ on })} />
          </div>
          <p className="muted small">{t('Ändert die Helligkeit über die eingestellte Dauer auf den Zielwert.')}</p>
          <label className="field">
            <span>{t('Dauer (Minuten)')}</span>
            <input
              type="number"
              min={1}
              max={255}
              value={dur}
              onChange={(e) => setDur(e.target.value)}
              onBlur={() => {
                const v = Math.min(255, Math.max(1, Math.round(Number(dur) || 1)));
                setDur(String(v));
                if (v !== nl.dur) sendNl({ dur: v });
              }}
            />
          </label>
          <label className="field">
            <span>{t('Modus')}</span>
            <select value={nl.mode} onChange={(e) => sendNl({ mode: Number(e.target.value) })}>
              {NL_MODES.map((m, i) => (
                <option key={m} value={i}>
                  {t(m)}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>{t('Zielhelligkeit · {n} %', { n: Math.round((nl.tbri / 255) * 100) })}</span>
            <Slider value={nl.tbri} label={t('Zielhelligkeit')} onChange={(v) => sendNl({ tbri: v }, 'nl-tbri')} />
          </div>
        </div>
      )}
    </Popover>
  );
}

function SyncPopover({ device, state }: { device: DeviceSnapshot; state: WledState }) {
  const u = state.udpn;
  const sendUdp = (fields: Record<string, unknown>) => send(device.id, { udpn: fields });
  return (
    <Popover
      trigger={(open, toggle) => (
        <button className={`chip-btn${u.send || u.recv ? ' on' : ''}${open ? ' open' : ''}`} onClick={toggle} title="UDP-Sync">
          <Icon name="sync" size={16} />
          Sync
        </button>
      )}
    >
      {() => (
        <div className="pop-form">
          <p className="muted small">{t('Synchronisiert Farben, Effekte und Helligkeit mit anderen WLED-Geräten im Netz (UDP).')}</p>
          <div className="pop-row">
            <span>{t('Senden')}</span>
            <Toggle checked={u.send} label={t('Sync senden')} onChange={(v) => sendUdp({ send: v })} />
          </div>
          <div className="pop-row">
            <span>{t('Empfangen')}</span>
            <Toggle checked={u.recv} label={t('Sync empfangen')} onChange={(v) => sendUdp({ recv: v })} />
          </div>
          {(u.sgrp !== undefined || u.rgrp !== undefined) && (
            <p className="muted small">
              {t('Gruppen: senden {s}, empfangen {r} (ändern unter Einstellungen → Sync)', { s: u.sgrp ?? '–', r: u.rgrp ?? '–' })}
            </p>
          )}
        </div>
      )}
    </Popover>
  );
}

function LiveStrip({ device, live }: { device: DeviceSnapshot; live: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hasFrame, setHasFrame] = useState(false);

  useEffect(() => {
    setHasFrame(false);
    if (!live) return;
    return wled.onLive((id, frame) => {
      if (id !== device.id || !canvas.current) return;
      const offset = frame[1] === 2 ? 4 : 2;
      const n = Math.floor((frame.length - offset) / 3);
      if (n <= 0) return;
      const el = canvas.current;
      if (el.width !== n) {
        el.width = n;
        el.height = 1;
      }
      const ctx = el.getContext('2d');
      if (!ctx) return;
      const img = ctx.createImageData(n, 1);
      for (let i = 0; i < n; i++) {
        img.data[i * 4] = frame[offset + i * 3];
        img.data[i * 4 + 1] = frame[offset + i * 3 + 1];
        img.data[i * 4 + 2] = frame[offset + i * 3 + 2];
        img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      setHasFrame(true);
    });
  }, [device.id, live]);

  // Ohne Live-Daten: die Segmente mit ihrer ersten Farbe.
  const state = device.state;
  const count = device.info?.leds.count || 1;
  let staticBg = 'var(--panel-2)';
  if (state?.on) {
    const stops: string[] = [];
    let pos = 0;
    for (const s of [...state.seg].sort((a, b) => a.start - b.start)) {
      const a = (Math.max(s.start, pos) / count) * 100;
      const b = (Math.min(s.stop, count) / count) * 100;
      if (a > (pos / count) * 100) stops.push(`var(--panel-2) ${(pos / count) * 100}%`, `var(--panel-2) ${a}%`);
      const c = s.on ? displayColor(s.col[0]) : 'var(--panel-2)';
      stops.push(`${c} ${a}%`, `${c} ${b}%`);
      pos = Math.max(pos, s.stop);
    }
    if (stops.length) staticBg = `linear-gradient(90deg, ${stops.join(', ')})`;
  }

  return (
    <div className="live-strip" title={live ? t('Live-Vorschau der LEDs') : t('Segmentfarben (Live-Vorschau ist aus)')}>
      <canvas ref={canvas} style={{ display: hasFrame ? 'block' : 'none' }} />
      {!hasFrame && <div className="static-strip" style={{ background: staticBg }} />}
    </div>
  );
}

export function DeviceView({ device, onEdit }: { device: DeviceSnapshot; onEdit: () => void }) {
  const st = useStatic(device);
  const settings = useSettings();
  const [tab, setTab] = useState<TabId>(() => readLocal<TabId>('wled.tab', 'colors'));
  const [showInfo, setShowInfo] = useState(false);
  useEffect(() => writeLocal('wled.tab', tab), [tab]);

  const { state } = device;
  const online = device.status === 'online';
  const preset = state && st && state.ps > 0 ? st.presets[String(state.ps)] : undefined;
  const playlist = state && st && state.pl > 0 ? st.presets[String(state.pl)] : undefined;

  return (
    <div className="device-view">
      <header className="titlebar drag">
        <h1 className="device-title">{device.name}</h1>
        <span className={`pill status-${device.status}`} title={device.error}>
          {t(STATUS_LABEL[device.status])}
        </span>
        <span className="host">{device.host}</span>
        {(preset || playlist) && (
          <span className="pill preset" title={t('Aktives Preset')}>
            <Icon name={playlist ? 'list' : 'bookmark'} size={12} />
            {playlist ? `${playlist.n ?? t('Playlist {id}', { id: state!.pl })} · ${preset?.n ?? ''}` : preset?.n}
          </span>
        )}
      </header>

      {!state ? (
        <div className="empty">
          <Icon name="wifi" size={40} />
          <h2>{device.status === 'connecting' ? t('Verbinde …') : t('Gerät nicht erreichbar')}</h2>
          <p className="muted">
            {device.status === 'connecting'
              ? t('Verbindung zu {host} wird aufgebaut.', { host: device.host })
              : t('{host} antwortet nicht. Hat der Controller Strom und ist er im Netz? Es wird automatisch weiter versucht.', { host: device.host })}
          </p>
          <button className="btn" onClick={onEdit}>
            <Icon name="edit" size={16} />
            {t('Adresse ändern')}
          </button>
        </div>
      ) : (
        <div className={`device-body${online ? '' : ' stale'}`}>
          {!online && (
            <div className="banner">
              <Icon name="wifi" size={16} />
              {t('Nicht erreichbar — angezeigt werden die letzten bekannten Werte. Es wird automatisch neu verbunden.')}
            </div>
          )}
          <section className="hero">
            <button
              className={`power-btn${state.on ? ' on' : ''}`}
              disabled={!online}
              onClick={() => send(device.id, { on: !state.on })}
              aria-pressed={state.on}
              aria-label={state.on ? t('Ausschalten') : t('Einschalten')}
              title={state.on ? t('Ausschalten') : t('Einschalten')}
            >
              <Icon name="power" size={26} />
            </button>
            <div className="hero-bri">
              <div className="hero-bri-label">
                <Icon name="sun" size={16} />
                {t('Helligkeit')}
                <span className="hero-pct">{state.on ? t('{n} %', { n: pct(state.bri) }) : t('aus')}</span>
              </div>
              <Slider
                variant="big"
                min={1}
                value={state.bri}
                disabled={!online}
                label={t('Helligkeit')}
                onChange={(v) => send(device.id, { bri: v }, 'bri')}
              />
            </div>
          </section>

          <div className="toolbar">
            <NightlightPopover device={device} state={state} />
            <SyncPopover device={device} state={state} />
            <button
              className={`chip-btn${settings.liveView ? ' on' : ''}`}
              onClick={() => void wled.setSettings({ liveView: !settings.liveView })}
              title={t('Live-Vorschau der LEDs')}
            >
              <Icon name="eye" size={16} />
              Live
            </button>
            <CopyLookPopover device={device} state={state} st={st} />
            <button className="chip-btn" onClick={() => setShowInfo(true)} title={t('Geräteinformationen')}>
              <Icon name="info" size={16} />
              Info
            </button>
            <span className="spacer" />
            <button className="chip-btn" onClick={() => wled.openDevicePage(device.id, 'ui')} title={t('Original-Weboberfläche des Geräts öffnen')}>
              <Icon name="globe" size={16} />
              {t('Weboberfläche')}
            </button>
            <Popover
              align="right"
              trigger={(open, toggle) => (
                <button className={`chip-btn${open ? ' open' : ''}`} onClick={toggle} title={t('Geräteeinstellungen (WLED)')}>
                  <Icon name="gear" size={16} />
                  {t('Einstellungen')}
                  <Icon name="chevron" size={14} />
                </button>
              )}
            >
              {(close) => (
                <div className="menu">
                  {PAGES.map((p) => (
                    <button
                      key={p.page}
                      className="menu-item"
                      onClick={() => {
                        close();
                        wled.openDevicePage(device.id, p.page);
                      }}
                    >
                      {t(p.label)}
                    </button>
                  ))}
                  <div className="menu-sep" />
                  <button
                    className="menu-item"
                    onClick={() => {
                      close();
                      onEdit();
                    }}
                  >
                    {t('Name & Adresse in dieser App …')}
                  </button>
                </div>
              )}
            </Popover>
          </div>

          <LiveStrip device={device} live={settings.liveView && online} />

          <nav className="tabs" role="tablist">
            {TABS.map((tb) => (
              <button
                key={tb.id}
                role="tab"
                aria-selected={tab === tb.id}
                className={`tab${tab === tb.id ? ' active' : ''}`}
                data-tab={tb.id}
                onClick={() => setTab(tb.id)}
              >
                <Icon name={tb.icon} size={16} />
                {t(tb.label)}
              </button>
            ))}
          </nav>
          <div className="tab-body" role="tabpanel">
            <ErrorBoundary resetKey={`${device.id}/${tab}`}>
              {tab === 'colors' && <ColorsTab device={device} state={state} st={st} />}
              {tab === 'effects' && <EffectsTab device={device} state={state} st={st} />}
              {tab === 'segments' && <SegmentsTab device={device} state={state} />}
              {tab === 'presets' && <PresetsTab device={device} state={state} st={st} />}
            </ErrorBoundary>
          </div>
        </div>
      )}
      {showInfo && <InfoDialog device={device} onClose={() => setShowInfo(false)} />}
    </div>
  );
}
