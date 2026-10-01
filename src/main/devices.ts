import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { CommandResult, DeviceConfig, DeviceSnapshot } from '../shared/types';
import { DeviceConnection, normalizeHost, probeInfo } from './device';
import type { Store } from './store';

/** Befehle, nach denen sich presets.json ändert. */
const PRESET_KEYS = ['psave', 'pdel'];

export class DeviceManager extends EventEmitter {
  private conns = new Map<string, DeviceConnection>();
  private order: string[] = [];
  private pendingUpdates = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private liveId: string | null = null;

  constructor(private store: Store) {
    super();
  }

  init(): void {
    for (const cfg of this.store.getDevices()) this.attach(cfg);
  }

  get size(): number {
    return this.order.length;
  }

  list(): DeviceSnapshot[] {
    return this.order.map((id) => this.conns.get(id)!.snapshot());
  }

  get(id: string): DeviceConnection | undefined {
    return this.conns.get(id);
  }

  all(): DeviceConnection[] {
    return this.order.map((id) => this.conns.get(id)!);
  }

  findByMac(mac: string): DeviceConnection | undefined {
    return this.all().find((c) => c.config.mac && c.config.mac === mac);
  }

  private attach(cfg: DeviceConfig): DeviceConnection {
    const conn = new DeviceConnection(cfg);
    conn.on('update', () => this.queueUpdate(cfg.id));
    conn.on('config', () => this.persist());
    conn.on('live', (frame: Uint8Array) => this.emit('live', cfg.id, frame));
    conn.on('toast', (msg: string) => this.emit('toast', msg));
    this.conns.set(cfg.id, conn);
    this.order.push(cfg.id);
    conn.start();
    return conn;
  }

  /** Bündelt Updates eines Geräts auf höchstens eines pro Frame. */
  private queueUpdate(id: string): void {
    this.pendingUpdates.add(id);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const ids = [...this.pendingUpdates];
      this.pendingUpdates.clear();
      for (const pid of ids) {
        const conn = this.conns.get(pid);
        if (conn) this.emit('device', conn.snapshot());
      }
    }, 16);
  }

  private persist(): void {
    this.store.setDevices(this.all().map((c) => c.config));
  }

  private listChanged(): void {
    this.persist();
    this.emit('list', this.list());
  }

  async add(input: string): Promise<CommandResult & { id?: string }> {
    const host = normalizeHost(input);
    if (!host) return { ok: false, error: 'Bitte eine IP-Adresse oder einen Hostnamen eingeben.' };
    const byHost = this.all().find((c) => c.host === host);
    if (byHost) return { ok: true, id: byHost.id };
    let info;
    try {
      info = await probeInfo(host, 6000);
    } catch {
      return { ok: false, error: `Unter ${host} antwortet kein WLED-Gerät.` };
    }
    const byMac = info.mac ? this.findByMac(info.mac) : undefined;
    if (byMac) {
      // Bekanntes Gerät mit neuer Adresse (DHCP) — Adresse übernehmen statt doppelt anlegen.
      byMac.setHost(host);
      this.listChanged();
      return { ok: true, id: byMac.id };
    }
    const conn = this.attach({ id: randomUUID(), host, mac: info.mac, lastName: info.name });
    this.listChanged();
    return { ok: true, id: conn.id };
  }

  remove(id: string): void {
    const conn = this.conns.get(id);
    if (!conn) return;
    conn.stop();
    conn.removeAllListeners();
    this.conns.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (this.liveId === id) this.liveId = null;
    this.listChanged();
  }

  async update(id: string, changes: { alias?: string; host?: string }): Promise<CommandResult> {
    const conn = this.conns.get(id);
    if (!conn) return { ok: false, error: 'Gerät nicht gefunden' };
    if (changes.alias !== undefined) {
      const alias = changes.alias.trim();
      conn.config.alias = alias || undefined;
    }
    if (changes.host !== undefined) {
      const host = normalizeHost(changes.host);
      if (!host) return { ok: false, error: 'Adresse fehlt' };
      if (host !== conn.host) {
        try {
          await probeInfo(host, 6000);
        } catch {
          return { ok: false, error: `Unter ${host} antwortet kein WLED-Gerät.` };
        }
        conn.setHost(host);
      }
    }
    this.listChanged();
    return { ok: true };
  }

  reorder(ids: string[]): void {
    const known = ids.filter((id) => this.conns.has(id));
    const rest = this.order.filter((id) => !known.includes(id));
    this.order = [...known, ...rest];
    this.listChanged();
  }

  send(id: string, patch: Record<string, unknown>, key?: string): Promise<CommandResult> {
    const conn = this.conns.get(id);
    if (!conn) return Promise.resolve({ ok: false, error: 'Gerät nicht gefunden' });
    conn.applyLocal(patch);
    const result = conn.enqueue(patch, key);
    if (PRESET_KEYS.some((k) => k in patch)) void result.then(() => conn.reloadPresetsSoon());
    return result;
  }

  sendAll(patch: Record<string, unknown>): void {
    for (const conn of this.all()) {
      if (conn.status === 'online') void this.send(conn.id, patch);
    }
  }

  setLive(id: string | null): void {
    this.liveId = id;
    for (const conn of this.all()) conn.setLive(conn.id === id);
  }

  stopAll(): void {
    for (const conn of this.all()) conn.stop();
  }
}
