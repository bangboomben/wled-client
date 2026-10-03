import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Der Installer legt den Link-Eintrag wled-client:// selbst an: electron-builder wertet build.protocols für
// NSIS nicht aus. Die Datei resources/installer.nsh gelangt nur über diese Kette in den Installer; ein Fehler
// darin fiele erst nach einer Installation auf, deshalb prüft dieser Test sie.

/** Datei aus der Projektwurzel; Zeilenenden vereinheitlicht (ein Windows-Checkout hat CRLF). */
const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const pkg = JSON.parse(read('package.json')) as { build: { directories?: { buildResources?: string }; nsis?: { include?: string } } };
const nsh = read('resources/installer.nsh');

describe('Installer-Einbindung für wled-client://', () => {
  it('electron-builder bindet resources/installer.nsh von selbst ein', () => {
    expect(pkg.build.directories?.buildResources).toBe('resources');
    // Ein eigenes nsis.include würde die automatische Einbindung ersetzen.
    expect(pkg.build.nsis?.include).toBeUndefined();
  });

  it('schreibt den Öffnen-Befehl mit dem Link als Argument', () => {
    expect(nsh).toContain(
      'WriteRegStr SHELL_CONTEXT "Software\\Classes\\wled-client\\shell\\open\\command" "" \'"$INSTDIR\\${APP_EXECUTABLE_FILENAME}" "%1"\'',
    );
  });

  it('entfernt den Eintrag beim Deinstallieren nur, wenn es kein Update ist', () => {
    expect(nsh).toMatch(/\$\{ifNot\} \$\{isUpdated\}\n\s*DeleteRegKey SHELL_CONTEXT "Software\\Classes\\wled-client"\n\s*\$\{endIf\}/);
  });

  it('räumt bei „alle Benutzer“ den alten Eintrag des Benutzers weg, der den neuen überdecken würde', () => {
    expect(nsh).toMatch(/\$\{if\} \$installMode == "all"\n\s*DeleteRegKey HKCU "Software\\Classes\\wled-client"\n\s*\$\{endIf\}/);
  });
});
