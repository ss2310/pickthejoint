import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import sharp from "sharp";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SITE_URL = "https://pickthejoint.com";
  process.env.ADMIN_SETUP_TOKEN = "setup-token-for-tests-0123456789";
  process.env.POSTER_EMAIL_SENDERS = "owner@example.com";
  process.env.TURNSTILE_SECRET_KEY = "turnstile-secret";
});

import { freshDb } from "./helpers";
import { seed } from "../db/seed";
import { closePool } from "../src/lib/db";
import {
  checkLogin, cleanToken, createSession, endSession, hashPassword, passwordProblem, sessionValid, setPassword, setupAllowed, verifyPassword,
} from "../src/lib/admin-auth";
import { handleInbound, verifyWebhook } from "../src/lib/inbound-email";
import type { LlmClient, LlmRequest, LlmResult, LlmRunOptions } from "../src/lib/pipeline/llm";
import type { Extraction } from "../src/lib/pipeline/extract";
import { cleanUp } from "../src/lib/pipeline/housekeeping";
import { localDate } from "../src/lib/pipeline/text";
import { cleanImage, inboxPosters, readPosters, storePoster, UploadError } from "../src/lib/posters";
import { getEvent, listEvents } from "../src/lib/queries";
import { eventLd } from "../src/lib/schema";
import { clientIp, rateAllow, verifyTurnstile } from "../src/lib/security";
import {
  approveSubmission, createDraft, emptyFields, fieldsFromExtraction, queueSubmission, rejectAsBot, rejectSubmission, spamSigns, validate,
  type SubmissionFields,
} from "../src/lib/submissions";

let pool: Pool;
beforeAll(async () => { pool = await freshDb(); await seed(pool); });
afterAll(async () => { await closePool(); await pool.end(); });
beforeEach(async () => {
  await pool.query(`TRUNCATE events, venues, artists, organisers, sources, event_artists, event_organisers, review_queue, cost_log,
    submissions, poster_images, rate_hits, admin_account, admin_sessions, source_state RESTART IDENTITY CASCADE`);
});

const TZ = "Asia/Kolkata";
const today = localDate(new Date(), TZ);
const inDays = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const CATS = ["music", "comedy", "workshops", "theatre"];
const cityId = async () => (await pool.query<{ id: number }>("SELECT id FROM cities WHERE slug = 'indore'")).rows[0].id;

const f = <T>(value: T | null, confidence = value === null ? 0 : 0.95) => ({ value, confidence });
function event(over: Partial<Extraction["events"][number]> = {}): Extraction["events"][number] {
  return {
    announcement: "new_event", title: f("Sufi Night"), start_date: f(inDays(5)), start_time: f("19:30"), end_date: f<string>(null),
    end_time: f<string>(null), venue_name: f("Ravindra Natya Griha"), venue_instagram_handle: null, city: f("Indore"), area: f("South Tukoganj"),
    price_text: f("₹300"), is_free: f(false), booking_url: f<string>(null), performers: [{ name: "Rahat Ensemble", kind: "group", confidence: 0.9 }],
    organiser: f<string>(null), organiser_instagram_handle: null, category: f("music"), practical: "", ...over,
  };
}

