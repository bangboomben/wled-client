import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { t } from '../shared/i18n';
import { applyStatePatch } from '../shared/merge';
import type {
  CommandResult,
  DeviceConfig,
  DeviceSnapshot,
  DeviceStatic,
  DeviceStatus,
  PalxEntry,
  Presets,
  WledInfo,
  WledPlaylist,
  WledPreset,
  WledState,
} from '../shared/types';

const HTTP_TIMEOUT_MS = 8000;
const HTTP_GAP_MS = 80;
const PING_INTERVAL_MS = 10_000;
const LIVE_MIN_INTERVAL_MS = 40;
/** Wie lange Aktionen (Speichern, Löschen, Neustart) auf die Bestätigung des Geräts warten. */
const CONFIRM_TIMEOUT_MS = 5000;
/** Obergrenze für Antworten — ein fehlerhaftes Gerät soll den Speicher nicht füllen. */
const MAX_BODY_BYTES = 4 << 20;
const MAX_WS_MESSAGE_BYTES = 1 << 20;
/** Wartezeit, bevor fehlende Gerätedaten erneut geholt werden (wächst je Fehlversuch). */
const STATIC_RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000];

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Pro Gerät läuft app-weit höchstens eine HTTP-Anfrage. Controller mit schwachem WLAN
 * (gemessen: −82 dBm) liefern große Antworten sonst abgeschnitten, Wiederholungen stauen
 * sich, und das Gerät antwortet irgendwann gar nicht mehr.
 */
const hostQueues = new Map<string, Promise<void>>();

function serialized<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const prev = hostQueues.get(host) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(
    () => delay(HTTP_GAP_MS),
    () => delay(HTTP_GAP_MS),
  );
  hostQueues.set(host, tail);
  void tail.then(() => {
    if (hostQueues.get(host) === tail) hostQueues.delete(host);
  });
  return run;
}

