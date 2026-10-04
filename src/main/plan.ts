import { EventEmitter } from 'node:events';
import type { RoomPlan } from '../shared/types';
import type { Store } from './store';
import { cleanPlan } from './store-data';

/** Was der PlanManager vom Store braucht — im Test reicht ein einfacher Ersatz. */
export type PlanStore = Pick<Store, 'getPlan' | 'setPlan'>;

/** Raumplan: übernimmt geprüfte Pläne aus der Oberfläche, nimmt gelöschte Geräte heraus; meldet jede Änderung als 'plan'. */
export class PlanManager extends EventEmitter {
  private plan: RoomPlan;

  constructor(
    private store: PlanStore,
    private deviceIds: () => string[],
  ) {
    super();
    this.plan = store.getPlan();
  }

  get(): RoomPlan {
    return structuredClone(this.plan);
  }

  /** Übernimmt einen Plan (Ungültiges fällt weg) und gibt den gespeicherten Plan zurück. */
  set(raw: unknown): RoomPlan {
    this.plan = cleanPlan(raw, this.deviceIds());
    this.changed();
    return this.get();
  }

  placedIds(): string[] {
    return this.plan.items.map((i) => i.deviceId);
  }

  pruneDevices(deviceIds: string[]): void {
    const known = new Set(deviceIds);
    const items = this.plan.items.filter((i) => known.has(i.deviceId));
    if (items.length === this.plan.items.length) return;
    this.plan = { ...this.plan, items };
    this.changed();
  }

  private changed(): void {
    this.store.setPlan(this.plan);
    this.emit('plan', this.get());
  }
}
