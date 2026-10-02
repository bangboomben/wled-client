import { describe, expect, it } from 'vitest';
import { normalizeHost } from './device';

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
