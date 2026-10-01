import { useState } from 'react';
import { t } from '../../../shared/i18n';
import type { DeviceSnapshot, DeviceStatic, Presets, WledPlaylist, WledPreset, WledState } from '../../../shared/types';
import { send, wled } from '../../lib/store';
import { Check, Modal, SearchInput, toast } from '../controls';
import { Icon } from '../Icon';

interface PlEntry {
  ps: number;
  dur: string;
  tr: string;
}

interface PlForm {
  entries: PlEntry[];
  repeat: string;
  end: number;
  shuffle: boolean;
}

const at = (v: number[] | number | undefined, i: number, fallback: number): number =>
  Array.isArray(v) ? (v[i] ?? v[v.length - 1] ?? fallback) : (v ?? fallback);

function toPlForm(pl: WledPlaylist | undefined, firstPreset: number): PlForm {
  if (!pl) return { entries: [{ ps: firstPreset, dur: '30', tr: '0.7' }], repeat: '0', end: 0, shuffle: false };
  return {
    entries: pl.ps.map((ps, i) => ({ ps, dur: String(at(pl.dur, i, 100) / 10), tr: String(at(pl.transition, i, 7) / 10) })),
    repeat: String(pl.repeat ?? 0),
    end: pl.end ?? 0,
    shuffle: !!pl.r,
  };
}

/** Der API-Text eines Presets, wie ihn die WLED-Weboberfläche zeigt (ohne Name und Quick-Load). */
function apiText(p: WledPreset | undefined): string {
  if (!p) return '';
  if (typeof p.win === 'string') return p.win;
  const o: Record<string, unknown> = { ...p };
  delete o.n;
  delete o.p;
  delete o.ql;
  return JSON.stringify(o);
}

const presetName = (p: WledPreset | undefined, id: number) => p?.n || t('Preset {id}', { id });

