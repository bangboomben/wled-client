// Bekannte, harmlose Fehler aus Node selbst (ohne Electron, testbar).

/**
 * Node baut beim Lesen aus einem Socket, der gerade zerstört wird, einen ErrnoException aus der Byte-Zahl des
 * letzten Frames (positiv statt negativer Fehlernummer) — das wirft einen RangeError (ERR_OUT_OF_RANGE) aus
 * TCP.onStreamRead. Er tritt auf, wenn `ws.terminate()` einen Socket schließt, während noch ein Frame eintrifft
 * (Beenden, Gerät entfernt, Ping ohne Antwort). Die Verbindung ist zu diesem Zeitpunkt ohnehin weg.
 * Erkannt wird die Signatur (Code und Stapel), nicht der Zeitpunkt.
 */
export function isSocketTeardownRace(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (err as NodeJS.ErrnoException).code === 'ERR_OUT_OF_RANGE' && (err.stack ?? '').includes('onStreamRead');
}
