import { useEffect, useState, type ReactNode } from 'react';
import type { DeviceSnapshot, ThemeMode } from '../../shared/types';
import { store, useDevices, useScan, useSettings, wled } from '../lib/store';
import { formatUptime } from '../lib/wled';
import { Modal, Toggle, toast } from './controls';
import { Icon } from './Icon';

// ------------------------------------------------------------------ Gerät hinzufügen

export function AddDeviceDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const devices = useDevices();
  const scan = useScan();
  const [host, setHost] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState('');
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
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
      setError(r.error ?? 'Hinzufügen fehlgeschlagen');
      return false;
    }
    if (r.id) onAdded(r.id);
    return true;
  };

  const fresh = scan.found.filter((r) => !isKnown(r.host, r.mac));

  return (
    <Modal title="Gerät hinzufügen" onClose={onClose} width={580}>
      <section className="form-section">
        <h3>Per Adresse</h3>
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await add(host)) {
              toast(`${host.trim()} hinzugefügt`);
              setHost('');
            }
          }}
        >
          <input
            value={host}
            autoFocus
            placeholder="IP-Adresse oder Hostname, z. B. 192.168.1.50"
            spellCheck={false}
            onChange={(e) => setHost(e.target.value)}
          />
          <button className="btn primary" disabled={busy || !host.trim()}>
            {busy && adding === host ? 'Prüfe …' : 'Hinzufügen'}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="form-section">
        <h3>Im Netzwerk suchen</h3>
        <p className="muted small">
          Fragt jede Adresse der angegebenen Netze nach WLED. Andere Netze, etwa über VPN, mit Komma ergänzen
          (Schreibweise 192.168.2.0/24).
        </p>
        <div className="inline-form">
          <input value={targets} spellCheck={false} onChange={(e) => setTargets(e.target.value)} aria-label="Netze für die Suche" />
          {scan.running ? (
            <button className="btn" onClick={() => wled.cancelScan()}>
              Abbrechen
            </button>
          ) : (
            <button className="btn" disabled={!targets.trim()} onClick={() => void wled.scan(targets.split(/[\s,;]+/).filter(Boolean))}>
              <Icon name="search" size={15} />
              Suchen
            </button>
          )}
        </div>
        {scan.total > 0 && (
          <div className="progress" aria-label="Suchfortschritt">
            <span style={{ width: `${(scan.done / scan.total) * 100}%` }} />
          </div>
        )}
        {scan.total > 0 && (
          <p className="muted small">
            {scan.running ? `${scan.done} von ${scan.total} Adressen geprüft` : `Fertig: ${scan.total} Adressen geprüft`} ·{' '}
            {scan.found.length} WLED-Gerät{scan.found.length === 1 ? '' : 'e'} gefunden
          </p>
        )}
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
                  <span className="pill">vorhanden</span>
                ) : (
                  <button className="btn small" disabled={busy} onClick={() => void add(r.host)}>
                    {adding === r.host ? '…' : 'Hinzufügen'}
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
              toast(`${fresh.length} Geräte hinzugefügt`);
            }}
          >
            Alle {fresh.length} hinzufügen
          </button>
        )}
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
    if (!r.ok) return setError(r.error ?? 'Speichern fehlgeschlagen');
    onClose();
  };

  const remove = async () => {
    if (!window.confirm(`„${device.name}“ aus der App entfernen? Am Gerät selbst ändert sich nichts.`)) return;
    await wled.removeDevice(device.id);
    onClose();
  };

  return (
    <Modal
      title="Gerät bearbeiten"
      onClose={onClose}
      width={480}
      footer={
        <>
          <button className="btn danger" onClick={remove}>
            <Icon name="trash" size={15} />
            Entfernen
          </button>
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            Speichern
          </button>
        </>
      }
    >
      <label className="field">
        <span>Anzeigename in dieser App</span>
        <input value={alias} autoFocus placeholder={device.info?.name ?? device.name} onChange={(e) => setAlias(e.target.value)} />
      </label>
      <p className="muted small">Leer lassen, um den Namen vom Gerät zu übernehmen. Den Gerätenamen selbst änderst du unter Einstellungen → Oberfläche.</p>
      <label className="field">
        <span>Adresse</span>
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
      <dt>{label}</dt>
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
    if (!window.confirm(`„${device.name}“ jetzt neu starten?`)) return;
    const r = await wled.command(device.id, { rb: true });
    toast(r.ok ? 'Neustart ausgelöst' : (r.error ?? 'Neustart fehlgeschlagen'));
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
            Neu starten
          </button>
          <button className="btn ghost" onClick={() => wled.openDevicePage(device.id, 'update')}>
            <Icon name="upload" size={15} />
            Firmware-Update
          </button>
          <span className="spacer" />
          <button
            className="btn ghost"
            onClick={() => {
              void wled.refresh(device.id);
              toast('Gerätedaten werden neu geladen');
            }}
          >
            <Icon name="refresh" size={15} />
            Neu laden
          </button>
        </>
      }
    >
      <dl className="info-grid">
        <Row label="Gerätename">{i.name}</Row>
        <Row label="Version">
          WLED {i.ver} <span className="muted">({i.vid})</span>
        </Row>
        <Row label="Build">{[i.brand, i.product, i.release].filter(Boolean).join(' · ') || '–'}</Row>
        <Row label="Plattform">{[i.arch, i.core].filter(Boolean).join(' · ') || '–'}</Row>
        <Row label="LEDs">
          {i.leds.count}
          {i.leds.rgbw ? ' · RGBW' : ' · RGB'}
          {i.leds.matrix ? ` · Matrix ${i.leds.matrix.w}×${i.leds.matrix.h}` : ''}
        </Row>
        <Row label="Strom (Schätzung)">
          {i.leds.pwr !== undefined ? `${(i.leds.pwr / 1000).toFixed(2)} A` : '–'}
          {i.leds.maxpwr ? ` von max. ${(i.leds.maxpwr / 1000).toFixed(1)} A` : ''}
        </Row>
        <Row label="Bildrate">{i.leds.fps !== undefined ? `${i.leds.fps} fps` : '–'}</Row>
        <Row label="WLAN">
          {i.wifi?.signal !== undefined ? `${i.wifi.signal} %` : '–'}
          {i.wifi?.rssi !== undefined ? ` (${i.wifi.rssi} dBm)` : ''}
          {i.wifi?.channel ? ` · Kanal ${i.wifi.channel}` : ''}
        </Row>
        <Row label="IP / Adresse">{i.ip || device.host}</Row>
        <Row label="MAC">{i.mac?.match(/.{1,2}/g)?.join(':') ?? '–'}</Row>
        <Row label="Laufzeit">{formatUptime(i.uptime)}</Row>
        <Row label="Freier Speicher">{i.freeheap ? `${Math.round(i.freeheap / 1024)} KB` : '–'}</Row>
        <Row label="Dateisystem">{fs ? `${fs.u} von ${fs.t} KB belegt` : '–'}</Row>
        <Row label="Live-Daten">{i.live ? `aktiv${i.lm ? ` · ${i.lm}` : ''}${i.lip ? ` von ${i.lip}` : ''}` : 'nein'}</Row>
        {usermods.length > 0 && <Row label="Usermods">{usermods.join(', ')}</Row>}
      </dl>
    </Modal>
  );
}

