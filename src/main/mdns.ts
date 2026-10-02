// Minimaler mDNS-Client (RFC 6762), nur für die Gerätesuche. Die App lauscht nicht auf Port 5353,
// sondern fragt von einem freien Port aus („legacy unicast“, RFC 6762 §6.7): Die Geräte antworten
// dann per Unicast direkt an diesen Port. So öffnet die App keinen Empfangsport, und die
// Windows-Firewall lässt die Antworten ohne Rückfrage durch — Unicast-Antworten auf eigene
// Multicast-Anfragen erlaubt sie ab Werk drei Sekunden lang.

import dgram from 'node:dgram';

const GROUP = '224.0.0.251';
const PORT = 5353;
const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 } as const;
/** Anfragen nach 0, 1 und 2,5 s: Funk verliert Pakete, und jede Anfrage öffnet das Firewall-Fenster neu. */
const SEND_AT = [0, 1000, 2500];

export type MdnsRecord =
  | { type: 'A'; name: string; address: string }
  | { type: 'PTR'; name: string; target: string }
  | { type: 'SRV'; name: string; target: string; port: number }
  | { type: 'TXT'; name: string; entries: string[] };

export interface MdnsService {
  /** Instanzname, z. B. „wled-abc123._wled._tcp.local“ */
  instance: string;
  address: string;
  port: number;
  txt: Record<string, string>;
}

export interface BrowseOptions {
  /** IPv4-Adressen der Netzwerkkarten, über die gefragt wird. */
  interfaces: string[];
  /** Gesamtdauer in ms */
  timeout?: number;
  signal?: AbortSignal;
  /** Für Tests: Anfrage per Unicast an diese Adresse statt an die Multicast-Gruppe. */
  target?: { address: string; port: number };
  /** Für jeden neu gefundenen Dienst, sobald er antwortet. */
  onService?: (service: MdnsService) => void;
}

