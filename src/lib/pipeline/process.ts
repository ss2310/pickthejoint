/**
 * Processes stored posts through the pipeline:
 *   filter (caption only) -> extract (caption + poster, transcript if needed)
 *   -> resolve (match, de-duplicate, publish or queue) -> write descriptions.
 * Each stage reads its input from the database, so a run that stops part-way
 * (for example on a budget cap) resumes where it left off next time.
 */
import type { Pool } from "pg";
import { apify, ingestion } from "../../config";
import { guardedCall } from "../budget-guard";
import type { ApifyClient } from "./apify";
import { auditCities, type AuditReport } from "./audit";
import { extractionRequest, fetchImages, missingForTranscript, type Extraction, type ExtractionInput } from "./extract";
import { filterRequest, ruleFilter, type FilterLabel } from "./filter";
import { estimateUsd, type LlmClient } from "./llm";
import { emptyCounts, resolvePost, type PostContext } from "./resolve";
import { descriptionEstimate, writeDescriptions } from "./write";

export interface Deps {
  llm: LlmClient;
  apify: ApifyClient;
  fetchFn?: typeof fetch;
}

export interface ProcessOptions {
  jobName: string;
  dryRun?: boolean;
  batch?: boolean;
  /** Dry run only: posts the scrape would fetch, to include in the estimate. */
  expectedNewPosts?: number;
}

interface RawRow {
  id: number; shortcode: string; handle: string; post_url: string; post_type: string | null; caption: string | null;
  media_urls: string[]; tagged_handles: string[]; posted_at: Date | null; fetched_at: Date; source_kind: "instagram" | "google" | "news" | "web" | "facebook";
  filter_result: FilterLabel | null; extraction: Extraction | null; transcript: string | null;
  transcript_requested_at: Date | null; city_id: number; city_name: string; timezone: string; handle_type: string | null;
  /** The Facebook page's name, for Facebook items. */
  page_name: string | null;
}

const RAW_SELECT = `
  SELECT rp.id, rp.shortcode, rp.handle, rp.post_url, rp.post_type, rp.caption, rp.media_urls, rp.tagged_handles,
         rp.posted_at, rp.fetched_at, rp.source_kind, rp.filter_result, rp.extraction, rp.transcript,
         rp.transcript_requested_at, c.id AS city_id, c.name AS city_name, c.timezone,
         coalesce(h.handle_type, fp.category) AS handle_type, fp.name AS page_name
  FROM raw_posts rp
  LEFT JOIN handles h ON h.handle = rp.handle AND rp.source_kind = 'instagram'
  LEFT JOIN facebook_pages fp ON fp.page = rp.handle AND fp.city_id = rp.city_id AND rp.source_kind = 'facebook'
  JOIN cities c ON c.id = coalesce(rp.city_id, h.city_id)`;

/** An ordinary post on a Facebook page ("fbp:<post id>"), as opposed to a native Facebook event ("fb:<event id>"). */
const isFacebookPost = (row: Pick<RawRow, "source_kind" | "shortcode">) => row.source_kind === "facebook" && row.shortcode.startsWith("fbp:");

const usd = (n: number) => Number(n.toFixed(4));

/** Adds a model call's cost to the item it was for, so cost per event can be reported by source. */
async function charge(pool: Pool, rawPostId: number | string, amount: number) {
  if (amount > 0) await pool.query("UPDATE raw_posts SET model_usd = model_usd + $2 WHERE id = $1", [Number(rawPostId), amount]);
}

/** Where a raw post came from, for per-source counts: "instagram", or "<kind>:<source key>". */
export const sourceLabel = (kind: string, handle: string) => (kind === "instagram" ? "instagram" : `${kind}:${handle}`);

async function cityLists(pool: Pool) {
  const areas = await pool.query<{ city_id: number; name: string }>("SELECT city_id, name FROM areas ORDER BY name");
  const cats = await pool.query<{ slug: string }>("SELECT slug FROM categories ORDER BY sort_order");
  return {
    areasFor: (cityId: number) => areas.rows.filter((a) => Number(a.city_id) === Number(cityId)).map((a) => a.name),
    categorySlugs: cats.rows.map((c) => c.slug),
  };
}

function toInput(row: RawRow, lists: Awaited<ReturnType<typeof cityLists>>, images: ExtractionInput["images"]): ExtractionInput {
  const fbPost = isFacebookPost(row);
  return {
    id: String(row.id), sourceKind: fbPost ? "facebook_post" : row.source_kind,
    sourceName: fbPost ? `${row.page_name ? `"${row.page_name}", ` : ""}facebook.com/${row.handle}` : row.handle, sourceType: row.handle_type ?? undefined,
    cityName: row.city_name, timeZone: row.timezone, postedAt: row.posted_at ?? row.fetched_at,
    text: row.caption ?? "", transcript: row.transcript, images,
    areas: lists.areasFor(row.city_id), categorySlugs: lists.categorySlugs,
  };
}

