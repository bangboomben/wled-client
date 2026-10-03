import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceConnection, normalizeHost } from './device';

describe('normalizeHost', () => {
  it('entfernt Schema und Pfad', () => {
    expect(normalizeHost('http://192.0.2.10/')).toBe('192.0.2.10');
    expect(normalizeHost('ws://192.0.2.10/ws')).toBe('192.0.2.10');
  });

  it('behält den Port', () => {
    expect(normalizeHost('HTTPS://Testlampe.example:8080/json/info')).toBe('testlampe.example:8080');
    expect(normalizeHost('192.0.2.10:81')).toBe('192.0.2.10:81');
  });

  it('entfernt Leerzeichen und schreibt klein', () => {
    expect(normalizeHost('  WLED-Testlampe.local  ')).toBe('wled-testlampe.local');
  });
});

describe('presetsLoaded', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

  /** Kleiner WLED-Ersatz: Effekte und Paletten sofort, presets.json erst, wenn `release` aufgerufen wird. */
  async function serve(presets: 'json' | 'missing'): Promise<{ host: string; release: () => void }> {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server = createServer((req, res) => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/json/eff') return reply(200, ['Solid', 'Rainbow']);
      if (req.url === '/json/pal') return reply(200, ['Default', 'Party']);
      if (req.url === '/json/fxdata') return reply(200, ['', '']);
      if (req.url === '/presets.json') {
        void gate.then(() => (presets === 'json' ? reply(200, { '0': {}, '3': { n: 'Abend' } }) : reply(404, {})));
        return;
      }
      reply(404, {});
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return { host: `127.0.0.1:${(server.address() as AddressInfo).port}`, release };
  }

  it('ist erst wahr, wenn presets.json angekommen ist — vorher steht in staticData nur ein leeres Gerüst', async () => {
    const { host, release } = await serve('json');
    const conn = new DeviceConnection({ id: 'a', host });
    expect(conn.presetsLoaded).toBe(false);
    const loading = conn.loadStatic();
    // Effekte und Paletten sind da, die Presets noch nicht.
    await vi.waitFor(() => expect(conn.staticData?.effects).toEqual(['Solid', 'Rainbow']));
    expect(conn.staticData?.presets).toEqual({});
    expect(conn.presetsLoaded).toBe(false);
    release();
    await loading;
    expect(conn.presetsLoaded).toBe(true);
    expect(conn.staticData?.presets).toEqual({ '3': { n: 'Abend' } });
    conn.stop();
  });

  it('gilt auch ohne gespeicherte Presets als geladen (presets.json gibt es dann nicht)', async () => {
    const { host, release } = await serve('missing');
    const conn = new DeviceConnection({ id: 'a', host });
    const loading = conn.loadStatic();
    await vi.waitFor(() => expect(conn.staticData).not.toBeNull());
    expect(conn.presetsLoaded).toBe(false);
    release();
    await loading;
    expect(conn.presetsLoaded).toBe(true);
    expect(conn.staticData?.presets).toEqual({});
    conn.stop();
  });
});
