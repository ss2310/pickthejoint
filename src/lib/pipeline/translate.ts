/**
 * Hindi translation (Prompt 5). Text is translated when it is created or
 * changed, never when a page loads: this step finds every piece of public
 * text whose Hindi is missing or out of date, translates it with the mid-tier
 * model and stores the result in `translations`. Pages read that table and
 * fall back to English for anything not there yet.
 *
 * Names (people, bands, venues, events, places) are written in Devanagari as
 * they sound; they go first, and the settled spellings are then handed to the
 * model with the longer texts so a name reads the same everywhere.
 *
 * "Out of date" is decided by a hash of the English text stored beside each
 * translation, so unchanged text is never paid for twice.
 */
import { z } from "zod";
import type { Pool } from "pg";
import { translation, type Locale } from "../../config";
import { estimateUsd, type LlmClient, type LlmRequest } from "./llm";

const LOCALE: Locale = "hi";

/** Fields that hold a proper name: transliterated, not translated. */
const NAME_FIELDS = new Set(["event:title", "venue:name", "artist:name", "organiser:name", "series:name", "area:name", "city:name", "city:state", "artist:hometown"]);

/** What each field is, in words the translator can use. */
const FIELD_LABEL: Record<string, string> = {
  "event:title": "name of an event", "event:description": "description of an event", "event:price_text": "ticket price line",
  "venue:name": "name of a venue", "venue:venue_type": "type of venue (a few words)", "venue:address": "postal address",
  "venue:parking": "parking note", "venue:how_to_reach": "directions", "venue:landmarks": "nearby landmarks", "venue:description": "description of a venue",
  "artist:name": "name of a performer or band", "artist:genre": "music genre or art form", "artist:hometown": "name of a place",
  "artist:bio": "profile of a performer", "organiser:name": "name of an event organiser", "organiser:bio": "profile of an organiser",
  "series:name": "name of a festival or recurring event", "series:description": "description of a recurring event", "series:recurrence": "when it recurs",
  "area:name": "name of a neighbourhood", "city:name": "name of a city", "city:state": "name of an Indian state",
};

export interface Item { type: string; id: number; field: string; text: string; hash: string }

/** Every piece of public text, with whether its Hindi is missing or stale. Only pages a visitor can reach are included. */
const PENDING_SQL = `
WITH src AS (
  SELECT 'event' AS type, e.id, f.field, f.text, 1 AS rank
    FROM events e JOIN cities c ON c.id = e.city_id,
         LATERAL (VALUES ('title', e.title), ('description', e.description), ('price_text', e.price_text)) f(field, text)
    WHERE e.is_published AND c.is_live
  UNION ALL
  SELECT 'venue', v.id, f.field, f.text, 2
    FROM venues v JOIN cities c ON c.id = v.city_id,
         LATERAL (VALUES ('name', v.name), ('venue_type', v.venue_type), ('address', v.address), ('parking', v.parking),
                         ('how_to_reach', v.how_to_reach), ('landmarks', v.landmarks), ('description', v.description)) f(field, text)
    WHERE c.is_live AND EXISTS (SELECT 1 FROM events e WHERE e.venue_id = v.id AND e.is_published)
  UNION ALL
  SELECT 'artist', p.id, f.field, f.text, 3
    FROM artists p, LATERAL (VALUES ('name', p.name), ('genre', p.genre), ('hometown', p.hometown), ('bio', p.bio)) f(field, text)
    WHERE EXISTS (SELECT 1 FROM event_artists j JOIN events e ON e.id = j.event_id WHERE j.artist_id = p.id AND e.is_published)
  UNION ALL
  SELECT 'organiser', p.id, f.field, f.text, 4
    FROM organisers p, LATERAL (VALUES ('name', p.name), ('bio', p.bio)) f(field, text)
    WHERE EXISTS (SELECT 1 FROM event_organisers j JOIN events e ON e.id = j.event_id WHERE j.organiser_id = p.id AND e.is_published)
  UNION ALL
  SELECT 'series', s.id, f.field, f.text, 5
    FROM series s, LATERAL (VALUES ('name', s.name), ('description', s.description), ('recurrence', s.recurrence)) f(field, text)
  UNION ALL
  SELECT 'area', a.id, 'name', a.name, 6 FROM areas a JOIN cities c ON c.id = a.city_id WHERE c.is_live
  UNION ALL
  SELECT 'city', c.id, f.field, f.text, 0 FROM cities c, LATERAL (VALUES ('name', c.name), ('state', c.state)) f(field, text) WHERE c.is_live
)
SELECT src.type, src.id, src.field, src.text, md5(src.text) AS hash
FROM src LEFT JOIN translations t
  ON t.entity_type = src.type AND t.entity_id = src.id AND t.locale = $1 AND t.field = src.field
WHERE src.text IS NOT NULL AND btrim(src.text) <> ''
  AND (t.id IS NULL OR t.source_hash IS DISTINCT FROM md5(src.text)
       -- A stored translation with a word half in Devanagari and half in Latin letters ("टour") is redone.
       OR t.text ~ '[ऀ-ॿ][A-Za-z]|[A-Za-z][ऀ-ॿ]')
ORDER BY src.rank, src.id, src.field`;

