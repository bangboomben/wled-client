import { useEffect, useState, type ReactNode } from 'react';
import { key, t } from '../../shared/i18n';
import type { DeviceSnapshot, LanguageSetting, ThemeMode, UpdateState } from '../../shared/types';
import { store, useDevices, useScan, useSettings, useUpdate, wled } from '../lib/store';
import { formatUptime } from '../lib/wled';
import { Modal, Toggle, toast } from './controls';
import { Icon } from './Icon';

// ------------------------------------------------------------------ Gerät hinzufügen

/** Fortschritt der Suche: bei der Adresssuche anteilig, sonst durchlaufend. */
export function ScanProgressBar({ wide }: { wide?: boolean }) {
  const scan = useScan();
  const sweep = scan.mode === 'sweep' && scan.total > 0;
  return (
    <div className={`progress${wide ? ' wide' : ''}${sweep ? '' : ' indeterminate'}`} aria-label={t('Suchfortschritt')}>
      <span style={sweep ? { width: `${(scan.done / scan.total) * 100}%` } : undefined} />
    </div>
  );
}

export function AddDeviceDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const devices = useDevices();
  const scan = useScan();
  const [host, setHost] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState('');
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    if (!store.scan.running) void wled.discover();
    void wled.localSubnets().then((s) => setTargets((prev) => prev || s.join(', ')));
  }, []);

  const isKnown = (h: string, mac: string) => devices.some((d) => d.host === h || (d.info?.mac && d.info.mac === mac));

  const add = async (h: string) => {
    setError('');
    setBusy(true);
    setAdding(h);
    const r = await wled.addDevice(h);
    setBusy(false);
    setAdding(null);
    if (!r.ok) {
      setError(r.error ?? t('Hinzufügen fehlgeschlagen'));
      return false;
    }
    if (r.id) onAdded(r.id);
    return true;
  };

  const fresh = scan.found.filter((r) => !isKnown(r.host, r.mac));
  const foundText = scan.found.length === 1 ? t('1 WLED-Gerät gefunden') : t('{n} WLED-Geräte gefunden', { n: scan.found.length });
  const scanStatus =
    scan.mode === 'sweep' && scan.total > 0
      ? `${scan.running ? t('{done} von {total} Adressen geprüft', { done: scan.done, total: scan.total }) : t('Fertig: {total} Adressen geprüft', { total: scan.total })} · ${foundText}`
      : scan.running
        ? `${t('Suche läuft …')} · ${foundText}`
        : foundText;

  return (
    <Modal title={t('Gerät hinzufügen')} onClose={onClose} width={580}>
      <section className="form-section">
        <h3>{t('Per Adresse')}</h3>
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await add(host)) {
              toast(t('{host} hinzugefügt', { host: host.trim() }));
              setHost('');
            }
          }}
        >
          <input
            value={host}
            autoFocus
            placeholder={t('IP-Adresse oder Hostname, z. B. 192.168.1.50')}
            spellCheck={false}
            onChange={(e) => setHost(e.target.value)}
          />
          <button className="btn primary" disabled={busy || !host.trim()}>
            {busy && adding === host ? t('Prüfe …') : t('Hinzufügen')}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="form-section">
        <h3>{t('Im Netzwerk suchen')}</h3>
        <p className="muted small">{t('Findet WLED-Geräte, die sich im Netzwerk melden (mDNS und WLED-Knotenliste).')}</p>
        <div className="scan-bar">
          {scan.running && scan.mode === 'discover' ? (
            <button className="btn" onClick={() => wled.cancelScan()}>
              {t('Abbrechen')}
            </button>
          ) : (
            <button className="btn discover-btn" disabled={scan.running} onClick={() => void wled.discover()}>
              <Icon name="search" size={15} />
              {t('Erneut suchen')}
            </button>
          )}
          <span className="muted small scan-status">{scanStatus}</span>
        </div>
        {scan.running && <ScanProgressBar />}
        <div className="scan-results">
          {scan.found.map((r) => {
            const known = isKnown(r.host, r.mac);
            return (
              <div className="scan-row" key={r.mac}>
                <div className="scan-text">
                  <strong>{r.name}</strong>
                  <span className="muted small">
                    {r.host} · {r.leds} LEDs · WLED {r.ver}
                  </span>
                </div>
                {known ? (
                  <span className="pill">{t('vorhanden')}</span>
                ) : (
                  <button className="btn small" disabled={busy} onClick={() => void add(r.host)}>
                    {adding === r.host ? '…' : t('Hinzufügen')}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {fresh.length > 1 && (
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              for (const r of fresh) await add(r.host);
              toast(t('{n} Geräte hinzugefügt', { n: fresh.length }));
            }}
          >
            {t('Alle {n} hinzufügen', { n: fresh.length })}
          </button>
        )}
        <details className="sweep">
          <summary>{t('Gerät nicht dabei? Adressbereich durchsuchen')}</summary>
          <p className="muted small">
            {t('Fragt jede Adresse der angegebenen Netze einzeln nach WLED — für Geräte, die sich nicht melden, etwa hinter einem VPN. Mehrere Netze mit Komma trennen (Schreibweise 192.168.2.0/24, höchstens /22).')}
          </p>
          <div className="inline-form">
            <input value={targets} spellCheck={false} onChange={(e) => setTargets(e.target.value)} aria-label={t('Netze für die Suche')} />
            {scan.running && scan.mode === 'sweep' ? (
              <button className="btn" onClick={() => wled.cancelScan()}>
                {t('Abbrechen')}
              </button>
            ) : (
              <button
                className="btn sweep-btn"
                disabled={scan.running || !targets.trim()}
                onClick={() => void wled.scan(targets.split(/[\s,;]+/).filter(Boolean))}
              >
                {t('Durchsuchen')}
              </button>
            )}
          </div>
        </details>
      </section>
    </Modal>
  );
}

// ------------------------------------------------------------------ Gerät bearbeiten

export function DeviceEditDialog({ device, onClose }: { device: DeviceSnapshot; onClose: () => void }) {
  const [alias, setAlias] = useState(device.alias ?? '');
  const [host, setHost] = useState(device.host);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const r = await wled.updateDevice(device.id, { alias, host });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? t('Speichern fehlgeschlagen'));
    onClose();
  };

  const remove = async () => {
    if (!window.confirm(t('„{name}“ aus der App entfernen? Am Gerät selbst ändert sich nichts.', { name: device.name }))) return;
    await wled.removeDevice(device.id);
    onClose();
  };

  return (
    <Modal
      title={t('Gerät bearbeiten')}
      onClose={onClose}
      width={480}
      footer={
        <>
          <button className="btn danger" onClick={remove}>
            <Icon name="trash" size={15} />
            {t('Entfernen')}
          </button>
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            {t('Abbrechen')}
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {t('Speichern')}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{t('Anzeigename in dieser App')}</span>
        <input value={alias} autoFocus placeholder={device.info?.name ?? device.name} onChange={(e) => setAlias(e.target.value)} />
      </label>
      <p className="muted small">{t('Leer lassen, um den Namen vom Gerät zu übernehmen. Den Gerätenamen selbst änderst du unter Einstellungen → Oberfläche.')}</p>
      <label className="field">
        <span>{t('Adresse')}</span>
        <input value={host} spellCheck={false} onChange={(e) => setHost(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

// ------------------------------------------------------------------ Info

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{t(label)}</dt>
      <dd>{children}</dd>
    </>
  );
}

export function InfoDialog({ device, onClose }: { device: DeviceSnapshot; onClose: () => void }) {
  const i = device.info;
  if (!i) return null;
  const usermods = Object.keys(i.u ?? {});
  const fs = i.fs;
  const reboot = async () => {
    if (!window.confirm(t('„{name}“ jetzt neu starten?', { name: device.name }))) return;
    const r = await wled.command(device.id, { rb: true });
    toast(r.ok ? t('Neustart ausgelöst') : (r.error ?? t('Neustart fehlgeschlagen')));
    onClose();
  };
  return (
    <Modal
      title={device.name}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn danger" onClick={reboot}>
            <Icon name="reboot" size={15} />
            {t('Neu starten')}
          </button>
          <button className="btn ghost" onClick={() => wled.openDevicePage(device.id, 'update')}>
            <Icon name="upload" size={15} />
            {t('Firmware-Update')}
          </button>
          <span className="spacer" />
          <button
            className="btn ghost"
            onClick={() => {
              void wled.refresh(device.id);
              toast(t('Gerätedaten werden neu geladen'));
            }}
          >
            <Icon name="refresh" size={15} />
            {t('Neu laden')}
          </button>
        </>
      }
    >
      <dl className="info-grid">
        <Row label={key('Gerätename')}>{i.name}</Row>
        <Row label={key('Version')}>
          WLED {i.ver} <span className="muted">({i.vid})</span>
        </Row>
        <Row label={key('Build')}>{[i.brand, i.product, i.release].filter(Boolean).join(' · ') || '–'}</Row>
        <Row label={key('Plattform')}>{[i.arch, i.core].filter(Boolean).join(' · ') || '–'}</Row>
        <Row label={key('LEDs')}>
          {i.leds.count}
          {i.leds.rgbw ? ' · RGBW' : ' · RGB'}
          {i.leds.matrix ? ` · ${t('Matrix {w}×{h}', { w: i.leds.matrix.w, h: i.leds.matrix.h })}` : ''}
        </Row>
        <Row label={key('Strom (Schätzung)')}>
          {i.leds.pwr !== undefined ? `${(i.leds.pwr / 1000).toFixed(2)} A` : '–'}
          {i.leds.maxpwr ? ` ${t('von max. {a} A', { a: (i.leds.maxpwr / 1000).toFixed(1) })}` : ''}
        </Row>
        <Row label={key('Bildrate')}>{i.leds.fps !== undefined ? `${i.leds.fps} fps` : '–'}</Row>
        <Row label={key('WLAN')}>
          {i.wifi?.signal !== undefined ? `${i.wifi.signal} %` : '–'}
          {i.wifi?.rssi !== undefined ? ` (${i.wifi.rssi} dBm)` : ''}
          {i.wifi?.channel ? ` · ${t('Kanal {n}', { n: i.wifi.channel })}` : ''}
        </Row>
        <Row label={key('IP / Adresse')}>{i.ip || device.host}</Row>
        <Row label={key('MAC')}>{i.mac?.match(/.{1,2}/g)?.join(':') ?? '–'}</Row>
        <Row label={key('Laufzeit')}>{formatUptime(i.uptime)}</Row>
        <Row label={key('Freier Speicher')}>{i.freeheap ? `${Math.round(i.freeheap / 1024)} KB` : '–'}</Row>
        <Row label={key('Dateisystem')}>{fs ? t('{used} von {total} KB belegt', { used: fs.u, total: fs.t }) : '–'}</Row>
        <Row label={key('Live-Daten')}>{i.live ? `${t('aktiv')}${i.lm ? ` · ${i.lm}` : ''}${i.lip ? ` ${t('von {ip}', { ip: i.lip })}` : ''}` : t('nein')}</Row>
        {usermods.length > 0 && <Row label={key('Usermods')}>{usermods.join(', ')}</Row>}
      </dl>
    </Modal>
  );
}

// ------------------------------------------------------------------ App-Einstellungen

export function AppSettingsDialog({ onClose }: { onClose: () => void }) {
  const s = useSettings();
  const set = (patch: Parameters<typeof wled.setSettings>[0]) => void wled.setSettings(patch);
  const themes: Array<[ThemeMode, string]> = [
    ['system', t('Wie Windows')],
    ['dark', t('Dunkel')],
    ['light', t('Hell')],
  ];
  // Sprachnamen stehen immer in ihrer eigenen Sprache.
  const languages: Array<[LanguageSetting, string]> = [
    ['system', t('Wie Windows')],
    ['de', 'Deutsch'],
    ['en', 'English'],
  ];
  return (
    <Modal
      title={t('App-Einstellungen')}
      onClose={onClose}
      width={480}
      footer={
        <>
          <span className="muted small">WLED Client {store.version}</span>
          <span className="spacer" />
          <button className="btn ghost" onClick={() => wled.quit()}>
            <Icon name="power" size={15} />
            {t('Beenden')}
          </button>
        </>
      }
    >
      <div className="field">
        <span>{t('Darstellung')}</span>
        <div className="seg-switch" role="radiogroup">
          {themes.map(([id, label]) => (
            <button key={id} role="radio" aria-checked={s.theme === id} className={s.theme === id ? 'on' : ''} onClick={() => set({ theme: id })}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span>{t('Sprache')}</span>
        <div className="seg-switch" role="radiogroup">
          {languages.map(([id, label]) => (
            <button key={id} role="radio" aria-checked={s.language === id} className={s.language === id ? 'on' : ''} onClick={() => set({ language: id })}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <div>
          <strong>{t('Beim Schließen im Infobereich weiterlaufen')}</strong>
          <p className="muted small">{t('Das Tray-Symbol bietet Ein/Aus und Helligkeit für alle Geräte.')}</p>
        </div>
        <Toggle checked={s.closeToTray} label={t('Im Infobereich weiterlaufen')} onChange={(v) => set({ closeToTray: v })} />
      </div>
      <div className="setting-row">
        <div>
          <strong>{t('Mit Windows starten')}</strong>
          <p className="muted small">{t('Startet unsichtbar im Infobereich.')}</p>
        </div>
        <Toggle checked={s.startWithWindows} label={t('Mit Windows starten')} onChange={(v) => set({ startWithWindows: v })} />
      </div>
      <div className="setting-row">
        <div>
          <strong>{t('Live-Vorschau')}</strong>
          <p className="muted small">{t('Zeigt die echten LED-Farben des gewählten Geräts. Die Weboberfläche kann sie nur für ein Programm gleichzeitig liefern.')}</p>
        </div>
        <Toggle checked={s.liveView} label={t('Live-Vorschau')} onChange={(v) => set({ liveView: v })} />
      </div>
      <UpdateSettings autoUpdate={s.autoUpdate} onAutoUpdate={(v) => set({ autoUpdate: v })} />
    </Modal>
  );
}

function updateText(u: UpdateState): string {
  switch (u.status) {
    case 'unsupported':
      return t('Updates gibt es nur in der installierten App.');
    case 'checking':
      return t('Suche nach Updates …');
    case 'latest':
      return t('Version {current} ist aktuell.', { current: u.current });
    case 'downloading':
      return t('Lade Version {version} … {progress} %', { version: u.version ?? '', progress: u.progress ?? 0 });
    case 'ready':
      return t('Version {version} ist bereit und wird beim nächsten Beenden installiert.', { version: u.version ?? '' });
    case 'error':
      return t('Update-Prüfung fehlgeschlagen: {error}', { error: u.error ?? '' });
    default:
      return t('Installiert: Version {current}', { current: u.current });
  }
}

function UpdateSettings({ autoUpdate, onAutoUpdate }: { autoUpdate: boolean; onAutoUpdate: (v: boolean) => void }) {
  const u = useUpdate();
  const supported = u.status !== 'unsupported';
  return (
    <div className="setting-row update-row">
      <div>
        <strong>{t('Automatisch nach Updates suchen')}</strong>
        <p className="muted small">{updateText(u)}</p>
        {supported && (
          <div className="row-actions">
            {u.status === 'ready' ? (
              <button className="btn primary small" onClick={() => wled.installUpdate()}>
                <Icon name="refresh" size={14} />
                {t('Neu starten und aktualisieren')}
              </button>
            ) : (
              <button className="btn small" disabled={u.status === 'checking' || u.status === 'downloading'} onClick={() => wled.checkForUpdates()}>
                <Icon name="search" size={14} />
                {t('Jetzt prüfen')}
              </button>
            )}
          </div>
        )}
      </div>
      <Toggle checked={autoUpdate} disabled={!supported} label={t('Automatisch nach Updates suchen')} onChange={onAutoUpdate} />
    </div>
  );
}
