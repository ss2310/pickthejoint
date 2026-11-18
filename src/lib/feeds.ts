/** Calendar (ICS) files for single events and city feeds, and the JSON feed of upcoming events. */
import { site } from "../config";
import type { City, EventCard } from "./queries";
import { abs, eventPath, venuePath } from "./schema";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const utc = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const day = (iso: string) => iso.replace(/-/g, "");

/** Lines longer than 75 bytes are folded, as the iCalendar format requires. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > 73) { out.push(cur); cur = " "; bytes = 1; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

export interface CalendarEvent extends EventCard { description?: string | null }

function vevent(e: CalendarEvent, stamp: Date): string[] {
  const url = abs(eventPath(e));
  const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: e.timezone }).format(e.starts_at);
  const nextDay = new Date(Date.parse(`${localDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const when = e.start_time_known
    // Without an announced end, two hours is a reasonable calendar block.
    ? [`DTSTART:${utc(e.starts_at)}`, `DTEND:${utc(e.ends_at ?? new Date(e.starts_at.getTime() + 2 * 3_600_000))}`]
    : [`DTSTART;VALUE=DATE:${day(localDay)}`, `DTEND;VALUE=DATE:${day(nextDay)}`];
  const where = [e.venue_name, e.area_name].filter(Boolean).join(", ");
  return [
    "BEGIN:VEVENT",
    `UID:event-${e.id}@${new URL(site.url).hostname}`,
    `DTSTAMP:${utc(stamp)}`,
    `LAST-MODIFIED:${utc(e.updated_at)}`,
    ...when,
    `SUMMARY:${esc(e.title)}`,
    where ? `LOCATION:${esc(where)}` : "",
    `DESCRIPTION:${esc([e.description, e.is_free ? "Free entry" : e.price_text, `Details and source: ${url}`].filter(Boolean).join("\n\n"))}`,
    `URL:${url}`,
    `STATUS:${e.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
  ].filter(Boolean);
}

export function calendar(events: CalendarEvent[], name: string, now = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:-//${site.name}//Events//EN`, "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`,
    ...events.flatMap((e) => vevent(e, now)),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function icsResponse(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "public, max-age=600",
    },
  });
}

export function jsonFeed(city: City, events: EventCard[], now = new Date()) {
  return {
    title: `Upcoming events in ${city.name}`,
    home_page_url: abs(`/${city.slug}`),
    feed_url: abs(`/${city.slug}/feed.json`),
    generated_at: now.toISOString(),
    timezone: city.timezone,
    events: events.map((e) => ({
      id: abs(eventPath(e)),
      url: abs(eventPath(e)),
      title: e.title,
      starts_at: e.starts_at.toISOString(),
      ends_at: e.ends_at?.toISOString() ?? null,
      start_time_announced: e.start_time_known,
      status: e.status,
      category: e.category_name,
      venue: e.venue_name ? { name: e.venue_name, area: e.area_name, url: e.venue_slug ? abs(venuePath(e.city_slug, e.venue_slug)) : null } : null,
      price: e.is_free ? "Free entry" : e.price_text,
      is_free: e.is_free,
      performers: e.performers,
      date_modified: e.updated_at.toISOString(),
    })),
  };
}
