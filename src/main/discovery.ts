import { EventEmitter } from 'node:events';
import os from 'node:os';
import type { ScanProgress, ScanResult } from '../shared/types';
import { probeInfo, requestJson } from './device';
import { browse } from './mdns';

const MDNS_SERVICE = '_wled._tcp.local';
const MDNS_TIMEOUT = 4000;
/** Die Adresssuche fragt höchstens ein /22 ab (1022 Adressen) — größere Netze deckt mDNS ab. */
const MIN_PREFIX = 22;
const MAX_HOSTS = 2 ** (32 - MIN_PREFIX);
const SWEEP_CONCURRENCY = 32;
/** Controller mit schwachem WLAN brauchen für eine Antwort mitunter über 3 s. */
const PATIENT_TIMEOUT = 6000;
const VIRTUAL_ADAPTER = /vethernet|virtualbox|vmware|hyper-v|wsl|loopback|docker|tailscale|zerotier/i;

const ipToInt = (ip: string) => ip.split('.').reduce((acc, p) => (acc << 8) + (Number(p) & 255), 0) >>> 0;
const intToIp = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

function isPrivate(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** IPv4-Adressen der eigenen Netzwerkkarten (ohne virtuelle Adapter) mit Präfixlänge. */
function localAddresses(ifaces = os.networkInterfaces()): Array<{ address: string; prefix: number }> {
  const out: Array<{ address: string; prefix: number }> = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (VIRTUAL_ADAPTER.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ address: a.address, prefix: Number(a.cidr?.split('/')[1] ?? 24) });
    }
  }
  return out;
}

/**
 * Die privaten Netze der eigenen Netzwerkkarten nach ihrer echten Netzmaske, als Vorschlag für
 * die Adresssuche. Netze größer als /22 werden auf das /22 um die eigene Adresse begrenzt;
 * Punkt-zu-Punkt-Verbindungen (/31, /32) haben nichts abzufragen. `ifaces` ersetzt in Tests die
 * echten Netzwerkkarten.
 */
export function localSubnets(ifaces = os.networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const { address, prefix } of localAddresses(ifaces)) {
    if (!isPrivate(address) || prefix > 30) continue;
    const p = Math.max(MIN_PREFIX, prefix);
    const mask = (~0 << (32 - p)) >>> 0;
    out.add(`${intToIp((ipToInt(address) & mask) >>> 0)}/${p}`);
  }
  return [...out];
}

/** Akzeptiert „192.168.1.0/24“, „192.168.1.*“ und einzelne Adressen oder Hostnamen. */
export function expandTargets(targets: string[]): string[] {
  const hosts = new Set<string>();
  for (const raw of targets) {
    const t = raw.trim();
    if (!t) continue;
    const star = t.match(/^(\d+\.\d+\.\d+)\.\*$/);
    const cidr = t.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
    if (star || cidr) {
      const base = star ? `${star[1]}.0` : cidr![1];
      const prefix = star ? 24 : Math.max(MIN_PREFIX, Math.min(32, Number(cidr![2])));
      const size = 2 ** (32 - prefix);
      const start = (ipToInt(base) & (~(size - 1) >>> 0)) >>> 0;
      const first = size > 2 ? 1 : 0;
      const last = size > 2 ? size - 2 : size - 1;
      for (let i = first; i <= last && hosts.size < MAX_HOSTS; i++) hosts.add(intToIp(start + i));
    } else {
      hosts.add(t);
    }
  }
  return [...hosts];
}

/** Für Tests: mDNS-Anfrage per Unicast an eine feste Adresse (scripts/mock-wled.mjs --mdns). */
function mdnsTestTarget(): { address: string; port: number } | undefined {
  const m = process.env.WLED_CLIENT_MDNS_TARGET?.match(/^([\d.]+):(\d+)$/);
  return m ? { address: m[1], port: Number(m[2]) } : undefined;
}

/** Adressen der WLED-Knoten, die ein Gerät per UDP sieht (/json/nodes). */
async function nodeIps(host: string): Promise<string[]> {
  try {
    const res = await requestJson<{ nodes?: Array<{ ip?: unknown }> }>(host, '/json/nodes', { timeout: 3000 });
    return (res.nodes ?? []).map((n) => n.ip).filter((ip): ip is string => typeof ip === 'string' && /^[\d.]+$/.test(ip));
  } catch {
    return []; // Gerät gerade nicht erreichbar
  }
}

/** Arbeitet Aufgaben mit begrenzter Parallelität ab; neue Aufgaben dürfen jederzeit dazukommen. */
class Pool {
  private queue: Array<() => Promise<void>> = [];
  private active = 0;
  private waiters: Array<() => void> = [];
  private readonly limit: number;
  private readonly signal: AbortSignal;

  constructor(limit: number, signal: AbortSignal) {
    this.limit = limit;
    this.signal = signal;
  }

  add(task: () => Promise<void>): void {
    this.queue.push(task);
    this.pump();
  }

