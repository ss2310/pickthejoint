/** Date and time formatting for pages. Everything is shown in the city's timezone (hard rule 7). */

const fmt = (timeZone: string, opts: Intl.DateTimeFormatOptions, locale = "en-IN") =>
  new Intl.DateTimeFormat(locale, { timeZone, ...opts });

/** "Saturday, 21 November 2026" */
export function longDate(d: Date, timeZone: string): string {
  return fmt(timeZone, { weekday: "long", day: "numeric", month: "long", year: "numeric" }, "en-GB").format(d);
}

/** "Sat 21 Nov" */
export function shortDate(d: Date, timeZone: string): string {
  return fmt(timeZone, { weekday: "short", day: "numeric", month: "short" }, "en-GB").format(d).replace(",", "");
}

/** "8:00 PM" */
export function clock(d: Date, timeZone: string): string {
  return fmt(timeZone, { hour: "numeric", minute: "2-digit", hour12: true }, "en-US").format(d);
}

/** "18 November 2026, 9:05 AM IST" */
export function stamp(d: Date, timeZone: string): string {
  const zone = timeZone === "Asia/Kolkata" ? "IST" : timeZone;
  return `${fmt(timeZone, { day: "numeric", month: "long", year: "numeric" }, "en-GB").format(d)}, ${clock(d, timeZone)} ${zone}`;
}

/** "YYYY-MM-DD" as seen in the timezone. */
export function isoDay(d: Date, timeZone: string): string {
  return fmt(timeZone, { year: "numeric", month: "2-digit", day: "2-digit" }, "en-CA").format(d);
}

/** ISO 8601 with the timezone's UTC offset, e.g. "2026-11-21T20:00:00+05:30" (for structured data). */
export function isoWithOffset(d: Date, timeZone: string): string {
  const parts = fmt(timeZone, {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }, "en-CA").formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const local = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
  const offsetMin = Math.round((Date.parse(`${local}Z`) - d.getTime()) / 60_000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday, for a "YYYY-MM-DD" date. */
export function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

/** Human date for a "YYYY-MM-DD" value: "Saturday, 21 November 2026". */
export function longDay(isoDate: string): string {
  return longDate(new Date(`${isoDate}T12:00:00Z`), "UTC");
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "A", "A and B", "A, B and C" */
export function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
