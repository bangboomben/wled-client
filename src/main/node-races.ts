// Bekannte, harmlose Fehler aus Node selbst (ohne Electron, testbar).

/**
 * Node baut beim Lesen aus einem Socket, der gerade zerstört wird, einen ErrnoException aus der Byte-Zahl des
 * letzten Frames (positiv statt negativer Fehlernummer) — das wirft einen RangeError (ERR_OUT_OF_RANGE) aus
 * TCP.onStreamRead. Er tritt auf, wenn `ws.terminate()` einen Socket schließt, während noch ein Frame eintrifft
 * (Beenden, Gerät entfernt, Ping ohne Antwort). Die Verbindung ist zu diesem Zeitpunkt ohnehin weg.
 * Erkannt wird die Signatur (Code und Stapel), nicht der Zeitpunkt. onStreamRead allein reicht nicht: stream.push
 * feuert 'data' synchron, ein echter ERR_OUT_OF_RANGE aus einem Daten-Handler (etwa Buffer.read* beim Zerlegen
 * eines Frames) hätte es auch im Stapel. Deshalb muss der Fehler aus dem Bau des ErrnoException stammen.
 */
export function isSocketTeardownRace(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if ((err as NodeJS.ErrnoException).code !== 'ERR_OUT_OF_RANGE') return false;
  const stack = err.stack ?? '';
  return stack.includes('onStreamRead') && (stack.includes('ErrnoException') || stack.includes('getSystemErrorName'));
}
