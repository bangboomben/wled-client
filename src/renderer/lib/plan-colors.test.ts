import { describe, expect, it } from 'vitest';
import type { DeviceSnapshot, WledSegment, WledState } from '../../shared/types';
import { parseFrame, rgbCss, staticColors } from './plan-colors';

const seg = (start: number, stop: number, col: number[], on = true) => ({ id: start, start, stop, on, col: [col] }) as unknown as WledSegment;
const dev = (patch: Partial<DeviceSnapshot>, segs: WledSegment[] = [seg(0, 10, [255, 0, 0])], on = true): DeviceSnapshot => ({
  id: 'a',
  host: 'h',
  name: 'Desk',
  status: 'online',
  staticRev: 0,
  state: { on, bri: 255, seg: segs } as unknown as WledState,
  info: { leds: { count: 10, maxseg: 32 } } as DeviceSnapshot['info'],
  ...patch,
});

describe('parseFrame', () => {
  it('Version 1: RGB je Wert', () => {
    expect(parseFrame(Uint8Array.from([0x4c, 1, 255, 0, 0, 0, 0, 255]))).toEqual({ colors: [[255, 0, 0], [0, 0, 255]] });
  });
  it('Version 2: Breite und Höhe der Matrix', () => {
    expect(parseFrame(Uint8Array.from([0x4c, 2, 2, 1, 1, 2, 3, 4, 5, 6]))).toEqual({ colors: [[1, 2, 3], [4, 5, 6]], w: 2, h: 1 });
  });
  it('kein Live-Bild oder leer → null', () => {
    expect(parseFrame(Uint8Array.from([0x41, 1, 1, 2, 3]))).toBeNull();
    expect(parseFrame(Uint8Array.from([0x4c, 1]))).toBeNull();
  });
  it('rgbCss', () => {
    expect(rgbCss([1, 2, 3])).toBe('rgb(1, 2, 3)');
  });
});

describe('staticColors', () => {
  it('jede Position in der ersten Farbe ihres Segments', () => {
    const d = dev({}, [seg(0, 5, [255, 0, 0]), seg(5, 10, [0, 0, 255])]);
    expect(staticColors(d, 4)).toEqual(['rgb(255, 0, 0)', 'rgb(255, 0, 0)', 'rgb(0, 0, 255)', 'rgb(0, 0, 255)']);
  });
  it('Segment aus oder Lücke → dunkel (null)', () => {
    const d = dev({}, [seg(0, 5, [255, 0, 0], false)]);
    expect(staticColors(d, 2)).toEqual([null, null]);
  });
  it('Gerät aus, offline oder ohne Daten → dunkel', () => {
    expect(staticColors(dev({}, undefined, false), 2)).toEqual([null, null]);
    expect(staticColors(dev({ status: 'offline' }), 2)).toEqual([null, null]);
    expect(staticColors(dev({ state: undefined, info: undefined }), 2)).toEqual([null, null]);
  });
  it('ohne info: eine LED je Position angenommen', () => {
    expect(staticColors(dev({ info: undefined }), 1)).toEqual(['rgb(255, 0, 0)']);
  });
  it('n = 0 → leer', () => {
    expect(staticColors(dev({}), 0)).toEqual([]);
  });
});
