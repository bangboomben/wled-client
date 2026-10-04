import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { t } from '../shared/i18n';
import { actionPatch, lookPatch, type CopyResult, type GroupAction, type Look } from '../shared/look';
import type { CommandResult, DeviceConfig, DeviceSnapshot, DeviceStatic, WledState } from '../shared/types';
import { DeviceConnection, normalizeHost, probeInfo } from './device';
import type { Store } from './store';

/** Befehle, nach denen sich presets.json ändert. */
const PRESET_KEYS = ['psave', 'pdel'];

export class DeviceManager extends EventEmitter {
  private conns = new Map<string, DeviceConnection>();
  private order: string[] = [];
  private pendingUpdates = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;

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
    if (!host) return { ok: false, error: t('Bitte eine IP-Adresse oder einen Hostnamen eingeben.') };
    const byHost = this.all().find((c) => c.host === host);
    if (byHost) return { ok: true, id: byHost.id };
    let info;
    try {
      info = await probeInfo(host, 6000);
    } catch {
      return { ok: false, error: t('Unter {host} antwortet kein WLED-Gerät.', { host }) };
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
    this.listChanged();
  }

  async update(id: string, changes: { alias?: string; host?: string }): Promise<CommandResult> {
    const conn = this.conns.get(id);
    if (!conn) return { ok: false, error: t('Gerät nicht gefunden') };
    // Erst alles prüfen, dann ändern: Bei einer Fehlermeldung bleibt auch der Name, wie er war.
    let newHost: string | undefined;
    if (changes.host !== undefined) {
      const host = normalizeHost(changes.host);
      if (!host) return { ok: false, error: t('Adresse fehlt') };
      if (host !== conn.host) {
        try {
          await probeInfo(host, 6000);
        } catch {
          return { ok: false, error: t('Unter {host} antwortet kein WLED-Gerät.', { host }) };
        }
        newHost = host;
      }
    }
    if (changes.alias !== undefined) conn.config.alias = changes.alias.trim() || undefined;
    if (newHost) conn.setHost(newHost);
    this.listChanged();
    return { ok: true };
  }

  reorder(ids: string[]): void {
    const known = [...new Set(ids)].filter((id) => this.conns.has(id));
    const rest = this.order.filter((id) => !known.includes(id));
    this.order = [...known, ...rest];
    this.listChanged();
  }

  /** `confirm`: Aktion, die erst mit der Antwort des Geräts als erledigt gilt; `quiet`: kein Toast bei Fehlschlag (siehe DeviceConnection.enqueue). */
  send(id: string, patch: Record<string, unknown>, key?: string, confirm = false, quiet = false): Promise<CommandResult> {
    const conn = this.conns.get(id);
    if (!conn) return Promise.resolve({ ok: false, error: t('Gerät nicht gefunden') });
    conn.applyLocal(patch);
    const result = conn.enqueue(patch, key, confirm, quiet);
    if (PRESET_KEYS.some((k) => k in patch)) void result.then(() => conn.reloadPresetsSoon());
    return result;
  }

  sendAll(patch: Record<string, unknown>): void {
    for (const conn of this.all()) {
      if (conn.status === 'online') void this.send(conn.id, patch);
    }
  }

  /** Je Gerät einen Befehl bauen und mit Bestätigung still senden; Ergebnis je Gerät. */
  applyEach(
    ids: string[],
    build: (state: WledState, st: DeviceStatic | null) => { patch: Record<string, unknown> } | { reason: string },
  ): Promise<CopyResult[]> {
    return Promise.all(
      ids.map(async (id): Promise<CopyResult> => {
        const conn = this.conns.get(id);
        if (!conn) return { id, ok: false, reason: t('Gerät nicht gefunden') };
        if (conn.status !== 'online' || !conn.state) return { id, ok: false, reason: t('Offline') };
        const r = build(conn.state, conn.staticData);
        if ('reason' in r) return { id, ok: false, reason: r.reason };
        // Leise senden: Die Zusammenfassung der Oberfläche nennt das Gerät schon, ein eigener Toast käme doppelt.
        const sent = await this.send(id, r.patch, undefined, true, true);
        if (sent.ok) return { id, ok: true };
        // Die Fehlermeldung beginnt mit dem Gerätenamen; er steht in der Zusammenfassung bereits davor.
        const prefix = `${conn.displayName}: `;
        const error = sent.error?.startsWith(prefix) ? sent.error.slice(prefix.length) : sent.error;
        return { id, ok: false, reason: error || t('Übertragen fehlgeschlagen') };
      }),
    );
  }

  /** Look auf Geräte übertragen. */
  copyLook(look: Look, ids: string[]): Promise<CopyResult[]> {
    return this.applyEach(ids, (state, st) => lookPatch(look, state, st));
  }

  /** Schnellfarbe, Effekt oder Palette „für alle“ auf Geräte anwenden. */
  applyAll(action: GroupAction, ids: string[]): Promise<CopyResult[]> {
    return this.applyEach(ids, (state, st) => actionPatch(action, state, st));
  }

  setLive(ids: readonly string[]): void {
    const on = new Set(ids);
    for (const conn of this.all()) conn.setLive(on.has(conn.id));
  }

  stopAll(): void {
    for (const conn of this.all()) conn.stop();
  }
}
