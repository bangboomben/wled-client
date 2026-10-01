// Übersetzung nach gettext-Art: Der deutsche Text ist der Schlüssel, `EN` liefert die
// englische Fassung. Fehlt ein Eintrag, erscheint der deutsche Text — `npm run i18n`
// listet solche Lücken. Platzhalter: {name}.
//
// Haupt- und Renderer-Prozess haben je eine eigene Instanz dieses Moduls und setzen
// die Sprache jeweils selbst (setLanguage).

import { EN } from './i18n-en';

export type Lang = 'de' | 'en';
export type LanguageSetting = 'system' | Lang;

let current: Lang = 'de';

export function setLanguage(lang: Lang): void {
  current = lang;
}

export function language(): Lang {
  return current;
}

/** „system“ folgt der Windows-Sprache: Deutsch bei de-*, sonst Englisch. */
export function resolveLanguage(setting: LanguageSetting | undefined, locale: string): Lang {
  if (setting === 'de' || setting === 'en') return setting;
  return locale.toLowerCase().startsWith('de') ? 'de' : 'en';
}

export function t(text: string, vars?: Record<string, string | number>): string {
  let s = current === 'en' ? (EN[text] ?? text) : text;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  return s;
}

/** Markiert einen Text als übersetzbar, ohne ihn schon zu übersetzen (für Konstanten). */
export const key = (text: string): string => text;
