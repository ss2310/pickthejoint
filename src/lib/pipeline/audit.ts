/**
 * City audit: checks published listings that were created before extraction
 * recorded each event's city. A listing that turns out to be somewhere else
 * is unpublished and put in the review queue with the reason; one the models
 * cannot place stays up but is queued for a person to look at. Each listing
 * is audited once.
 */
import { z } from "zod";
import type { Pool } from "pg";
import { ingestion } from "../../config";
import type { LlmClient, LlmRequest } from "./llm";

const CitySchema = z.object({ takes_place_in_city: z.boolean(), actual_city: z.string().nullable(), confidence: z.number() });
type CityAnswer = z.infer<typeof CitySchema>;

interface Row {
  id: number; title: string; city: string; state: string; venue: string | null; address: string | null;
  description: string | null; captions: string[] | null; sources: string[] | null;
}

function request(row: Row, tier: "fast" | "mid"): LlmRequest<CityAnswer> {
  const text = [
    `Listing filed under: ${row.city}, ${row.state}, India`,
    `Event: ${row.title}`,
    row.venue ? `Venue: ${row.venue}${row.address ? `, ${row.address}` : ""}` : null,
    row.description ? `Description: ${row.description}` : null,
    row.sources?.length ? `Source accounts: ${row.sources.join(", ")}` : null,
    ...(row.captions ?? []).map((c, i) => `Source text ${i + 1}:\n${c.slice(0, 1500)}`),
  ].filter(Boolean).join("\n");
  return {
    id: String(row.id), tier, schema: CitySchema, maxTokens: tier === "fast" ? 300 : 2000, effort: "low",
    system: `You check event listings for a city events guide. Decide whether the event takes place in the city it is filed under (its suburbs and localities count as the city).
Listing and ticketing accounts post about events all over the world, so do not assume the filing is right: look for a city, state, country, address or venue that places the event. If the evidence places it in the filed city, answer true. A venue, bar, cafe, hotel or mall account that belongs to the filed city posting about an event at its own premises is in that city, even if the post does not name the city. If it places it somewhere else, answer false and name the actual city. If nothing in the text places it anywhere, answer true with a confidence below 0.5. Give your confidence from 0 to 1.`,
    content: [{ type: "text", text }],
    estInputTokens: 260 + Math.ceil(text.length / 3), estOutputTokens: tier === "fast" ? 40 : 300,
  };
}

export interface AuditReport { checked: number; inCity: number; unpublished: { title: string; actualCity: string | null }[]; unsure: number; modelUsd: number }

export async function auditCities(pool: Pool, llm: LlmClient, opts: { jobName: string; batch?: boolean }): Promise<AuditReport> {
  const report: AuditReport = { checked: 0, inCity: 0, unpublished: [], unsure: 0, modelUsd: 0 };
  const { rows } = await pool.query<Row>(
    `SELECT e.id, e.title, c.name AS city, c.state, v.name AS venue, v.address, e.description,
            (SELECT array_agg(rp.caption) FROM sources s JOIN raw_posts rp ON rp.id = s.raw_post_id WHERE s.event_id = e.id AND rp.caption IS NOT NULL) AS captions,
            (SELECT array_agg(DISTINCT rp.handle || coalesce(' (listed as: ' || h.handle_type || ')', '')) FROM sources s JOIN raw_posts rp ON rp.id = s.raw_post_id
               LEFT JOIN handles h ON h.handle = rp.handle WHERE s.event_id = e.id) AS sources
     FROM events e JOIN cities c ON c.id = e.city_id LEFT JOIN venues v ON v.id = e.venue_id
     WHERE e.is_published AND NOT e.city_checked AND e.origin = 'scraped' ORDER BY e.id`);
  if (rows.length === 0) return report;

  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const sure = (a: CityAnswer | undefined) => !!a && a.confidence >= ingestion.fastTierMinConfidence;
  const answers = new Map<string, CityAnswer | undefined>();
  const first = await llm.run(rows.map((r) => request(r, "fast")), opts);
  for (const r of first) { report.modelUsd += r.usd; answers.set(r.id, r.ok ? r.data : undefined); }
  // One retry on the mid tier for the ones the fast tier was unsure about.
  const retry = rows.filter((r) => !sure(answers.get(String(r.id))));
  for (const r of await llm.run(retry.map((row) => request(row, "mid")), opts)) {
    report.modelUsd += r.usd;
    if (r.ok) answers.set(r.id, r.data);
  }

  for (const [id, row] of byId) {
    const a = answers.get(id);
    report.checked++;
    if (sure(a) && a!.takes_place_in_city) {
      report.inCity++;
    } else if (sure(a)) {
      report.unpublished.push({ title: row.title, actualCity: a!.actual_city });
      await pool.query("UPDATE events SET is_published = false, updated_at = now() WHERE id = $1", [row.id]);
      await pool.query(
        "INSERT INTO review_queue (item_type, item_id, reason, payload) VALUES ('event', $1, $2, $3)",
        [row.id, `unpublished: appears to take place outside ${row.city}`, { actualCity: a!.actual_city, confidence: a!.confidence }]);
    } else {
      report.unsure++;
      await pool.query(
        "INSERT INTO review_queue (item_type, item_id, reason, payload) VALUES ('event', $1, $2, $3)",
        [row.id, `could not confirm the event is in ${row.city}`, { answer: a ?? null }]);
    }
    await pool.query("UPDATE events SET city_checked = true WHERE id = $1", [row.id]);
  }
  report.modelUsd = Number(report.modelUsd.toFixed(4));
  return report;
}
