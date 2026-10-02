import { describe, expect, it } from 'vitest';
import { encodeQuery, parseResponse, servicesFrom, type MdnsRecord } from './mdns';

// Pakete werden hier von Hand gebaut (RFC 1035 §4.1) — erfundene Namen und Adressen, keine Mitschnitte.
const SERVICE = '_wled._tcp.local';
const INSTANCE = 'wled-ddeeff._wled._tcp.local';
const HOST = 'wled-ddeeff.local';
const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33 };

const label = (text: string): Buffer => Buffer.concat([Buffer.from([Buffer.byteLength(text)]), Buffer.from(text)]);
/** Name als Folge von Labels mit abschließender 0. */
const name = (n: string): Buffer => Buffer.concat([...n.split('.').map((l) => label(l)), Buffer.from([0])]);
/** Zeiger auf einen Namen ab `offset` im Paket (Namenskompression). */
const pointer = (offset: number): Buffer => Buffer.from([0xc0 | (offset >> 8), offset & 0xff]);
const question = (n: string): Buffer => Buffer.concat([name(n), Buffer.from([0, TYPE.PTR, 0, 1])]);

/** Eintrag: Name, Typ, Klasse (IN, mit Cache-Flush-Bit 0x8001), TTL 120 s, Daten. */
function record(owner: Buffer, type: number, data: Buffer, cls = 1): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(cls, 2);
  head.writeUInt32BE(120, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([owner, head, data]);
}

function srvData(port: number, target: Buffer): Buffer {
  const fixed = Buffer.alloc(6); // Priorität, Gewicht, Port
  fixed.writeUInt16BE(port, 4);
  return Buffer.concat([fixed, target]);
}

const txtData = (...entries: string[]): Buffer => Buffer.concat(entries.map((e) => label(e)));

/** Antwortpaket (QR-Bit gesetzt) mit den Zählern aus den übergebenen Abschnitten. */
function packet(sections: { questions?: Buffer[]; answers?: Buffer[]; additional?: Buffer[] }): Buffer {
  const { questions = [], answers = [], additional = [] } = sections;
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(additional.length, 10);
  return Buffer.concat([header, ...questions, ...answers, ...additional]);
}

/** Antwort eines WLED-Geräts wie vom Mock: PTR als Antwort, SRV, TXT und A als Zusatz. */
const wledAnswer = (): Buffer =>
  packet({
    questions: [question(SERVICE)],
    answers: [record(name(SERVICE), TYPE.PTR, name(INSTANCE))],
    additional: [
      record(name(INSTANCE), TYPE.SRV, srvData(80, name(HOST))),
      record(name(INSTANCE), TYPE.TXT, txtData('mac=aabbccddeeff')),
      record(name(HOST), TYPE.A, Buffer.from([192, 0, 2, 10])),
    ],
  });

describe('encodeQuery', () => {
  it('baut eine Anfrage mit einer Frage und der ID im Header', () => {
    const q = encodeQuery(SERVICE, 0x1234);
    expect(q.readUInt16BE(0)).toBe(0x1234);
    expect(q.readUInt16BE(2)).toBe(0); // Flags: Anfrage
    expect([q.readUInt16BE(4), q.readUInt16BE(6), q.readUInt16BE(8), q.readUInt16BE(10)]).toEqual([1, 0, 0, 0]);
  });

  it('fragt nach PTR in Klasse IN, den Namen als Labels', () => {
    expect(encodeQuery(SERVICE, 1).subarray(12)).toEqual(question(SERVICE));
  });

  it('kürzt die ID auf 16 Bit', () => {
    expect(encodeQuery(SERVICE, 0x12345).readUInt16BE(0)).toBe(0x2345);
  });

  it('ignoriert leere Labels (Punkt am Ende)', () => {
    expect(encodeQuery(`${SERVICE}.`, 1)).toEqual(encodeQuery(SERVICE, 1));
  });

  it('wirft bei Labels über 63 Byte', () => {
    expect(() => encodeQuery(`${'a'.repeat(64)}.local`, 1)).toThrow(RangeError);
  });
});

