import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SITE_URL = "https://pickthejoint.com";
  delete process.env.ANTHROPIC_API_KEY;
});

import { freshDb } from "./helpers";
import { seedDemo } from "./fixtures";
import { seed } from "../db/seed";
import { closePool } from "../src/lib/db";
import { EditError, editEvent, eventFields, loadEvent, type EditInput, type EditableEvent } from "../src/lib/event-edit";
import type { LlmClient, LlmRequest, LlmResult } from "../src/lib/pipeline/llm";
import { localDate, zonedToUtc } from "../src/lib/pipeline/text";
import { getEvent, movedEventSlug } from "../src/lib/queries";
import type { SubmissionFields } from "../src/lib/submissions";

const TZ = "Asia/Kolkata";
const NOW = new Date();
const day = (n: number) => new Date(Date.parse(`${localDate(NOW, TZ)}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

let pool: Pool;
beforeAll(async () => { pool = await freshDb(); await seed(pool); });
afterAll(async () => { await closePool(); await pool.end(); });
beforeEach(async () => {
  await pool.query(`TRUNCATE entity_sources, sources, events, event_artists, event_organisers, venues, artists, organisers, series,
    review_queue, cost_log, job_runs RESTART IDENTITY CASCADE`);
  await seedDemo(pool, NOW);
});

const NEW_TEXT = `Rewritten from the corrected facts. ${Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ")}.`;

/** Stands in for the description writer: records the facts it was given. Nothing paid. */
class FakeLlm implements LlmClient {
  asked: string[] = [];
  fail = false;
  async run<T>(requests: LlmRequest<T>[]): Promise<LlmResult<T>[]> {
    if (this.fail) throw new Error("API error 529: overloaded");
    return requests.map((req) => {
      this.asked.push(req.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n"));
      return { id: req.id, ok: true, data: req.schema.parse({ description: NEW_TEXT }), model: "fake", usd: 0.004, inputTokens: 10, outputTokens: 10 };
    });
  }
}

const byTitle = async (title: string) =>
  (await loadEvent(pool, Number((await pool.query<{ id: number }>("SELECT id FROM events WHERE title = $1", [title])).rows[0].id)))!;
const input = (e: EditableEvent, fields: Partial<SubmissionFields>, over: Partial<EditInput> = {}): EditInput =>
  ({ fields: { ...eventFields(e), ...fields }, description: e.description ?? "", rewrite: true, reason: "wrong date entered", ...over });
const actions = async (id: number) =>
  (await pool.query<{ action: string; reason: string }>("SELECT action, reason FROM event_actions WHERE event_id = $1 ORDER BY id", [id])).rows;
const edit = (e: EditableEvent, llm: LlmClient, fields: Partial<SubmissionFields>, over: Partial<EditInput> = {}) =>
  editEvent(pool, llm, e.id, input(e, fields, over), { jobName: "admin", now: NOW });

describe("the edit form's starting values", () => {
  it("shows an event's facts as they were entered", async () => {
    expect(eventFields(await byTitle("Aria Quartet Live"))).toMatchObject({
      title: "Aria Quartet Live", date: day(0), start_time: "20:00", end_date: "", end_time: "22:30", venue: "The Blue Room",
      category: "music", price: "₹499 onwards", is_free: false, booking_url: "https://tickets.example/aria",
    });
    // No start time announced, and free entry.
    expect(eventFields(await byTitle("Block Printing Workshop"))).toMatchObject({ date: day(3), start_time: "", end_time: "" });
    expect(eventFields(await byTitle("Open Mic Night"))).toMatchObject({ is_free: true, price: "" });
    // A run of several days with an end time on the last day.
    expect(eventFields(await byTitle("Winter Arts Week"))).toMatchObject({ date: day(5), start_time: "11:00", end_date: day(7), end_time: "22:00" });
  });

  it("reads back a last day with no end time, and a show that ends after midnight", async () => {
    const e = await byTitle("Open Mic Night");
    await pool.query("UPDATE events SET ends_at = $2 WHERE id = $1", [e.id, zonedToUtc(day(2), "23:59", TZ)]);
    expect(eventFields((await loadEvent(pool, e.id))!)).toMatchObject({ end_date: day(2), end_time: "" });
    await pool.query("UPDATE events SET ends_at = $2 WHERE id = $1", [e.id, zonedToUtc(day(2), "01:00", TZ)]);
    expect(eventFields((await loadEvent(pool, e.id))!)).toMatchObject({ start_time: "19:30", end_date: "", end_time: "01:00" });
  });
});

describe("correcting a published event", () => {
  it("moves the event to the right date, keeps the reason, and rewrites the description from the corrected facts", async () => {
    const e = await byTitle("Open Mic Night");
    const llm = new FakeLlm();
    const out = await edit(e, llm, { date: day(8) });

    const after = (await loadEvent(pool, e.id))!;
    expect(after.local_date).toBe(day(8));
    expect(after.starts_at.toISOString()).toBe(zonedToUtc(day(8), "19:30", TZ).toISOString());
    expect(after).toMatchObject({ start_time_known: true, venue: "Laugh Cottage", venue_id: e.venue_id, title: "Open Mic Night", status: "scheduled", is_published: true });
    expect(out.changes).toEqual([`date: "${day(1)}" to "${day(8)}"`]);

    // The writer was given the corrected date, and its text replaced the old one.
    expect(llm.asked).toHaveLength(1);
    expect(llm.asked[0]).toContain(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(after.starts_at));
    expect(out.description).toBe("rewritten");
    expect(after.description).toBe(NEW_TEXT);

    expect(await actions(e.id)).toEqual([{ action: "edited", reason: `wrong date entered (date: "${day(1)}" to "${day(8)}"); description rewritten` }]);
    const verified = (await pool.query<{ ok: boolean }>("SELECT last_verified_at > now() - interval '1 minute' AS ok FROM events WHERE id = $1", [e.id])).rows[0];
    expect(verified.ok).toBe(true);
  });

  it("gives the page an address with the right date and redirects the old address to it", async () => {
    const e = await byTitle("Open Mic Night");
    const out = await edit(e, new FakeLlm(), { date: day(8) });
    expect(e.slug).toBe(`open-mic-night-${day(1)}`);
    expect(out).toMatchObject({ path: `/indore/events/open-mic-night-${day(8)}`, movedFrom: `/indore/events/open-mic-night-${day(1)}` });

    expect(await getEvent("indore", `open-mic-night-${day(1)}`)).toBeNull();
    expect(await movedEventSlug("indore", `open-mic-night-${day(1)}`)).toBe(`open-mic-night-${day(8)}`);
    expect((await getEvent("indore", `open-mic-night-${day(8)}`))!.id).toBe(e.id);
    expect(await movedEventSlug("indore", "never-existed")).toBeNull();

    // A second correction: both earlier addresses lead to the page.
    await edit((await loadEvent(pool, e.id))!, new FakeLlm(), { date: day(9) });
    expect(await movedEventSlug("indore", `open-mic-night-${day(1)}`)).toBe(`open-mic-night-${day(9)}`);
    expect(await movedEventSlug("indore", `open-mic-night-${day(8)}`)).toBe(`open-mic-night-${day(9)}`);

    // Put back to the first date: the event takes its first address back, and that address no longer redirects.
    const back = await edit((await loadEvent(pool, e.id))!, new FakeLlm(), { date: day(1) });
    expect(back.path).toBe(`/indore/events/open-mic-night-${day(1)}`);
    expect(await movedEventSlug("indore", `open-mic-night-${day(1)}`)).toBeNull();
    expect((await getEvent("indore", `open-mic-night-${day(1)}`))!.id).toBe(e.id);
    expect(await movedEventSlug("indore", `open-mic-night-${day(9)}`)).toBe(`open-mic-night-${day(1)}`);
  });

  it("keeps the address when only the time, price or link changes", async () => {
    const e = await byTitle("Aria Quartet Live");
    const out = await edit(e, new FakeLlm(), { start_time: "21:00", end_time: "23:00", price: "₹599", booking_url: "https://tickets.example/aria-new" }, { reason: "organiser moved the start" });
    expect(out.movedFrom).toBeNull();
    expect(out.path).toBe(`/indore/events/${e.slug}`);
    expect(out.changes).toEqual(['start time: "20:00" to "21:00"', 'end time: "22:30" to "23:00"', 'price: "₹499 onwards" to "₹599"',
      'booking link: "https://tickets.example/aria" to "https://tickets.example/aria-new"']);
    const after = (await loadEvent(pool, e.id))!;
    expect(after.starts_at.toISOString()).toBe(zonedToUtc(day(0), "21:00", TZ).toISOString());
    expect(after.ends_at!.toISOString()).toBe(zonedToUtc(day(0), "23:00", TZ).toISOString());
    expect(after).toMatchObject({ price_text: "₹599", is_free: false, booking_url: "https://tickets.example/aria-new" });
    expect(await pool.query("SELECT 1 FROM event_redirects")).toMatchObject({ rowCount: 0 });
    // Performers, organisers and sources are untouched.
    expect((await getEvent("indore", e.slug))!).toMatchObject({ artists: [{ slug: "aria-quartet" }], organisers: [{ slug: "indore-jazz-club" }] });
  });

  it("matches a corrected venue to one we know, or creates it, and removes a start time that was never announced", async () => {
    const e = await byTitle("Open Mic Night");
    const blueRoom = Number((await pool.query<{ id: number }>("SELECT id FROM venues WHERE slug = 'the-blue-room'")).rows[0].id);
    await edit(e, new FakeLlm(), { venue: "the blue room" }, { reason: "wrong venue" });
    expect((await loadEvent(pool, e.id))!).toMatchObject({ venue_id: blueRoom, venue: "The Blue Room" });

    const out = await edit((await loadEvent(pool, e.id))!, new FakeLlm(), { venue: "Rooftop at Hotel Example", start_time: "" }, { reason: "moved" });
    const after = (await loadEvent(pool, e.id))!;
    expect(after.venue).toBe("Rooftop at Hotel Example");
    expect(after.venue_id).not.toBe(blueRoom);
    expect(after.start_time_known).toBe(false);
    expect(out.changes).toEqual(['start time: "19:30" to none', 'venue: "The Blue Room" to "Rooftop at Hotel Example"']);
  });

  it("puts an event marked as over back on when it is moved to a date still to come", async () => {
    const e = await byTitle("The Last Letter");
    expect(e.status).toBe("happened");
    await edit(e, new FakeLlm(), { date: day(4) }, { reason: "the year was wrong" });
    expect((await loadEvent(pool, e.id))!).toMatchObject({ status: "scheduled", local_date: day(4) });
    // A cancelled event stays cancelled.
    const c = await byTitle("Saturday Social");
    await edit(c, new FakeLlm(), { date: day(6) }, { reason: "wrong day" });
    expect((await loadEvent(pool, c.id))!.status).toBe("cancelled");
  });

  it("uses the admin's own description as it is, without a model call", async () => {
    const e = await byTitle("Open Mic Night");
    const llm = new FakeLlm();
    const own = "An open mic evening of stand-up comedy at Laugh Cottage in Old Palasia, Indore. Entry is free.";
    const out = await edit(e, llm, { date: day(8) }, { description: `  ${own}\n` });
    expect(out.description).toBe("edited by hand");
    expect(llm.asked).toHaveLength(0);
    expect((await loadEvent(pool, e.id))!.description).toBe(own);
    expect((await actions(e.id))[0].reason).toBe(`wrong date entered (date: "${day(1)}" to "${day(8)}"; description edited by hand)`);

    // A description change alone is a valid correction.
    const again = await edit((await loadEvent(pool, e.id))!, llm, {}, { description: `${own} Doors open at 7:00 PM.`, reason: "added the door time" });
    expect(again.changes).toEqual(["description edited by hand"]);
    expect(llm.asked).toHaveLength(0);
  });

  it("makes no model call when the box is unticked", async () => {
    const e = await byTitle("Open Mic Night");
    const llm = new FakeLlm();
    const out = await edit(e, llm, { date: day(8) }, { rewrite: false });
    expect(out.description).toBe("unchanged");
    expect(llm.asked).toHaveLength(0);
    expect((await loadEvent(pool, e.id))!.description).toBe(e.description);
  });

  it("saves the corrected facts and says so plainly when the description cannot be rewritten", async () => {
    const e = await byTitle("Open Mic Night");
    const llm = new FakeLlm();
    llm.fail = true;
    const out = await edit(e, llm, { date: day(8) });
    expect(out).toMatchObject({ description: "not rewritten", descriptionError: "API error 529: overloaded" });
    const after = (await loadEvent(pool, e.id))!;
    expect(after.local_date).toBe(day(8));
    expect(after.description).toBe(e.description); // the old text is still there: the caller tells the admin
    expect(await actions(e.id)).toEqual([{ action: "edited", reason: `wrong date entered (date: "${day(1)}" to "${day(8)}")` }]);
  });

  it("refuses an edit with no reason, no change, or facts that cannot be stored, and changes nothing", async () => {
    const e = await byTitle("Open Mic Night");
    const llm = new FakeLlm();
    await expect(edit(e, llm, { date: day(8) }, { reason: "  " })).rejects.toThrow("Give a reason");
    await expect(edit(e, llm, {})).rejects.toThrow("Nothing was changed.");
    await expect(edit(e, llm, { date: "2026-02-30" })).rejects.toThrow("valid date");
    await expect(edit(e, llm, { title: "" })).rejects.toThrow("needs a title");
    await expect(edit(e, llm, { venue: "" })).rejects.toThrow("needs a venue");
    await expect(edit(e, llm, { end_date: day(0) })).rejects.toThrow("last day cannot be before");
    await expect(edit(e, llm, { booking_url: "tickets.example" })).rejects.toThrow("full web address");
    await expect(edit(e, llm, { start_time: "7pm" })).rejects.toBeInstanceOf(EditError);
    await expect(editEvent(pool, llm, 999_999, input(e, { date: day(8) }), { jobName: "admin" })).rejects.toThrow("no longer exists");
    expect((await loadEvent(pool, e.id))!).toEqual(e);
    expect(await actions(e.id)).toEqual([]);
    expect(llm.asked).toHaveLength(0);
  });
});
