import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { t } from '../shared/i18n';
import type { CommandResult, DeviceGroup } from '../shared/types';
import type { Store } from './store';
import { checkGroup } from './store-data';

/** Was der GroupManager vom Store braucht — im Test reicht ein einfacher Ersatz. */
export type GroupStore = Pick<Store, 'getGroups' | 'setGroups'>;

type GroupInput = { name: unknown; members: unknown };

/** Gerätegruppen: anlegen, ändern, löschen, speichern; meldet jede Änderung als 'groups'. */
export class GroupManager extends EventEmitter {
  private groups: DeviceGroup[];

  constructor(
    private store: GroupStore,
    private deviceIds: () => string[],
  ) {
    super();
    this.groups = store.getGroups();
  }

  list(): DeviceGroup[] {
    return this.groups.map((g) => ({ ...g, members: [...g.members] }));
  }

  create(input: GroupInput): CommandResult & { id?: string } {
    const r = checkGroup(input, this.groups, this.deviceIds());
    if (!r.ok) return { ok: false, error: r.error };
    const id = randomUUID();
    this.groups = [...this.groups, { id, name: r.name, members: r.members }];
    this.changed();
    return { ok: true, id };
  }

  update(id: string, input: GroupInput): CommandResult {
    if (!this.groups.some((g) => g.id === id)) return { ok: false, error: t('Gruppe nicht gefunden') };
    const r = checkGroup(input, this.groups, this.deviceIds(), id);
    if (!r.ok) return { ok: false, error: r.error };
    this.groups = this.groups.map((g) => (g.id === id ? { id, name: r.name, members: r.members } : g));
    this.changed();
    return { ok: true };
  }

  remove(id: string): void {
    const next = this.groups.filter((g) => g.id !== id);
    if (next.length === this.groups.length) return;
    this.groups = next;
    this.changed();
  }

  /** Nimmt Geräte, die es nicht mehr gibt, aus allen Gruppen; leere Gruppen bleiben stehen. */
  pruneDevices(deviceIds: string[]): void {
    const known = new Set(deviceIds);
    let changed = false;
    this.groups = this.groups.map((g) => {
      const members = g.members.filter((m) => known.has(m));
      if (members.length === g.members.length) return g;
      changed = true;
      return { ...g, members };
    });
    if (changed) this.changed();
  }

  private changed(): void {
    this.store.setGroups(this.groups);
    this.emit('groups', this.list());
  }
}
