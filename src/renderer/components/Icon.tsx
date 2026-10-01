import type { CSSProperties } from 'react';

// Schlichte Linien-Icons (24er Raster, Strichstärke 2), selbst gezeichnet.
const PATHS: Record<string, string> = {
  power: 'M12 3v8 M6.4 6.6a8 8 0 1 0 11.2 0',
  sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8 M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  sync: 'M4 12a8 8 0 0 1 13.7-5.6L20 9 M20 4v5h-5 M20 12a8 8 0 0 1-13.7 5.6L4 15 M4 20v-5h5',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
  info: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20 M12 11v6 M12 7.5v.01',
  globe: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20 M2 12h20 M12 2c3 3.2 3 16.8 0 20 M12 2c-3 3.2-3 16.8 0 20',
  gear: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6 M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14 M5 12h14',
  x: 'M6 6l12 12 M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14 M20 20l-3.5-3.5',
  trash: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3',
  edit: 'M4 20h4L19 9l-4-4L4 16v4z M13.5 6.5l4 4',
  play: 'M7 4.5v15l12-7.5-12-7.5z',
  chevron: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  grip: 'M9 6h.01 M15 6h.01 M9 12h.01 M15 12h.01 M9 18h.01 M15 18h.01',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7',
  list: 'M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01',
  save: 'M5 3h11l4 4v14H4V3z M8 3v5h7V3 M8 21v-7h8v7',
  layers: 'M12 3l9 5-9 5-9-5 9-5z M3 13l9 5 9-5 M3 17.5l9 5 9-5',
  palette: 'M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-4-4-7.2-9-7.2z M7.5 11.5h.01 M9.5 7.5h.01 M14.5 7.5h.01',
  sparkles: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z',
  droplet: 'M12 3s6 6.4 6 11a6 6 0 1 1-12 0c0-4.6 6-11 6-11z',
  bookmark: 'M6 3h12v18l-6-4-6 4V3z',
  wifi: 'M2 8.8a15 15 0 0 1 20 0 M5 12.5a10 10 0 0 1 14 0 M8.5 16a5 5 0 0 1 7 0 M12 19.5h.01',
  external: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  bulb: 'M9 18h6 M10 21h4 M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z',
  shuffle: 'M3 6h4l10 12h4 M17 15l3 3-3 3 M3 18h4l3-3.6 M14 9.6L17 6h4 M17 3l3 3-3 3',
  reboot: 'M12 3v4 M6.4 6.6a8 8 0 1 0 11.2 0',
  upload: 'M12 16V4 M7 9l5-5 5 5 M4 20h16',
};

export function Icon({ name, size = 18, style, className }: { name: string; size?: number; style?: CSSProperties; className?: string }) {
  const d = PATHS[name] ?? PATHS.info;
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="lg-ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff4d6d" />
          <stop offset="0.35" stopColor="#ffb703" />
          <stop offset="0.65" stopColor="#3ddc97" />
          <stop offset="1" stopColor="#4cc9f0" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="11" fill="none" stroke="url(#lg-ring)" strokeWidth="5" />
      <circle cx="16" cy="16" r="3.2" fill="#fff" />
    </svg>
  );
}
