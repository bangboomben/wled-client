import { useEffect, useLayoutEffect, useRef } from 'react';
import { Icon, Logo } from './components/Icon';
import { DeviceDot, QuickControls, deviceAccent, statusText } from './components/Sidebar';
import { sendAll, useDevices, wled } from './lib/store';

/** Schnellzugriff aus dem Infobereich: Ein/Aus und Helligkeit aller Geräte. */
export function Flyout() {
  const devices = useDevices();
  const root = useRef<HTMLDivElement>(null);
  const anyOn = devices.some((d) => d.status === 'online' && d.state?.on);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const report = () => wled.resizeFlyout(el.offsetHeight);
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') wled.hideFlyout();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flyout" ref={root}>
      <div className="flyout-head">
        <Logo size={18} />
        <span className="app-title">WLED</span>
        <span className="spacer" />
        <button className="btn ghost small" disabled={!devices.length} onClick={() => sendAll({ on: !anyOn })}>
          <Icon name="power" size={14} />
          {anyOn ? 'Alle aus' : 'Alle an'}
        </button>
      </div>
      <div className="flyout-list">
        {devices.map((d) => (
          <div key={d.id} className={`device-row flyout-row${d.status === 'online' ? '' : ' offline'}`} style={deviceAccent(d)}>
            <DeviceDot device={d} />
            <button className="device-meta as-button" onClick={() => wled.showMain(d.id)} title="In der App öffnen">
              <span className="device-name">{d.name}</span>
              <span className="device-sub">{statusText(d)}</span>
            </button>
            <QuickControls device={d} />
          </div>
        ))}
        {devices.length === 0 && <p className="muted small pad">Noch keine Geräte — füge sie in der App hinzu.</p>}
      </div>
      <div className="flyout-foot">
        <button className="btn ghost small" onClick={() => wled.showMain()}>
          <Icon name="external" size={14} />
          App öffnen
        </button>
      </div>
    </div>
  );
}