// ------------------------------------------------------------------ App-Einstellungen

export function AppSettingsDialog({ onClose }: { onClose: () => void }) {
  const s = useSettings();
  const set = (patch: Parameters<typeof wled.setSettings>[0]) => void wled.setSettings(patch);
  const themes: Array<[ThemeMode, string]> = [
    ['system', 'Wie Windows'],
    ['dark', 'Dunkel'],
    ['light', 'Hell'],
  ];
  return (
    <Modal
      title="App-Einstellungen"
      onClose={onClose}
      width={480}
      footer={
        <>
          <span className="muted small">WLED Client {store.version}</span>
          <span className="spacer" />
          <button className="btn ghost" onClick={() => wled.quit()}>
            <Icon name="power" size={15} />
            Beenden
          </button>
        </>
      }
    >
      <div className="field">
        <span>Darstellung</span>
        <div className="seg-switch" role="radiogroup">
          {themes.map(([id, label]) => (
            <button key={id} role="radio" aria-checked={s.theme === id} className={s.theme === id ? 'on' : ''} onClick={() => set({ theme: id })}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <div>
          <strong>Beim Schließen im Infobereich weiterlaufen</strong>
          <p className="muted small">Das Tray-Symbol bietet Ein/Aus und Helligkeit für alle Geräte.</p>
        </div>
        <Toggle checked={s.closeToTray} label="Im Infobereich weiterlaufen" onChange={(v) => set({ closeToTray: v })} />
      </div>
      <div className="setting-row">
        <div>
          <strong>Mit Windows starten</strong>
          <p className="muted small">Startet unsichtbar im Infobereich.</p>
        </div>
        <Toggle checked={s.startWithWindows} label="Mit Windows starten" onChange={(v) => set({ startWithWindows: v })} />
      </div>
      <div className="setting-row">
        <div>
          <strong>Live-Vorschau</strong>
          <p className="muted small">Zeigt die echten LED-Farben des gewählten Geräts. Die Weboberfläche kann sie nur für ein Programm gleichzeitig liefern.</p>
        </div>
        <Toggle checked={s.liveView} label="Live-Vorschau" onChange={(v) => set({ liveView: v })} />
      </div>
    </Modal>
  );
}
