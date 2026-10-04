/**
 * Welche Geräte Live-Bilder schicken sollen: das Gerät der Geräteansicht und — solange der Raumplan sichtbar ist —
 * alle platzierten Geräte. Fenster versteckt oder Live-Vorschau aus: keine (schont schwaches WLAN).
 */
export function liveIds(o: { visible: boolean; liveView: boolean; device: string | null; plan: boolean; placed: readonly string[] }): string[] {
  if (!o.visible || !o.liveView) return [];
  const ids = new Set<string>(o.plan ? o.placed : []);
  if (o.device) ids.add(o.device);
  return [...ids];
}