function PresetEditor({
  device,
  presets,
  mode,
  id,
  onClose,
}: {
  device: DeviceSnapshot;
  presets: Presets;
  mode: 'new' | 'edit' | 'playlist';
  id?: number;
  onClose: () => void;
}) {
  const existing = id !== undefined ? presets[String(id)] : undefined;
  const isPlaylist = mode === 'playlist' || !!existing?.playlist;
  const nextFree = () => {
    for (let i = 1; i <= 250; i++) if (!presets[String(i)]) return i;
    return 250;
  };
  const statePresets = Object.entries(presets)
    .filter(([, p]) => !p.playlist)
    .map(([pid, p]) => ({ id: Number(pid), name: presetName(p, Number(pid)) }))
    .sort((a, b) => a.id - b.id);

  const [pid, setPid] = useState(String(id ?? nextFree()));
  const [name, setName] = useState(existing?.n ?? '');
  const [ql, setQl] = useState(existing?.ql ?? '');
  const [useCurrent, setUseCurrent] = useState(mode === 'new');
  const [ib, setIb] = useState(true);
  const [sb, setSb] = useState(true);
  const [sc, setSc] = useState(false);
  const wasBoot = id !== undefined && device.info?.leds.bootps === id;
  const [boot, setBoot] = useState(wasBoot);
  const [api, setApi] = useState(() => apiText(existing));
  const [pl, setPl] = useState<PlForm>(() => toPlForm(existing?.playlist, statePresets[0]?.id ?? 1));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const setEntry = (i: number, patch: Partial<PlEntry>) =>
    setPl((f) => ({ ...f, entries: f.entries.map((e, j) => (j === i ? { ...e, ...patch } : e)) }));

  const save = async () => {
    const n = Number(pid);
    if (!Number.isInteger(n) || n < 1 || n > 250) return setError(t('Die ID muss zwischen 1 und 250 liegen.'));
    if (mode !== 'edit' && presets[String(n)] && !window.confirm(t('ID {id} ist schon belegt („{name}“). Überschreiben?', { id: n, name: presetName(presets[String(n)], n) }))) return;
    const body: Record<string, unknown> = { psave: n, n: name.trim() || (isPlaylist ? t('Playlist {id}', { id: n }) : t('Preset {id}', { id: n })) };
    const quick = Array.from(ql.trim()).slice(0, 2).join('');
    if (quick) body.ql = quick;
    if (boot) body.bootps = n;
    else if (wasBoot) body.bootps = 0;

    if (isPlaylist) {
      if (!pl.entries.length) return setError(t('Die Playlist braucht mindestens einen Eintrag.'));
      const secs = (v: string) => Math.max(0, Math.round((Number(v.replace(',', '.')) || 0) * 10));
      body.playlist = {
        ps: pl.entries.map((e) => e.ps),
        dur: pl.entries.map((e) => secs(e.dur)),
        transition: pl.entries.map((e) => secs(e.tr)),
        repeat: Math.max(0, Math.round(Number(pl.repeat) || 0)),
        end: pl.end,
        r: pl.shuffle,
      };
      body.on = true;
      body.o = true;
    } else if (useCurrent) {
      body.ib = ib;
      body.sb = sb;
      body.sc = sc;
    } else {
      const raw = api.trim();
      if (raw.length < 2) return setError(t('Bitte einen API-Befehl eintragen oder „Aktuellen Zustand speichern“ wählen.'));
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        for (const [k, v] of Object.entries(parsed)) if (!['psave', 'n', 'ql'].includes(k)) body[k] = v;
      } catch {
        if (raw.includes('{')) return setError(t('Der JSON-Befehl ist fehlerhaft.'));
        body.win = raw; // HTTP-API-Befehl, z. B. „FX=0&T=1“
      }
      body.o = true;
    }

    setBusy(true);
    const r = await wled.command(device.id, body);
    setBusy(false);
    if (!r.ok) return setError(r.error ?? t('Speichern fehlgeschlagen'));
    toast(t('„{name}“ gespeichert', { name: String(body.n) }));
    onClose();
  };

  const remove = async () => {
    if (id === undefined || !window.confirm(t('„{name}“ löschen?', { name: presetName(existing, id) }))) return;
    setBusy(true);
    const r = await wled.command(device.id, { pdel: id });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? t('Löschen fehlgeschlagen'));
    toast(t('„{name}“ gelöscht', { name: presetName(existing, id) }));
    onClose();
  };

  const title =
    mode === 'edit'
      ? isPlaylist
        ? t('Playlist bearbeiten')
        : t('Preset bearbeiten')
      : isPlaylist
        ? t('Neue Playlist')
        : t('Zustand als Preset speichern');

  return (
    <Modal
      title={title}
      onClose={onClose}
      width={isPlaylist ? 640 : 540}
      footer={
        <>
          {mode === 'edit' && (
            <button className="btn danger" onClick={remove} disabled={busy}>
              <Icon name="trash" size={15} />
              {t('Löschen')}
            </button>
          )}
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            {t('Abbrechen')}
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            <Icon name="save" size={15} />
            {t('Speichern')}
          </button>
        </>
      }
    >
      <div className="grid-fields two">
        <label className="field wide">
          <span>{t('Name')}</span>
          <input value={name} autoFocus placeholder={isPlaylist ? t('Playlist {id}', { id: pid }) : t('Preset {id}', { id: pid })} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('ID (1–250)')}</span>
          <input type="number" min={1} max={250} value={pid} disabled={mode === 'edit'} onChange={(e) => setPid(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('Quick-Load (1–2 Zeichen)')}</span>
          <input value={ql} placeholder={t('z. B. 1 oder ★')} onChange={(e) => setQl(e.target.value)} />
        </label>
      </div>

      {isPlaylist ? (
        <div className="playlist-editor">
          <div className="pl-head">
            <span>{t('Preset')}</span>
            <span>{t('Dauer (s)')}</span>
            <span>{t('Übergang (s)')}</span>
            <span />
          </div>
          {pl.entries.map((e, i) => (
            <div className="pl-row" key={i}>
              <select value={e.ps} onChange={(ev) => setEntry(i, { ps: Number(ev.target.value) })}>
                {statePresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id} · {p.name}
                  </option>
                ))}
              </select>
              <input inputMode="decimal" value={e.dur} onChange={(ev) => setEntry(i, { dur: ev.target.value })} />
              <input inputMode="decimal" value={e.tr} onChange={(ev) => setEntry(i, { tr: ev.target.value })} />
              <button
                className="icon-btn"
                aria-label={t('Eintrag entfernen')}
                disabled={pl.entries.length <= 1}
                onClick={() => setPl((f) => ({ ...f, entries: f.entries.filter((_, j) => j !== i) }))}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
          ))}
          <button
            className="btn ghost small"
            disabled={!statePresets.length}
            onClick={() => setPl((f) => ({ ...f, entries: [...f.entries, { ...f.entries[f.entries.length - 1] }] }))}
          >
            <Icon name="plus" size={14} />
            {t('Eintrag')}
          </button>
          {!statePresets.length && <p className="error">{t('Lege zuerst normale Presets an — eine Playlist spielt sie nacheinander ab.')}</p>}
          <div className="grid-fields two">
            <label className="field">
              <span>{t('Wiederholungen (0 = endlos)')}</span>
              <input type="number" min={0} value={pl.repeat} onChange={(e) => setPl((f) => ({ ...f, repeat: e.target.value }))} />
            </label>
            <label className="field">
              <span>{t('Danach')}</span>
              <select value={pl.end} onChange={(e) => setPl((f) => ({ ...f, end: Number(e.target.value) }))}>
                <option value={0}>{t('Nichts (letztes bleibt)')}</option>
                <option value={255}>{t('Vorherigen Zustand wiederherstellen')}</option>
                {statePresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id} · {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Check checked={pl.shuffle} onChange={(v) => setPl((f) => ({ ...f, shuffle: v }))}>
            {t('Zufällige Reihenfolge')}
          </Check>
        </div>
      ) : (
        <div className="preset-mode">
          <div className="seg-switch" role="radiogroup">
            <button role="radio" aria-checked={useCurrent} className={useCurrent ? 'on' : ''} onClick={() => setUseCurrent(true)}>
              {t('Aktuellen Zustand speichern')}
            </button>
            <button role="radio" aria-checked={!useCurrent} className={!useCurrent ? 'on' : ''} onClick={() => setUseCurrent(false)}>
              {t('API-Befehl')}
            </button>
          </div>
          {useCurrent ? (
            <div className="check-list">
              <Check checked={ib} onChange={setIb}>
                {t('Helligkeit mitspeichern')}
              </Check>
              <Check checked={sb} onChange={setSb}>
                {t('Segmentgrenzen mitspeichern')}
              </Check>
              <Check checked={sc} onChange={setSc}>
                {t('Nur ausgewählte Segmente')}
              </Check>
            </div>
          ) : (
            <label className="field">
              <span>{t('JSON- oder HTTP-API-Befehl')}</span>
              <textarea rows={6} spellCheck={false} className="mono" value={api} onChange={(e) => setApi(e.target.value)} placeholder='{"on":true,"bri":128}' />
            </label>
          )}
        </div>
      )}
      <Check checked={boot} onChange={setBoot}>
        {t('Beim Gerätestart laden')}
      </Check>
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

