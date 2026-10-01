import { useEffect, useRef, useState } from 'react';
import type { Color } from '../../shared/types';
import { hsvToRgb, rgbCss, rgbToHsv } from '../lib/wled';

/** Farbkreis: Winkel = Farbton, Abstand zur Mitte = Sättigung. Die Helligkeit regelt ein eigener Regler. */
export function ColorWheel({
  color,
  onChange,
  size = 248,
  disabled,
}: {
  color: Color;
  onChange: (c: Color) => void;
  size?: number;
  disabled?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<[number, number] | null>(null);
  const dragging = useRef(false);
  const [h0, s0, v] = rgbToHsv(color);
  const [h, s] = drag ?? [h0, s0];

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(size * dpr);
    el.width = px;
    el.height = px;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(px, px);
    const r = px / 2;
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        const dx = x - r + 0.5;
        const dy = y - r + 0.5;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const i = (y * px + x) * 4;
        if (dist > r) continue;
        const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
        const [cr, cg, cb] = hsvToRgb(hue, Math.min(1, dist / r), 1);
        img.data[i] = cr;
        img.data[i + 1] = cg;
        img.data[i + 2] = cb;
        img.data[i + 3] = Math.round(Math.min(1, r - dist) * 255); // weiche Kante
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [size]);

  const pick = (clientX: number, clientY: number) => {
    const rect = canvas.current!.getBoundingClientRect();
    const R = rect.width / 2;
    const dx = clientX - rect.left - R;
    const dy = clientY - rect.top - R;
    const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    const sat = Math.min(1, Math.sqrt(dx * dx + dy * dy) / R);
    setDrag([hue, sat]);
    onChange(hsvToRgb(hue, sat, v < 0.05 ? 1 : v));
  };

  const rad = (h * Math.PI) / 180;
  const mx = size / 2 + Math.cos(rad) * s * (size / 2);
  const my = size / 2 + Math.sin(rad) * s * (size / 2);
  const markerColor = hsvToRgb(h, s, 1);

  return (
    <div
      className={`wheel${disabled ? ' disabled' : ''}`}
      style={{ width: size, height: size }}
      onPointerDown={(e) => {
        if (disabled) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        dragging.current = true;
        pick(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (dragging.current) pick(e.clientX, e.clientY);
      }}
      onPointerUp={() => {
        dragging.current = false;
        window.setTimeout(() => {
          if (!dragging.current) setDrag(null);
        }, 800);
      }}
    >
      <canvas ref={canvas} style={{ width: size, height: size }} aria-label="Farbkreis" role="img" />
      <span className="wheel-marker" style={{ left: mx, top: my, background: rgbCss(markerColor) }} />
    </div>
  );
}
