/** Small pure helpers for names, slugs, similarity and timezone maths. */

export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

const NAME_NOISE = new Set(["the", "a", "an", "at", "of", "and", "official", "live", "presents"]);

/**
 * Comparison key for a venue, artist or organiser name: lowercase, no
 * punctuation, no filler words, and without the city name ("Social Indore"
 * and "SOCIAL" compare equal).
 */
export function nameKey(name: string, cityName?: string): string {
  const city = cityName?.toLowerCase();
  const words = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’.]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w && !NAME_NOISE.has(w) && w !== city);
  return words.join(" ");
}

/** An Instagram handle reduced to letters and digits, for comparing against a name key. */
export function handleKey(handle: string, cityName?: string): string {
  let h = handle.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9]/g, "");
  h = h.replace(/official/g, "");
  if (cityName) h = h.replace(cityName.toLowerCase(), "");
  return h;
}

function bigrams(s: string): Map<string, number> {
  const t = s.replace(/\s+/g, " ");
  const m = new Map<string, number>();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice coefficient on character bigrams, 0..1. Tolerates small spelling differences. */
export function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const x = bigrams(a);
  const y = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const [g, n] of x) {
    overlap += Math.min(n, y.get(g) ?? 0);
    total += n;
  }
  for (const n of y.values()) total += n;
  return total === 0 ? 0 : (2 * overlap) / total;
}

const TITLE_NOISE = new Set([
  ...NAME_NOISE, "ft", "feat", "featuring", "with", "night", "nights", "show", "event", "presents", "in", "on",
  "this", "tonight", "edition", "vol", "by",
]);

function titleTokens(title: string): Set<string> {
  return new Set(nameKey(title).split(" ").filter((w) => w.length > 1 && !TITLE_NOISE.has(w)));
}

/**
 * How alike two event titles are, 0..1. The larger of spelling similarity and
 * shared-word overlap measured against the shorter title, so "DJ Aria Live" and
 * "Saturday Sundowner ft. DJ Aria" still score well.
 */
export function titleSimilarity(a: string, b: string): number {
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (!ka || !kb) return 0;
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  const smaller = Math.min(ta.size, tb.size);
  const overlap = smaller === 0 ? 0 : shared / smaller;
  return Math.max(diceSimilarity(ka, kb), overlap);
}

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Offset of `timeZone` from UTC, in minutes, at the given instant. */
function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** The UTC instant of a wall-clock date ("YYYY-MM-DD") and time ("HH:MM") in a timezone. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offset = tzOffsetMinutes(new Date(guess), timeZone);
  const first = guess - offset * 60_000;
  // Re-check at the corrected instant, in case the offset differs across a DST change.
  const offset2 = tzOffsetMinutes(new Date(first), timeZone);
  return new Date(guess - offset2 * 60_000);
}

/** "YYYY-MM-DD" of an instant as seen in a timezone. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

export function localWeekday(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(instant);
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isClockTime(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}
