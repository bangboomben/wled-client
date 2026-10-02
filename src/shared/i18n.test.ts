import { afterEach, describe, expect, it } from 'vitest';
import { key, language, resolveLanguage, setLanguage, t } from './i18n';

// Die Sprache ist Modulzustand — nach jedem Test zurück auf Deutsch (Startwert).
afterEach(() => setLanguage('de'));

describe('resolveLanguage', () => {
  it('nimmt eine fest eingestellte Sprache unabhängig von Windows', () => {
    expect(resolveLanguage('de', 'en-US')).toBe('de');
    expect(resolveLanguage('en', 'de-DE')).toBe('en');
  });

  it('folgt bei „system“ der Windows-Sprache: Deutsch bei de-*', () => {
    expect(resolveLanguage('system', 'de-DE')).toBe('de');
    expect(resolveLanguage('system', 'de-AT')).toBe('de');
    expect(resolveLanguage('system', 'DE-ch')).toBe('de');
  });

  it('nimmt bei „system“ für alle anderen Sprachen Englisch', () => {
    expect(resolveLanguage('system', 'en-US')).toBe('en');
    expect(resolveLanguage('system', 'fr-FR')).toBe('en');
    expect(resolveLanguage('system', '')).toBe('en');
  });

  it('behandelt eine fehlende Einstellung wie „system“', () => {
    expect(resolveLanguage(undefined, 'de-DE')).toBe('de');
    expect(resolveLanguage(undefined, 'en-GB')).toBe('en');
  });
});

describe('setLanguage / language', () => {
  it('startet auf Deutsch und merkt sich die gesetzte Sprache', () => {
    expect(language()).toBe('de');
    setLanguage('en');
    expect(language()).toBe('en');
  });
});

describe('t', () => {
  it('gibt auf Deutsch den Schlüssel selbst zurück', () => {
    expect(t('Abbrechen')).toBe('Abbrechen');
  });

  it('übersetzt auf Englisch über die Tabelle', () => {
    setLanguage('en');
    expect(t('Abbrechen')).toBe('Cancel');
  });

  it('zeigt auf Englisch den deutschen Text, wenn die Übersetzung fehlt', () => {
    setLanguage('en');
    expect(t('Text ohne Übersetzung')).toBe('Text ohne Übersetzung');
  });

  it('ersetzt Platzhalter in beiden Sprachen', () => {
    expect(t('{n} von {total}', { n: 2, total: 5 })).toBe('2 von 5');
    setLanguage('en');
    expect(t('{n} von {total}', { n: 2, total: 5 })).toBe('2 of 5');
  });

  it('lässt Platzhalter ohne Wert stehen', () => {
    expect(t('{n} von {total}', { n: 0 })).toBe('0 von {total}');
  });
});

describe('key', () => {
  it('gibt den Text unverändert zurück (übersetzt wird später per t)', () => {
    expect(key('Abbrechen')).toBe('Abbrechen');
  });
});
