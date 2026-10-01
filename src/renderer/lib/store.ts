import { useEffect, useState, useSyncExternalStore } from 'react';
import { applyStatePatch } from '../../shared/merge';
import type { AppSettings, DeviceSnapshot, DeviceStatic, PalxEntry, ScanProgress, WledBridge } from '../../shared/types';

declare global {
  interface Window {
    wled: WledBridge;
  }
}

export const wled = window.wled;

type Listener = () => void;

class AppStore {
  devices: DeviceSnapshot[] = [];
  settings: AppSettings = { closeToTray: true, startWithWindows: false, liveView: false, theme: 'system' };
  scan: ScanProgress = { running: false, done: 0, total: 0, found: [] };
  version = '';
  ready = false;
  private listeners = new Set<Listener>();

  async init(): Promise<void> {
    const snap = await wled.getSnapshot();
    this.devices = snap.devices;
    this.settings = snap.settings;
    this.version = snap.version;
    this.ready = true;
    wled.onDevices((list) => {
      this.devices = list;
      this.emit();
    });
    wled.onDevice((d) => {
      const i = this.devices.findIndex((x) => x.id === d.id);
      if (i < 0) return;
      const next = this.devices.slice();
      next[i] = d;
      this.devices = next;
      this.emit();
    });
    wled.onSettings((s) => {
      this.settings = s;
      this.emit();
    });
    wled.onScan((p) => {
      this.scan = p;
      this.emit();
    });
    this.emit();
  }

  /** Übernimmt eine Änderung sofort in die Anzeige; der Hauptprozess bestätigt sie danach. */
  applyLocal(ids: string[], patch: Record<string, unknown>): void {
    let changed = false;
    const next = this.devices.map((d) => {
      if (!ids.includes(d.id) || !d.state || d.status !== 'online') return d;
      changed = true;
      return { ...d, state: applyStatePatch(d.state, patch) };
    });
    if (!changed) return;
    this.devices = next;
    this.emit();
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

export const store = new AppStore();

/** Befehl an ein Gerät. `key` fasst schnelle Folgen zusammen (Regler ziehen). */
export function send(id: string, patch: Record<string, unknown>, key?: string): void {
  store.applyLocal([id], patch);
  wled.send(id, patch, key);
}

export function sendAll(patch: Record<string, unknown>): void {
  store.applyLocal(
    store.devices.map((d) => d.id),
    patch,
  );
  wled.sendAll(patch);
}

export const useDevices = () => useSyncExternalStore(store.subscribe, () => store.devices);
export const useSettings = () => useSyncExternalStore(store.subscribe, () => store.settings);
export const useScan = () => useSyncExternalStore(store.subscribe, () => store.scan);
export const useReady = () => useSyncExternalStore(store.subscribe, () => store.ready);

// Statische Gerätedaten (Effekte, Paletten, Presets) — zwischengespeichert pro Revision.
const staticCache = new Map<string, { rev: number; data: DeviceStatic }>();

export function useStatic(device: DeviceSnapshot | undefined): DeviceStatic | null {
  const id = device?.id;
  const rev = device?.staticRev ?? -1;
  const cached = id ? staticCache.get(id) : undefined;
  const [, force] = useState(0);
  useEffect(() => {
    if (!id || rev < 1) return;
    if (staticCache.get(id)?.rev === rev) return;
    let cancelled = false;
    void wled.getStatic(id).then((data) => {
      if (cancelled || !data) return;
      staticCache.set(id, { rev, data });
      force((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [id, rev]);
  return cached?.data ?? null;
}

const palxCache = new Map<string, { rev: number; data: Record<string, PalxEntry> }>();

export function usePalx(device: DeviceSnapshot | undefined, enabled: boolean): Record<string, PalxEntry> | null {
  const id = device?.id;
  const rev = device?.staticRev ?? -1;
  const cached = id ? palxCache.get(id) : undefined;
  const [, force] = useState(0);
  useEffect(() => {
    if (!enabled || !id || rev < 1) return;
    if (palxCache.get(id)?.rev === rev) return;
    let cancelled = false;
    void wled.loadPalettes(id).then((data) => {
      if (cancelled || !data) return;
      palxCache.set(id, { rev, data });
      force((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [id, rev, enabled]);
  return cached?.rev === rev ? cached.data : (cached?.data ?? null);
}

export function readLocal<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Speicher nicht verfügbar */
  }
}