const DESCRIPTION = { description: Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ") };

/** Stand-in for Claude: answers by what each request is for, and records the calls. */
class FakeLlm implements LlmClient {
  calls: { kind: string; tier: string; images: number; subBudget?: string }[] = [];
  constructor(private readonly respond: (kind: string, text: string, tier: string) => unknown) {}
  async run<T>(requests: LlmRequest<T>[], opts: LlmRunOptions): Promise<LlmResult<T>[]> {
    return requests.map((req) => {
      const kind = req.system.startsWith("You extract") ? "extract" : req.system.startsWith("You screen") ? "screen" : "write";
      const text = req.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      this.calls.push({ kind, tier: req.tier, images: req.content.filter((b) => b.type === "image").length, subBudget: opts.subBudget });
      return { id: req.id, ok: true, data: req.schema.parse(this.respond(kind, text, req.tier)), model: "fake", usd: 0.001, inputTokens: 10, outputTokens: 10 };
    });
  }
}

const honest = () => new FakeLlm((kind, text) => {
  if (kind === "screen") {
    const spam = /casino|crypto/i.test(text);
    return { spam, plausible_event: !spam, reason: spam ? "advertising" : "a concert at a known hall", confidence: 0.9 };
  }
  if (kind === "write") return DESCRIPTION;
  throw new Error(`unexpected ${kind}`);
});

function formFields(over: Partial<SubmissionFields> = {}): SubmissionFields {
  return {
    ...emptyFields(), title: "Monsoon Ragas", date: inDays(6), start_time: "18:30", venue: "Jal Sabhagrah", venue_address: "Near Rajwada, Indore",
    category: "music", price: "₹200 onwards", booking_url: "https://tickets.example.org/monsoon-ragas",
    instagram_url: "https://www.instagram.com/p/ABC123xyz/", performers: "Asha Rao, Vikram Joshi", organiser: "Raag Sangam Trust", ...over,
  };
}

const jpeg = (w: number, h: number, color = "#cc3355") =>
  sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();

describe("the form", () => {
  it("checks required fields, dates, links and contact details", () => {
    const ok = validate(formFields(), { name: "Asha", contact: "asha@example.org" }, CATS, today);
    expect(ok).toEqual({});
    const bad = validate(formFields({ title: "", date: inDays(-2), booking_url: "tickets.example", instagram_url: "https://example.com/x", category: "poker" }),
      { name: "", contact: "call me" }, CATS, today);
    expect(bad).toEqual({ title: "required", date: "pastDate", booking_url: "badUrl", instagram_url: "badInstagram", category: "badCategory", name: "required", contact: "badContact" });
    expect(validate(formFields({ date: inDays(400) }), null, CATS, today).date).toBe("farDate");
    expect(validate(formFields({ end_date: inDays(2) }), null, CATS, today).end_date).toBe("endBeforeStart");
    expect(validate(formFields(), { name: "A", contact: "+91 98260 12345" }, CATS, today)).toEqual({});
  });

  it("sees the usual signs of spam", () => {
    expect(spamSigns(formFields(), { name: "Asha", contact: "a@b.co" })).toEqual([]);
    const signs = spamSigns(formFields({ title: "BEST CASINO BONUS WIN BIG TODAY NOW", note: "visit https://a.example and www.b.example bit.ly/x" }), null);
    expect(signs.length).toBeGreaterThanOrEqual(3);
  });

  it("queues a real and a spam-like submission for review, and publishes neither", async () => {
    const llm = honest();
    const city = await cityId();
    const real = await createDraft({ channel: "form", cityId: city, fields: formFields(), submitter: { name: "Asha Rao", contact: "asha@example.org" } }, pool);
    const spam = await createDraft({
      channel: "form", cityId: city,
      fields: formFields({ title: "CRYPTO CASINO MEGA BONUS PARTY NIGHT", venue: "online", note: "best casino www.win.example https://bit.ly/abc", booking_url: "https://bit.ly/abc", instagram_url: "" }),
      submitter: { name: "Promo", contact: "promo@example.com" },
    }, pool);
    const a = await queueSubmission(pool, llm, real.id, { jobName: "submissions", subBudget: "submissions" });
    const b = await queueSubmission(pool, llm, spam.id, { jobName: "submissions", subBudget: "submissions" });
    expect(a.verdict).toBe("looks_fine");
    expect(a.notes).toEqual(expect.arrayContaining(["complete", "date plausible", "no duplicate found"]));
    expect(b.verdict).toBe("likely_spam");
    const queue = (await pool.query("SELECT item_type, item_id, reason, status FROM review_queue ORDER BY id")).rows;
    expect(queue).toEqual([
      { item_type: "submission", item_id: real.id, reason: "New event via form: looks fine", status: "open" },
      { item_type: "submission", item_id: spam.id, reason: "New event via form: likely spam", status: "open" },
    ]);
    // Screening ran on the fast tier, charged to the submissions limit.
    expect(llm.calls.every((c) => c.kind === "screen" && c.tier === "fast" && c.subBudget === "submissions")).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS n FROM events")).rows[0].n).toBe(0);
    expect(await listEvents({ cityId: city })).toEqual([]);
  });

  it("escalates an unsure screening to the mid tier once", async () => {
    const llm = new FakeLlm((kind, _t, tier) => kind === "screen" ? { spam: false, plausible_event: true, reason: "unsure", confidence: tier === "fast" ? 0.4 : 0.85 } : DESCRIPTION);
    const { id } = await createDraft({ channel: "form", cityId: await cityId(), fields: formFields(), submitter: { name: "A", contact: "a@b.co" } }, pool);
    const s = await queueSubmission(pool, llm, id, { jobName: "submissions" });
    expect(llm.calls.map((c) => c.tier)).toEqual(["fast", "mid"]);
    expect(s.model?.tier).toBe("mid");
  });

  it("flags a likely duplicate of a listed event", async () => {
    const llm = honest();
    const city = await cityId();
    const first = await createDraft({ channel: "form", cityId: city, fields: formFields(), submitter: { name: "A", contact: "a@b.co" } }, pool);
    await queueSubmission(pool, llm, first.id, { jobName: "submissions" });
    await approveSubmission(pool, llm, first.id, { jobName: "admin" });
    const again = await createDraft({ channel: "form", cityId: city, fields: formFields({ title: "Monsoon Ragas Concert" }), submitter: { name: "B", contact: "b@b.co" } }, pool);
    const s = await queueSubmission(pool, llm, again.id, { jobName: "submissions" });
    expect(s.verdict).toBe("needs_checking");
    expect(s.duplicateOf?.title).toBe("Monsoon Ragas");
  });

  it("goes live on approval with origin submitted, the organiser label and correct structured data", async () => {
    const llm = honest();
    const city = await cityId();
    const { id } = await createDraft({ channel: "form", cityId: city, fields: formFields(), submitter: { name: "Asha Rao", contact: "asha@example.org" } }, pool);
    await queueSubmission(pool, llm, id, { jobName: "submissions" });
    const out = await approveSubmission(pool, llm, id, { jobName: "admin" });
    expect(out.published).toBe(true);
    expect(out.path).toBe(`/indore/events/monsoon-ragas-${inDays(6)}`);

    const e = (await getEvent("indore", `monsoon-ragas-${inDays(6)}`))!;
    expect(e.origin).toBe("submitted");
    expect(e.sources).toEqual([{ source_type: "submission", url: "https://www.instagram.com/p/ABC123xyz/" }]);
    expect(e.artists.map((a) => a.name)).toEqual(["Asha Rao", "Vikram Joshi"]);
    expect(e.organisers.map((o) => o.name)).toEqual(["Raag Sangam Trust"]);
    expect(e.venue_address).toBe("Near Rajwada, Indore");
    const ld = eventLd(e);
    expect(ld).toMatchObject({
      "@type": "MusicEvent", name: "Monsoon Ragas", startDate: `${inDays(6)}T18:30:00+05:30`,
      eventStatus: "https://schema.org/EventScheduled", eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      location: { "@type": "Place", name: "Jal Sabhagrah" },
      offers: { "@type": "Offer", url: "https://tickets.example.org/monsoon-ragas", price: 200, priceCurrency: "INR" },
    });
    expect(JSON.stringify(ld)).not.toContain("asha@example.org");
    expect((await pool.query("SELECT status, resolution_note FROM review_queue")).rows[0]).toEqual({ status: "approved", resolution_note: `published as ${out.path}` });
    expect((await pool.query("SELECT status, event_id FROM submissions WHERE id = $1", [id])).rows[0]).toEqual({ status: "approved", event_id: out.eventId });
  });

  it("rejects, and files honeypot bots as rejected without queueing them", async () => {
    const city = await cityId();
    const a = await createDraft({ channel: "form", cityId: city, fields: formFields(), submitter: { name: "A", contact: "a@b.co" } }, pool);
    await queueSubmission(pool, honest(), a.id, { jobName: "submissions" });
    await rejectSubmission(pool, a.id, "not a public event");
    const bot = await createDraft({ channel: "form", cityId: city, fields: formFields(), submitter: { name: "x", contact: "x@y.z" } }, pool);
    await rejectAsBot(pool, bot.id);
    expect((await pool.query("SELECT id, status FROM submissions ORDER BY id")).rows).toEqual([{ id: a.id, status: "rejected" }, { id: bot.id, status: "rejected" }]);
    expect((await pool.query("SELECT item_id, status FROM review_queue")).rows).toEqual([{ item_id: a.id, status: "rejected" }]);
  });
});

describe("poster photos", () => {
  it("keeps JPEG, PNG and WebP, refuses anything else, and strips location data", async () => {
    const withGps = await sharp({ create: { width: 400, height: 200, channels: 3, background: "#123456" } })
      .withExif({ IFD0: { Make: "PhoneMaker", Model: "Phone 9" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "22/1 43/1 0/1" } })
      .jpeg().toBuffer();
    expect((await sharp(withGps).metadata()).exif).toBeDefined();
    const clean = await cleanImage(withGps);
    const meta = await sharp(clean.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.format).toBe("jpeg");
    expect(clean.bytes.includes(Buffer.from("PhoneMaker"))).toBe(false);

    // The camera's orientation is applied before the metadata goes.
    const turned = await sharp({ create: { width: 300, height: 100, channels: 3, background: "#fff" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const upright = await cleanImage(turned);
    expect([upright.width, upright.height]).toEqual([100, 300]);

    const big = await cleanImage(await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#fff" } }).png().toBuffer());
    expect(Math.max(big.width, big.height)).toBe(1600);
    expect((await cleanImage(await sharp({ create: { width: 50, height: 50, channels: 4, background: "#0000" } }).webp().toBuffer())).mediaType).toBe("image/jpeg");

    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).gif().toBuffer();
    await expect(cleanImage(gif)).rejects.toMatchObject({ problem: "badType" });
    await expect(cleanImage(Buffer.from("not an image at all"))).rejects.toBeInstanceOf(UploadError);
    await expect(cleanImage(Buffer.alloc(0))).rejects.toMatchObject({ problem: "empty" });
    await expect(cleanImage(Buffer.alloc(9 * 1024 * 1024, 1))).rejects.toMatchObject({ problem: "tooBig" });
  });

  it("reads a snapped poster into a prefilled form, marking what it was unsure of", async () => {
    const city = await cityId();
    const id = await storePoster({ channel: "public", cityId: city, image: await cleanImage(await jpeg(600, 800)), note: "outside the college gate", keepDays: 2 }, pool);
    const llm = new FakeLlm((kind, text) => {
      expect(text).toContain("outside the college gate");
      return { is_event_post: true, events: [event({ start_time: f("19:30", 0.55), area: f("Palasia", 0.3) })], co_host_handles: [], notes: "time partly hidden" };
    });
    const [r] = await readPosters(pool, llm, [id], { jobName: "submissions", subBudget: "submissions" });
    expect(llm.calls).toEqual([{ kind: "extract", tier: "mid", images: 1, subBudget: "submissions" }]);
    const fields = fieldsFromExtraction(r.extraction!.events[0], CATS);
    expect(fields).toMatchObject({ title: "Sufi Night", date: inDays(5), start_time: "19:30", venue: "Ravindra Natya Griha", area: "", category: "music", price: "₹300" });
    expect(fields.uncertain).toEqual(["start_time", "area"]);
    expect((await pool.query("SELECT extraction_state FROM poster_images WHERE id = $1", [id])).rows[0].extraction_state).toBe("done");
  });

  it("turns inbox posters into drafts in the review queue: clear, blurry and not an event", async () => {
    const city = await cityId();
    const ids: number[] = [];
    for (const c of ["#111111", "#777777", "#eeeeee"]) {
      ids.push(await storePoster({ channel: "admin", cityId: city, image: await cleanImage(await jpeg(500, 700, c)), keepDays: 7 }, pool));
    }
    const llm = new FakeLlm((kind) => {
      if (kind === "write") return DESCRIPTION;
      const n = llm.calls.filter((c) => c.kind === "extract").length;
      if (n === 1) return { is_event_post: true, events: [event(), event({ title: f("Qawwali Evening"), start_date: f(inDays(6)) })], co_host_handles: [], notes: "" };
      if (n === 2) return {
        is_event_post: true, co_host_handles: [], notes: "photo is blurred; only the title is readable",
        events: [event({ title: f("Jazz at the Lake", 0.7), start_date: f(null), start_time: f(null), venue_name: f("Lake", 0.3), price_text: f(null), category: f("music", 0.5) })],
      };
      return { is_event_post: false, events: [], co_host_handles: [], notes: "a restaurant menu, not an event" };
    });
    const results = await inboxPosters(pool, llm, ids, "admin", { jobName: "poster-inbox" });
    expect(results.map((r) => r.outcome)).toEqual(["drafts", "drafts", "not_event"]);
    expect(results[0].titles).toEqual(["Sufi Night", "Qawwali Evening"]);
    const queue = (await pool.query<{ item_type: string; reason: string }>("SELECT item_type, reason FROM review_queue ORDER BY id")).rows;
    expect(queue).toEqual([
      { item_type: "submission", reason: "New event via poster inbox: looks fine" },
      { item_type: "submission", reason: "New event via poster inbox: looks fine" },
      { item_type: "submission", reason: "New event via poster inbox: needs checking" },
      { item_type: "poster", reason: "photo does not look like an event poster" },
    ]);
    // The inbox is the admin's own: no spam screening by model.
    expect(llm.calls.filter((c) => c.kind === "screen")).toEqual([]);
    const blurry = (await pool.query("SELECT fields, screening FROM submissions WHERE poster_id = $1", [ids[1]])).rows[0];
    expect(blurry.fields).toMatchObject({ title: "Jazz at the Lake", date: "", venue: "" });
    expect(blurry.screening.missing).toEqual(["date", "venue"]);

    // Approved from a poster: the page names a submitted poster and shows no image.
    const subId = (await pool.query<{ id: number }>("SELECT id FROM submissions WHERE poster_id = $1 ORDER BY id LIMIT 1", [ids[0]])).rows[0].id;
    const out = await approveSubmission(pool, llm, subId, { jobName: "admin" });
    const e = (await getEvent("indore", out.path.split("/").pop()!))!;
    expect(e.sources).toEqual([{ source_type: "poster", url: null }]);
    expect(JSON.stringify(eventLd(e))).not.toContain("/admin/posters");
    // The photo is kept until the day after the event, then housekeeping deletes it.
    const keep = (await pool.query<{ delete_after: Date }>("SELECT delete_after FROM poster_images WHERE id = $1", [ids[0]])).rows[0].delete_after;
    expect(localDate(keep, TZ)).toBe(inDays(7));
  });

  it("housekeeping deletes photos whose time is up and drafts never sent", async () => {
    const city = await cityId();
    const old = await storePoster({ channel: "public", cityId: city, image: await cleanImage(await jpeg(100, 100)), keepDays: 0 }, pool);
    const kept = await storePoster({ channel: "public", cityId: city, image: await cleanImage(await jpeg(100, 100)), keepDays: 5 }, pool);
    const draftPoster = await storePoster({ channel: "public", cityId: city, image: await cleanImage(await jpeg(100, 100)), keepDays: 5 }, pool);
    const d = await createDraft({ channel: "poster", cityId: city, fields: emptyFields(), posterId: draftPoster }, pool);
    await pool.query("UPDATE submissions SET updated_at = now() - interval '3 days' WHERE id = $1", [d.id]);
    const report = await cleanUp(pool, new Date(Date.now() + 60_000));
    expect(report).toMatchObject({ posterPhotosDeleted: 2, unsentDraftsDeleted: 1 });
    expect((await pool.query("SELECT id FROM poster_images")).rows).toEqual([{ id: kept }]);
    expect(old).toBeLessThan(kept);
  });
});

describe("abuse protection", () => {
  it("rate limits per key and reads the client address", async () => {
    const limit = { max: 2, windowMinutes: 60 };
    expect(await rateAllow("form:abc", [limit], pool)).toBe(true);
    expect(await rateAllow("form:abc", [limit], pool)).toBe(true);
    expect(await rateAllow("form:abc", [limit], pool)).toBe(false);
    expect(await rateAllow("form:other", [limit], pool)).toBe(true);
    const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
    expect(clientIp(h({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientIp(h({ "x-forwarded-for": "198.51.100.7, 10.0.0.1" }))).toBe("198.51.100.7");
  });

  it("checks Turnstile tokens with Cloudflare", async () => {
    const seen: string[] = [];
    const cf = (async (_u: string, init: RequestInit) => {
      const body = init.body as URLSearchParams;
      seen.push(body.get("secret")!);
      return new Response(JSON.stringify(body.get("response") === "good" ? { success: true } : { success: false, "error-codes": ["invalid-input-response"] }));
    }) as unknown as typeof fetch;
    expect(await verifyTurnstile("good", "203.0.113.9", cf)).toEqual({ ok: true });
    expect(await verifyTurnstile("bad", "203.0.113.9", cf)).toEqual({ ok: false, reason: "invalid-input-response" });
    expect(await verifyTurnstile(null, "203.0.113.9", cf)).toEqual({ ok: false, reason: "no token" });
    expect(seen).toEqual(["turnstile-secret", "turnstile-secret"]);
  });
});

describe("admin login", () => {
  it("hashes with scrypt and verifies", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(hash).not.toContain("horse");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("correct horse battery stapler", hash)).toBe(false);
    expect(passwordProblem("short")).toMatch(/at least 14/);
    expect(passwordProblem("aaaaaaaaaaaaaaaa")).not.toBeNull();
    expect(passwordProblem("lantern velvet orbit mango")).toBeNull();
  });

  it("opens setup only with the token and only once, and runs sessions", async () => {
    expect((await setupAllowed("wrong", pool)).ok).toBe(false);
    expect((await setupAllowed("", pool)).ok).toBe(false);
    expect((await setupAllowed("setup-token-for-tests-0123456789", pool)).ok).toBe(true);
    // Spaces and quotes picked up when copying the value are ignored.
    expect((await setupAllowed('  "setup-token-for-tests-0123456789"\n', pool)).ok).toBe(true);
    expect(cleanToken("'abc'")).toBe("abc");
    await setPassword("lantern velvet orbit mango", pool);
    expect(await setupAllowed("setup-token-for-tests-0123456789", pool)).toEqual({ ok: false, reason: "The admin password is already set. Setup is locked." });
    expect(await checkLogin("lantern velvet orbit mango", pool)).toBe(true);
    expect(await checkLogin("lantern velvet orbit", pool)).toBe(false);
    const { token } = await createSession(pool);
    expect(await sessionValid(token, pool)).toBe(true);
    expect(await sessionValid(`${token}x`, pool)).toBe(false);
    expect((await pool.query("SELECT token_hash FROM admin_sessions")).rows[0].token_hash).not.toBe(token);
    await endSession(token, pool);
    expect(await sessionValid(token, pool)).toBe(false);
  });
});

describe("poster email", () => {
  const secret = `whsec_${Buffer.from("a-webhook-secret-of-some-length").toString("base64")}`;
  const sign = (id: string, ts: string, body: string) =>
    `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64")}`;

  it("accepts only correctly signed, recent webhooks", () => {
    const body = JSON.stringify({ type: "email.received", data: { email_id: "e1" } });
    const ts = String(Math.floor(Date.now() / 1000));
    expect(verifyWebhook(secret, { id: "msg_1", timestamp: ts, signature: `v1,bogus ${sign("msg_1", ts, body)}` }, body)).toBe(true);
    expect(verifyWebhook(secret, { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, `${body} `) }, body)).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(verifyWebhook(secret, { id: "msg_1", timestamp: old, signature: sign("msg_1", old, body) }, body)).toBe(false);
  });

  it("reads image attachments from allowed senders into the inbox, once", async () => {
    const poster = await jpeg(400, 600);
    const calls: string[] = [];
    const resend = (async (url: string) => {
      calls.push(url);
      if (url.endsWith("/attachments?limit=100")) {
        return Response.json({ data: [
          { id: "a1", filename: "poster.jpg", content_type: "image/jpeg", size: poster.length, download_url: "https://inbound-cdn.example/a1" },
          { id: "a2", filename: "notes.pdf", content_type: "application/pdf", size: 100, download_url: "https://inbound-cdn.example/a2" },
        ] });
      }
      if (url.startsWith("https://inbound-cdn.example/")) return new Response(new Uint8Array(poster));
      return Response.json({ from: "Owner <owner@example.com>", subject: "from the gigs group", authentication: { spf: "pass", dkim: "pass" } });
    }) as unknown as typeof fetch;
    const llm = new FakeLlm(() => ({ is_event_post: true, events: [event()], co_host_handles: [], notes: "" }));
    const payload = { type: "email.received", data: { email_id: "e-42", from: "owner@example.com", subject: "from the gigs group" } };

    const stranger = await handleInbound(pool, llm, { ...payload, data: { ...payload.data, from: "someone@else.example" } }, { fetchFn: resend, apiKey: "re_test" });
    expect(stranger).toMatchObject({ status: "rejected", reason: "sender not allowed" });
    expect(calls).toEqual([]);

    const done = await handleInbound(pool, llm, payload, { fetchFn: resend, apiKey: "re_test" });
    expect(done).toMatchObject({ status: "processed", posters: 1 });
    expect(calls.filter((u) => u.includes("a2"))).toEqual([]);
    expect((await pool.query("SELECT channel, note FROM poster_images")).rows).toEqual([{ channel: "email", note: "from the gigs group" }]);
    expect((await pool.query("SELECT reason FROM review_queue")).rows).toEqual([{ reason: "New event via poster email: looks fine" }]);
    expect(await handleInbound(pool, llm, payload, { fetchFn: resend, apiKey: "re_test" })).toMatchObject({ status: "duplicate" });
  });

  it("drops mail whose sender cannot be authenticated", async () => {
    const resend = (async () => Response.json({ authentication: { spf: "fail", dkim: "fail" } })) as unknown as typeof fetch;
    const out = await handleInbound(pool, new FakeLlm(() => ({})), { type: "email.received", data: { email_id: "e-9", from: "owner@example.com" } }, { fetchFn: resend, apiKey: "re_test" });
    expect(out).toMatchObject({ status: "rejected", reason: "neither SPF nor DKIM passed" });
  });
});
