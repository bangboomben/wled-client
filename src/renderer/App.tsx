import { useEffect, useRef, useState } from 'react';
import { t } from '../shared/i18n';
import { DeviceView } from './components/DeviceView';
import { GroupView } from './components/GroupView';
import { AddDeviceDialog, AppSettingsDialog, DeviceEditDialog, GroupDialog, ScanProgressBar } from './components/dialogs';
import { Modal, Toasts } from './components/controls';
import { Icon, Logo } from './components/Icon';
import { RoomPlan, type PlanGuard } from './components/RoomPlan';
import { Sidebar } from './components/Sidebar';
import { store, useDevices, useGroups, useScan, wled } from './lib/store';
import { accentFor } from './lib/wled';

type Dialog = { type: 'add' } | { type: 'settings' } | { type: 'edit'; id: string } | { type: 'group'; id?: string } | null;

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
  const groups = useGroups();
  const [selectedId, setSelectedId] = useState<string | undefined>(() => store.settings.selectedId);
  const [groupId, setGroupId] = useState<string | undefined>(() => store.settings.selectedGroupId || undefined);
  const [planOpen, setPlanOpen] = useState<boolean>(() => !!store.settings.planOpen);
  // Rückfrage vor dem Verlassen bei ungespeicherten Änderungen (Bearbeitungsmodus)
  const planGuard = useRef<PlanGuard | null>(null);
  // Für Rückfragen aus Ereignissen (Tray, Tastatur), deren Handler einmal registriert werden.
  const planOpenRef = useRef(planOpen);
  planOpenRef.current = planOpen;
  const [leave, setLeave] = useState<{ go: () => void } | null>(null);
  /** Verlässt den Raumplan erst nach Rückfrage, wenn er ungespeicherte Änderungen hat. */
  const guarded = (go: () => void) => {
    if (planOpenRef.current && planGuard.current?.dirty()) setLeave({ go });
    else go();
  };
  const [dialog, setDialog] = useState<Dialog>(null);
  const selected = devices.find((d) => d.id === selectedId) ?? devices[0];
  const selectedKey = selected?.id;
  const selectedGroup = groupId ? groups.find((g) => g.id === groupId) : undefined;
  // Ein Gerät zu wählen heißt auch, Gruppenansicht und Raumplan zu verlassen.
  const selectDevice = (id: string) =>
    guarded(() => {
      setPlanOpen(false);
      setGroupId(undefined);
      setSelectedId(id);
    });
  const selectGroup = (id: string) =>
    guarded(() => {
      setPlanOpen(false);
      setGroupId(id);
    });
  const openPlan = () => {
    setGroupId(undefined);
    setPlanOpen(true);
  };

  useEffect(() => wled.onSelect((id) => selectDevice(id)), []);

  useEffect(() => {
    wled.setLiveView(selectedGroup || planOpen ? null : (selectedKey ?? null));
    if (!selectedKey || selectedKey === store.settings.selectedId) return;
    const t = window.setTimeout(() => void wled.setSettings({ selectedId: selectedKey }), 400);
    return () => window.clearTimeout(t);
  }, [selectedKey, selectedGroup?.id, planOpen]);

  // Gibt es die gewählte Gruppe nicht mehr (gelöscht), gilt wieder das Gerät.
  useEffect(() => {
    if (groupId && !groups.some((g) => g.id === groupId)) setGroupId(undefined);
  }, [groupId, groups]);

  useEffect(() => {
    if ((groupId ?? '') === (store.settings.selectedGroupId ?? '')) return;
    const timer = window.setTimeout(() => void wled.setSettings({ selectedGroupId: groupId ?? '' }), 400);
    return () => window.clearTimeout(timer);
  }, [groupId]);

  useEffect(() => {
    if (planOpen === !!store.settings.planOpen) return;
    const timer = window.setTimeout(() => void wled.setSettings({ planOpen }), 400);
    return () => window.clearTimeout(timer);
  }, [planOpen]);

  // Strg+1…9 wählt ein Gerät, Strg+↑/↓ blättert.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || isTyping(e.target) || !devices.length) return;
      if (/^[1-9]$/.test(e.key)) {
        const d = devices[Number(e.key) - 1];
        if (d) {
          e.preventDefault();
          selectDevice(d.id);
        }
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const i = Math.max(0, devices.findIndex((d) => d.id === selectedKey));
        const next = devices[(i + (e.key === 'ArrowDown' ? 1 : devices.length - 1)) % devices.length];
        selectDevice(next.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [devices, selectedKey]);

  // Akzentfarbe = aktuelle Farbe des gewählten Geräts. Sie sitzt am Wurzelelement, damit
  // die abgeleiteten Töne (--accent-soft) mitziehen und auch Dialoge sie erben.
  const accent = accentFor(selectedGroup || planOpen ? undefined : selected);
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--accent', accent.accent);
    root.setProperty('--accent-contrast', accent.contrast);
  }, [accent.accent, accent.contrast]);

  const editDevice = dialog?.type === 'edit' ? devices.find((d) => d.id === dialog.id) : undefined;
  const editGroup = dialog?.type === 'group' && dialog.id ? groups.find((g) => g.id === dialog.id) : undefined;
  // Eine Gruppe, die es nicht mehr gibt (eben gelöscht), öffnet keinen leeren Dialog.
  const groupDialogOpen = dialog?.type === 'group' && (!dialog.id || !!editGroup);

  return (
    <div className="app">
      <Sidebar
        devices={devices}
        groups={groups}
        selectedId={selectedGroup || planOpen ? undefined : selectedKey}
        onSelect={selectDevice}
        selectedGroupId={planOpen ? undefined : selectedGroup?.id}
        onSelectGroup={selectGroup}
        planOpen={planOpen}
        onOpenPlan={openPlan}
        onAdd={() => setDialog({ type: 'add' })}
        onAddGroup={() => setDialog({ type: 'group' })}
        onSettings={() => setDialog({ type: 'settings' })}
        onEdit={(id) => setDialog({ type: 'edit', id })}
        onEditGroup={(id) => setDialog({ type: 'group', id })}
      />
      <main className="main">
        {planOpen && devices.length > 0 ? (
          <RoomPlan devices={devices} onOpen={selectDevice} guard={planGuard} />
        ) : selectedGroup ? (
          <GroupView
            key={selectedGroup.id}
            group={selectedGroup}
            devices={devices}
            onEdit={() => setDialog({ type: 'group', id: selectedGroup.id })}
            onOpen={selectDevice}
          />
        ) : selected ? (
          <DeviceView key={selected.id} device={selected} onEdit={() => setDialog({ type: 'edit', id: selected.id })} />
        ) : (
          <Welcome onAdd={() => setDialog({ type: 'add' })} />
        )}
      </main>
      {dialog?.type === 'add' && <AddDeviceDialog onClose={() => setDialog(null)} onAdded={(id) => selectDevice(id)} />}
      {editDevice && <DeviceEditDialog device={editDevice} onClose={() => setDialog(null)} />}
      {dialog?.type === 'settings' && <AppSettingsDialog onClose={() => setDialog(null)} />}
      {groupDialogOpen && <GroupDialog group={editGroup} devices={devices} onClose={() => setDialog(null)} />}
      {leave && (
        <Modal
          title={t('Änderungen speichern?')}
          width={420}
          onClose={() => setLeave(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setLeave(null)}>
                {t('Abbrechen')}
              </button>
              <button
                className="btn"
                onClick={() => {
                  planGuard.current?.discard();
                  setLeave(null);
                  leave.go();
                }}
              >
                {t('Verwerfen')}
              </button>
              <button
                className="btn primary"
                onClick={async () => {
                  // Scheitert das Speichern (die Meldung kommt vom Plan), bleibt die Bearbeitung offen und die Rückfrage schließt
                  const saved = await planGuard.current?.save();
                  setLeave(null);
                  if (saved !== false) leave.go();
                }}
              >
                {t('Speichern')}
              </button>
            </>
          }
        >
          <p>{t('Der Raumplan hat ungespeicherte Änderungen.')}</p>
        </Modal>
      )}
      <Toasts />
    </div>
  );
}
