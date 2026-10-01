import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { wled } from '../lib/store';
import { Icon } from './Icon';

// ------------------------------------------------------------------ Regler

interface SliderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  disabled?: boolean;
  variant?: 'default' | 'big' | 'mini' | 'gradient';
  /** CSS-Hintergrund der Spur (für Farbregler). */
  track?: string;
  fillColor?: string;
  label: string;
  className?: string;
}

/**
 * Bereichsregler, der während des Ziehens seinen eigenen Wert hält. Ohne das springt er
 * zurück, wenn zwischendurch ein älterer Gerätezustand eintrifft.
 */
export function Slider({
  value,
  min = 0,
  max = 255,
  step = 1,
  onChange,
  onCommit,
  disabled,
  variant = 'default',
  track,
  fillColor,
  label,
  className = '',
}: SliderProps) {
  const [local, setLocal] = useState<number | null>(null);
  const dragging = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  const releaseSoon = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (!dragging.current) setLocal(null);
    }, 800);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const v = local ?? value;
  const fill = max > min ? ((v - min) / (max - min)) * 100 : 0;
  const style = {
    '--fill': `${fill}%`,
    ...(track ? { '--track-bg': track } : {}),
    ...(fillColor ? { '--fill-color': fillColor } : {}),
  } as CSSProperties;

  const end = () => {
    if (!dragging.current) return;
    dragging.current = false;
    releaseSoon();
    onCommit?.(v);
  };

  return (
    <input
      type="range"
      className={`slider slider-${variant} ${className}`}
      min={min}
      max={max}
      step={step}
      value={v}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={style}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        e.stopPropagation();
        dragging.current = true;
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyUp={releaseSoon}
      onChange={(e) => {
        const n = Number(e.target.value);
        setLocal(n);
        onChange(n);
        if (!dragging.current) releaseSoon();
      }}
    />
  );
}

// ------------------------------------------------------------------ Schalter

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className={`toggle${checked ? ' on' : ''}`}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    >
      <span className="knob" />
    </button>
  );
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="box">
        <Icon name="check" size={13} />
      </span>
      <span>{children}</span>
    </label>
  );
}

// ------------------------------------------------------------------ Dialog

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 520,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Schließen" title="Schließen">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ Aufklappmenü

export function Popover({
  trigger,
  children,
  align = 'left',
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="popover-wrap" ref={ref}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && <div className={`popover popover-${align}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ Suche

export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="search">
      <Icon name="search" size={15} />
      <input value={value} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      {value && (
        <button type="button" className="search-clear" onClick={() => onChange('')} aria-label="Suche leeren">
          <Icon name="x" size={13} />
        </button>
      )}
    </label>
  );
}

// ------------------------------------------------------------------ Hinweise

const toastListeners = new Set<(msg: string) => void>();

export function toast(msg: string): void {
  for (const l of toastListeners) l(msg);
}

export function Toasts() {
  const [items, setItems] = useState<Array<{ id: number; msg: string }>>([]);
  useEffect(() => {
    let seq = 0;
    const add = (msg: string) => {
      const id = ++seq;
      setItems((list) => (list.some((t) => t.msg === msg) ? list : [...list.slice(-2), { id, msg }]));
      window.setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), 3500);
    };
    toastListeners.add(add);
    const off = wled.onToast(add);
    return () => {
      toastListeners.delete(add);
      off();
    };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="toast">
          {t.msg}
        </div>
      ))}
    </div>
  );
}
