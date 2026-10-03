import { useEffect, useState } from 'react';
import { key, t } from '../../../shared/i18n';
import type { Color, DeviceSnapshot, DeviceStatic, WledState } from '../../../shared/types';
import { readLocal, send, writeLocal } from '../../lib/store';
import {
  colPatch,
  displayColor,
  fromHex,
  hsvToRgb,
  lightCaps,
  parseFx,
  rgbCss,
  rgbToHsv,
  segPatch,
  toHex,
  viewSeg,
} from '../../lib/wled';
import { ColorWheel } from '../ColorWheel';
import { Icon } from '../Icon';
import { Slider } from '../controls';

export const QUICK: Array<{ c: Color; label: string }> = [
  { c: [255, 0, 0], label: key('Rot') },
  { c: [255, 160, 0], label: key('Orange') },
  { c: [255, 200, 0], label: key('Gelb') },
  { c: [255, 224, 160], label: key('Warmweiß') },
  { c: [255, 255, 255], label: key('Weiß') },
  { c: [0, 0, 0], label: key('Schwarz (aus)') },
  { c: [255, 0, 220], label: key('Pink') },
  { c: [0, 0, 255], label: key('Blau') },
  { c: [0, 255, 200], label: key('Türkis') },
  { c: [8, 255, 0], label: key('Grün') },
];

const SLOT_NAMES = [key('Farbe 1'), key('Farbe 2'), key('Farbe 3')];

