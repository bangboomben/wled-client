// Simuliertes WLED-Gerät für Entwicklung und Tests — schaltet keine echten Lampen.
//
//   node scripts/mock-wled.mjs 8181:desk:"Mock Desk" 8182:bedroom:"Mock Bedroom"
//
// Je Argument ein Gerät: Port, Fixture-Ordner (mock/fixtures/<name>), Anzeigename.
// Die Fixtures sind echte API-Antworten (WLED 16.0.1) ohne MAC, IP und WLAN-Daten.
// Zusatzendpunkte für Tests: GET /__log (empfangene Befehle), POST /__reset.

import { readFileSync } from 'node:fs';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { applyStatePatch } from '../src/shared/merge.ts';

const FIXTURES = new URL('../mock/fixtures/', import.meta.url);

/** Farbton (0–360) → RGB bei voller Sättigung und Helligkeit. */
const hsv = (h) => {
  const x = 1 - Math.abs(((h / 60) % 2) - 1);
  const [r, g, b] = h < 60 ? [1, x, 0] : h < 120 ? [x, 1, 0] : h < 180 ? [0, 1, x] : h < 240 ? [0, x, 1] : h < 300 ? [x, 0, 1] : [1, 0, x];
  return [r * 255, g * 255, b * 255];
};
const META_KEYS = ['psave', 'pdel', 'ps', 'pl', 'ib', 'sb', 'sc', 'o', 'n', 'ql', 'playlist', 'v', 'rb', 'fxdef', 'bootps', 'lv'];

