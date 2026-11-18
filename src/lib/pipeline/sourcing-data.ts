/**
 * Per-city source lists for wider sourcing (Prompt 9), read from
 * data/sourcing.json: the census area, discovery hashtags and web calendars.
 * Adding a city means adding an entry there, not changing code.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { sourcing } from "../../config";

export interface CalendarSource {
  key: string;
  name: string;
  /**
   * jsonld-list: a listing page whose event links are followed and read from their schema.org Event data;
   * sitemap-page: event pages found in a sitemap, read as text (between textStart and textEnd);
   * page: one page read as text.
   */
  kind: "jsonld-list" | "sitemap-page" | "page";
  url: string;
  eventUrlPattern?: string;
  textStart?: string;
  textEnd?: string;
  /** Skip a page (no model call) unless its text names this word, usually the city. */
  mustMention?: string;
  everyDays: number;
  enabled: boolean;
  /** When and what was checked about the source's terms and robots.txt. */
  checked: string;
}

export interface CitySourcing {
  censusBbox?: [number, number, number, number];
  hashtags: string[];
  calendars: CalendarSource[];
}

let cache: Record<string, CitySourcing> | undefined;

export function sourcingData(file = path.join(process.cwd(), "data", "sourcing.json")): Record<string, CitySourcing> {
  if (cache && !process.env.VITEST) return cache;
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, Partial<CitySourcing>>;
  const out: Record<string, CitySourcing> = {};
  for (const [city, v] of Object.entries(raw)) {
    out[city] = { censusBbox: v.censusBbox, hashtags: v.hashtags ?? [], calendars: v.calendars ?? [] };
  }
  return (cache = out);
}

export function forCity(slug: string): CitySourcing {
  return sourcingData()[slug] ?? { hashtags: [], calendars: [] };
}

/** Calendars switched on: WEB_CALENDARS when set, otherwise each entry's own flag. */
export function enabledCalendars(slug: string, only = sourcing.calendars.enabled): CalendarSource[] {
  return forCity(slug).calendars.filter((c) => (only ? only.includes(c.key) : c.enabled));
}