export function normalizeHost(input: string): string {
  return input
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function isWledInfo(v: unknown): v is WledInfo {
  return (
    isObj(v) &&
    typeof v.ver === 'string' &&
    typeof v.name === 'string' &&
    (v.mac === undefined || typeof v.mac === 'string') &&
    isObj(v.leds) &&
    typeof v.leds.count === 'number'
  );
}

/** HTTP-Fehler mit Statuscode. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/** Liest den Antworttext, aber höchstens `MAX_BODY_BYTES`. */
async function readCapped(res: Response): Promise<string> {
  if (Number(res.headers.get('content-length')) > MAX_BODY_BYTES) throw new Error(t('Antwort zu groß'));
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error(t('Antwort zu groß'));
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * HTTP-Anfrage an ein Gerät. Der ESP32 bricht größere Antworten gelegentlich ab
 * (abgeschnittenes JSON) oder antwortet bei schwachem WLAN zu spät. Mit `retries` wird
 * dann wiederholt — mit wachsender Pause, und zwischen den Versuchen kommen andere
 * Anfragen an dasselbe Gerät dran. Antworten mit 4xx (etwa ein Endpunkt, den ältere
 * Firmware nicht kennt) und abgebrochene Anfragen werden nicht wiederholt.
 */
export async function requestJson<T>(
  host: string,
  path: string,
  opts: { method?: 'GET' | 'POST'; body?: unknown; timeout?: number; retries?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const retries = opts.retries ?? 0;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await serialized(host, async () => {
        const timeout = AbortSignal.timeout(opts.timeout ?? HTTP_TIMEOUT_MS);
        const res = await fetch(`http://${host}${path}`, {
          method: opts.method ?? 'GET',
          headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
        });
        if (!res.ok) throw new HttpError(res.status);
        return JSON.parse(await readCapped(res)) as T;
      });
    } catch (err) {
      lastError = err;
      if ((err instanceof HttpError && err.status < 500) || opts.signal?.aborted) break;
      if (attempt < retries) await delay(700 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function probeInfo(host: string, timeout = 3000): Promise<WledInfo> {
  const info = await requestJson<unknown>(host, '/json/info', { timeout });
  if (!isWledInfo(info)) throw new Error('keine WLED-Antwort');
  return info;
}

const countsOf = (info: WledInfo) => `${info.fxcount}/${info.palcount}/${info.cpalcount ?? 0}`;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numbers = (v: unknown): number[] => (Array.isArray(v) ? v.filter(finite) : []);

function cleanPlaylist(raw: unknown): WledPlaylist | undefined {
  if (!isObj(raw)) return undefined;
  const ps = numbers(raw.ps);
  if (!ps.length) return undefined;
  const pl: WledPlaylist = {
    ps,
    dur: finite(raw.dur) ? raw.dur : Array.isArray(raw.dur) ? numbers(raw.dur) : 100,
    transition: finite(raw.transition) ? raw.transition : Array.isArray(raw.transition) ? numbers(raw.transition) : 7,
  };
  if (finite(raw.repeat)) pl.repeat = raw.repeat;
  if (finite(raw.end)) pl.end = raw.end;
  if (typeof raw.r === 'boolean' || finite(raw.r)) pl.r = raw.r;
  return pl;
}

/**
 * Presets aus presets.json in der Form, die die Oberfläche erwartet: Name und Schnellwahl als
 * Text, Playlists mit einer Liste von Preset-Nummern. Die Datei lässt sich am Gerät von Hand
 * bearbeiten — ein kaputter Eintrag soll nicht die ganze Oberfläche mitreißen.
 */
function cleanPresets(raw: unknown): Presets {
  const out: Presets = {};
  if (!isObj(raw)) return out;
  const text = (v: unknown) => (typeof v === 'string' ? v : finite(v) ? String(v) : undefined);
  for (const [id, p] of Object.entries(raw)) {
    if (!/^[1-9]\d*$/.test(id) || !isObj(p) || Object.keys(p).length === 0) continue;
    const preset: WledPreset = { ...p };
    for (const k of ['n', 'ql'] as const) {
      const v = text(p[k]);
      if (v === undefined) delete preset[k];
      else preset[k] = v;
    }
    const playlist = 'playlist' in p ? cleanPlaylist(p.playlist) : undefined;
    if (playlist) preset.playlist = playlist;
    else delete preset.playlist;
    out[id] = preset;
  }
  return out;
}

/** Zustand vom Gerät, mit Segmenten, Nachtlicht und Sync in der Form, die Oberfläche und merge.ts erwarten. */
function cleanState(raw: unknown): WledState | undefined {
  if (!isObj(raw) || !Array.isArray(raw.seg)) return undefined;
  const seg = raw.seg.filter(isObj).map((sg) => ({
    ...sg,
    col: Array.isArray(sg.col) ? sg.col.filter((c): c is number[] => Array.isArray(c)) : [],
  }));
  const num = (v: unknown, fallback: number) => (finite(v) ? v : fallback);
  const nl = isObj(raw.nl) ? raw.nl : {};
  const udpn = isObj(raw.udpn) ? raw.udpn : {};
  // Geprüft ist, was Oberfläche und merge.ts voraussetzen; die übrigen Felder reicht die App durch.
  return {
    ...raw,
    on: raw.on === true,
    bri: num(raw.bri, 128),
    transition: num(raw.transition, 7),
    ps: num(raw.ps, -1),
    pl: num(raw.pl, -1),
    mainseg: num(raw.mainseg, 0),
    seg: seg as unknown as WledState['seg'],
    nl: { ...nl, on: nl.on === true, dur: num(nl.dur, 60), mode: num(nl.mode, 1), tbri: num(nl.tbri, 0), rem: num(nl.rem, -1) },
    udpn: { ...udpn, send: udpn.send === true, recv: udpn.recv === true },
  };
}

/** Paletten aus /json/palx: nur Einträge, die Listen sind. */
function cleanPalx(raw: unknown): Record<string, PalxEntry> {
  const out: Record<string, PalxEntry> = {};
  if (isObj(raw)) for (const [id, e] of Object.entries(raw)) if (Array.isArray(e)) out[id] = e as PalxEntry;
  return out;
}

/** Integrierte Paletten sind je Firmware-Version gleich — einmal laden reicht für alle Geräte. */
const builtinPalettes = new Map<string, Record<string, PalxEntry>>();

interface QueueItem {
  patch: Record<string, unknown>;
  key?: string;
  /** Aktion statt Reglerwert: ohne Antwort des Geräts gilt sie als nicht bestätigt. */
  confirm: boolean;
  resolve: (r: CommandResult) => void;
}

/**
 * Eine Verbindung zu einem WLED-Gerät: WebSocket für Live-Zustand und Befehle,
 * HTTP für statische Daten (Effekte, Paletten, Presets) und als Rückfallebene.
 */
export class DeviceConnection extends EventEmitter {
  status: DeviceStatus = 'connecting';
  state?: WledState;
  info?: WledInfo;
  error?: string;
  staticData: DeviceStatic | null = null;
  staticRev = 0;

  private ws: WebSocket | null = null;
  /** Gilt bis zum nächsten stop(): Laufende Anfragen brechen dann ab, ihre Ergebnisse werden verworfen. */
  private session = new AbortController();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private awaitingPong = false;
  private backoff = 1000;
  private connectedAt = 0;
  private closed = false;
  private queue: QueueItem[] = [];
  private sending = false;
  private waiter: ((msg: Record<string, unknown> | null) => void) | null = null;
  private liveWanted = false;
  private lastLive = 0;
  private staticLoading: Promise<void> | null = null;
  private loadedVer?: string;
  private loadedCounts = '';
  private presetsPmt?: number;
  private presetsTimer: NodeJS.Timeout | null = null;
  private missing = { presets: false, fxdata: false };
  private staticRetryTimer: NodeJS.Timeout | null = null;
  private staticAttempt = 0;
  private staticBlockedUntil = 0;
  private palx: Record<string, PalxEntry> | null = null;
  private palxLoading: Promise<Record<string, PalxEntry> | null> | null = null;

  constructor(public config: DeviceConfig) {
    super();
  }

  get id(): string {
    return this.config.id;
  }

  get host(): string {
    return this.config.host;
  }

  get displayName(): string {
    return this.config.alias || this.info?.name || this.config.lastName || this.config.host;
  }

  snapshot(): DeviceSnapshot {
    return {
      id: this.id,
      host: this.host,
      alias: this.config.alias,
      name: this.displayName,
      status: this.status,
      state: this.state,
      info: this.info,
      error: this.error,
      staticRev: this.staticRev,
    };
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.session.abort();
    this.session = new AbortController();
    this.staticLoading = null;
    this.palxLoading = null;
    this.clearTimers();
    this.dropSocket();
    this.releaseWaiter(null);
    for (const item of this.queue.splice(0)) item.resolve({ ok: false, error: t('Verbindung beendet') });
  }

  setHost(host: string): void {
    this.stop();
    this.config.host = host;
    this.state = undefined;
    this.info = undefined;
    this.staticData = null;
    this.loadedVer = undefined;
    this.palx = null;
    this.staticAttempt = 0;
    this.staticBlockedUntil = 0;
    this.setStatus('connecting');
    this.start();
  }

  // ---------------------------------------------------------------- Verbindung

  private dropSocket(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.removeAllListeners();
    ws?.on('error', () => {});
    ws?.terminate();
  }

  private connect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // WLED hat nur wenige WebSocket-Plätze: nie eine zweite Verbindung neben der alten offen lassen.
    this.dropSocket();
    const ws = new WebSocket(`ws://${this.host}/ws`, {
      handshakeTimeout: 5000,
      perMessageDeflate: false,
      maxPayload: MAX_WS_MESSAGE_BYTES,
    });
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.connectedAt = Date.now();
      this.startPing(ws);
      if (this.liveWanted) this.rawSend({ lv: true });
      void this.pump();
    });
    ws.on('message', (data, isBinary) => {
      if (this.ws !== ws) return;
      this.onMessage(data as Buffer, isBinary);
    });
    ws.on('pong', () => {
      this.awaitingPong = false;
    });
    ws.on('error', (err) => {
      if (this.ws === ws) this.error = err.message;
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPing();
      this.releaseWaiter(null);
      void this.onDisconnect();
    });
  }

  private async onDisconnect(): Promise<void> {
    if (this.closed) return;
    // Lief die Verbindung eine Weile, war es ein normaler Abbruch: schnell neu verbinden.
    if (this.connectedAt && Date.now() - this.connectedAt > 5000) this.backoff = 1000;
    this.connectedAt = 0;
    // Gerät erreichbar, aber WebSocket nicht? Dann per HTTP weiterarbeiten.
    const { signal } = this.session;
    const reachable = await this.httpProbe(signal);
    if (signal.aborted || this.closed) return;
    if (!reachable) this.setStatus('offline');
    const wait = reachable ? 5000 : this.backoff;
    if (!reachable) this.backoff = Math.min(this.backoff * 2, 30_000);
    this.reconnectTimer = setTimeout(() => this.connect(), wait);
  }

  private async httpProbe(signal: AbortSignal): Promise<boolean> {
    try {
      const si = await requestJson<unknown>(this.host, '/json/si', { timeout: 3000, signal });
      if (signal.aborted || !isObj(si) || !cleanState(si.state) || !isWledInfo(si.info)) return false;
      this.applyFull(si.state, si.info);
      return true;
    } catch {
      return false;
    }
  }

  private startPing(ws: WebSocket): void {
    this.stopPing();
    this.awaitingPong = false;
    this.pingTimer = setInterval(() => {
      if (this.awaitingPong) {
        ws.terminate(); // keine Antwort seit dem letzten Ping: Gerät weg
        return;
      }
      this.awaitingPong = true;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private clearTimers(): void {
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.presetsTimer) clearTimeout(this.presetsTimer);
    if (this.staticRetryTimer) clearTimeout(this.staticRetryTimer);
    this.reconnectTimer = null;
    this.presetsTimer = null;
    this.staticRetryTimer = null;
  }

  private setStatus(status: DeviceStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('update');
  }

  // ---------------------------------------------------------------- Eingehend

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      if (data[0] !== 0x4c /* 'L' */) return;
      const now = Date.now();
      if (now - this.lastLive < LIVE_MIN_INTERVAL_MS) return;
      this.lastLive = now;
      this.emit('live', new Uint8Array(data));
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (!isObj(msg)) return;
    this.releaseWaiter(msg);
    if (msg.state || msg.info) this.applyFull(msg.state, msg.info);
  }

  private applyFull(rawState?: unknown, info?: unknown): void {
    const state = cleanState(rawState);
    if (state) this.state = state;
    if (isWledInfo(info)) {
      this.info = info;
      if (info.mac && this.config.mac !== info.mac) {
        this.config.mac = info.mac;
        this.emit('config');
      }
      if (info.name && this.config.lastName !== info.name) {
        this.config.lastName = info.name;
        this.emit('config');
      }
    }
    this.error = undefined;
    this.status = 'online';
    this.emit('update');

    if (!this.info) return;
    const stale = !this.staticData || this.loadedVer !== this.info.ver || this.loadedCounts !== countsOf(this.info);
    if (stale) {
      if (Date.now() >= this.staticBlockedUntil) void this.loadStatic();
    } else if (this.info.fs?.pmt !== undefined && this.presetsPmt !== undefined && this.info.fs.pmt !== this.presetsPmt) {
      this.reloadPresetsSoon(200);
    }
  }

  // ---------------------------------------------------------------- Statische Daten

  /**
   * Lädt Effekte und Paletten (klein, sofort sichtbar), danach Presets und Effekt-Metadaten.
   * Was nicht ankommt, wird mit wachsendem Abstand nachgeholt statt sofort erneut.
   */
  loadStatic(): Promise<void> {
    if (this.staticLoading) return this.staticLoading;
    const info = this.info;
    const { signal } = this.session;
    this.staticLoading = (async () => {
      try {
        const effects = await requestJson<unknown>(this.host, '/json/eff', { retries: 2, signal });
        const palettes = await requestJson<unknown>(this.host, '/json/pal', { retries: 2, signal });
        if (signal.aborted) return;
        if (!isStringArray(effects) || !isStringArray(palettes)) throw new Error(t('unerwartete Antwort'));
        this.loadedVer = info?.ver;
        this.loadedCounts = info ? countsOf(info) : '';
        this.staticData = {
          effects,
          palettes,
          fxdata: this.staticData?.fxdata ?? [],
          presets: this.staticData?.presets ?? {},
        };
        this.palx = null;
        this.missing = { presets: true, fxdata: true };
        this.publishStatic();
        await this.fillMissing(signal);
      } catch (err) {
        if (signal.aborted) return;
        this.error = t('Gerätedaten nicht geladen: {reason}', { reason: (err as Error).message });
        this.emit('update');
        this.scheduleStaticRetry(() => void this.loadStatic());
      } finally {
        // Nach stop() gehört staticLoading schon der nächsten Verbindung.
        if (!signal.aborted) this.staticLoading = null;
      }
    })();
    return this.staticLoading;
  }

  private async fillMissing(signal: AbortSignal): Promise<void> {
    if (this.missing.presets) {
      try {
        const raw = await requestJson<unknown>(this.host, '/presets.json', { retries: 2, signal });
        if (signal.aborted) return;
        this.setPresets(raw);
        this.missing.presets = false;
      } catch (err) {
        // Ohne gespeicherte Presets gibt es keine presets.json.
        if (err instanceof HttpError && err.status === 404) {
          this.setPresets({});
          this.missing.presets = false;
        }
      }
    }
    if (this.missing.fxdata) {
      try {
        const fxdata = await requestJson<unknown>(this.host, '/json/fxdata', { retries: 3, timeout: 10_000, signal });
        if (signal.aborted) return;
        if (isStringArray(fxdata) && this.staticData) {
          this.staticData = { ...this.staticData, fxdata };
          this.missing.fxdata = false;
          this.publishStatic();
        }
      } catch (err) {
        // Firmware vor 0.14 kennt /json/fxdata nicht: dann bleibt es bei Standardreglern.
        // Andere Fehler: später erneut, bis dahin ebenfalls Standardregler.
        if (err instanceof HttpError && err.status === 404) this.missing.fxdata = false;
      }
    }
    if (signal.aborted) return;
    if (this.missing.presets || this.missing.fxdata) this.scheduleStaticRetry(() => void this.fillMissing(this.session.signal));
    else this.staticAttempt = 0;
  }

  private scheduleStaticRetry(fn: () => void): void {
    if (this.closed || this.staticRetryTimer) return;
    const wait = STATIC_RETRY_MS[Math.min(this.staticAttempt, STATIC_RETRY_MS.length - 1)];
    this.staticAttempt++;
    this.staticBlockedUntil = Date.now() + wait;
    this.staticRetryTimer = setTimeout(() => {
      this.staticRetryTimer = null;
      fn();
    }, wait);
  }

  private setPresets(raw: unknown): void {
    if (!this.staticData) return;
    this.staticData = { ...this.staticData, presets: cleanPresets(raw) };
    this.presetsPmt = this.info?.fs?.pmt;
    this.publishStatic();
  }

  private publishStatic(): void {
    this.staticRev++;
    this.emit('update');
  }

  reloadPresetsSoon(ms = 900): void {
    if (this.closed) return;
    if (this.presetsTimer) clearTimeout(this.presetsTimer);
    this.presetsTimer = setTimeout(() => {
      this.presetsTimer = null;
      void this.reloadPresets();
    }, ms);
  }

  private async reloadPresets(): Promise<void> {
    const { signal } = this.session;
    try {
      const raw = await requestJson<unknown>(this.host, '/presets.json', { retries: 2, signal });
      if (!signal.aborted) this.setPresets(raw);
    } catch {
      /* nächster Versuch beim nächsten pmt-Wechsel */
    }
  }

  async loadPalettes(): Promise<Record<string, PalxEntry> | null> {
    if (this.palx) return this.palx;
    if (this.palxLoading) return this.palxLoading;
    const cacheKey = this.info ? `${this.info.ver}/${this.info.palcount}` : '';
    if (cacheKey && !this.info?.cpalcount && builtinPalettes.has(cacheKey)) {
      this.palx = builtinPalettes.get(cacheKey)!;
      return this.palx;
    }
    const { signal } = this.session;
    this.palxLoading = (async () => {
      try {
        const out: Record<string, PalxEntry> = {};
        const first = await requestJson<unknown>(this.host, '/json/palx?page=0', { retries: 2, signal });
        if (!isObj(first)) throw new Error(t('unerwartete Antwort'));
        Object.assign(out, cleanPalx(first.p));
        const pages = finite(first.m) ? Math.min(first.m, 64) : 0;
        for (let page = 1; page <= pages; page++) {
          const res = await requestJson<unknown>(this.host, `/json/palx?page=${page}`, { retries: 2, signal });
          if (isObj(res)) Object.assign(out, cleanPalx(res.p));
        }
        if (signal.aborted) return null;
        this.palx = out;
        if (cacheKey && !this.info?.cpalcount) builtinPalettes.set(cacheKey, out);
        return out;
      } catch {
        return null;
      } finally {
        if (!signal.aborted) this.palxLoading = null;
      }
    })();
    return this.palxLoading;
  }

  // ---------------------------------------------------------------- Ausgehend

  /** Zeigt eine Änderung sofort an, bevor das Gerät sie bestätigt. */
  applyLocal(patch: Record<string, unknown>): void {
    if (!this.state || this.status !== 'online') return;
    try {
      this.state = applyStatePatch(this.state, patch);
    } catch {
      return; // Das Gerät meldet gleich ohnehin den echten Zustand.
    }
    this.emit('update');
  }

  /**
   * Stellt einen Befehl in die Warteschlange. Befehle mit gleichem `key` ersetzen sich —
   * beim Ziehen eines Reglers kommt so nur der jeweils letzte Wert beim Gerät an.
   * `confirm`: eine Aktion (Speichern, Löschen, Neustart), deren Erfolg erst die Antwort
   * des Geräts belegt.
   */
  enqueue(patch: Record<string, unknown>, key?: string, confirm = false): Promise<CommandResult> {
    return new Promise((resolve) => {
      if (key) {
        const existing = this.queue.find((q) => q.key === key);
        if (existing) {
          existing.resolve({ ok: true });
          existing.patch = patch;
          existing.confirm ||= confirm;
          existing.resolve = resolve;
          return;
        }
      }
      this.queue.push({ patch, key, confirm, resolve });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        const result = await this.deliver(item.patch, item.confirm);
        item.resolve(result);
        if (!result.ok && result.error) this.emit('toast', result.error);
      }
    } finally {
      this.sending = false;
    }
  }

  private async deliver(patch: Record<string, unknown>, confirm: boolean): Promise<CommandResult> {
    const { signal } = this.session;
    if (this.ws?.readyState === WebSocket.OPEN) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const reply = this.waitForMessage(confirm ? CONFIRM_TIMEOUT_MS : 500);
        this.rawSend(patch);
        const msg = await reply;
        // error 3 = JSON-Puffer des Geräts belegt, Befehl wurde verworfen
        if (msg && msg.error === 3) {
          await delay(120);
          continue;
        }
        // WLED beantwortet jeden Befehl. Bleibt die Antwort aus, ist das bei Reglerwerten egal
        // (der nächste folgt), eine Aktion ist dann aber nicht bestätigt. Nicht erneut per HTTP
        // senden: Umschalten ("t") oder Neustart würden sonst doppelt ausgeführt.
        if (!msg && confirm) return { ok: false, error: t('{name}: keine Bestätigung vom Gerät', { name: this.displayName }) };
        return { ok: true };
      }
    }
    try {
      const res = await requestJson<unknown>(this.host, '/json/state', { method: 'POST', body: patch, signal });
      if (!signal.aborted && isObj(res) && res.state) this.applyFull(res.state, res.info);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: t('{name}: Befehl kam nicht an ({reason})', { name: this.displayName, reason: (err as Error).message }) };
    }
  }

  private rawSend(obj: Record<string, unknown>): void {
    try {
      this.ws?.send(JSON.stringify(obj));
    } catch {
      /* close-Handler übernimmt */
    }
  }

  private waitForMessage(timeout: number): Promise<Record<string, unknown> | null> {
    this.releaseWaiter(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter === done) this.waiter = null;
        resolve(null);
      }, timeout);
      const done = (msg: Record<string, unknown> | null) => {
        clearTimeout(timer);
        resolve(msg);
      };
      this.waiter = done;
    });
  }

  private releaseWaiter(msg: Record<string, unknown> | null): void {
    const w = this.waiter;
    this.waiter = null;
    w?.(msg);
  }

  setLive(on: boolean): void {
    if (this.liveWanted === on) return;
    this.liveWanted = on;
    if (this.ws?.readyState === WebSocket.OPEN) this.rawSend({ lv: on });
  }
}