/** Transcript actors differ in input and output names; these cover the ones we have checked. */
export function transcriptInput(actorId: string, reelUrl: string): Record<string, unknown> {
  if (/instagram-reel-transcript-scraper$/.test(actorId)) return { reelUrls: [reelUrl], maxItems: 1 };
  if (/instagram-reel-scraper$/.test(actorId)) return { username: [reelUrl], resultsLimit: 1, includeTranscript: true };
  return { bulkUrls: [reelUrl] };
}
/** Spoken words, plus on-screen text where the actor reads it (music-only reels often carry the details there). */
export function transcriptText(items: Record<string, unknown>[]): string {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  for (const item of items) {
    if (item._summary) continue;
    const spoken = ["transcript", "text", "spokenTranscript", "transcription"].map((k) => str(item[k])).find(Boolean) ?? "";
    const onScreen = str(item.onScreenText);
    const text = [spoken, onScreen && `Text shown on screen: ${onScreen}`].filter(Boolean).join("\n");
    if (text) return text;
  }
  return "";
}

const confidentFields = (ex: Extraction) => {
  const got = new Set<string>();
  for (const e of ex.events) {
    if (e.start_date.value !== null && e.start_date.confidence >= ingestion.publishConfidence) got.add("date");
    if (e.venue_name.value !== null && e.venue_name.confidence >= ingestion.publishConfidence) got.add("venue");
    if (e.price_text.value !== null || e.is_free.value !== null) got.add("price");
  }
  return got;
};

