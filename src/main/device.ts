import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
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
  WledState,
} from '../shared/types';

const HTTP_TIMEOUT_MS = 8000;
const HTTP_GAP_MS = 80;
const PING_INTERVAL_MS = 10_000;
const LIVE_MIN_INTERVAL_MS = 40;
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

export function isWledInfo(v: unknown): v is WledInfo {
  const o = v as WledInfo | null;
  return !!o && typeof o.ver === 'string' && !!o.leds && typeof o.leds.count === 'number';
}

/**
 * HTTP-Anfrage an ein Gerät. Der ESP32 bricht größere Antworten gelegentlich ab
 * (abgeschnittenes JSON), deshalb wird bei Parse-Fehlern wiederholt — mit wachsender
 * Pause, und zwischen den Versuchen kommen andere Anfragen an dasselbe Gerät dran.
 */
export async function requestJson<T>(
  host: string,
  path: string,
  opts: { method?: 'GET' | 'POST'; body?: unknown; timeout?: number; retries?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 0;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await serialized(host, async () => {
        const res = await fetch(`http://${host}${path}`, {
          method: opts.method ?? 'GET',
          headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(opts.timeout ?? HTTP_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return JSON.parse(await res.text()) as T;
      });
    } catch (err) {
      lastError = err;
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

function cleanPresets(raw: unknown): Presets {
  const out: Presets = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, p] of Object.entries(raw as Record<string, unknown>)) {
    if (id === '0' || !p || typeof p !== 'object' || Object.keys(p).length === 0) continue;
    out[id] = p as Presets[string];
  }
  return out;
}

/** Integrierte Paletten sind je Firmware-Version gleich — einmal laden reicht für alle Geräte. */
const builtinPalettes = new Map<string, Record<string, PalxEntry>>();

interface QueueItem {
  patch: Record<string, unknown>;
  key?: string;
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
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    ws?.removeAllListeners();
    ws?.on('error', () => {});
    ws?.terminate();
    this.releaseWaiter(null);
    for (const item of this.queue.splice(0)) item.resolve({ ok: false, error: 'Verbindung beendet' });
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

  private connect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = new WebSocket(`ws://${this.host}/ws`, { handshakeTimeout: 5000, perMessageDeflate: false });
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
    const reachable = await this.httpProbe();
    if (this.closed) return;
    if (!reachable) this.setStatus('offline');
    const wait = reachable ? 5000 : this.backoff;
    if (!reachable) this.backoff = Math.min(this.backoff * 2, 30_000);
    this.reconnectTimer = setTimeout(() => this.connect(), wait);
  }

  private async httpProbe(): Promise<boolean> {
    try {
      const si = await requestJson<{ state: WledState; info: WledInfo }>(this.host, '/json/si', { timeout: 3000 });
      if (!si?.state || !isWledInfo(si.info)) return false;
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
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    this.releaseWaiter(msg);
    if (msg.state || msg.info) this.applyFull(msg.state as WledState | undefined, msg.info as WledInfo | undefined);
  }

  private applyFull(state?: WledState, info?: WledInfo): void {
    if (state && Array.isArray(state.seg)) this.state = state;
    if (info && isWledInfo(info)) {
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
    this.staticLoading = (async () => {
      try {
        const effects = await requestJson<string[]>(this.host, '/json/eff', { retries: 2 });
        const palettes = await requestJson<string[]>(this.host, '/json/pal', { retries: 2 });
        if (!Array.isArray(effects) || !Array.isArray(palettes)) throw new Error('unerwartete Antwort');
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
        await this.fillMissing();
      } catch (err) {
        this.error = `Gerätedaten nicht geladen: ${(err as Error).message}`;
        this.emit('update');
        this.scheduleStaticRetry(() => void this.loadStatic());
      } finally {
        this.staticLoading = null;
      }
    })();
    return this.staticLoading;
  }

  private async fillMissing(): Promise<void> {
    if (this.missing.presets) {
      try {
        this.setPresets(await requestJson<unknown>(this.host, '/presets.json', { retries: 2 }));
        this.missing.presets = false;
      } catch {
        /* später erneut */
      }
    }
    if (this.missing.fxdata) {
      try {
        const fxdata = await requestJson<string[]>(this.host, '/json/fxdata', { retries: 3, timeout: 10_000 });
        if (Array.isArray(fxdata) && this.staticData) {
          this.staticData = { ...this.staticData, fxdata };
          this.missing.fxdata = false;
          this.publishStatic();
        }
      } catch {
        /* später erneut — bis dahin zeigt die Oberfläche Standardregler */
      }
    }
    if (this.missing.presets || this.missing.fxdata) this.scheduleStaticRetry(() => void this.fillMissing());
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
    if (this.presetsTimer) clearTimeout(this.presetsTimer);
    this.presetsTimer = setTimeout(() => {
      this.presetsTimer = null;
      void this.reloadPresets();
    }, ms);
  }

  private async reloadPresets(): Promise<void> {
    try {
      this.setPresets(await requestJson<unknown>(this.host, '/presets.json', { retries: 2 }));
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
    this.palxLoading = (async () => {
      try {
        const out: Record<string, PalxEntry> = {};
        const first = await requestJson<{ m: number; p: Record<string, PalxEntry> }>(this.host, '/json/palx?page=0', {
          retries: 2,
        });
        Object.assign(out, first.p);
        for (let page = 1; page <= Math.min(first.m ?? 0, 64); page++) {
          const res = await requestJson<{ p: Record<string, PalxEntry> }>(this.host, `/json/palx?page=${page}`, {
            retries: 2,
          });
          Object.assign(out, res.p);
        }
        this.palx = out;
        if (cacheKey && !this.info?.cpalcount) builtinPalettes.set(cacheKey, out);
        return out;
      } catch {
        return null;
      } finally {
        this.palxLoading = null;
      }
    })();
    return this.palxLoading;
  }

  // ---------------------------------------------------------------- Ausgehend

  /** Zeigt eine Änderung sofort an, bevor das Gerät sie bestätigt. */
  applyLocal(patch: Record<string, unknown>): void {
    if (!this.state || this.status !== 'online') return;
    this.state = applyStatePatch(this.state, patch);
    this.emit('update');
  }

  /**
   * Stellt einen Befehl in die Warteschlange. Befehle mit gleichem `key` ersetzen sich —
   * beim Ziehen eines Reglers kommt so nur der jeweils letzte Wert beim Gerät an.
   */
  enqueue(patch: Record<string, unknown>, key?: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      if (key) {
        const existing = this.queue.find((q) => q.key === key);
        if (existing) {
          existing.resolve({ ok: true });
          existing.patch = patch;
          existing.resolve = resolve;
          return;
        }
      }
      this.queue.push({ patch, key, resolve });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        const result = await this.deliver(item.patch);
        item.resolve(result);
        if (!result.ok && result.error) this.emit('toast', result.error);
      }
    } finally {
      this.sending = false;
    }
  }

  private async deliver(patch: Record<string, unknown>): Promise<CommandResult> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const reply = this.waitForMessage(500);
        this.rawSend(patch);
        const msg = await reply;
        // error 3 = JSON-Puffer des Geräts belegt, Befehl wurde verworfen
        if (msg && msg.error === 3) {
          await delay(120);
          continue;
        }
        return { ok: true };
      }
    }
    try {
      const res = await requestJson<Record<string, unknown>>(this.host, '/json/state', { method: 'POST', body: patch });
      if (res && res.state) this.applyFull(res.state as WledState, res.info as WledInfo | undefined);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `${this.displayName}: Befehl kam nicht an (${(err as Error).message})` };
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
