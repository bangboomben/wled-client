import { getSystemErrorName } from 'node:util';
import { describe, expect, it } from 'vitest';
import { isSocketTeardownRace } from './node-races';

/** Der echte Fehler von Node (positive Byte-Zahl statt Fehlernummer), mit dem Stapel aus dem Hauptprozess. */
function rangeError(stack?: string): Error {
  try {
    getSystemErrorName(774);
  } catch (e) {
    const err = e as Error;
    if (stack !== undefined) err.stack = stack;
    return err;
  }
  throw new Error('getSystemErrorName(774) hätte werfen müssen');
}

const READ_STACK = `RangeError [ERR_OUT_OF_RANGE]: The value of "err" is out of range. It must be a negative integer. Received 774
    at getSystemErrorName (node:util:300:11)
    at new ErrnoException (node:internal/errors:770:20)
    at TCP.onStreamRead (node:internal/stream_base_commons:216:20)`;

describe('isSocketTeardownRace', () => {
  it('erkennt den RangeError aus onStreamRead', () => {
    const err = rangeError(READ_STACK);
    expect((err as NodeJS.ErrnoException).code).toBe('ERR_OUT_OF_RANGE');
    expect(isSocketTeardownRace(err)).toBe(true);
  });
  it('derselbe Fehlercode ohne onStreamRead im Stapel ist ein echter Fehler', () => {
    expect(isSocketTeardownRace(rangeError())).toBe(false);
  });
  it('onStreamRead mit anderem Fehlercode ist ein echter Fehler', () => {
    const err = new Error('boom') as NodeJS.ErrnoException;
    err.code = 'ECONNRESET';
    err.stack = READ_STACK;
    expect(isSocketTeardownRace(err)).toBe(false);
  });
  it('Fehler ohne Code, Nicht-Fehler und fehlender Stapel', () => {
    expect(isSocketTeardownRace(new Error('x'))).toBe(false);
    expect(isSocketTeardownRace('onStreamRead')).toBe(false);
    expect(isSocketTeardownRace(null)).toBe(false);
    expect(isSocketTeardownRace({ code: 'ERR_OUT_OF_RANGE' })).toBe(false);
  });
});
