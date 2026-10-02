// Gerätegruppen: Zustand und Befehle aus den Mitgliedern ableiten. Ohne Electron, damit
// Oberfläche und Tray-Menü dieselbe Rechnung nutzen und sie sich ohne App testen lässt.

import type { DeviceGroup, DeviceSnapshot } from './types';

/** Höchstlänge eines Gruppennamens — im Dialog wie bei der Prüfung im Hauptprozess. */
export const GROUP_NAME_MAX = 40;

export interface GroupView {
  /** Mindestens ein erreichbares Mitglied leuchtet. */
  lit: boolean;
  /** Bezugswert des Reglers: hellste leuchtende Lampe, sonst hellste erreichbare, sonst 128. */
  bri: number;
  /** Anzahl der Mitglieder mit Verbindung. */
  reachable: number;
}

export interface BriTarget {
  id: string;
  bri: number;
}

const reachable = (d: DeviceSnapshot): boolean => d.status === 'online' && !!d.state;
const lit = (d: DeviceSnapshot): boolean => reachable(d) && !!d.state?.on;

/** Mitglieder in der Reihenfolge der Geräteliste; IDs ohne Gerät fallen weg. */
export function groupMembers(group: DeviceGroup, devices: DeviceSnapshot[]): DeviceSnapshot[] {
  const ids = new Set(group.members);
  return devices.filter((d) => ids.has(d.id));
}

export function groupView(members: DeviceSnapshot[]): GroupView {
  const reach = members.filter(reachable);
  const on = reach.filter(lit);
  const ref = on.length ? on : reach;
  return {
    lit: on.length > 0,
    bri: ref.length ? Math.max(...ref.map((d) => d.state!.bri)) : 128,
    reachable: reach.length,
  };
}

/** Geräte, die der Gruppenschalter schaltet: alle erreichbaren Mitglieder. */
export function powerTargets(members: DeviceSnapshot[]): string[] {
  return members.filter(reachable).map((d) => d.id);
}

/**
 * Stand bei Zugbeginn: die leuchtenden erreichbaren Mitglieder. Ausgeschaltete bleiben aus,
 * weil WLED eine Lampe einschaltet, sobald sie eine Helligkeit bekommt. Leuchtet keins, alle
 * erreichbaren — der Regler schaltet die Gruppe dann ein.
 */
export function brightnessBase(members: DeviceSnapshot[]): BriTarget[] {
  const reach = members.filter(reachable);
  const on = reach.filter(lit);
  return (on.length ? on : reach).map((d) => ({ id: d.id, bri: d.state!.bri }));
}

/** Anteilige Helligkeit: Die hellste Lampe bekommt `v`, die anderen im selben Verhältnis (1–255). */
export function scaleBrightness(base: BriTarget[], v: number): BriTarget[] {
  const max = Math.max(1, ...base.map((b) => b.bri));
  return base.map((b) => ({ id: b.id, bri: Math.min(255, Math.max(1, Math.round((b.bri * v) / max))) }));
}
