import { useEffect, useState } from 'react';
import { t } from '../shared/i18n';
import { DeviceView } from './components/DeviceView';
import { AddDeviceDialog, AppSettingsDialog, DeviceEditDialog, ScanProgressBar } from './components/dialogs';
import { Toasts } from './components/controls';
import { Icon, Logo } from './components/Icon';
import { Sidebar } from './components/Sidebar';
import { store, useDevices, useScan, wled } from './lib/store';
import { accentFor } from './lib/wled';

type Dialog = { type: 'add' } | { type: 'settings' } | { type: 'edit'; id: string } | null;

function Welcome({ onAdd }: { onAdd: () => void }) {
  const scan = useScan();
  return (
    <div className="device-view">
      <header className="titlebar drag" />
      <div className="empty">
        <Logo size={64} />
        {scan.running ? (
          <>
            <h2>{t('Suche WLED-Geräte im Netzwerk …')}</h2>
            <p className="muted">
              {scan.mode === 'sweep'
                ? t('{done} von {total} Adressen geprüft · {found} gefunden', { done: scan.done, total: scan.total, found: scan.found.length })
                : scan.found.length === 1
                  ? t('1 WLED-Gerät gefunden')
                  : t('{n} WLED-Geräte gefunden', { n: scan.found.length })}
            </p>
            <ScanProgressBar wide />
          </>
        ) : (
          <>
            <h2>{t('Noch keine Geräte')}</h2>
            <p className="muted">{t('Füge dein erstes WLED-Gerät hinzu — per Adresse oder über die Netzwerksuche.')}</p>
            <button className="btn primary" onClick={onAdd}>
              <Icon name="plus" size={16} />
              {t('Gerät hinzufügen')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;

export function App() {
  const devices = useDevices();
  const [selectedId, setSelectedId] = useState<string | undefined>(() => store.settings.selectedId);
  const [dialog, setDialog] = useState<Dialog>(null);
  const selected = devices.find((d) => d.id === selectedId) ?? devices[0];
  const selectedKey = selected?.id;

  useEffect(() => wled.onSelect((id) => setSelectedId(id)), []);

  useEffect(() => {
    wled.setLiveView(selectedKey ?? null);
    if (!selectedKey || selectedKey === store.settings.selectedId) return;
    const t = window.setTimeout(() => void wled.setSettings({ selectedId: selectedKey }), 400);
    return () => window.clearTimeout(t);
  }, [selectedKey]);

  // Strg+1…9 wählt ein Gerät, Strg+↑/↓ blättert.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || isTyping(e.target) || !devices.length) return;
      if (/^[1-9]$/.test(e.key)) {
        const d = devices[Number(e.key) - 1];
        if (d) {
          e.preventDefault();
          setSelectedId(d.id);
        }
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const i = Math.max(0, devices.findIndex((d) => d.id === selectedKey));
        const next = devices[(i + (e.key === 'ArrowDown' ? 1 : devices.length - 1)) % devices.length];
        setSelectedId(next.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [devices, selectedKey]);

  // Akzentfarbe = aktuelle Farbe des gewählten Geräts. Sie sitzt am Wurzelelement, damit
  // die abgeleiteten Töne (--accent-soft) mitziehen und auch Dialoge sie erben.
  const accent = accentFor(selected);
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--accent', accent.accent);
    root.setProperty('--accent-contrast', accent.contrast);
  }, [accent.accent, accent.contrast]);

  const editDevice = dialog?.type === 'edit' ? devices.find((d) => d.id === dialog.id) : undefined;

  return (
    <div className="app">
      <Sidebar
        devices={devices}
        selectedId={selectedKey}
        onSelect={setSelectedId}
        onAdd={() => setDialog({ type: 'add' })}
        onSettings={() => setDialog({ type: 'settings' })}
        onEdit={(id) => setDialog({ type: 'edit', id })}
      />
      <main className="main">
        {selected ? (
          <DeviceView key={selected.id} device={selected} onEdit={() => setDialog({ type: 'edit', id: selected.id })} />
        ) : (
          <Welcome onAdd={() => setDialog({ type: 'add' })} />
        )}
      </main>
      {dialog?.type === 'add' && <AddDeviceDialog onClose={() => setDialog(null)} onAdded={(id) => setSelectedId(id)} />}
      {editDevice && <DeviceEditDialog device={editDevice} onClose={() => setDialog(null)} />}
      {dialog?.type === 'settings' && <AppSettingsDialog onClose={() => setDialog(null)} />}
      <Toasts />
    </div>
  );
}