export async function pendingItems(pool: Pool): Promise<Item[]> {
  const { rows } = await pool.query<Item>(PENDING_SQL, [LOCALE]);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

const isName = (i: Item) => NAME_FIELDS.has(`${i.type}:${i.field}`);

const SYSTEM = `You translate text for a city events guide in India from English into Hindi.

Write natural, everyday Hindi in Devanagari, the way the city page of a Hindi newspaper reads. Keep the English words people really use when they talk about going out (टिकट, शो, इवेंट, बुकिंग, कॉमेडी, कॉन्सर्ट, वर्कशॉप, एंट्री, पार्किंग); do not replace them with formal coinages.

Each item is marked NAME or TEXT.
- NAME: a proper name (a person, band, venue, event, festival, place). Write it in Devanagari as it is pronounced. Do not translate its meaning: "The Blue Room" is "द ब्लू रूम", not "नीला कमरा". Initials, brand names and names that are normally written in Latin letters even in Hindi stay as they are (DJ, TEDx, BookMyShow, YouTube, U4ria).
- TEXT: translate it. Inside the text, write names of people, venues and events in Devanagari as pronounced, and use the spellings given under "Names already settled" exactly when those names appear. Keep every number, ₹ amount, time, phone number, web address and @handle exactly as written. Write dates with Hindi month and weekday names. Add nothing and leave nothing out: no explanations, no notes, no quotation marks around the result.

Return one entry for every item, with the same number.`;

const OutSchema = z.object({ items: z.array(z.object({ n: z.number(), text: z.string() })) });
type Out = z.infer<typeof OutSchema>;

function chunk(items: Item[]): Item[][] {
  const out: Item[][] = [];
  let cur: Item[] = [];
  let chars = 0;
  for (const i of items) {
    if (cur.length && (cur.length >= translation.itemsPerRequest || chars + i.text.length > translation.charsPerRequest)) { out.push(cur); cur = []; chars = 0; }
    cur.push(i);
    chars += i.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

function request(id: string, items: Item[], settled: Map<string, string>): LlmRequest<Out> {
  // Only the settled names that actually occur in these texts are sent along.
  const haystack = items.map((i) => i.text.toLowerCase()).join("\n");
  const glossary = [...settled].filter(([name]) => name.length > 2 && haystack.includes(name.toLowerCase())).slice(0, 40);
  const lines = items.map((i, n) => `${n + 1}. [${isName(i) ? "NAME" : "TEXT"}: ${FIELD_LABEL[`${i.type}:${i.field}`] ?? i.field}] ${i.text.replace(/\s+/g, " ").trim()}`);
  const text = `${glossary.length ? `Names already settled:\n${glossary.map(([a, b]) => `${a} = ${b}`).join("\n")}\n\n` : ""}Items:\n${lines.join("\n")}`;
  const chars = items.reduce((s, i) => s + i.text.length, 0);
  return {
    id, tier: "mid", system: SYSTEM, content: [{ type: "text", text }], schema: OutSchema, maxTokens: 8000, effort: "low",
    estInputTokens: 520 + Math.ceil(text.length / 3), estOutputTokens: 60 + Math.ceil(chars * 0.9) + items.length * 12,
  };
}

const DEVANAGARI = /[ऀ-ॿ]/;
const MIXED_WORD = /[ऀ-ॿ][A-Za-z]|[A-Za-z][ऀ-ॿ]/;

/** A translation we are willing to store: something came back, of a believable length, and running text is actually in Hindi. */
export function acceptable(item: Item, text: string): boolean {
  const t = text.trim();
  if (!t || t.length > item.text.length * 4 + 40) return false;
  // A word that switches script half way ("टour") is a garbled transliteration, never real Hindi.
  if (MIXED_WORD.test(t)) return false;
  if (isName(item)) return true;
  // Prices and other short lines may be all digits and symbols; longer text must contain Hindi.
  return DEVANAGARI.test(t) || !/[A-Za-z]{4,}/.test(item.text);
}

export interface TranslateReport {
  pending: number;
  translated: number;
  failed: number;
  requests: number;
  estimatedUsd: number;
  usd: number;
  byType: Record<string, number>;
  note?: string;
}

export interface TranslateOptions { jobName: string; dryRun?: boolean; batch?: boolean; limit?: number }

export async function translatePending(pool: Pool, llm: LlmClient, opts: TranslateOptions): Promise<TranslateReport> {
  let items = await pendingItems(pool);
  const report: TranslateReport = { pending: items.length, translated: 0, failed: 0, requests: 0, estimatedUsd: 0, usd: 0, byType: {} };
  if (opts.limit && items.length > opts.limit) {
    items = items.slice(0, opts.limit);
    report.note = `limited to the first ${opts.limit} of ${report.pending} items`;
  }
  for (const i of items) report.byType[i.type] = (report.byType[i.type] ?? 0) + 1;
  if (items.length === 0) return report;

  const names = items.filter(isName);
  const texts = items.filter((i) => !isName(i));

  // Spellings settled on earlier runs, so today's texts use them too.
  const settled = new Map<string, string>();
  const known = await pool.query<{ source: string; text: string }>(
    `SELECT s.source, t.text FROM translations t JOIN (
       SELECT 'venue' AS type, id, name AS source FROM venues UNION ALL SELECT 'artist', id, name FROM artists
       UNION ALL SELECT 'organiser', id, name FROM organisers UNION ALL SELECT 'series', id, name FROM series
       UNION ALL SELECT 'area', id, name FROM areas UNION ALL SELECT 'city', id, name FROM cities
     ) s ON s.type = t.entity_type AND s.id = t.entity_id
     WHERE t.locale = $1 AND t.field = 'name'`, [LOCALE]);
  for (const k of known.rows) settled.set(k.source, k.text);

  const run = async (group: Item[], label: string) => {
    const chunks = chunk(group);
    const requests = chunks.map((c, n) => request(`${label}-${n}`, c, settled));
    report.requests += requests.length;
    report.estimatedUsd += requests.reduce((s, r) => s + estimateUsd(r, opts.batch), 0);
    const results = await llm.run(requests, { jobName: opts.jobName, dryRun: opts.dryRun, batch: opts.batch, subBudget: "translation", pool });
    if (opts.dryRun) return;
    const byId = new Map(results.map((r) => [r.id, r]));
    for (const [n, c] of chunks.entries()) {
      const res = byId.get(`${label}-${n}`);
      report.usd += res?.usd ?? 0;
      const out = new Map((res?.ok ? res.data?.items ?? [] : []).map((x) => [x.n, x.text]));
      for (const [k, item] of c.entries()) {
        const text = out.get(k + 1)?.trim().replace(/\s+/g, " ");
        // Anything missing or implausible is left untranslated: the page shows English and the next run tries again.
        if (!text || !acceptable(item, text)) { report.failed++; continue; }
        await pool.query(
          `INSERT INTO translations (entity_type, entity_id, locale, field, text, source_hash, updated_at) VALUES ($1,$2,$3,$4,$5,$6,now())
           ON CONFLICT (entity_type, entity_id, locale, field) DO UPDATE SET text = EXCLUDED.text, source_hash = EXCLUDED.source_hash, updated_at = now()`,
          [item.type, item.id, LOCALE, item.field, text, item.hash]);
        if (isName(item)) settled.set(item.text, text);
        report.translated++;
      }
    }
  };

  await run(names, "names");
  await run(texts, "texts");
  report.estimatedUsd = Number(report.estimatedUsd.toFixed(4));
  report.usd = Number(report.usd.toFixed(4));
  return report;
}