describe('parseResponse', () => {
  it('liest PTR, SRV, TXT und A aus einer Antwort', () => {
    expect(parseResponse(wledAnswer())).toEqual([
      { type: 'PTR', name: SERVICE, target: INSTANCE },
      { type: 'SRV', name: INSTANCE, target: HOST, port: 80 },
      { type: 'TXT', name: INSTANCE, entries: ['mac=aabbccddeeff'] },
      { type: 'A', name: HOST, address: '192.0.2.10' },
    ]);
  });

  it('folgt komprimierten Namen (Zeigern)', () => {
    // Frage ab Offset 12: „_wled“ ab 12, „_tcp“ ab 18, „local“ ab 23
    const q = question(SERVICE);
    const ptrAt = 12 + q.length;
    const instanceAt = ptrAt + 2 + 10; // Daten des PTR-Eintrags hinter Zeiger und Kopf
    const buf = packet({
      questions: [q],
      answers: [record(pointer(12), TYPE.PTR, Buffer.concat([label('wled-ddeeff'), pointer(12)]))],
      additional: [record(pointer(instanceAt), TYPE.SRV, srvData(80, Buffer.concat([label('wled-ddeeff'), pointer(23)])))],
    });
    expect(parseResponse(buf)).toEqual([
      { type: 'PTR', name: SERVICE, target: INSTANCE },
      { type: 'SRV', name: INSTANCE, target: HOST, port: 80 },
    ]);
  });

  it('liest Einträge mit Cache-Flush-Bit wie Klasse IN', () => {
    const buf = packet({ answers: [record(name(HOST), TYPE.A, Buffer.from([192, 0, 2, 10]), 0x8001)] });
    expect(parseResponse(buf)).toEqual([{ type: 'A', name: HOST, address: '192.0.2.10' }]);
  });

  it('überspringt unbekannte Typen und A-Einträge mit falscher Länge', () => {
    const buf = packet({
      answers: [
        record(name(HOST), TYPE.AAAA, Buffer.alloc(16)),
        record(name(HOST), TYPE.A, Buffer.from([192, 0, 2])),
        record(name(HOST), TYPE.A, Buffer.from([192, 0, 2, 10])),
      ],
    });
    expect(parseResponse(buf)).toEqual([{ type: 'A', name: HOST, address: '192.0.2.10' }]);
  });

  it('überspringt leere TXT-Einträge', () => {
    const buf = packet({ answers: [record(name(INSTANCE), TYPE.TXT, Buffer.concat([Buffer.from([0]), txtData('a=1')]))] });
    expect(parseResponse(buf)).toEqual([{ type: 'TXT', name: INSTANCE, entries: ['a=1'] }]);
  });

  it('schneidet TXT-Einträge ab, deren Länge über die Daten hinausgeht', () => {
    const buf = packet({ answers: [record(name(INSTANCE), TYPE.TXT, Buffer.concat([Buffer.from([10]), Buffer.from('a=1')]))] });
    expect(parseResponse(buf)).toEqual([{ type: 'TXT', name: INSTANCE, entries: ['a=1'] }]);
  });

  it('gibt für Anfragen und zu kurze Pakete nichts zurück', () => {
    expect(parseResponse(encodeQuery(SERVICE, 1))).toEqual([]);
    expect(parseResponse(Buffer.alloc(11))).toEqual([]);
  });

  it('wirft bei jedem abgeschnittenen Paket RangeError', () => {
    const full = wledAnswer();
    for (let len = 12; len < full.length; len++) {
      expect(() => parseResponse(full.subarray(0, len)), `gekürzt auf ${len} Byte`).toThrow(RangeError);
    }
  });

  it('wirft bei Zeigerschleifen und Zeigern hinter das Paketende', () => {
    for (const target of [12, 200]) {
      const buf = Buffer.concat([packet({}), pointer(target), Buffer.alloc(10)]);
      buf.writeUInt16BE(1, 6); // ein Antworteintrag; sein Name zeigt auf sich selbst bzw. ins Leere
      expect(() => parseResponse(buf)).toThrow(RangeError);
    }
  });
});

describe('servicesFrom', () => {
  const SENDER = '198.51.100.7';

  it('setzt einen Dienst aus PTR, SRV, TXT und A zusammen', () => {
    expect(servicesFrom(parseResponse(wledAnswer()), SERVICE, SENDER)).toEqual([
      { instance: INSTANCE, address: '192.0.2.10', port: 80, txt: { mac: 'aabbccddeeff' } },
    ]);
  });

  it('nimmt ohne A-Eintrag die Absenderadresse', () => {
    const records: MdnsRecord[] = [
      { type: 'PTR', name: SERVICE, target: INSTANCE },
      { type: 'SRV', name: INSTANCE, target: HOST, port: 8080 },
    ];
    expect(servicesFrom(records, SERVICE, SENDER)).toEqual([{ instance: INSTANCE, address: SENDER, port: 8080, txt: {} }]);
  });

  it('nimmt ohne SRV-Eintrag Port 80 und die Absenderadresse', () => {
    const records: MdnsRecord[] = [{ type: 'PTR', name: SERVICE, target: INSTANCE }];
    expect(servicesFrom(records, SERVICE, SENDER)).toEqual([{ instance: INSTANCE, address: SENDER, port: 80, txt: {} }]);
  });

  it('vergleicht Namen ohne Rücksicht auf Groß- und Kleinschreibung', () => {
    const records: MdnsRecord[] = [
      { type: 'PTR', name: '_WLED._tcp.LOCAL', target: 'WLED-ddeeff._wled._tcp.local' },
      { type: 'SRV', name: INSTANCE, target: 'WLED-DDEEFF.local', port: 81 },
      { type: 'A', name: HOST, address: '192.0.2.10' },
    ];
    expect(servicesFrom(records, SERVICE, SENDER)).toEqual([
      { instance: 'WLED-ddeeff._wled._tcp.local', address: '192.0.2.10', port: 81, txt: {} },
    ]);
  });

  it('liest TXT-Schlüssel klein, Werte unverändert, Einträge ohne = als leeren Wert', () => {
    const records: MdnsRecord[] = [
      { type: 'PTR', name: SERVICE, target: INSTANCE },
      { type: 'TXT', name: INSTANCE, entries: ['MAC=AaBbCcDdEeFf', 'flag', 'x=a=b'] },
    ];
    expect(servicesFrom(records, SERVICE, SENDER)[0].txt).toEqual({ mac: 'AaBbCcDdEeFf', flag: '', x: 'a=b' });
  });

  it('ignoriert andere Dienste', () => {
    const records: MdnsRecord[] = [{ type: 'PTR', name: '_http._tcp.local', target: 'drucker._http._tcp.local' }];
    expect(servicesFrom(records, SERVICE, SENDER)).toEqual([]);
  });

  it('findet mehrere Geräte in einer Antwort', () => {
    const records: MdnsRecord[] = [
      { type: 'PTR', name: SERVICE, target: 'wled-aaaaaa._wled._tcp.local' },
      { type: 'PTR', name: SERVICE, target: 'wled-bbbbbb._wled._tcp.local' },
    ];
    expect(servicesFrom(records, SERVICE, SENDER).map((s) => s.instance)).toEqual([
      'wled-aaaaaa._wled._tcp.local',
      'wled-bbbbbb._wled._tcp.local',
    ]);
  });
});
