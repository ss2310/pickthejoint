/**
 * Made-up listings for tests and local development: a handful of events that
 * cover the cases pages must handle (free, paid, cancelled, no start time,
 * multi-day, past, unpublished). Dates are set relative to `now`.
 * Never load this into production: the names are invented.
 */
import type { Pool } from "pg";
import { localDate, zonedToUtc } from "../src/lib/pipeline/text";

const TZ = "Asia/Kolkata";

export async function seedDemo(pool: Pool, now = new Date()): Promise<void> {
  const today = localDate(now, TZ);
  const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
  const at = (offset: number, time: string) => zonedToUtc(day(offset), time, TZ);
  const one = async <T>(sql: string, args: unknown[]) => (await pool.query(sql, args)).rows[0] as T;

  const city = await one<{ id: number }>("SELECT id FROM cities WHERE slug = 'indore'", []);
  const area = async (slug: string) => (await one<{ id: number }>("SELECT id FROM areas WHERE city_id = $1 AND slug = $2", [city.id, slug])).id;
  const cat = async (slug: string) => (await one<{ id: number }>("SELECT id FROM categories WHERE slug = $1", [slug])).id;

  const venue = async (slug: string, name: string, areaSlug: string, address: string, extra: Record<string, unknown> = {}) =>
    (await one<{ id: number }>(
      `INSERT INTO venues (city_id, area_id, slug, name, address, official_links, lat, lng, capacity, parking, how_to_reach, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [city.id, await area(areaSlug), slug, name, address, JSON.stringify(extra.links ?? {}), extra.lat ?? null, extra.lng ?? null,
        extra.capacity ?? null, extra.parking ?? null, extra.reach ?? null, extra.description ?? null])).id;
  const blueRoom = await venue("the-blue-room", "The Blue Room", "vijay-nagar", "12 Example Road, Vijay Nagar", {
    links: { instagram: "the_blue_room_demo" }, lat: 22.7533, lng: 75.8937, capacity: 180,
    parking: "Basement parking for about 40 cars.", reach: "Five minutes from Vijay Nagar Square by auto.",
    description: "A listening room with a small stage and a bar at the back.",
  });
  const cottage = await venue("laugh-cottage", "Laugh Cottage", "old-palasia", "4 Sample Lane, Old Palasia");
  const grounds = await venue("city-grounds", "City Grounds", "race-course-road", "Race Course Road");

  const artist = async (slug: string, name: string, kind: string, bio: string | null) =>
    (await one<{ id: number }>("INSERT INTO artists (slug, name, kind, bio, genre, official_links) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [slug, name, kind, bio, kind === "group" ? "Jazz" : null, JSON.stringify(bio ? { instagram: `${slug.replace(/-/g, "")}_demo` } : {})])).id;
  const quartet = await artist("aria-quartet", "Aria Quartet", "group", "Aria Quartet is a four-piece jazz group that plays standards and original compositions.");
  const comic = await artist("dev-sharma", "Dev Sharma", "person", null);
  const organiser = (await one<{ id: number }>(
    "INSERT INTO organisers (slug, name, bio) VALUES ('indore-jazz-club', 'Indore Jazz Club', 'A volunteer-run club that puts on monthly jazz nights.') RETURNING id", [])).id;
  const series = (await one<{ id: number }>(
    "INSERT INTO series (slug, name, city_id, description, recurrence) VALUES ('winter-arts-week', 'Winter Arts Week', $1, 'Winter Arts Week is a festival of music, theatre and craft held in Indore.', 'every year in winter') RETURNING id",
    [city.id])).id;

  interface E {
    slug: string; title: string; venue: number; cat: string; start: Date; end?: Date; timeKnown?: boolean; price?: string; free?: boolean;
    booking?: string; status?: string; published?: boolean; series?: number; artists?: number[]; organisers?: number[]; desc?: string;
  }
  const events: E[] = [
    { slug: `aria-quartet-live-${day(0)}`, title: "Aria Quartet Live", venue: blueRoom, cat: "music", start: at(0, "20:00"), end: at(0, "22:30"),
      price: "₹499 onwards", free: false, booking: "https://tickets.example/aria", artists: [quartet], organisers: [organiser],
      desc: "Aria Quartet plays an evening of jazz standards and original pieces at The Blue Room in Vijay Nagar, Indore. The show starts at 8:00 PM and tickets start at ₹499." },
    { slug: `open-mic-night-${day(1)}`, title: "Open Mic Night", venue: cottage, cat: "comedy", start: at(1, "19:30"), free: true, artists: [comic],
      desc: "An open mic evening of stand-up comedy at Laugh Cottage in Old Palasia, Indore, with free entry." },
    { slug: `saturday-social-${day(2)}`, title: "Saturday Social", venue: blueRoom, cat: "nightlife", start: at(2, "21:00"), price: "Cover ₹1000", free: false, status: "cancelled",
      desc: "A DJ night at The Blue Room." },
    { slug: `block-printing-workshop-${day(3)}`, title: "Block Printing Workshop", venue: cottage, cat: "workshops", start: at(3, "00:00"), timeKnown: false, price: "₹1,200 per person", free: false,
      desc: "A hands-on block printing workshop at Laugh Cottage in Old Palasia, Indore." },
    { slug: `winter-arts-week-${day(5)}`, title: "Winter Arts Week", venue: grounds, cat: "festivals", start: at(5, "11:00"), end: at(7, "22:00"), free: true, series,
      desc: "Three days of music, theatre and craft stalls at City Grounds on Race Course Road, Indore, with free entry." },
    { slug: `the-last-letter-${day(-10)}`, title: "The Last Letter", venue: blueRoom, cat: "theatre", start: at(-10, "19:00"), price: "₹300", free: false, status: "happened", artists: [comic],
      desc: "A one-act play staged at The Blue Room in Indore." },
    { slug: `secret-gig-${day(1)}`, title: "Secret Gig", venue: blueRoom, cat: "music", start: at(1, "20:00"), published: false },
  ];
  for (const e of events) {
    const row = await one<{ id: number }>(
      `INSERT INTO events (city_id, venue_id, category_id, series_id, slug, title, description, starts_at, ends_at, local_date, start_time_known,
         price_text, is_free, booking_url, status, confidence, is_published, last_verified_at, origin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,0.9,$16,$17,'scraped') RETURNING id`,
      [city.id, e.venue, await cat(e.cat), e.series ?? null, e.slug, e.title, e.desc ?? null, e.start, e.end ?? null, localDate(e.start, TZ),
        e.timeKnown ?? true, e.price ?? null, e.free ?? null, e.booking ?? null, e.status ?? "scheduled", e.published ?? true, now]);
    await pool.query("INSERT INTO sources (event_id, source_type, url) VALUES ($1, 'instagram', $2)", [row.id, `https://www.instagram.com/p/DEMO${row.id}/`]);
    for (const [i, a] of (e.artists ?? []).entries()) await pool.query("INSERT INTO event_artists (event_id, artist_id, billing_order) VALUES ($1,$2,$3)", [row.id, a, i]);
    for (const o of e.organisers ?? []) await pool.query("INSERT INTO event_organisers (event_id, organiser_id) VALUES ($1,$2)", [row.id, o]);
  }
}
