import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CopyResult, GroupAction, Look } from '../shared/look';
import type { DeviceGroup, DeviceSnapshot, DeviceStatic, WledState } from '../shared/types';
import { LINK_QUEUE_MAX, LinkRunner, type LinkDeps } from './links';

/** Gerät mit einem Segment; „verbindet“ hat noch keinen Zustand. */
function dev(id: string, opts: { name?: string; status?: DeviceSnapshot['status']; on?: boolean; bri?: number; fx?: number; pal?: number } = {}): DeviceSnapshot {
  const { name = `Lampe ${id}`, status = 'online', on = true, bri = 128, fx = 0, pal = 0 } = opts;
  const seg = { id: 0, fx, pal, sx: 128, ix: 128, c1: 0, c2: 0, c3: 0, o1: false, o2: false, o3: false, col: [[255, 0, 0]], sel: true };
  return {
    id,
    host: '192.0.2.10',
    name,
    status,
    staticRev: 1,
    state: status === 'connecting' ? undefined : ({ on, bri, mainseg: 0, seg: [seg] } as unknown as WledState),
  };
}

const ST: DeviceStatic = { effects: ['Solid', 'Rainbow'], palettes: ['Default', 'Party'], fxdata: [], presets: { '0': {}, '3': { n: 'Abend' } } };
const OFF_TEXT = 'Links sind ausgeschaltet — einschalten in den App-Einstellungen.';

function setup(devices: DeviceSnapshot[], opts: { allowed?: boolean; groups?: DeviceGroup[] } = {}) {
  let list = devices;
  const deps = {
    allowed: () => opts.allowed ?? true,
    devices: () => list,
    groups: () => opts.groups ?? [],
    staticOf: vi.fn((_id: string): DeviceStatic | null => ST),
    send: vi.fn((_id: string, _patch: Record<string, unknown>) => {}),
    applyAll: vi.fn(async (_a: GroupAction, ids: string[]): Promise<CopyResult[]> => ids.map((id) => ({ id, ok: true }))),
    copyLook: vi.fn(async (_l: Look, ids: string[]): Promise<CopyResult[]> => ids.map((id) => ({ id, ok: true }))),
    notify: vi.fn((_m: string) => {}),
    log: vi.fn((_l: string) => {}),
  } satisfies LinkDeps;
  return { runner: new LinkRunner(deps), deps, setDevices: (d: DeviceSnapshot[]) => (list = d) };
}

afterEach(() => vi.useRealTimers());

