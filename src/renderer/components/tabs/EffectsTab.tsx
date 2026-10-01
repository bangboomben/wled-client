import { useEffect, useMemo, useRef, useState } from 'react';
import { key, t } from '../../../shared/i18n';
import type { DeviceSnapshot, DeviceStatic, WledState } from '../../../shared/types';
import { send, usePalx } from '../../lib/store';
import { effectList, paletteGradient, paletteList, parseFx, segPatch, viewSeg } from '../../lib/wled';
import { SearchInput, Slider, Toggle } from '../controls';
import { Icon } from '../Icon';

const FILTERS = [
  { id: 'pal', label: key('Mit Palette') },
  { id: '1', label: '1D' },
  { id: '2', label: '2D' },
  { id: 'v', label: key('♪ Lautstärke') },
  { id: 'f', label: key('♫ Frequenz') },
];

function ListSkeleton() {
  return (
    <div className="skeleton-list">
      {Array.from({ length: 8 }, (_, i) => (
        <span key={i} className="skeleton" />
      ))}
    </div>
  );
}

export function EffectsTab({ device, state, st }: { device: DeviceSnapshot; state: WledState; st: DeviceStatic | null }) {
  const seg = viewSeg(state);
  const meta = parseFx(seg.fx, st?.fxdata ?? []);
  const [q, setQ] = useState('');
  const [pq, setPq] = useState('');
  const [filter, setFilter] = useState<string | null>(null);
  const activeFx = useRef<HTMLButtonElement>(null);
  const activePal = useRef<HTMLButtonElement>(null);

  const effects = useMemo(() => (st ? effectList(st.effects, st.fxdata) : []), [st]);
  const palettes = useMemo(() => (st ? paletteList(st.palettes, device.info) : []), [st, device.info]);
  const palx = usePalx(device, true);

  const shownFx = effects.filter((e) => {
    if (q && !e.name.toLowerCase().includes(q.toLowerCase())) return false;
    if (!filter) return true;
    if (filter === 'pal') return e.palette;
    return e.flags.includes(filter);
  });
  const shownPal = palettes.filter((p) => !pq || p.name.toLowerCase().includes(pq.toLowerCase()));

  useEffect(() => {
    activeFx.current?.scrollIntoView({ block: 'nearest' });
  }, [seg.fx, st]);
  useEffect(() => {
    activePal.current?.scrollIntoView({ block: 'nearest' });
  }, [seg.pal, st]);

  const sendSeg = (fields: Record<string, unknown>, key?: string) => send(device.id, segPatch(state, fields), key);
  const fxName = st?.effects[seg.fx] ?? t('Effekt {n}', { n: seg.fx });

  return (
    <div className="fx-layout">
      <section className="panel list-panel">
        <div className="panel-head">
          <h3>{t('Effekt')}</h3>
          <span className="muted small">{effects.length ? t('{n} von {total}', { n: shownFx.length, total: effects.length }) : ''}</span>
        </div>
        <SearchInput value={q} onChange={setQ} placeholder={t('Effekt suchen')} />
        <div className="filter-chips">
          {FILTERS.map((f) => (
            <button key={f.id} className={`fchip${filter === f.id ? ' on' : ''}`} onClick={() => setFilter(filter === f.id ? null : f.id)}>
              {t(f.label)}
            </button>
          ))}
        </div>
        <div className="list">
          {!st && <ListSkeleton />}
          {shownFx.map((e) => (
            <button
              key={e.id}
              ref={e.id === seg.fx ? activeFx : undefined}
              className={`list-item${e.id === seg.fx ? ' active' : ''}`}
              onClick={() => sendSeg({ fx: e.id, fxdef: true })}
            >
              <span className="li-name">{e.name}</span>
              <span className="li-flags">
                {e.palette && <Icon name="palette" size={13} />}
                {e.flags.includes('2') && <span className="badge">2D</span>}
                {e.flags.includes('v') && <span className="badge">♪</span>}
                {e.flags.includes('f') && <span className="badge">♫</span>}
              </span>
            </button>
          ))}
          {st && shownFx.length === 0 && <p className="muted small pad">{t('Kein Effekt passt zur Suche.')}</p>}
        </div>
      </section>

      <div className="fx-side">
        <section className="panel">
          <div className="panel-head">
            <h3>{fxName}</h3>
          </div>
          {meta.sliders.length === 0 && meta.options.length === 0 && (
            <p className="muted small">{t('Dieser Effekt hat keine eigenen Einstellungen.')}</p>
          )}
          {meta.sliders.map((sl) => {
            const max = sl.key === 'c3' ? 31 : 255;
            const value = Number(seg[sl.key] ?? 0);
            return (
              <div className="field" key={sl.key}>
                <span>
                  {t(sl.label)} <span className="val">{value}</span>
                </span>
                <Slider value={value} max={max} label={t(sl.label)} onChange={(v) => sendSeg({ [sl.key]: v }, `seg-${sl.key}`)} />
              </div>
            );
          })}
          {meta.options.map((o) => (
            <div className="pop-row" key={o.key}>
              <span>{t(o.label)}</span>
              <Toggle checked={!!seg[o.key]} label={t(o.label)} onChange={(v) => sendSeg({ [o.key]: v })} />
            </div>
          ))}
        </section>

        <section className={`panel list-panel${meta.usesPalette ? '' : ' dimmed'}`}>
          <div className="panel-head">
            <h3>{meta.usesPalette ? t(meta.paletteLabel) : t('Palette')}</h3>
            {!meta.usesPalette && <span className="muted small">{t('vom aktuellen Effekt nicht genutzt')}</span>}
          </div>
          <SearchInput value={pq} onChange={setPq} placeholder={t('Palette suchen')} />
          <div className="list palettes">
            {!st && <ListSkeleton />}
            {shownPal.map((p) => (
              <button
                key={p.id}
                ref={p.id === seg.pal ? activePal : undefined}
                className={`pal-item${p.id === seg.pal ? ' active' : ''}`}
                onClick={() => sendSeg({ pal: p.id })}
              >
                <span className="pal-name">{p.name}</span>
                <span className="pal-bar" style={{ background: paletteGradient(palx?.[String(p.id)], seg) }} />
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