export function PresetsTab({ device, state, st }: { device: DeviceSnapshot; state: WledState; st: DeviceStatic | null }) {
  const [q, setQ] = useState('');
  const [editor, setEditor] = useState<{ mode: 'new' | 'edit' | 'playlist'; id?: number } | null>(null);
  const presets = st?.presets ?? {};
  const entries = Object.entries(presets)
    .map(([id, p]) => ({ id: Number(id), p }))
    .filter((e) => Number.isInteger(e.id) && e.id > 0)
    .sort((a, b) => a.id - b.id);
  const needle = q.trim().toLowerCase();
  const shown = needle ? entries.filter((e) => presetName(e.p, e.id).toLowerCase().includes(needle) || String(e.id) === needle) : entries;
  const quick = entries.filter((e) => e.p.ql);
  const apply = (id: number) => send(device.id, { ps: id });

  return (
    <div className="presets">
      <div className="presets-head">
        <SearchInput value={q} onChange={setQ} placeholder={t('Preset suchen')} />
        <span className="spacer" />
        <button className="btn" onClick={() => setEditor({ mode: 'playlist' })}>
          <Icon name="list" size={15} />
          {t('Neue Playlist')}
        </button>
        <button className="btn primary" onClick={() => setEditor({ mode: 'new' })}>
          <Icon name="save" size={15} />
          {t('Aktuellen Zustand speichern')}
        </button>
      </div>

      {quick.length > 0 && (
        <div className="ql-bar" aria-label={t('Quick-Load')}>
          {quick.map((e) => (
            <button key={e.id} className={`ql-btn${state.ps === e.id ? ' active' : ''}`} title={presetName(e.p, e.id)} onClick={() => apply(e.id)}>
              {e.p.ql}
            </button>
          ))}
        </div>
      )}

      {!st ? (
        <p className="muted">{t('Presets werden geladen …')}</p>
      ) : entries.length === 0 ? (
        <div className="empty small">
          <Icon name="bookmark" size={32} />
          <p className="muted">{t('Noch keine Presets. „Aktuellen Zustand speichern“ legt das erste an.')}</p>
        </div>
      ) : (
        <div className="preset-grid">
          {shown.map((e) => {
            const active = state.ps === e.id;
            const playing = state.pl === e.id;
            return (
              <div key={e.id} className={`preset-card${active ? ' active' : ''}${playing ? ' playing' : ''}`}>
                <button className="preset-main" onClick={() => apply(e.id)} title={t('Anwenden')}>
                  <span className="preset-ql">{e.p.ql || <Icon name={e.p.playlist ? 'list' : 'bookmark'} size={16} />}</span>
                  <span className="preset-text">
                    <span className="preset-name">{presetName(e.p, e.id)}</span>
                    <span className="muted small">
                      #{e.id}
                      {e.p.playlist ? ` · ${t('Playlist mit {n} Einträgen', { n: e.p.playlist.ps.length })}` : ''}
                      {playing ? ` · ${t('läuft')}` : active ? ` · ${t('aktiv')}` : ''}
                    </span>
                  </span>
                </button>
                <button className="icon-btn" onClick={() => setEditor({ mode: 'edit', id: e.id })} aria-label={t('Bearbeiten')} title={t('Bearbeiten')}>
                  <Icon name="edit" size={16} />
                </button>
              </div>
            );
          })}
          {shown.length === 0 && <p className="muted small">{t('Kein Preset passt zur Suche.')}</p>}
        </div>
      )}

      {editor && <PresetEditor device={device} presets={presets} mode={editor.mode} id={editor.id} onClose={() => setEditor(null)} />}
    </div>
  );
}
