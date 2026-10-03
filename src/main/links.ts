// Führt Links wled-client://… aus — vom Stream Deck, aus Automationen oder einem zweiten Start der App.
// Hängt nur über übergebene Funktionen an der App, damit er sich ohne Electron testen lässt.

import { groupView, powerTargets } from '../shared/groups';
import { t } from '../shared/i18n';
import { findPreset, parseLink, planBrightness, resolveTarget, type LinkCommand, type LinkTarget } from '../shared/links';
import { failureSummary, lookFrom, type CopyResult, type GroupAction, type Look } from '../shared/look';
import { viewSeg } from '../shared/segments';
import type { CommandResult, DeviceGroup, DeviceSnapshot, DeviceStatic } from '../shared/types';

export interface LinkDeps {
  allowed(): boolean;
  devices(): DeviceSnapshot[];
  groups(): DeviceGroup[];
  staticOf(id: string): DeviceStatic | null;
  /** Die Presets des Geräts sind geladen — `staticOf` liefert sie sonst nur als leeres Gerüst. */
  presetsReady(id: string): boolean;
  send(id: string, patch: Record<string, unknown>): Promise<CommandResult>;
  applyAll(action: GroupAction, ids: string[]): Promise<CopyResult[]>;
  copyLook(look: Look, ids: string[]): Promise<CopyResult[]>;
  notify(message: string): void;
  log(line: string): void;
}

/** Höchstens so viele Links warten gleichzeitig. */
export const LINK_QUEUE_MAX = 20;
/** So lange wartet ein Link auf Geräte, die noch verbinden (Kaltstart). */
export const CONNECT_WAIT_MS = 8000;
const POLL_MS = 200;
/** So viele Zeichen eines Links kommen höchstens ins Protokoll. */
const LOG_URL_MAX = 200;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const reachable = (d: DeviceSnapshot) => d.status === 'online' && !!d.state;

/** Protokollzeile: Links kommen von außen, deshalb gekürzt und ohne Steuerzeichen (Zeilenumbrüche usw.). */
function logLine(url: string, result: string): string {
  const text = String(url);
  const shown = text.length > LOG_URL_MAX ? `${text.slice(0, LOG_URL_MAX - 1)}…` : text;
  return `${shown} → ${result}`.replace(/[\u0000-\u001f\u007f]/g, '?');
}