function createDevice(port, fixture, name, index) {
  const load = (file) => JSON.parse(readFileSync(new URL(`${fixture}/${file}`, FIXTURES), 'utf8'));
  const base = load('json.json');
  const fxdata = load('fxdata.json');
  const palx = load('palx.json');
  const channels = base.info.leds.rgbw ? 4 : 3;
  const mac = `02000000bb${String(index).padStart(2, '0')}`;

  let state;
  let presets;
  let pmt;
  let log;
  const reset = () => {
    state = structuredClone(base.state);
    presets = load('presets.json');
    pmt = 1_700_000_000;
    log = [];
  };
  reset();

  const info = () => ({
    ...base.info,
    name,
    mac,
    ip: '127.0.0.1',
    uptime: Math.floor(process.uptime()) + 3600,
    fs: { ...base.info.fs, pmt },
  });
  const full = () => ({ state, info: info() });

  const clients = new Set();
  let liveClient = null;
  const broadcast = () => {
    const msg = JSON.stringify(full());
    for (const c of clients) if (c.readyState === 1) c.send(msg);
  };

  const applyPreset = (id) => {
    const p = presets[String(id)];
    if (!p) return;
    if (p.playlist) {
      const first = p.playlist.ps?.[0];
      if (first) applyPreset(first);
      state = { ...state, pl: Number(id) };
      return;
    }
    const patch = Object.fromEntries(Object.entries(p).filter(([k]) => !['n', 'ql'].includes(k)));
    state = applyStatePatch(state, patch, { createSegments: true, channels });
    state = { ...state, ps: Number(id), pl: -1 };
  };

  const handle = (cmd) => {
    log.push(cmd);
    if (cmd.psave !== undefined) {
      const entry = {};
      if (cmd.o) {
        for (const [k, v] of Object.entries(cmd)) if (!META_KEYS.includes(k) || k === 'playlist') entry[k] = v;
      } else {
        entry.on = state.on;
        if (cmd.ib !== false) entry.bri = state.bri;
        entry.transition = state.transition;
        entry.mainseg = state.mainseg;
        entry.seg = state.seg.map((s) => {
          const copy = { ...s };
          if (cmd.sb === false) {
            delete copy.start;
            delete copy.stop;
          }
          return copy;
        });
      }
      entry.n = cmd.n;
      if (cmd.ql) entry.ql = cmd.ql;
      presets[String(cmd.psave)] = entry;
      pmt++;
    }
    if (cmd.pdel !== undefined) {
      delete presets[String(cmd.pdel)];
      pmt++;
    }
    if (cmd.ps !== undefined) applyPreset(cmd.ps);
    const rest = Object.fromEntries(Object.entries(cmd).filter(([k]) => !META_KEYS.includes(k)));
    if (Object.keys(rest).length) {
      state = applyStatePatch(state, rest, { createSegments: true, channels });
      if ('seg' in rest) state = { ...state, ps: -1, pl: -1 };
    }
    // fxdef: Effekt-Standardwerte setzen (vereinfacht)
    if (cmd.seg && cmd.seg.fxdef) state = { ...state, seg: state.seg.map((s) => (s.sel ? { ...s, sx: 128, ix: 128 } : s)) };
    setTimeout(broadcast, 15);
  };

  const pages = (() => {
    const ids = Object.keys(palx.p).map(Number).sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < ids.length; i += 8) out.push(ids.slice(i, i + 8));
    return out;
  })();

  const json = (res, body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const path = url.pathname;
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (path === '/__reset') {
          reset();
          broadcast();
          return json(res, { ok: true });
        }
        let cmd;
        try {
          cmd = JSON.parse(body || '{}');
        } catch {
          return json(res, { error: 9 }, 400);
        }
        handle(cmd);
        json(res, cmd.v ? full() : { success: true });
      });
      return;
    }
    switch (path) {
      case '/json':
        return json(res, { state, info: info(), effects: base.effects, palettes: base.palettes });
      case '/json/state':
        return json(res, state);
      case '/json/info':
        return json(res, info());
      case '/json/si':
        return json(res, full());
      case '/json/eff':
        return json(res, base.effects);
      case '/json/pal':
        return json(res, base.palettes);
      case '/json/fxdata':
        return json(res, fxdata);
      case '/json/nodes':
        return json(res, { nodes: [] });
      case '/json/palx': {
        const page = Number(url.searchParams.get('page') ?? 0);
        const ids = pages[page] ?? [];
        return json(res, { m: pages.length - 1, p: Object.fromEntries(ids.map((id) => [id, palx.p[id]])) });
      }
      case '/presets.json':
        return json(res, { 0: {}, ...presets });
      case '/__log':
        return json(res, log);
      default:
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><title>${name}</title><body style="font:16px system-ui;background:#111;color:#eee;padding:40px">` +
            `<h1>Mock-WLED: ${name}</h1><p>Seite <code>${path}</code> — hier stünde die WLED-Weboberfläche.</p>`,
        );
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify(full()));
    ws.on('message', (data) => {
      let cmd;
      try {
        cmd = JSON.parse(data.toString());
      } catch {
        return;
      }
      if ('lv' in cmd) {
        liveClient = cmd.lv ? ws : liveClient === ws ? null : liveClient;
        ws.send('{"success":true}');
        return;
      }
      handle(cmd);
    });
    ws.on('close', () => {
      clients.delete(ws);
      if (liveClient === ws) liveClient = null;
    });
  });

  // Live-Vorschau: 'L', Version 1, dann RGB je LED (höchstens 256)
  let tick = 0;
  setInterval(() => {
    if (!liveClient || liveClient.readyState !== 1) return;
    tick++;
    const n = Math.min(base.info.leds.count, 256);
    const frame = Buffer.alloc(2 + n * 3);
    frame[0] = 0x4c;
    frame[1] = 1;
    for (let i = 0; i < n; i++) {
      const led = Math.floor((i / n) * base.info.leds.count);
      const seg = state.seg.find((s) => led >= s.start && led < s.stop && s.on);
      let [r, g, b] = seg && state.on ? seg.col[0] : [0, 0, 0];
      const w = seg && state.on ? (seg.col[0][3] ?? 0) : 0;
      r = Math.min(255, r + w);
      g = Math.min(255, g + w * 0.9);
      b = Math.min(255, b + w * 0.75);
      // Laufender Effekt: wandernder Regenbogen statt Einzelfarbe
      if (seg && state.on && seg.fx !== 0) [r, g, b] = hsv(((i / n) * 360 + tick * 6) % 360);
      const k = state.bri / 255;
      frame[2 + i * 3] = r * k;
      frame[3 + i * 3] = g * k;
      frame[4 + i * 3] = b * k;
    }
    liveClient.send(frame);
  }, 60);

  server.listen(port, '127.0.0.1', () => console.log(`Mock-WLED „${name}“ (${fixture}) auf http://127.0.0.1:${port}`));
  return server;
}

const args = process.argv.slice(2);
const specs = args.length ? args : ['8181:desk:Mock Desk', '8182:bedroom:Mock Bedroom'];
specs.forEach((spec, i) => {
  const [port, fixture, ...nameParts] = spec.split(':');
  createDevice(Number(port), fixture, nameParts.join(':') || `Mock ${fixture}`, i + 1);
});
