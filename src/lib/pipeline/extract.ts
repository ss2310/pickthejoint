/**
 * Extraction step: caption (plus poster image, plus reel transcript when one
 * was needed) -> event facts with a confidence per field. The model returns
 * null instead of guessing; publish-or-review is decided later in resolve.ts.
 */
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { ingestion } from "../../config";
import type { LlmRequest } from "./llm";
import { localDate, localWeekday } from "./text";

const field = <T extends z.ZodType>(value: T) => z.object({ value: value.nullable(), confidence: z.number() });

export function extractionSchema(categorySlugs: string[]) {
  const event = z.object({
    announcement: z.enum(["new_event", "cancellation", "postponement", "change"]),
    title: field(z.string()),
    start_date: field(z.string()),
    start_time: field(z.string()),
    end_date: field(z.string()),
    end_time: field(z.string()),
    venue_name: field(z.string()),
    venue_instagram_handle: z.string().nullable(),
    area: field(z.string()),
    price_text: field(z.string()),
    is_free: field(z.boolean()),
    booking_url: field(z.string()),
    performers: z.array(z.object({ name: z.string(), kind: z.enum(["person", "group"]), confidence: z.number() })),
    organiser: field(z.string()),
    organiser_instagram_handle: z.string().nullable(),
    category: field(z.enum(categorySlugs as [string, ...string[]])),
  });
  return z.object({
    is_event_post: z.boolean(),
    events: z.array(event),
    co_host_handles: z.array(z.string()),
    notes: z.string(),
  });
}

export type Extraction = z.infer<ReturnType<typeof extractionSchema>>;
export type ExtractedEvent = Extraction["events"][number];

export interface ExtractionInput {
  id: string;
  sourceKind: "instagram" | "google" | "news";
  /** Instagram handle, or the name of the web source. */
  sourceName: string;
  sourceType?: string;
  cityName: string;
  timeZone: string;
  /** When the post or article was published; relative dates resolve against this. */
  postedAt: Date;
  text: string;
  transcript?: string | null;
  images?: { mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; base64: string }[];
  areas: string[];
  categorySlugs: string[];
}

const SYSTEM = `You extract event facts for a city events guide in India. The facts you return are published as-is, so a wrong fact is worse than a missing one.

You are given a post or listing (an Instagram caption with its poster image, a search result, or a news roundup), the city it belongs to, and the date it was published.

What to return
- is_event_post: true only if it announces at least one specific event the public can attend, or announces that one is cancelled, postponed or changed. A recap of something that already happened, a menu, an offer with no event, or a generic promotion is not an event post: return an empty events list.
- events: one entry per distinct event. A weekly line-up poster listing three nights is three events. Do not include events that had already taken place when the post was published.
- For every field give a value and a confidence from 0 to 1. Use null with a low confidence when the source does not state it. Never infer a fact that is not written in the caption, shown on the poster, or said in the transcript.

Fields
- announcement: "new_event" for a normal announcement or reminder; "cancellation" if the post says the event is cancelled; "postponement" if it is postponed and no new date is given; "change" if the date, time or venue has changed (then give the new details).
- title: the event's own name as the organiser gives it, without dates, prices or hashtags. If there is no name, use the headline act and format (for example "Rahul Dua Live").
- start_date, end_date: YYYY-MM-DD. Resolve relative dates ("this Saturday", "tomorrow", "kal") against the published date given to you, never against any other date. If a day and month are given with no year, use the first such date on or after the published date. If you cannot pin the date to a single day, return null.
- start_time, end_time: HH:MM in 24-hour local time. "8 PM onwards" is 20:00 with no end time. Null if not stated.
- venue_name: the place where it happens, as named. If the posting account is itself a venue and the post names no other place, the venue is that account's venue. A listing or promoter account is not a venue. If only a city or "TBA" is given, return null.
- venue_instagram_handle: the venue's Instagram handle without @ if it is the posting account, is tagged, or is written in the post; otherwise null.
- area: the locality within the city if stated or if it is one of the known areas listed; otherwise null.
- price_text: the price as stated, short ("₹499 onwards", "Free entry", "Cover ₹1000, fully redeemable"). is_free: true only if the source says entry is free.
- booking_url: a full URL that is written out. "Link in bio" is not a URL: return null.
- performers: named artists, bands, comedians, DJs or speakers. Not the venue, not sponsors.
- organiser and organiser_instagram_handle: who is putting it on, if stated and different from the venue.
- category: the best fit from the allowed list.
- co_host_handles: Instagram handles (without @) credited in the post as co-hosts, organisers, partners or performers.
- notes: one short sentence on anything that made you unsure, or an empty string.

Confidence: 0.9 or above means the fact is stated plainly; 0.6 to 0.8 means you had to interpret; below 0.5 means a guess, in which case prefer null.`;

