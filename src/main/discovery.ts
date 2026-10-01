import { EventEmitter } from 'node:events';
import os from 'node:os';
import type { ScanProgress, ScanResult } from '../shared/types';
import { probeInfo, requestJson } from './device';

const MAX_HOSTS = 2048;
const CONCURRENCY = 96;
const VIRTUAL_ADAPTER = /vethernet|virtualbox|vmware|hyper-v|wsl|loopback|docker|tailscale|zerotier/i;

const ipToInt = (ip: string) => ip.split('.').reduce((acc, p) => (acc << 8) + (Number(p) & 255), 0) >>> 0;
const intToIp = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

function isPrivate(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** Die /24-Netze der eigenen Netzwerkkarten (ohne virtuelle Adapter). */
export function localSubnets(): string[] {
  const out = new Set<string>();
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_ADAPTER.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || !isPrivate(a.address)) continue;
      out.add(`${a.address.split('.').slice(0, 3).join('.')}.0/24`);
    }
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
      const prefix = star ? 24 : Math.max(21, Math.min(32, Number(cidr![2])));
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

export class Scanner extends EventEmitter {
  private abort: AbortController | null = null;
  private progress: ScanProgress = { running: false, done: 0, total: 0, found: [] };

  get running(): boolean {
    return this.progress.running;
  }

  cancel(): void {
    this.abort?.abort();
  }

  /**
   * Fragt jede Adresse nach /json/info. Zuerst und mit viel Geduld die Adressen, die
   * bekannte Geräte über /json/nodes melden (WLED-Knoten, die sie per UDP-Sync sehen):
   * Controller mit schwachem WLAN brauchen für eine Antwort mitunter über 3 s.
   */
  async run(targets: string[], knownHosts: string[], macToId: Map<string, string>): Promise<ScanResult[]> {
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;

    const sweep = expandTargets(targets);
    const likely = new Set(knownHosts.filter((h) => sweep.includes(h)));
    await Promise.all(
      knownHosts.map(async (host) => {
        try {
          const res = await requestJson<{ nodes?: Array<{ ip?: string }> }>(host, '/json/nodes', { timeout: 3000 });
          for (const n of res.nodes ?? []) if (n.ip) likely.add(n.ip);
        } catch {
          /* Gerät gerade nicht erreichbar */
        }
      }),
    );
    const rest = sweep.filter((h) => !likely.has(h));

    this.progress = { running: true, done: 0, total: likely.size + rest.length, found: [] };
    this.emit('progress', this.snapshot());
    const seenMacs = new Set<string>();
    let lastEmit = 0;

    const probeOne = async (host: string, timeout: number) => {
      try {
        const info = await probeInfo(host, timeout);
        if (!abort.signal.aborted && !seenMacs.has(info.mac)) {
          seenMacs.add(info.mac);
          this.progress.found.push({
            host,
            name: info.name,
            mac: info.mac,
            ver: info.ver,
            leds: info.leds.count,
            knownId: macToId.get(info.mac),
          });
        }
      } catch {
        /* kein WLED unter dieser Adresse */
      }
      this.progress.done++;
      const now = Date.now();
      if (now - lastEmit > 120) {
        lastEmit = now;
        this.emit('progress', this.snapshot());
      }
    };

    const pool = async (hosts: string[], concurrency: number, timeout: number) => {
      let next = 0;
      const worker = async () => {
        while (!abort.signal.aborted && next < hosts.length) await probeOne(hosts[next++], timeout);
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
    };

    await Promise.all([pool([...likely], 8, 6000), pool(rest, CONCURRENCY, 2500)]);

    // Zweite Welle: Knoten, die gefundene Geräte melden, die aber im Durchlauf nicht
    // geantwortet haben (zu langsam) — noch einmal mit viel Geduld fragen.
    if (!abort.signal.aborted) {
      const foundHosts = new Set(this.progress.found.map((f) => f.host));
      const retry = new Set<string>();
      await Promise.all(
        [...foundHosts].map(async (host) => {
          try {
            const res = await requestJson<{ nodes?: Array<{ ip?: string }> }>(host, '/json/nodes', { timeout: 3000 });
            for (const n of res.nodes ?? []) if (n.ip && !foundHosts.has(n.ip)) retry.add(n.ip);
          } catch {
            /* egal */
          }
        }),
      );
      if (retry.size) {
        this.progress.total += retry.size;
        await pool([...retry], 8, 6000);
      }
    }

    this.progress.running = false;
    this.progress.found.sort((a, b) => ipToInt(a.host) - ipToInt(b.host) || a.host.localeCompare(b.host));
    this.emit('progress', this.snapshot());
    if (this.abort === abort) this.abort = null;
    return this.progress.found;
  }

  snapshot(): ScanProgress {
    return { ...this.progress, found: [...this.progress.found] };
  }
}