  /** Wartet, bis die Warteschlange leer ist und nichts mehr läuft. */
  drain(): Promise<void> {
    if (this.idle) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private get idle(): boolean {
    return this.active === 0 && this.queue.length === 0;
  }

  private pump(): void {
    if (this.signal.aborted) this.queue = [];
    while (this.active < this.limit && this.queue.length) {
      const task = this.queue.shift()!;
      this.active++;
      void task()
        .catch(() => {})
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
    if (this.idle) for (const resolve of this.waiters.splice(0)) resolve();
  }
}

interface Run {
  abort: AbortController;
  progress: ScanProgress;
  macs: Set<string>;
  macToId: Map<string, string>;
}

export class Scanner extends EventEmitter {
  private run: Run | null = null;
  private progress: ScanProgress = { running: false, mode: 'discover', done: 0, total: 0, found: [] };
  private lastEmit = 0;

  get running(): boolean {
    return this.progress.running;
  }

  cancel(): void {
    this.run?.abort.abort();
  }

  /**
   * Findet Geräte, die sich selbst melden: per mDNS (_wled._tcp) und über die Knotenliste
   * (/json/nodes), die WLED aus den UDP-Meldungen anderer Geräte aufbaut. Erzeugt kaum
   * Netzverkehr und hängt nicht von der Größe des Netzes ab. Verbundene Geräte (`online`)
   * werden nicht erneut abgefragt, sondern mit ihren vorhandenen Daten gemeldet; `macToId`
   * ordnet Funde unter neuer Adresse den gespeicherten Geräten zu.
   */
  async discover(online: ScanResult[], macToId: Map<string, string>): Promise<ScanResult[]> {
    const run = this.begin('discover', macToId);
    const pool = new Pool(4, run.abort.signal);
    const asked = new Set<string>();

    const check = (host: string) => {
      const k = online.find((r) => r.host === host);
      if (k) return this.add(run, k);
      if (asked.has(host)) return;
      asked.add(host);
      run.progress.total++;
      pool.add(async () => {
        if (await this.probe(run, host, PATIENT_TIMEOUT)) for (const ip of await nodeIps(host)) check(ip);
      });
    };

    for (const k of online) pool.add(async () => (await nodeIps(k.host)).forEach(check));
    await browse(MDNS_SERVICE, {
      interfaces: localAddresses().map((a) => a.address),
      timeout: MDNS_TIMEOUT,
      signal: run.abort.signal,
      target: mdnsTestTarget(),
      onService: (s) => check(s.port === 80 ? s.address : `${s.address}:${s.port}`),
    });
    await pool.drain();
    return this.end(run);
  }

  /**
   * Fragt jede Adresse der angegebenen Netze nach /json/info — für Geräte, die sich nicht
   * melden, etwa hinter einem VPN. Zuerst und mit viel Geduld die Adressen, die bekannte
   * Geräte über /json/nodes melden.
   */
  async sweep(targets: string[], online: ScanResult[], macToId: Map<string, string>): Promise<ScanResult[]> {
    const run = this.begin('sweep', macToId);
    const hosts = expandTargets(targets);
    const likely = new Set(online.map((k) => k.host).filter((h) => hosts.includes(h)));
    for (const ips of await Promise.all(online.map((k) => nodeIps(k.host)))) for (const ip of ips) likely.add(ip);
    const rest = hosts.filter((h) => !likely.has(h));
    run.progress.total = likely.size + rest.length;
    this.emitProgress(run, true);

    const patient = new Pool(8, run.abort.signal);
    const quick = new Pool(SWEEP_CONCURRENCY, run.abort.signal);
    for (const h of likely) patient.add(async () => void (await this.probe(run, h, PATIENT_TIMEOUT)));
    for (const h of rest) quick.add(async () => void (await this.probe(run, h, 2500)));
    await Promise.all([patient.drain(), quick.drain()]);

    // Zweite Welle: Knoten, die gefundene Geräte melden, die aber im Durchlauf nicht
    // geantwortet haben (zu langsam) — noch einmal mit viel Geduld fragen.
    if (!run.abort.signal.aborted) {
      const foundHosts = new Set(run.progress.found.map((f) => f.host));
      const retry = new Set<string>();
      for (const ips of await Promise.all([...foundHosts].map(nodeIps))) for (const ip of ips) if (!foundHosts.has(ip)) retry.add(ip);
      run.progress.total += retry.size;
      for (const h of retry) patient.add(async () => void (await this.probe(run, h, PATIENT_TIMEOUT)));
      await patient.drain();
    }
    return this.end(run);
  }

  snapshot(): ScanProgress {
    return { ...this.progress, found: [...this.progress.found] };
  }

  private begin(mode: ScanProgress['mode'], macToId: Map<string, string>): Run {
    this.run?.abort.abort();
    const run: Run = {
      abort: new AbortController(),
      progress: { running: true, mode, done: 0, total: 0, found: [] },
      macs: new Set(),
      macToId,
    };
    this.run = run;
    this.progress = run.progress;
    this.emitProgress(run, true);
    return run;
  }

  private end(run: Run): ScanResult[] {
    run.progress.running = false;
    run.progress.found.sort((a, b) => ipToInt(a.host) - ipToInt(b.host) || a.host.localeCompare(b.host));
    this.emitProgress(run, true);
    if (this.run === run) this.run = null;
    return run.progress.found;
  }

  private add(run: Run, result: ScanResult): void {
    if (run.abort.signal.aborted || run.macs.has(result.mac)) return;
    run.macs.add(result.mac);
    run.progress.found.push(result);
    this.emitProgress(run);
  }

  /** Fragt eine Adresse nach /json/info; true, wenn dort ein WLED-Gerät antwortet. */
  private async probe(run: Run, host: string, timeout: number): Promise<boolean> {
    let ok = false;
    try {
      const info = await probeInfo(host, timeout);
      ok = true;
      this.add(run, { host, name: info.name, mac: info.mac, ver: info.ver, leds: info.leds.count, knownId: run.macToId.get(info.mac) });
    } catch {
      /* kein WLED unter dieser Adresse */
    }
    run.progress.done++;
    this.emitProgress(run);
    return ok;
  }

  private emitProgress(run: Run, force = false): void {
    if (this.run !== run) return;
    const now = Date.now();
    if (!force && now - this.lastEmit < 120) return;
    this.lastEmit = now;
    this.emit('progress', this.snapshot());
  }
}
