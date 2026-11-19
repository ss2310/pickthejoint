/**
 * Official video for tracked artists (Prompt 10), through the YouTube Data
 * API within its free quota (a search costs one of 100 searches a day; every
 * other call here costs 1 of 10,000 units a day).
 *
 * For each artist: find their official channel (from the YouTube link on
 * their page if there is one, otherwise by a name search that must match the
 * artist's name), take that channel's most-viewed videos, and store up to 5
 * as "pending". Nothing shows on a page until the owner approves it at
 * /admin/artists. Only YouTube's IDs and facts are stored; the video itself
 * is only ever embedded with YouTube's own player (hard rule 5).
 */
import { z } from "zod";
import type { Pool } from "pg";
import { artistTracking as cfg } from "../../config";
import type { LlmClient, LlmRequest } from "./llm";
import { trackedArtists } from "./artist-tracking";
import { nameKey } from "./text";

export interface YoutubeClient {
  /** GET https://www.googleapis.com/youtube/v3/<resource>; throws on an error response. */
  get(resource: string, params: Record<string, string>): Promise<{ items?: Record<string, unknown>[] }>;
  /** Searches used so far (each counts against the day's 100). */
  searches: number;
}

export class HttpYoutube implements YoutubeClient {
  searches = 0;
  constructor(private readonly key = cfg.youtubeApiKey, private readonly fetchFn: typeof fetch = fetch) {}
  async get(resource: string, params: Record<string, string>) {
    if (!this.key) throw new Error("YOUTUBE_API_KEY is not set");
    if (resource === "search") this.searches++;
    const q = new URLSearchParams({ ...params, key: this.key });
    const res = await this.fetchFn(`https://www.googleapis.com/youtube/v3/${resource}?${q}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      // The key travels in the address, so the address is never put in an error.
      const reason = (await res.text()).match(/"(?:reason|message)":\s*"([^"]{1,200})"/)?.[1] ?? "";
      throw new Error(`YouTube ${resource} failed: ${res.status} ${reason}`);
    }
    return (await res.json()) as { items?: Record<string, unknown>[] };
  }
}

export interface Channel { id: string; title: string; subscribers: number | null }
export interface Video { id: string; title: string; year: number | null; views: number | null; seconds: number | null; description: string }

const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const int = (v: unknown) => (v === undefined || v === null || Number.isNaN(Number(v)) ? null : Number(v));

function channelOf(item: Record<string, unknown>): Channel | null {
  const id = str(item.id) ?? str(obj(item.id).channelId);
  const title = str(obj(item.snippet).title);
  return id && title ? { id, title, subscribers: int(obj(item.statistics).subscriberCount) } : null;
}

/** "PT4M13S" -> 253. */
export function isoSeconds(d: string | null): number | null {
  const m = (d ?? "").match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  return m && d !== "P" ? Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0) : null;
}

/**
 * Whether a channel's name is the artist's own: the same name, optionally with "official", "music", "VEVO" or
 * YouTube's "- Topic" added. Anything looser (a fan page, a label, a namesake with extra words) is not taken.
 */
export function isOwnChannel(channelTitle: string, artistName: string): boolean {
  const strip = (s: string) => {
    let k = nameKey(s.replace(/\s*-\s*topic$/i, "")).replace(/\s+/g, "");
    for (let prev = ""; prev !== k && k.length > 3;) { prev = k; k = k.replace(/(official|music|vevo|band|live|tv|channel|comedy)$/, ""); }
    return k.replace(/^the(?=.{3})/, "");
  };
  const a = strip(artistName), c = strip(channelTitle);
  return a.length >= 3 && a === c;
}

/** What a YouTube link on an artist's page points at. */
export function parseChannelLink(url: string | null | undefined): { id?: string; handle?: string; user?: string } | null {
  const m = (url ?? "").trim().match(/^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(channel\/(UC[\w-]{20,})|@([\w.-]{3,})|user\/([\w.-]+))\/?(?:[?#].*)?$/i);
  if (!m) return null;
  return m[2] ? { id: m[2] } : m[3] ? { handle: m[3] } : { user: m[4] };
}

/** The artist's official channel and how it was found; null when none can be told with confidence. */
export async function findChannel(yt: YoutubeClient, artist: { name: string; youtube: string | null }): Promise<{ channel: Channel; via: "page_link" | "name_search" } | null> {
  const link = parseChannelLink(artist.youtube);
  if (link) {
    const params: Record<string, string> = link.id ? { id: link.id } : link.handle ? { forHandle: `@${link.handle}` } : { forUsername: link.user! };
    const channel = ((await yt.get("channels", { part: "snippet,statistics", ...params })).items ?? []).map(channelOf).find(Boolean);
    if (channel) return { channel, via: "page_link" };
  }
  const found = ((await yt.get("search", { part: "snippet", type: "channel", q: artist.name, maxResults: "5" })).items ?? []).map(channelOf).filter((c): c is Channel => !!c);
  const own = found.filter((c) => isOwnChannel(c.title, artist.name));
  if (own.length === 0) return null;
  const detailed = ((await yt.get("channels", { part: "snippet,statistics", id: own.map((c) => c.id).join(",") })).items ?? []).map(channelOf).filter((c): c is Channel => !!c);
  // An artist's own channel over YouTube's auto-made "Topic" channel, then the one with the most subscribers.
  const best = detailed.sort((a, b) => Number(/- topic$/i.test(a.title)) - Number(/- topic$/i.test(b.title)) || (b.subscribers ?? 0) - (a.subscribers ?? 0))[0];
  return best ? { channel: best, via: "name_search" } : null;
}

/** The channel's most-viewed public videos that may be embedded, best-known first. */
export async function topVideos(yt: YoutubeClient, channelId: string, max = cfg.videosPerArtist): Promise<Video[]> {
  const ids = ((await yt.get("search", { part: "id", channelId, type: "video", order: "viewCount", maxResults: "15" })).items ?? [])
    .map((i) => str(obj(i.id).videoId)).filter((v): v is string => !!v);
  if (ids.length === 0) return [];
  const items = (await yt.get("videos", { part: "snippet,statistics,status,contentDetails", id: ids.join(",") })).items ?? [];
  const videos: Video[] = [];
  for (const it of items) {
    const snippet = obj(it.snippet), status = obj(it.status);
    const id = str(it.id), title = str(snippet.title);
    const seconds = isoSeconds(str(obj(it.contentDetails).duration));
    if (!id || !title || status.embeddable !== true || status.privacyStatus !== "public") continue;
    if (str(snippet.liveBroadcastContent) && snippet.liveBroadcastContent !== "none") continue;
    if (seconds !== null && seconds < cfg.minVideoSeconds) continue;
    const year = Number((str(snippet.publishedAt) ?? "").slice(0, 4));
    videos.push({ id, title, year: year > 2004 ? year : null, views: int(obj(it.statistics).viewCount), seconds, description: (str(snippet.description) ?? "").slice(0, 400) });
  }
  return videos.sort((a, b) => (b.views ?? 0) - (a.views ?? 0)).slice(0, max);
}

// ------------------------------------------------------------------ the note beside each video

export const VideoNotesSchema = z.object({ videos: z.array(z.object({ video_id: z.string(), note: z.string() })) });
export type VideoNotes = z.infer<typeof VideoNotesSchema>;

const NOTES_SYSTEM = `You write the one-sentence note shown beside an embedded YouTube video on a performer's page of a city events guide in India. Search engines and AI assistants cannot see inside the video, so the note says in plain words what it is.

For each video you are given its title, the year it was published, the channel it is on, its view count and the start of its description.
Write ONE sentence per video, at most 30 words, in your own words, saying what the video is (a music video, a live performance, a stand-up set, a lyric video, an interview and so on) and why it is known. "Why it is known" must come from the facts given: for example that it is among the most-watched videos on the performer's official channel, with its view count rounded down ("over 12 million views"), or something the description states plainly, such as the album it is from.

Rules
- Use only the facts given. Do not add awards, chart positions, collaborators or anything else you remember.
- No lyrics, no quotes, no praise words (iconic, stunning, must-watch), no exclamation marks.
- Do not repeat the title in full if it is long; never copy the description.
- Return one entry per video, with the video_id exactly as given.`;

export function notesRequest(id: string, artistName: string, channelTitle: string, videos: Video[]): LlmRequest<VideoNotes> {
  const text = `Performer: ${artistName}\nOfficial channel: ${channelTitle}\n\n` + videos.map((v) =>
    `video_id: ${v.id}\nTitle: ${v.title}\nPublished: ${v.year ?? "unknown"}\nViews: ${v.views ?? "unknown"}\nDescription starts: ${v.description || "(none)"}`).join("\n\n");
  return {
    id, tier: "mid", system: NOTES_SYSTEM, content: [{ type: "text", text }], schema: VideoNotesSchema,
    maxTokens: 900, effort: "low", estInputTokens: 420 + Math.ceil(text.length / 3), estOutputTokens: 60 * videos.length,
  };
}

/** The line used when the model gave no usable note: plain facts only. */
export function fallbackNote(v: Video, channelTitle: string): string {
  const views = v.views && v.views >= 1000 ? `, with over ${roundedViews(v.views)} views` : "";
  return `A video from the official YouTube channel ${channelTitle}${v.year ? `, published in ${v.year}` : ""}${views}.`;
}

export function roundedViews(n: number): string {
  if (n >= 1_000_000) return `${Math.floor(n / 100_000) / 10} million`.replace(".0 ", " ");
  if (n >= 1000) return `${Math.floor(n / 1000).toLocaleString("en-IN")},000`;
  return String(n);
}

// ------------------------------------------------------------------ the job step

export interface VideoReport {
  status: string;
  /** Tracked artists whose videos have not been looked up yet. */
  waiting: number;
  lookedUp: number;
  searchesUsed: number;
  selections: { artist: string; channel: string; foundBy: string; videos: { id: string; title: string; year: number | null; views: number | null; note: string }[] }[];
  noChannel: string[];
  modelUsd: number;
  errors: string[];
}

export async function findArtistVideos(
  pool: Pool, yt: YoutubeClient, llm: LlmClient,
  opts: { jobName: string; dryRun?: boolean; batch?: boolean; slugs?: string[]; limit?: number; now?: Date },
): Promise<VideoReport> {
  const rep: VideoReport = { status: "ok", waiting: 0, lookedUp: 0, searchesUsed: 0, selections: [], noChannel: [], modelUsd: 0, errors: [] };
  if (!cfg.enabled) { rep.status = "switched off (ARTIST_TRACKING=off)"; return rep; }
  const tracked = await trackedArtists(pool, { now: opts.now, slugs: opts.slugs });
  if (tracked.length === 0) { rep.status = "no artist is being tracked"; return rep; }
  const rows = (await pool.query<{ id: number; name: string; youtube: string | null }>(
    `SELECT id, name, official_links->>'youtube' AS youtube FROM artists
     WHERE id = ANY($1) AND videos_checked_at IS NULL ORDER BY array_position($1::bigint[], id)`, [tracked.map((a) => a.id)])).rows;
  rep.waiting = rows.length;
  const batch = rows.slice(0, Math.min(opts.limit ?? cfg.videoLookupsPerRun, cfg.videoLookupsPerRun));
  if (batch.length === 0) { rep.status = "every tracked artist has been looked up"; return rep; }
  if (!cfg.youtubeApiKey && yt instanceof HttpYoutube) { rep.status = "YOUTUBE_API_KEY is not set"; return rep; }
  if (opts.dryRun) {
    rep.status = `dry run: would look up ${batch.length} artist(s), at most ${batch.length * 2} of the day's 100 YouTube searches (free)`;
    return rep;
  }

  for (const artist of batch) {
    try {
      const found = await findChannel(yt, artist);
      if (!found) {
        rep.noChannel.push(artist.name);
        await pool.query("UPDATE artists SET videos_checked_at = now(), videos_note = 'No official YouTube channel could be told apart by name.' WHERE id = $1", [artist.id]);
        rep.lookedUp++;
        continue;
      }
      const { channel, via } = found;
      const videos = await topVideos(yt, channel.id);
      const notes = new Map<string, string>();
      if (videos.length) {
        const [r] = await llm.run([notesRequest(String(artist.id), artist.name, channel.title, videos)], { jobName: opts.jobName, batch: opts.batch, subBudget: "artistText", pool });
        rep.modelUsd += r?.usd ?? 0;
        for (const n of r?.ok && r.data ? r.data.videos : []) {
          const note = n.note.replace(/\s+/g, " ").trim();
          if (note && note.split(" ").length <= 40) notes.set(n.video_id, note);
        }
      }
      const foundBy = via === "page_link" ? "the YouTube link on the artist's page" : "a name search: check it is the right channel";
      await pool.query(
        "UPDATE artists SET youtube_channel_id = $2, youtube_channel_title = $3, videos_checked_at = now(), videos_note = $4 WHERE id = $1",
        [artist.id, channel.id, channel.title, `Channel found by ${foundBy}.${videos.length ? "" : " It has no public video that can be embedded."}`]);
      const stored: VideoReport["selections"][number]["videos"] = [];
      for (const [i, v] of videos.entries()) {
        const note = notes.get(v.id) ?? fallbackNote(v, channel.title);
        await pool.query(
          `INSERT INTO artist_videos (artist_id, video_id, title, published_year, blurb, channel_id, channel_title, view_count, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (artist_id, video_id) DO NOTHING`,
          [artist.id, v.id, v.title, v.year, note, channel.id, channel.title, v.views, i]);
        stored.push({ id: v.id, title: v.title, year: v.year, views: v.views, note });
      }
      rep.selections.push({ artist: artist.name, channel: channel.title, foundBy, videos: stored });
      rep.lookedUp++;
    } catch (err) {
      // A quota or key problem will hit every artist: stop, and try again on the next run.
      rep.errors.push(`${artist.name}: ${(err as Error).message}`.slice(0, 300));
      if (/quota|keyInvalid|API key|forbidden|403|400/i.test((err as Error).message)) { rep.status = "stopped: YouTube refused the request"; break; }
    }
  }
  rep.searchesUsed = yt.searches;
  rep.modelUsd = Number(rep.modelUsd.toFixed(4));
  return rep;
}