export function ColorsTab({ device, state, st }: { device: DeviceSnapshot; state: WledState; st: DeviceStatic | null }) {
  const seg = viewSeg(state);
  const meta = parseFx(seg.fx, st?.fxdata ?? []);
  const caps = lightCaps(seg, device.info);
  const rgbw = caps.white || !!device.info?.leds.rgbw;
  const [slot, setSlot] = useState(0);
  const activeSlot = meta.colors.some((c) => c.slot === slot) ? slot : meta.colors[0].slot;

  const cur = seg.col[activeSlot] ?? [0, 0, 0];
  const rgb = cur.slice(0, 3);
  const w = cur[3] ?? 0;
  const [h, s, v] = rgbToHsv(rgb);

  const [hex, setHex] = useState(toHex(rgb));
  useEffect(() => setHex(toHex(rgb)), [rgb[0], rgb[1], rgb[2]]);

  // Die RGB-Regler braucht kaum jemand ständig: zugeklappt, bis man sie holt, und so gemerkt
  const [rgbOpen, setRgbOpen] = useState(() => readLocal<boolean>('wled.rgbOpen', false));
  useEffect(() => writeLocal('wled.rgbOpen', rgbOpen), [rgbOpen]);

  const sendColor = (c: Color) =>
    send(device.id, segPatch(state, { col: colPatch(activeSlot, c) }), `col${activeSlot}`);
  const setRgb = (next: Color) => sendColor(rgbw ? [...next.slice(0, 3), w] : next.slice(0, 3));
  const setChannel = (i: number, val: number) => {
    const next = [...rgb];
    next[i] = val;
    setRgb(next);
  };

  const commitHex = () => {
    const c = fromHex(hex);
    if (c) setRgb(c);
    else setHex(toHex(rgb));
  };

  const channelTrack = (i: number) => {
    const lo = [...rgb];
    const hi = [...rgb];
    lo[i] = 0;
    hi[i] = 255;
    return `linear-gradient(90deg, ${rgbCss(lo)}, ${rgbCss(hi)})`;
  };

  return (
    <div className="colors-layout">
      <section className="panel wheel-panel">
        <ColorWheel color={rgb} onChange={setRgb} />
        <div className="field">
          <span>
            {t('Farbhelligkeit')} <span className="val">{t('{n} %', { n: Math.round(v * 100) })}</span>
          </span>
          <Slider
            variant="gradient"
            track={`linear-gradient(90deg, #000, ${rgbCss(hsvToRgb(h, s, 1))})`}
            value={Math.round(v * 255)}
            label={t('Farbhelligkeit')}
            onChange={(nv) => setRgb(hsvToRgb(h, s, nv / 255))}
          />
        </div>
      </section>

      <div className="color-side">
        <section className="panel">
          <div className="panel-head">
            <h3>{t('Farbslots')}</h3>
            <span className="muted small">{t('Welche Slots ein Effekt nutzt, legt der Effekt fest.')}</span>
          </div>
          <div className="slots">
            {[0, 1, 2].map((i) => {
              const used = meta.colors.find((c) => c.slot === i);
              return (
                <button
                  key={i}
                  className={`slot${i === activeSlot ? ' active' : ''}`}
                  disabled={!used}
                  title={used ? t(used.label) : t('Vom aktuellen Effekt nicht genutzt')}
                  onClick={() => setSlot(i)}
                >
                  <span className="swatch" style={{ background: displayColor(seg.col[i]) }} />
                  <span className="slot-label">{t(used?.label ?? SLOT_NAMES[i])}</span>
                </button>
              );
            })}
          </div>
          <div className="hex-row">
            <span className="swatch big" style={{ background: displayColor(cur) }} />
            <label className="hex-input">
              <span>#</span>
              <input
                value={hex}
                maxLength={7}
                spellCheck={false}
                aria-label={t('Hex-Farbwert')}
                onChange={(e) => setHex(e.target.value.replace('#', ''))}
                onBlur={commitHex}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitHex();
                }}
              />
            </label>
            <button
              className="rgb-toggle"
              aria-expanded={rgbOpen}
              title={rgbOpen ? t('RGB-Regler ausblenden') : t('RGB-Regler einblenden')}
              onClick={() => setRgbOpen((o) => !o)}
            >
              <span className="rgb-toggle-label">RGB</span>
              <span className="mono">
                {rgb.join(', ')}
                {rgbw ? `, W ${w}` : ''}
              </span>
              <Icon name="chevron" size={14} style={{ transform: rgbOpen ? 'rotate(180deg)' : undefined }} />
            </button>
          </div>
        </section>

        {(rgbOpen || rgbw || caps.cct) && (
          <section className="panel">
            {rgbOpen &&
              [key('Rot'), key('Grün'), key('Blau')].map((label, i) => (
                <div className="field" key={label}>
                  <span>
                    {t(label)} <span className="val">{rgb[i]}</span>
                  </span>
                  <Slider variant="gradient" track={channelTrack(i)} value={rgb[i]} label={t(label)} onChange={(nv) => setChannel(i, nv)} />
                </div>
              ))}
            {rgbw && (
              <div className="field">
                <span>
                  {t('Weiß (W-Kanal)')} <span className="val">{w}</span>
                </span>
                <Slider
                  variant="gradient"
                  track="linear-gradient(90deg, #2a2620, #fff3d6)"
                  value={w}
                  label={t('Weißkanal')}
                  onChange={(nv) => sendColor([...rgb, nv])}
                />
              </div>
            )}
            {caps.cct && (
              <div className="field">
                <span>
                  {t('Farbtemperatur')} <span className="val">{seg.cct}</span>
                </span>
                <Slider
                  variant="gradient"
                  track="linear-gradient(90deg, #ff9d3c, #fff1dc, #cfe0ff)"
                  value={seg.cct}
                  label={t('Farbtemperatur')}
                  onChange={(nv) => send(device.id, segPatch(state, { cct: nv }), 'cct')}
                />
              </div>
            )}
          </section>
        )}

        <section className="panel">
          <div className="panel-head">
            <h3>{t('Schnellfarben')}</h3>
          </div>
          <div className="quick">
            {QUICK.map((q) => (
              <button key={q.label} className="quick-btn" title={t(q.label)} aria-label={t(q.label)} style={{ background: rgbCss(q.c) }} onClick={() => setRgb(q.c)} />
            ))}
            {rgbw && (
              <button
                className="quick-btn quick-w"
                title={t('Reines Weiß über den W-Kanal')}
                aria-label={t('Reines Weiß über den W-Kanal')}
                onClick={() => sendColor([0, 0, 0, 255])}
              >
                W
              </button>
            )}
            <button
              className="quick-btn quick-random"
              title={t('Zufällige Farbe')}
              aria-label={t('Zufällige Farbe')}
              onClick={() => setRgb(hsvToRgb(Math.random() * 360, 0.7 + Math.random() * 0.3, 1))}
            >
              ?
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
