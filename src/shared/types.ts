// Gemeinsame Typen für Hauptprozess, Preload und Oberfläche.
// Die WLED-Felder folgen der JSON-API (https://kno.wled.ge/interfaces/json-api/).

export type Color = number[]; // [r, g, b] oder [r, g, b, w]

export interface WledSegment {
  id: number;
  start: number;
  stop: number;
  len?: number;
  startY?: number;
  stopY?: number;
  grp: number;
  spc: number;
  of: number;
  on: boolean;
  frz: boolean;
  bri: number;
  cct: number;
  n?: string;
  col: Color[];
  fx: number;
  sx: number;
  ix: number;
  pal: number;
  c1: number;
  c2: number;
  c3: number;
  sel: boolean;
  rev: boolean;
  mi: boolean;
  o1: boolean;
  o2: boolean;
  o3: boolean;
  lc?: number;
  [key: string]: unknown;
}

export interface WledNightlight {
  on: boolean;
  dur: number;
  mode: number;
  tbri: number;
  rem: number;
}

export interface WledUdpn {
  send: boolean;
  recv: boolean;
  sgrp?: number;
  rgrp?: number;
}

export interface WledState {
  on: boolean;
  bri: number;
  transition: number;
  ps: number;
  pl: number;
  nl: WledNightlight;
  udpn: WledUdpn;
  lor?: number;
  mainseg: number;
  seg: WledSegment[];
  [key: string]: unknown;
}

export interface WledInfo {
  ver: string;
  vid: number;
  name: string;
  brand?: string;
  product?: string;
  release?: string;
  arch?: string;
  core?: string;
  mac: string;
  ip: string;
  uptime: number;
  freeheap?: number;
  fxcount: number;
  palcount: number;
  cpalcount?: number;
  live?: boolean;
  lm?: string;
  lip?: string;
  ws?: number;
  udpport?: number;
  leds: {
    count: number;
    pwr?: number;
    fps?: number;
    maxpwr?: number;
    maxseg: number;
    bootps?: number;
    lc?: number;
    seglc?: number[];
    rgbw?: boolean;
    cct?: number | boolean;
    matrix?: { w: number; h: number };
  };
  wifi?: { rssi?: number; signal?: number; channel?: number; ap?: boolean };
  fs?: { u: number; t: number; pmt: number };
  u?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WledPlaylist {
  ps: number[];
  dur: number[] | number;
  transition: number[] | number;
  repeat?: number;
  end?: number;
  r?: boolean | number;
}

export interface WledPreset {
  n?: string;
  ql?: string;
  playlist?: WledPlaylist;
  on?: boolean;
  bri?: number;
  win?: string;
  [key: string]: unknown;
}

export type Presets = Record<string, WledPreset>;

/** Eintrag aus /json/palx: Stützstellen [pos, r, g, b] oder Platzhalter wie "r", "c1". */
export type PalxEntry = Array<number[] | string>;

export interface DeviceConfig {
  id: string;
  host: string;
  mac?: string;
  alias?: string;
  lastName?: string;
}

export type DeviceStatus = 'connecting' | 'online' | 'offline';

export interface DeviceSnapshot {
  id: string;
  host: string;
  alias?: string;
  name: string;
  status: DeviceStatus;
  state?: WledState;
  info?: WledInfo;
  error?: string;
  /** Wird hochgezählt, sobald Effekte, Paletten, Metadaten oder Presets neu geladen wurden. */
  staticRev: number;
}

export interface DeviceStatic {
  effects: string[];
  palettes: string[];
  fxdata: string[];
  presets: Presets;
}

export type ThemeMode = 'system' | 'dark' | 'light';
export type { LanguageSetting } from './i18n';
import type { LanguageSetting } from './i18n';

export interface AppSettings {
  closeToTray: boolean;
  startWithWindows: boolean;
  liveView: boolean;
  theme: ThemeMode;
  language: LanguageSetting;
  autoUpdate: boolean;
  selectedId?: string;
  trayHintShown?: boolean;
}

export interface ScanResult {
  host: string;
  name: string;
  mac: string;
  ver: string;
  leds: number;
  knownId?: string;
}

export interface ScanProgress {
  running: boolean;
  /** discover: Geräte, die sich melden (mDNS, Knotenliste) · sweep: Adressbereich abfragen */
  mode: 'discover' | 'sweep';
  done: number;
  total: number;
  found: ScanResult[];
}

export type DevicePage =
  | 'ui'
  | 'settings'
  | 'wifi'
  | 'leds'
  | '2D'
  | 'ui-settings'
  | 'sync'
  | 'time'
  | 'sec'
  | 'um'
  | 'cpal'
  | 'edit'
  | 'update';

export interface CommandResult {
  ok: boolean;
  error?: string;
}

export type UpdateStatus = 'unsupported' | 'idle' | 'checking' | 'latest' | 'downloading' | 'ready' | 'error';

export interface UpdateState {
  status: UpdateStatus;
  current: string;
  version?: string;
  progress?: number;
  error?: string;
}

export interface Snapshot {
  devices: DeviceSnapshot[];
  settings: AppSettings;
  version: string;
  update: UpdateState;
}

/** Was das Preload-Skript als window.wled bereitstellt. */
export interface WledBridge {
  getSnapshot(): Promise<Snapshot>;
  onDevices(cb: (devices: DeviceSnapshot[]) => void): () => void;
  onDevice(cb: (device: DeviceSnapshot) => void): () => void;
  onToast(cb: (message: string) => void): () => void;
  getStatic(id: string): Promise<DeviceStatic | null>;
  loadPalettes(id: string): Promise<Record<string, PalxEntry> | null>;
  send(id: string, patch: Record<string, unknown>, key?: string): void;
  sendAll(patch: Record<string, unknown>): void;
  command(id: string, patch: Record<string, unknown>): Promise<CommandResult>;
  refresh(id: string): Promise<void>;
  addDevice(host: string): Promise<CommandResult & { id?: string }>;
  removeDevice(id: string): Promise<void>;
  updateDevice(id: string, changes: { alias?: string; host?: string }): Promise<CommandResult>;
  reorderDevices(ids: string[]): Promise<void>;
  localSubnets(): Promise<string[]>;
  /** Sucht Geräte, die sich im Netzwerk melden (mDNS, WLED-Knotenliste). */
  discover(): Promise<void>;
  /** Fragt jede Adresse der angegebenen Netze ab. */
  scan(targets: string[]): Promise<void>;
  cancelScan(): void;
  onScan(cb: (progress: ScanProgress) => void): () => void;
  setLiveView(id: string | null): void;
  onLive(cb: (id: string, frame: Uint8Array) => void): () => void;
  openDevicePage(id: string, page: DevicePage): void;
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  onSettings(cb: (settings: AppSettings) => void): () => void;
  onUpdate(cb: (state: UpdateState) => void): () => void;
  checkForUpdates(): void;
  installUpdate(): void;
  showMain(deviceId?: string): void;
  onSelect(cb: (id: string) => void): () => void;
  resizeFlyout(height: number): void;
  hideFlyout(): void;
  quit(): void;
}
