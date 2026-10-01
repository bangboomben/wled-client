import { useEffect, useState } from 'react';
import type { DeviceSnapshot, WledSegment, WledState } from '../../../shared/types';
import { send } from '../../lib/store';
import { displayColor, pct } from '../../lib/wled';
import { Check, Slider, Toggle, toast } from '../controls';
import { Icon } from '../Icon';

interface SegForm {
  n: string;
  start: string;
  stop: string;
  grp: string;
  spc: string;
  of: string;
  startY: string;
  stopY: string;
}

const toForm = (s: WledSegment): SegForm => ({
  n: s.n ?? '',
  start: String(s.start),
  stop: String(s.stop),
  grp: String(s.grp),
  spc: String(s.spc),
  of: String(s.of),
  startY: String(s.startY ?? 0),
  stopY: String(s.stopY ?? 1),
});

function NumField({ label, value, onChange, min = 0 }: { label: string; value: string; onChange: (v: string) => void; min?: number }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" min={min} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function SegmentCard({
  device,
  state,
  seg,
  count,
  matrix,
}: {
  device: DeviceSnapshot;
  state: WledState;
  seg: WledSegment;
  count: number;
  matrix: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<SegForm>(() => toForm(seg));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!dirty) setForm(toForm(seg));
  }, [seg, dirty]);

  const sendSeg = (fields: Record<string, unknown>, key?: string) =>
    send(device.id, { seg: { id: seg.id, ...fields } }, key);
  const set = (k: keyof SegForm) => (v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setDirty(true);
  };

  const apply = () => {
    const num = (v: string) => Math.round(Number(v));
    const start = num(form.start);
    const stop = num(form.stop);
    const grp = num(form.grp);
    const spc = num(form.spc);
    const of = num(form.of);
    if ([start, stop, grp, spc, of].some((n) => !Number.isFinite(n))) return setError('Bitte nur Zahlen eintragen.');
    if (start < 0 || stop > count || stop <= start) return setError(`Start muss kleiner als Ende sein, Ende höchstens ${count}.`);
    if (grp < 1) return setError('Gruppierung muss mindestens 1 sein.');
    const fields: Record<string, unknown> = { n: form.n.trim(), start, stop, grp, spc, of };
    if (matrix) {
      fields.startY = num(form.startY);
      fields.stopY = num(form.stopY);
    }
    setError('');
    setDirty(false);
    sendSeg(fields);
  };

  const remove = () => {
    if (state.seg.length <= 1) return;
    if (!window.confirm(`Segment „${seg.n || seg.id}“ löschen?`)) return;
    sendSeg({ stop: 0 });
  };

  const len = Math.max(0, seg.stop - seg.start);
  return (
    <div className={`seg-card${seg.sel ? ' selected' : ''}`}>
      <div className="seg-head">
        <Check checked={seg.sel} onChange={(v) => sendSeg({ sel: v })}>
          <span className="sr-only">Auswählen</span>
        </Check>
        <button className="seg-title" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="swatch" style={{ background: displayColor(seg.col[0]) }} />
          <span className="seg-name">{seg.n || `Segment ${seg.id}`}</span>
          <span className="muted small">
            LED {seg.start}–{seg.stop - 1} · {len} LEDs
            {seg.id === state.mainseg ? ' · Hauptsegment' : ''}
          </span>
        </button>
        <Toggle checked={seg.on} label="Segment ein/aus" onChange={(v) => sendSeg({ on: v })} />
        <button className="icon-btn" onClick={() => setOpen((o) => !o)} aria-label={open ? 'Zuklappen' : 'Bearbeiten'}>
          <Icon name="chevron" style={{ transform: open ? 'rotate(180deg)' : undefined }} />
        </button>
      </div>
      <div className="seg-bar" aria-hidden="true">
        <span
          style={{
            left: `${(seg.start / Math.max(count, 1)) * 100}%`,
            width: `${Math.max(0.6, (len / Math.max(count, 1)) * 100)}%`,
            background: displayColor(seg.col[0]),
          }}
        />
      </div>
      <div className="seg-bri">
        <Icon name="sun" size={14} />
        <Slider value={seg.bri} min={0} label="Segment-Helligkeit" onChange={(v) => sendSeg({ bri: v }, `seg${seg.id}-bri`)} />
        <span className="val">{seg.bri ? `${pct(seg.bri)} %` : '0 %'}</span>
      </div>
      {open && (
        <div className="seg-edit">
          <div className="grid-fields">
            <label className="field wide">
              <span>Name</span>
              <input value={form.n} placeholder={`Segment ${seg.id}`} onChange={(e) => set('n')(e.target.value)} />
            </label>
            <NumField label="Erste LED" value={form.start} onChange={set('start')} />
            <NumField label="Ende (exklusiv)" value={form.stop} onChange={set('stop')} />
            <NumField label="Gruppierung" value={form.grp} onChange={set('grp')} min={1} />
            <NumField label="Abstand" value={form.spc} onChange={set('spc')} />
            <NumField label="Versatz" value={form.of} onChange={set('of')} />
            {matrix && <NumField label="Start Y" value={form.startY} onChange={set('startY')} />}
            {matrix && <NumField label="Ende Y" value={form.stopY} onChange={set('stopY')} />}
          </div>
          <div className="seg-flags">
            <Check checked={seg.rev} onChange={(v) => sendSeg({ rev: v })}>
              Umkehren
            </Check>
            <Check checked={seg.mi} onChange={(v) => sendSeg({ mi: v })}>
              Spiegeln
            </Check>
            <Check checked={seg.frz} onChange={(v) => sendSeg({ frz: v })}>
              Einfrieren
            </Check>
          </div>
          {error && <p className="error">{error}</p>}
          <div className="row-actions">
            <button className="btn danger" disabled={state.seg.length <= 1} onClick={remove}>
              <Icon name="trash" size={15} />
              Löschen
            </button>
            <span className="spacer" />
            {dirty && (
              <button
                className="btn ghost"
                onClick={() => {
                  setForm(toForm(seg));
                  setDirty(false);
                  setError('');
                }}
              >
                Verwerfen
              </button>
            )}
            <button className="btn primary" disabled={!dirty} onClick={apply}>
              Übernehmen
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AddSegment({ device, state, count, onDone }: { device: DeviceSnapshot; state: WledState; count: number; onDone: () => void }) {
  const maxseg = device.info?.leds.maxseg ?? 32;
  const used = new Set(state.seg.map((s) => s.id));
  let id = 0;
  while (used.has(id)) id++;
  const lastStop = Math.max(0, ...state.seg.map((s) => s.stop));
  const [start, setStart] = useState(String(lastStop < count ? lastStop : 0));
  const [stop, setStop] = useState(String(count));
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  if (id >= maxseg) {
    return <p className="muted small">Das Gerät erlaubt höchstens {maxseg} Segmente.</p>;
  }
  const create = () => {
    const a = Math.round(Number(start));
    const b = Math.round(Number(stop));
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b > count || b <= a) {
      setError(`Start muss kleiner als Ende sein, Ende höchstens ${count}.`);
      return;
    }
    const seg: Record<string, unknown> = { id, start: a, stop: b };
    if (name.trim()) seg.n = name.trim();
    send(device.id, { seg });
    toast(`Segment ${id} angelegt`);
    onDone();
  };
  return (
    <div className="seg-card new">
      <div className="grid-fields">
        <label className="field wide">
          <span>Name (optional)</span>
          <input value={name} placeholder={`Segment ${id}`} onChange={(e) => setName(e.target.value)} />
        </label>
        <NumField label="Erste LED" value={start} onChange={setStart} />
        <NumField label="Ende (exklusiv)" value={stop} onChange={setStop} />
      </div>
      {error && <p className="error">{error}</p>}
      <div className="row-actions">
        <span className="spacer" />
        <button className="btn ghost" onClick={onDone}>
          Abbrechen
        </button>
        <button className="btn primary" onClick={create}>
          Segment anlegen
        </button>
      </div>
    </div>
  );
}

export function SegmentsTab({ device, state }: { device: DeviceSnapshot; state: WledState }) {
  const count = device.info?.leds.count ?? 0;
  const matrix = !!device.info?.leds.matrix;
  const [adding, setAdding] = useState(false);
  const [trans, setTrans] = useState((state.transition / 10).toFixed(1));
  useEffect(() => setTrans((state.transition / 10).toFixed(1)), [state.transition]);

  const commitTransition = () => {
    const sec = Math.min(65.5, Math.max(0, Number(trans.replace(',', '.')) || 0));
    setTrans(sec.toFixed(1));
    const t = Math.round(sec * 10);
    if (t !== state.transition) send(device.id, { transition: t });
  };

  const reset = () => {
    if (!window.confirm('Alle Segmente entfernen und ein einziges über die ganze Länge anlegen?')) return;
    const seg = [
      { id: 0, start: 0, stop: count, sel: true, on: true },
      ...state.seg.filter((s) => s.id !== 0).map((s) => ({ id: s.id, stop: 0 })),
    ];
    send(device.id, { seg, mainseg: 0 });
  };

  return (
    <div className="segments">
      <div className="seg-toolbar">
        <label className="inline-field">
          <span>Übergang</span>
          <input
            value={trans}
            inputMode="decimal"
            onChange={(e) => setTrans(e.target.value)}
            onBlur={commitTransition}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTransition();
            }}
          />
          <span className="muted">s</span>
        </label>
        <span className="muted small">
          {count} LEDs · {state.seg.length} {state.seg.length === 1 ? 'Segment' : 'Segmente'} · Farben und Effekte gelten für
          die ausgewählten Segmente
        </span>
        <span className="spacer" />
        <button className="btn ghost" onClick={reset}>
          <Icon name="refresh" size={15} />
          Zurücksetzen
        </button>
        <button className="btn primary" onClick={() => setAdding(true)} disabled={adding}>
          <Icon name="plus" size={15} />
          Segment
        </button>
      </div>
      {adding && <AddSegment device={device} state={state} count={count} onDone={() => setAdding(false)} />}
      {state.seg.map((s) => (
        <SegmentCard key={s.id} device={device} state={state} seg={s} count={count} matrix={matrix} />
      ))}
    </div>
  );
}
