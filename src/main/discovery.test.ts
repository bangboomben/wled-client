import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { expandTargets, localSubnets } from './discovery';

/** Erfundene IPv4-Adresse einer Netzwerkkarte („10.0.0.5/24“); netmask wertet localSubnets nicht aus. */
const v4 = (cidr: string, internal = false): NetworkInterfaceInfo => ({
  address: cidr.split('/')[0],
  netmask: '',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal,
  cidr,
});
const v6 = (cidr: string): NetworkInterfaceInfo => ({
  address: cidr.split('/')[0],
  netmask: '',
  family: 'IPv6',
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr,
  scopeid: 0,
});

describe('expandTargets', () => {
  it('liefert für ein /24 die 254 nutzbaren Adressen', () => {
    const hosts = expandTargets(['192.168.1.0/24']);
    expect(hosts).toHaveLength(254);
    expect(hosts[0]).toBe('192.168.1.1');
    expect(hosts.at(-1)).toBe('192.168.1.254');
  });

  it('rechnet von einer beliebigen Adresse im Netz auf den Netzanfang', () => {
    expect(expandTargets(['192.168.1.77/24'])).toEqual(expandTargets(['192.168.1.0/24']));
  });

  it('versteht a.b.c.* als /24', () => {
    expect(expandTargets(['192.168.1.*'])).toEqual(expandTargets(['192.168.1.0/24']));
  });

  it('versteht Bereiche mit Leerzeichen drumherum', () => {
    expect(expandTargets(['  10.0.0.0/30 '])).toEqual(['10.0.0.1', '10.0.0.2']);
  });

  it('behandelt kleine Netze: /30 ohne Netz- und Broadcast-Adresse, /31 und /32 vollständig', () => {
    expect(expandTargets(['10.0.0.0/30'])).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(expandTargets(['10.0.0.4/31'])).toEqual(['10.0.0.4', '10.0.0.5']);
    expect(expandTargets(['10.0.0.9/32'])).toEqual(['10.0.0.9']);
  });

  it('begrenzt größere Netze auf das /22, in dem die angegebene Adresse liegt', () => {
    const hosts = expandTargets(['10.0.201.7/16']);
    expect(hosts).toHaveLength(1022);
    expect(hosts[0]).toBe('10.0.200.1');
    expect(hosts.at(-1)).toBe('10.0.203.254');
  });

  it('fragt über mehrere Bereiche zusammen höchstens 1024 Adressen ab', () => {
    expect(expandTargets(['10.0.0.0/22', '10.0.4.0/22', '10.0.8.0/22'])).toHaveLength(1024);
  });

  it('übernimmt einzelne Adressen und Hostnamen, ohne Leerzeichen und Leereinträge', () => {
    expect(expandTargets(['  192.0.2.10 ', 'wled-testlampe.local', '', '   '])).toEqual(['192.0.2.10', 'wled-testlampe.local']);
  });

  it('nennt jede Adresse nur einmal', () => {
    expect(expandTargets(['192.0.2.10', '192.0.2.10', '192.0.2.8/30'])).toEqual(['192.0.2.10', '192.0.2.9']);
  });
});

describe('localSubnets', () => {
  it('nimmt das Netz jeder Karte nach ihrer echten Netzmaske', () => {
    expect(localSubnets({ Ethernet: [v4('192.168.1.23/24')], WLAN: [v4('10.0.5.130/26')] })).toEqual(['192.168.1.0/24', '10.0.5.128/26']);
  });

  it('begrenzt große Netze auf das /22 um die eigene Adresse', () => {
    expect(localSubnets({ Ethernet: [v4('10.20.30.40/16')] })).toEqual(['10.20.28.0/22']);
  });

  it('nimmt nur private Netze', () => {
    const ifaces = { a: [v4('172.20.1.5/24')], b: [v4('172.32.1.5/24')], c: [v4('203.0.113.5/24')], d: [v4('192.169.1.5/24')] };
    expect(localSubnets(ifaces)).toEqual(['172.20.1.0/24']);
  });

  it('überspringt Punkt-zu-Punkt-Verbindungen (/31, /32), behält /30', () => {
    expect(localSubnets({ a: [v4('10.0.0.1/31'), v4('10.0.0.2/32'), v4('10.0.0.5/30')] })).toEqual(['10.0.0.4/30']);
  });

  it('nimmt /24 an, wenn die Karte keine Netzmaske meldet', () => {
    expect(localSubnets({ Ethernet: [{ ...v4('192.168.1.23/24'), cidr: null }] })).toEqual(['192.168.1.0/24']);
  });

  it('überspringt virtuelle Adapter, interne und IPv6-Adressen', () => {
    const ifaces = {
      'vEthernet (WSL)': [v4('172.20.16.1/20')],
      'VirtualBox Host-Only Network': [v4('192.168.56.1/24')],
      Tailscale: [v4('10.64.0.1/24')],
      Ethernet: [v4('10.0.0.5/24', true), v6('fe80::1/64'), v4('192.168.1.23/24')],
    };
    expect(localSubnets(ifaces)).toEqual(['192.168.1.0/24']);
  });

  it('nennt ein Netz mehrerer Karten nur einmal', () => {
    expect(localSubnets({ Ethernet: [v4('192.168.1.23/24')], WLAN: [v4('192.168.1.42/24')] })).toEqual(['192.168.1.0/24']);
  });

  it('kommt mit Karten ohne Adressen zurecht', () => {
    expect(localSubnets({ Ethernet: undefined })).toEqual([]);
  });
});
