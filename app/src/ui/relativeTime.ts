/**
 * "Last edited" for the gallery cards, from the setup layer's mtime.
 *
 * Coarse on purpose: what a lab member wants from a card is whether a setup was
 * touched today or has sat untouched since term started, not a timestamp. Past a
 * week the relative form stops meaning anything ("37 days ago"), so it becomes a
 * plain date.
 */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * @param modified epoch **seconds** (as the API sends it), not milliseconds.
 * @param now      injectable for tests.
 */
export function editedLabel(
  modified: number | undefined,
  t: Translate,
  lang: string,
  now: Date = new Date(),
): string {
  if (!modified || modified <= 0) return "";
  const seconds = Math.max(0, now.getTime() / 1000 - modified);

  if (seconds < MINUTE) return t("edited_just_now");
  if (seconds < HOUR) {
    return t("edited_minutes", { n: Math.floor(seconds / MINUTE) });
  }
  if (seconds < DAY) return t("edited_hours", { n: Math.floor(seconds / HOUR) });
  if (seconds < WEEK) return t("edited_days", { n: Math.floor(seconds / DAY) });

  const date = new Date(modified * 1000);
  // Intl gives ja the year/month/day order the lab writes dates in, without a
  // second date format to maintain here.
  const formatted = new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : "en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
  return t("edited_on", { date: formatted });
}

/** "600 × 450 mm", or "" for a project whose board has no geometry. */
export function boardLabel(sizeX?: number, sizeY?: number): string {
  if (!sizeX || !sizeY) return "";
  return `${Math.round(sizeX)} × ${Math.round(sizeY)} mm`;
}