function encodeName(name: string): Buffer {
  const parts: Buffer[] = [];
  for (const label of name.split('.').filter(Boolean)) {
    const bytes = Buffer.from(label, 'utf8');
    if (bytes.length > 63) throw new RangeError(`DNS-Label zu lang: ${label}`);
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** Eine Anfrage mit einer Frage (Klasse IN). Legacy-Unicast-Antworten wiederholen die ID. */
export function encodeQuery(name: string, id: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id & 0xffff, 0);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(TYPE.PTR, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([header, encodeName(name), tail]);
}

function decodeName(buf: Buffer, start: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = start;
  let next = -1;
  for (let jumps = 0; ; ) {
    if (pos >= buf.length) throw new RangeError('Name über das Paketende hinaus');
    const len = buf[pos];
    if (len === 0) {
      if (next < 0) next = pos + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length || ++jumps > 32) throw new RangeError('Ungültiger Namenszeiger');
      if (next < 0) next = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    if (len > 63 || pos + 1 + len > buf.length) throw new RangeError('Ungültiges Label');
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return { name: labels.join('.'), next };
}

/** Alle Einträge einer Antwort, die die Suche braucht (A, PTR, SRV, TXT). Anfragen ergeben []. */
export function parseResponse(buf: Buffer): MdnsRecord[] {
  if (buf.length < 12 || !(buf.readUInt16BE(2) & 0x8000)) return [];
  const questions = buf.readUInt16BE(4);
  const records = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let pos = 12;
  for (let i = 0; i < questions; i++) pos = decodeName(buf, pos).next + 4;
  const out: MdnsRecord[] = [];
  for (let i = 0; i < records; i++) {
    const { name, next } = decodeName(buf, pos);
    if (next + 10 > buf.length) throw new RangeError('Eintrag über das Paketende hinaus');
    const type = buf.readUInt16BE(next);
    const len = buf.readUInt16BE(next + 8);
    const data = next + 10;
    if (data + len > buf.length) throw new RangeError('Daten über das Paketende hinaus');
    if (type === TYPE.A && len === 4) {
      out.push({ type: 'A', name, address: [...buf.subarray(data, data + 4)].join('.') });
    } else if (type === TYPE.PTR) {
      out.push({ type: 'PTR', name, target: decodeName(buf, data).name });
    } else if (type === TYPE.SRV && len >= 7) {
      out.push({ type: 'SRV', name, port: buf.readUInt16BE(data + 4), target: decodeName(buf, data + 6).name });
    } else if (type === TYPE.TXT) {
      const entries: string[] = [];
      for (let p = data; p < data + len; ) {
        const l = buf[p];
        if (l) entries.push(buf.toString('utf8', p + 1, Math.min(p + 1 + l, data + len)));
        p += 1 + l;
      }
      out.push({ type: 'TXT', name, entries });
    }
    pos = data + len;
  }
  return out;
}

/** Die Dienste eines Typs aus den Einträgen einer Antwort. Ohne A-Eintrag gilt die Absenderadresse. */
export function servicesFrom(records: MdnsRecord[], service: string, sender: string): MdnsService[] {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const out: MdnsService[] = [];
  for (const ptr of records) {
    if (ptr.type !== 'PTR' || !same(ptr.name, service)) continue;
    const srv = records.find((r) => r.type === 'SRV' && same(r.name, ptr.target)) as Extract<MdnsRecord, { type: 'SRV' }> | undefined;
    const txt = records.find((r) => r.type === 'TXT' && same(r.name, ptr.target)) as Extract<MdnsRecord, { type: 'TXT' }> | undefined;
    const a = srv && (records.find((r) => r.type === 'A' && same(r.name, srv.target)) as Extract<MdnsRecord, { type: 'A' }> | undefined);
    out.push({
      instance: ptr.target,
      address: a?.address ?? sender,
      port: srv?.port || 80,
      txt: Object.fromEntries(
        (txt?.entries ?? []).map((e) => {
          const i = e.indexOf('=');
          return i < 0 ? [e.toLowerCase(), ''] : [e.slice(0, i).toLowerCase(), e.slice(i + 1)];
        }),
      ),
    });
  }
  return out;
}

/** Fragt nach einem Dienst (z. B. „_wled._tcp.local“) und sammelt die Antworten bis zum Timeout. */
export function browse(service: string, opts: BrowseOptions): Promise<MdnsService[]> {
  return new Promise((resolve) => {
    const found = new Map<string, MdnsService>();
    const sockets: dgram.Socket[] = [];
    const timers: NodeJS.Timeout[] = [];
    let finished = false;

    const drop = (sock: dgram.Socket) => {
      const i = sockets.indexOf(sock);
      if (i >= 0) sockets.splice(i, 1);
      try {
        sock.close();
      } catch {
        /* schon geschlossen */
      }
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      for (const t of timers) clearTimeout(t);
      for (const s of [...sockets]) drop(s);
      opts.signal?.removeEventListener('abort', finish);
      resolve([...found.values()]);
    };
    if (opts.signal?.aborted) return finish();
    opts.signal?.addEventListener('abort', finish, { once: true });
    timers.push(setTimeout(finish, opts.timeout ?? 4000));

    const id = 1 + Math.floor(Math.random() * 0xfffe);
    const query = encodeQuery(service, id);
    const dest = opts.target ?? { address: GROUP, port: PORT };
    const binds = opts.target ? [undefined] : opts.interfaces;

    for (const address of binds) {
      const sock = dgram.createSocket('udp4');
      sockets.push(sock);
      // Netzwerkkarte ohne Multicast o. Ä.: diese eine Karte fällt aus, die übrigen fragen weiter.
      sock.on('error', () => drop(sock));
      sock.on('message', (msg, rinfo) => {
        let records: MdnsRecord[];
        try {
          records = parseResponse(msg);
        } catch {
          return;
        }
        for (const s of servicesFrom(records, service, rinfo.address)) {
          const key = s.instance.toLowerCase();
          if (found.has(key)) continue;
          found.set(key, s);
          opts.onService?.(s);
        }
      });
      sock.bind({ address, port: 0 }, () => {
        if (finished) return;
        if (!opts.target && address) {
          try {
            sock.setMulticastInterface(address);
            sock.setMulticastTTL(255);
          } catch {
            return drop(sock);
          }
        }
        for (const delay of SEND_AT) {
          timers.push(
            setTimeout(() => {
              if (!finished && sockets.includes(sock)) sock.send(query, dest.port, dest.address, () => {});
            }, delay),
          );
        }
      });
    }
  });
}