/** Rough token cost of one image for estimates; actual usage is logged after the call. */
const EST_IMAGE_TOKENS = 2200;

export function extractionRequest(input: ExtractionInput): LlmRequest<Extraction> {
  const published = `${localDate(input.postedAt, input.timeZone)} (${localWeekday(input.postedAt, input.timeZone)})`;
  const source =
    input.sourceKind === "instagram"
      ? `Instagram account @${input.sourceName}${input.sourceType ? ` (listed as: ${input.sourceType})` : ""}`
      : input.sourceKind === "google"
        ? `Google event result for ${input.cityName}`
        : `Local news page: ${input.sourceName}`;
  const parts = [
    `City: ${input.cityName}`,
    `Source: ${source}`,
    `Published: ${published}, timezone ${input.timeZone}`,
    `Known areas in ${input.cityName}: ${input.areas.join(", ")}`,
    `Allowed categories: ${input.categorySlugs.join(", ")}`,
    "",
    input.sourceKind === "instagram" ? "Caption:" : "Text:",
    input.text.trim() || "(empty)",
  ];
  if (input.transcript?.trim()) {
    parts.push("", "Spoken words in the reel (automatic transcript, may contain errors):", input.transcript.trim().slice(0, 6000));
  }
  const text = parts.join("\n");
  const content: Anthropic.ContentBlockParam[] = [
    ...(input.images ?? []).map((img): Anthropic.ContentBlockParam => ({
      type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 },
    })),
    { type: "text", text },
  ];
  return {
    id: input.id, tier: "mid", system: SYSTEM, content, schema: extractionSchema(input.categorySlugs),
    maxTokens: 6000, effort: "medium",
    estInputTokens: 1300 + Math.ceil(text.length / 3) + (input.images?.length ?? 0) * EST_IMAGE_TOKENS,
    estOutputTokens: 900,
  };
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

/**
 * Downloads poster images to pass to the vision model. The bytes are held in
 * memory for the request only and never stored (hard rule 4).
 */
export async function fetchImages(urls: string[], fetchFn: typeof fetch = fetch): Promise<NonNullable<ExtractionInput["images"]>> {
  const out: NonNullable<ExtractionInput["images"]> = [];
  for (const url of urls.slice(0, ingestion.maxImagesPerPost)) {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) continue;
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      const mediaType = IMAGE_TYPES.find((t) => t === type);
      if (!mediaType) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > ingestion.maxImageBytes) continue;
      out.push({ mediaType, base64: buf.toString("base64") });
    } catch {
      // An expired or blocked CDN link: extract from the caption alone.
    }
  }
  return out;
}

const confident = (f: { value: unknown; confidence: number }) => f.value !== null && f.confidence >= ingestion.publishConfidence;

/** The facts a reel transcript is allowed to be requested for (Prompt 2, step 3b). */
export function missingForTranscript(ex: Extraction): ("date" | "venue" | "price")[] {
  if (!ex.is_event_post) return [];
  const missing = new Set<"date" | "venue" | "price">();
  if (ex.events.length === 0) return ["date", "venue", "price"];
  for (const e of ex.events) {
    if (!confident(e.start_date)) missing.add("date");
    if (!confident(e.venue_name)) missing.add("venue");
    if (e.price_text.value === null && e.is_free.value === null) missing.add("price");
  }
  return [...missing];
}