describe('LinkRunner', () => {
  it('führt bei ausgeschalteter Einstellung nichts aus und meldet es', async () => {
    const { runner, deps } = setup([dev('a')], { allowed: false });
    runner.handle('wled-client://all/off');
    await runner.idle();
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith(OFF_TEXT);
    expect(deps.log).toHaveBeenCalledWith(`wled-client://all/off → ${OFF_TEXT}`);
  });

  it('schaltet eine Gruppe aus — offline Mitglieder halten nicht auf und werden übersprungen', async () => {
    const groups = [{ id: 'g', name: 'Abend', members: ['a', 'b', 'c'] }];
    const { runner, deps } = setup([dev('a'), dev('b', { status: 'offline' }), dev('c', { on: false })], { groups });
    runner.handle('wled-client://group/abend/off');
    await runner.idle();
    expect(deps.send.mock.calls).toEqual([
      ['a', { on: false }],
      ['c', { on: false }],
    ]);
    expect(deps.log).toHaveBeenCalledWith('wled-client://group/abend/off → ok');
  });

  it('schaltet beim Umschalten alle aus, wenn eins leuchtet, sonst alle an', async () => {
    const { runner, deps, setDevices } = setup([dev('a'), dev('c', { on: false })]);
    runner.handle('wled-client://all/toggle');
    await runner.idle();
    expect(deps.send.mock.calls).toEqual([
      ['a', { on: false }],
      ['c', { on: false }],
    ]);
    deps.send.mockClear();
    setDevices([dev('a', { on: false }), dev('c', { on: false })]);
    runner.handle('wled-client://all/toggle');
    await runner.idle();
    expect(deps.send.mock.calls).toEqual([
      ['a', { on: true }],
      ['c', { on: true }],
    ]);
  });

  it('dimmt schrittweise', async () => {
    const { runner, deps } = setup([dev('a', { bri: 128 })]);
    runner.handle('wled-client://device/Lampe%20a/brightness/+10');
    await runner.idle();
    expect(deps.send.mock.calls).toEqual([['a', { bri: 153 }]]);
  });

  it('wendet ein Preset beim Namen an und meldet unbekannte', async () => {
    const { runner, deps } = setup([dev('a')]);
    runner.handle('wled-client://device/Lampe%20a/preset/abend');
    runner.handle('wled-client://device/Lampe%20a/preset/Morgen');
    await runner.idle();
    expect(deps.send.mock.calls).toEqual([['a', { ps: 3 }]]);
    expect(deps.notify).toHaveBeenCalledWith('Preset „Morgen“ gibt es dort nicht');
  });

  it('gibt Farbe, Effekt und Palette an applyAll weiter und meldet Fehlschläge', async () => {
    const { runner, deps } = setup([dev('a'), dev('b')]);
    deps.applyAll.mockResolvedValueOnce([
      { id: 'a', ok: true },
      { id: 'b', ok: false, reason: 'Offline' },
    ]);
    runner.handle('wled-client://all/color/ff0000');
    runner.handle('wled-client://all/effect/Rainbow');
    await runner.idle();
    expect(deps.applyAll.mock.calls).toEqual([
      [{ kind: 'solid', color: [255, 0, 0] }, ['a', 'b']],
      [{ kind: 'effect', name: 'Rainbow' }, ['a', 'b']],
    ]);
    expect(deps.notify).toHaveBeenCalledWith('Nicht übernommen · Lampe b: Offline');
  });

  it('überträgt den Look der Quelle auf das Ziel, aber nicht auf sich selbst', async () => {
    const { runner, deps } = setup([dev('a', { fx: 1, pal: 1 }), dev('b')]);
    runner.handle('wled-client://device/Lampe%20b/look-from/Lampe%20a');
    runner.handle('wled-client://device/Lampe%20a/look-from/Lampe%20a');
    await runner.idle();
    const look = {
      fx: 'Rainbow',
      pal: 'Party',
      col: [
        [255, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      sx: 128,
      ix: 128,
      c1: 0,
      c2: 0,
      c3: 0,
      o1: false,
      o2: false,
      o3: false,
    };
    expect(deps.copyLook.mock.calls).toEqual([[look, ['b']]]);
    expect(deps.notify).toHaveBeenCalledWith('Quelle und Ziel sind dasselbe Gerät');
  });

  it('meldet unbekannte Namen', async () => {
    const { runner, deps } = setup([dev('a')]);
    runner.handle('wled-client://device/Nix/off');
    await runner.idle();
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith('Gerät „Nix“ gibt es nicht');
  });

  it('wartet beim Kaltstart auf verbindende Geräte, auch wenn deren Name noch fehlt', async () => {
    vi.useFakeTimers();
    const { runner, deps, setDevices } = setup([dev('a', { name: '192.0.2.10', status: 'connecting' })]);
    runner.handle('wled-client://device/Lampe%20a/on');
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.send).not.toHaveBeenCalled();
    setDevices([dev('a', { on: false })]);
    await vi.advanceTimersByTimeAsync(400);
    await runner.idle();
    expect(deps.send.mock.calls).toEqual([['a', { on: true }]]);
  });

  it('gibt nach 8 s auf, wenn ein Gerät weiter verbindet', async () => {
    vi.useFakeTimers();
    const { runner, deps } = setup([dev('a', { status: 'connecting' })]);
    runner.handle('wled-client://device/Lampe%20a/on');
    await vi.advanceTimersByTimeAsync(8200);
    await runner.idle();
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith('Kein Gerät erreichbar');
  });

  it('arbeitet der Reihe nach und verwirft Links über der Grenze', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { runner, deps } = setup([dev('a')]);
    deps.applyAll.mockImplementation(async (_a, ids) => {
      await gate;
      return ids.map((id) => ({ id, ok: true }));
    });
    for (let i = 0; i < LINK_QUEUE_MAX; i++) runner.handle('wled-client://all/effect/Rainbow');
    runner.handle('wled-client://all/off');
    expect(deps.notify).toHaveBeenCalledWith('Zu viele Links auf einmal');
    release();
    await runner.idle();
    expect(deps.applyAll).toHaveBeenCalledTimes(LINK_QUEUE_MAX);
    expect(deps.send).not.toHaveBeenCalled();
  });
});
