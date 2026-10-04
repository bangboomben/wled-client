// Farben für den Raumplan: Live-Bilder von WLED zerlegen; ohne Live-Daten die Segmentfarben wie im Farbbalken.

import type { DeviceSnapshot } from '../../shared/types';
import { displayColor } from './wled';

export type Rgb = [number, number, number];

/** Live-Bild: Farben in LED-Reihenfolge; bei einer Matrix zusätzlich Breite und Höhe. */
export interface LiveFrame {
  colors: Rgb[];
  w?: number;
  h?: number;
}

/** WLED-Live-Bild: 'L', Version (1 = Streifen, 2 = Matrix mit Breite und Höhe), dann RGB je Wert. */
export function parseFrame(frame: Uint8Array): LiveFrame | null {
  if (frame.length < 2 || frame[0] !== 0x4c) return null;
  const matrix = frame[1] === 2 && frame.length >= 4;
  const offset = matrix ? 4 : 2;
  const n = Math.floor((frame.length - offset) / 3);
  if (n <= 0) return null;
  const colors: Rgb[] = [];
  for (let i = 0; i < n; i++) colors.push([frame[offset + i * 3], frame[offset + i * 3 + 1], frame[offset + i * 3 + 2]]);
  return matrix ? { colors, w: frame[2], h: frame[3] } : { colors };
}

export const rgbCss = (c: Rgb) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

/**
 * Farben ohne Live-Daten für n Positionen: jede in der ersten Farbe ihres Segments (wie der Farbbalken der
 * Geräteansicht). null = dunkel (Gerät aus oder nicht erreichbar, Segment aus, Lücke zwischen Segmenten).
 */
export function staticColors(device: DeviceSnapshot, n: number): Array<string | null> {
  if (n <= 0) return [];
  const state = device.state;
  if (device.status !== 'online' || !state?.on) return Array<string | null>(n).fill(null);
  const count = Math.max(1, device.info?.leds.count ?? n);
  return Array.from({ length: n }, (_, i) => {
    const led = n === 1 ? 0 : Math.round((i * (count - 1)) / (n - 1));
    const seg = state.seg.find((s) => led >= s.start && led < s.stop);
    return seg?.on ? displayColor(seg.col[0]) : null;
  });
}