export async function processPosts(pool: Pool, deps: Deps, opts: ProcessOptions) {
  const { llm } = deps;
  const run = { jobName: opts.jobName, batch: opts.batch };
  const lists = await cityLists(pool);
  const report = {
    filter: { byRules: { event: 0, maybe: 0, not_event: 0, unclear: 0 }, askedModel: 0, continued: 0, filteredOut: 0, modelUsd: 0 },
    extraction: { posts: 0, failed: 0, eventsFound: 0, notEvents: 0, modelUsd: 0 },
    transcripts: { requested: 0, empty: 0, filledAMissingField: 0, scrapeUsd: 0 },
    resolve: emptyCounts(),
    /** Per source: events created (new), merged into a known event, queued for review, out of city. */
    bySource: {} as Record<string, { created: number; merged: number; queued: number; outOfCity: number; statusUpdates: number }>,
    descriptions: { written: 0, failed: 0, modelUsd: 0 },
    eventsPublished: 0,
    cityAudit: undefined as AuditReport | undefined,
    costs: {} as Record<string, number | null>,
    estimate: undefined as undefined | Record<string, unknown>,
  };

  // ---------------------------------------------------------------- 1. filter
  const fresh = (await pool.query<RawRow>(`${RAW_SELECT} WHERE rp.processing_state = 'new' AND rp.filter_result IS NULL ORDER BY rp.id`)).rows;
  const verdicts = fresh.map((row) => ({ row, verdict: ruleFilter(row.caption ?? "") }));
  for (const v of verdicts) report.filter.byRules[v.verdict]++;
  const unclear = verdicts.filter((v) => v.verdict === "unclear");

  if (opts.dryRun) {
    // Nothing is sent or written. Posts not fetched yet are assumed to split the way venue feeds usually do.
    const assumed = { event: 0.35, unclear: 0.3, unclearContinues: 0.5, extractionYieldsEvent: 0.6 };
    const extra = opts.expectedNewPosts ?? 0;
    const pending = (await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM raw_posts WHERE processing_state = 'new' AND filter_result IN ('event','maybe')")).rows[0].n;
    const nFilter = unclear.length + Math.round(extra * assumed.unclear);
    const nExtract = Number(pending) + report.filter.byRules.event + report.filter.byRules.maybe
      + Math.round(unclear.length * assumed.unclearContinues) + Math.round(extra * (assumed.event + assumed.unclear * assumed.unclearContinues));
    const nWrite = Math.round(nExtract * assumed.extractionYieldsEvent);
    const sample: ExtractionInput = {
      id: "est", sourceKind: "instagram", sourceName: "handle", cityName: "City", timeZone: "Asia/Kolkata", postedAt: new Date(),
      text: "x".repeat(600), images: [{ mediaType: "image/jpeg", base64: "" }], areas: lists.areasFor(fresh[0]?.city_id ?? 0), categorySlugs: lists.categorySlugs,
    };
    const reqs = [
      ...Array.from({ length: nFilter }, (_, i) => filterRequest(`f${i}`, "x".repeat(400), "handle", "venue")),
      ...Array.from({ length: nExtract }, () => extractionRequest(sample)),
      ...Array.from({ length: nWrite }, (_, i) => descriptionEstimate(`w${i}`)),
    ];
    await llm.run(reqs as never[], { ...run, dryRun: true, pool });
    report.estimate = {
      postsWaiting: fresh.length + Number(pending), postsExpectedFromScrape: extra,
      filterModelCalls: nFilter, extractionCalls: nExtract, descriptionCalls: nWrite,
      modelUsd: usd(reqs.reduce((s, r) => s + estimateUsd(r as never, opts.batch), 0)),
      assumptions: assumed,
    };
    return report;
  }

  // Listings published before the city check existed are audited once.
  report.cityAudit = await auditCities(pool, llm, run);

  const answers = await llm.run(unclear.map((v) => filterRequest(String(v.row.id), v.row.caption ?? "", v.row.handle, v.row.handle_type ?? "account")), run);
  const answerById = new Map(answers.map((a) => [a.id, a]));
  report.filter.askedModel = answers.length;
  report.filter.modelUsd = usd(answers.reduce((s, a) => s + a.usd, 0));
  for (const a of answers) await charge(pool, a.id, a.usd);
  for (const { row, verdict } of verdicts) {
    let label: FilterLabel;
    if (verdict !== "unclear") label = verdict;
    else {
      const a = answerById.get(String(row.id));
      // No answer or an unsure one: let it through; the mid-tier extraction is the second opinion.
      label = a?.ok && a.data && a.data.confidence >= ingestion.fastTierMinConfidence ? a.data.label : "maybe";
    }
    if (label === "not_event") {
      report.filter.filteredOut++;
      await pool.query("UPDATE raw_posts SET filter_result = $2, processing_state = 'filtered_out', processed_at = now() WHERE id = $1", [row.id, label]);
    } else {
      report.filter.continued++;
      await pool.query("UPDATE raw_posts SET filter_result = $2 WHERE id = $1", [row.id, label]);
    }
  }

  // ---------------------------------------------------------------- 2. extract
  const toExtract = (await pool.query<RawRow>(
    `${RAW_SELECT} WHERE rp.processing_state = 'new' AND rp.filter_result IN ('event','maybe') ORDER BY rp.id`)).rows;
  const inputs = new Map<number, ExtractionInput>();
  for (const row of toExtract) {
    const images = row.source_kind === "instagram" || isFacebookPost(row) ? await fetchImages(row.media_urls ?? [], deps.fetchFn) : undefined;
    inputs.set(row.id, toInput(row, lists, images));
  }
  const extracted = new Map<number, Extraction>();
  const firstPass = await llm.run(toExtract.map((r) => extractionRequest(inputs.get(r.id)!)), run);
  report.extraction.posts = firstPass.length;
  for (const r of firstPass) {
    report.extraction.modelUsd += r.usd;
    await charge(pool, r.id, r.usd);
    if (r.ok && r.data) { extracted.set(Number(r.id), r.data); continue; }
    report.extraction.failed++;
    await pool.query("UPDATE raw_posts SET processing_state = 'error', error = $2, processed_at = now() WHERE id = $1", [Number(r.id), r.error ?? "extraction failed"]);
    await pool.query("INSERT INTO review_queue (item_type, item_id, reason, payload) VALUES ('raw_post', $1, 'extraction failed', $2)",
      [Number(r.id), { error: r.error ?? null }]);
  }

  // ------------------------------------------------- 2b. reel transcript fallback
  // Only for reels already judged to be events where date, venue or price is still missing.
  const retry: { row: RawRow; before: Set<string> }[] = [];
  if (apify.reelTranscriptActorId) {
    for (const row of toExtract) {
      const ex = extracted.get(row.id);
      // The transcript actor reads Instagram reels only.
      if (!ex || row.source_kind !== "instagram" || row.post_type !== "reel" || row.transcript_requested_at || missingForTranscript(ex).length === 0) continue;
      const text = await guardedCall(
        {
          bucket: "scrape", subBudget: "reelTranscript", service: "apify", model: apify.reelTranscriptActorId,
          units: 1, unitLabel: "transcripts", estimatedUsd: apify.usdPerTranscript, jobName: opts.jobName,
        },
        async () => transcriptText((await deps.apify.runActor(apify.reelTranscriptActorId, transcriptInput(apify.reelTranscriptActorId, row.post_url),
          { maxChargeUsd: Math.max(apify.usdPerTranscript, 0.05), maxItems: 1, timeoutSecs: 300 })).items),
        { pool },
      ).catch((err) => {
        if ((err as Error).name === "BudgetExceededError") return null; // limit reached: carry on without transcripts
        console.warn(`[transcript] ${row.shortcode}: ${(err as Error).message}`);
        return "";
      });
      if (text === null) break;
      report.transcripts.requested++;
      report.transcripts.scrapeUsd += apify.usdPerTranscript;
      // Recorded even when empty: music-only reels are normal and are not asked again.
      await pool.query("UPDATE raw_posts SET transcript = $2, transcript_requested_at = now() WHERE id = $1", [row.id, text || null]);
      if (!text) { report.transcripts.empty++; continue; }
      inputs.set(row.id, { ...inputs.get(row.id)!, transcript: text });
      retry.push({ row, before: confidentFields(ex) });
    }
    const second = await llm.run(retry.map((t) => extractionRequest(inputs.get(t.row.id)!)), run);
    for (const r of second) {
      report.extraction.modelUsd += r.usd;
      await charge(pool, r.id, r.usd);
      if (!r.ok || !r.data) continue; // keep the first extraction
      const before = retry.find((t) => String(t.row.id) === r.id)!.before;
      if ([...confidentFields(r.data)].some((f) => !before.has(f))) report.transcripts.filledAMissingField++;
      extracted.set(Number(r.id), r.data);
    }
  }
  for (const [id, ex] of extracted) {
    report.extraction.eventsFound += ex.events.length;
    await pool.query("UPDATE raw_posts SET extraction = $2, processing_state = 'extracted' WHERE id = $1", [id, JSON.stringify(ex)]);
  }

  // ---------------------------------------------------------------- 3. resolve
  const ready = (await pool.query<RawRow>(`${RAW_SELECT} WHERE rp.processing_state = 'extracted' ORDER BY rp.posted_at NULLS LAST, rp.id`)).rows;
  for (const row of ready) {
    const ctx: PostContext = {
      rawPostId: row.id, sourceKind: row.source_kind, handle: row.handle, handleType: row.handle_type ?? undefined,
      postUrl: row.post_url, postedAt: row.posted_at ?? row.fetched_at, shortcode: row.shortcode, cityId: row.city_id,
      cityName: row.city_name, timeZone: row.timezone, taggedHandles: row.tagged_handles ?? [],
    };
    const before = { ...report.resolve };
    const state = await resolvePost(pool, llm, ctx, row.extraction!, opts.jobName, report.resolve);
    const label = sourceLabel(row.source_kind, row.handle);
    const b = (report.bySource[label] ??= { created: 0, merged: 0, queued: 0, outOfCity: 0, statusUpdates: 0 });
    b.created += report.resolve.created - before.created;
    b.merged += report.resolve.merged - before.merged - (report.resolve.statusUpdates - before.statusUpdates);
    b.statusUpdates += report.resolve.statusUpdates - before.statusUpdates;
    b.queued += report.resolve.queued - before.queued;
    b.outOfCity += report.resolve.outOfCity - before.outOfCity;
    await charge(pool, row.id, report.resolve.dedupModelUsd - before.dedupModelUsd);
    if (state === "filtered_out") report.extraction.notEvents++;
    await pool.query("UPDATE raw_posts SET processing_state = $2, processed_at = now() WHERE id = $1", [row.id, state]);
  }

  // ---------------------------------------------------------------- 4. write
  report.descriptions = await writeDescriptions(pool, llm, run);
  report.eventsPublished = report.descriptions.written;

  const modelUsd = report.filter.modelUsd + report.extraction.modelUsd + report.resolve.dedupModelUsd + report.descriptions.modelUsd + report.cityAudit.modelUsd;
  const posts = fresh.length;
  report.extraction.modelUsd = usd(report.extraction.modelUsd);
  report.resolve.dedupModelUsd = usd(report.resolve.dedupModelUsd);
  report.descriptions.modelUsd = usd(report.descriptions.modelUsd);
  report.transcripts.scrapeUsd = usd(report.transcripts.scrapeUsd);
  report.costs = {
    modelUsd: usd(modelUsd),
    modelUsdPerProcessedPost: posts ? usd(modelUsd / posts) : null,
    modelUsdPerPublishedEvent: report.eventsPublished ? usd(modelUsd / report.eventsPublished) : null,
  };
  return report;
}