export class LinkRunner {
  private pending = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private deps: LinkDeps) {}

  /** Link einreihen; die Links laufen der Reihe nach. */
  handle(url: string): void {
    if (this.pending >= LINK_QUEUE_MAX) {
      this.report(url, t('Zu viele Links auf einmal'));
      return;
    }
    this.pending++;
    this.chain = this.chain
      .then(() => this.run(url))
      .finally(() => {
        this.pending--;
      });
  }

  /** Erfüllt, sobald alle eingereihten Links abgearbeitet sind (für Tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  private async run(url: string): Promise<void> {
    let error: string | null;
    try {
      error = await this.execute(url);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (error) this.report(url, error);
    else this.safe(() => this.deps.log(logLine(url, 'ok')));
  }

  private report(url: string, error: string): void {
    this.safe(() => this.deps.notify(error));
    this.safe(() => this.deps.log(logLine(url, error)));
  }

  /** Meldung und Protokoll sind Beiwerk: Wirft eines davon, läuft der Runner trotzdem weiter. */
  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // bewusst verschluckt
    }
  }

  private async execute(url: string): Promise<string | null> {
    // Ein gemeinsames Zeitbudget pro Link: Auflösen der Namen und Warten auf Geräte teilen sich die 8 s.
    const deadline = Date.now() + CONNECT_WAIT_MS;
    if (!this.deps.allowed()) return t('Links sind ausgeschaltet — einschalten in den App-Einstellungen.');
    const cmd = parseLink(url);
    if ('error' in cmd) return cmd.error;
    const target = await this.resolve(cmd.target, deadline);
    if ('error' in target) return target.error;
    let sourceId: string | undefined;
    if (cmd.action.type === 'lookFrom') {
      const src = await this.resolve({ kind: 'device', name: cmd.action.source }, deadline);
      if ('error' in src) return src.error;
      sourceId = src.ids[0];
    }
    const need = cmd.action.type === 'power' || cmd.action.type === 'brightness' ? 'connect' : cmd.action.type === 'preset' ? 'presets' : 'names';
    await this.waitReady(sourceId ? [...target.ids, sourceId] : target.ids, need, deadline);
    const all = this.deps.devices();
    const members = target.ids.map((id) => all.find((d) => d.id === id)).filter((d): d is DeviceSnapshot => !!d);
    if (!members.some(reachable)) return t('Kein Gerät erreichbar');
    return this.apply(cmd, members, sourceId ? all.find((d) => d.id === sourceId) : undefined);
  }

  /** Name → Geräte; beim Kaltstart kennt die App manche Namen erst, wenn die Geräte verbunden sind. */
  private async resolve(target: LinkTarget, deadline: number): Promise<{ ids: string[] } | { error: string }> {
    const first = resolveTarget(target, this.deps.devices(), this.deps.groups());
    if (!('error' in first) || !this.deps.devices().some((d) => d.status === 'connecting')) return first;
    await this.waitReady(
      this.deps.devices().map((d) => d.id),
      'connect',
      deadline,
    );
    return resolveTarget(target, this.deps.devices(), this.deps.groups());
  }

  /**
   * Wartet bis zur Frist, solange Geräte noch verbinden oder (bei Aussehen) ihre Namenslisten fehlen, bei Presets
   * auch diese. Geräte, die offline sind, halten nicht auf — sonst würde ein fehlendes Gruppenmitglied jeden Link verzögern.
   */
  private async waitReady(ids: string[], need: 'connect' | 'names' | 'presets', deadline: number): Promise<void> {
    const ready = () => {
      const all = this.deps.devices();
      return ids.every((id) => {
        const d = all.find((x) => x.id === id);
        if (!d || d.status === 'offline') return true;
        if (!reachable(d)) return false;
        if (need === 'connect') return true;
        return !!this.deps.staticOf(id) && (need === 'names' || this.deps.presetsReady(id));
      });
    };
    while (!ready() && Date.now() < deadline) await sleep(POLL_MS);
  }

  /**
   * Schickt die Befehle eines Links und wartet auf alle. Fehlschläge kommen wie bei Aussehen-Links in einem Hinweis —
   * sonst sähe der Link im Protokoll „ok“ aus, obwohl ein Gerät nichts bekam.
   */
  private async deliver(sends: { id: string; patch: Record<string, unknown> }[], nameOf: (id: string) => string): Promise<string | null> {
    const results = await Promise.all(
      sends.map(async ({ id, patch }): Promise<CopyResult> => {
        const sent = await this.deps.send(id, patch);
        if (sent.ok) return { id, ok: true };
        // Die Fehlermeldung beginnt mit dem Gerätenamen; er steht in der Zusammenfassung bereits davor.
        const prefix = `${nameOf(id)}: `;
        const error = sent.error?.startsWith(prefix) ? sent.error.slice(prefix.length) : sent.error;
        return { id, ok: false, reason: error || t('Übertragen fehlgeschlagen') };
      }),
    );
    return failureSummary(results, nameOf);
  }

  private async apply(cmd: LinkCommand, members: DeviceSnapshot[], source?: DeviceSnapshot): Promise<string | null> {
    const a = cmd.action;
    const ids = members.filter(reachable).map((d) => d.id);
    const nameOf = (id: string) => this.deps.devices().find((d) => d.id === id)?.name ?? id;
    switch (a.type) {
      case 'power': {
        const on = a.mode === 'toggle' ? !groupView(members).lit : a.mode === 'on';
        return this.deliver(powerTargets(members).map((id) => ({ id, patch: { on } })), nameOf);
      }
      case 'brightness':
        return this.deliver(planBrightness(members, a.value, a.relative).map(({ id, bri }) => ({ id, patch: { bri } })), nameOf);
      case 'preset': {
        const st = this.deps.staticOf(ids[0]);
        // Auch nach der Frist nicht „gibt es dort nicht“ melden, solange die Liste nur ein leeres Gerüst ist.
        if (!st || !this.deps.presetsReady(ids[0])) return t('Presets noch nicht geladen');
        const ps = findPreset(st.presets, a.ref);
        if (ps === null) return t('Preset „{name}“ gibt es dort nicht', { name: a.ref });
        return this.deliver([{ id: ids[0], patch: { ps } }], nameOf);
      }
      case 'color':
      case 'effect':
      case 'palette': {
        const action: GroupAction = a.type === 'color' ? { kind: 'solid', color: a.color } : { kind: a.type, name: a.name };
        return failureSummary(await this.deps.applyAll(action, ids), nameOf);
      }
      case 'lookFrom': {
        if (!source || !reachable(source)) return t('Kein Gerät erreichbar');
        const look = source.state?.seg.length ? lookFrom(viewSeg(source.state), this.deps.staticOf(source.id)) : null;
        if (!look) return t('Effektliste noch nicht geladen');
        if (look.pal === null) return t('Eigene Paletten lassen sich nicht übertragen');
        const targets = ids.filter((id) => id !== source.id);
        if (!targets.length) return t('Quelle und Ziel sind dasselbe Gerät');
        return failureSummary(await this.deps.copyLook(look, targets), nameOf);
      }
    }
  }
}
