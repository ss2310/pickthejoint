import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { queueItem } from "@/lib/admin-data";
import { requireAdmin } from "@/lib/admin-session";
import type { ExtractedEvent } from "@/lib/pipeline/extract";
import { applyFound, lookupOf } from "@/lib/pipeline/second-look";
import { emptyFields, fieldsFromExtraction, getSubmission, type SubmissionFields } from "@/lib/submissions";
import { saveItem } from "../../actions";
import { FieldInputs, Msg, Raw, SecondLook, Thumb } from "../../components";

export const metadata = { title: "Edit review item" };

export default async function EditItem({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string }> }) {
  await requireAdmin();
  const item = await queueItem(Number((await params).id));
  if (!item) notFound();
  const { msg } = await searchParams;
  const pool = getPool();
  const cities = (await pool.query<{ id: number; slug: string; name: string }>("SELECT id, slug, name FROM cities ORDER BY is_live DESC, name")).rows;
  const categories = (await pool.query<{ slug: string; name: string }>("SELECT slug, name FROM categories ORDER BY sort_order")).rows;
  const p = item.payload as Record<string, unknown>;
  const lookup = item.item_type === "raw_post" ? lookupOf(p) : null;

  let fields: SubmissionFields = emptyFields();
  let city: string | null = null;
  let posterId: number | null = null;
  let event: { title: string; description: string | null; path: string } | null = null;
  if (item.item_type === "submission") {
    const s = await getSubmission(item.item_id!);
    if (s) { fields = s.fields; city = cities.find((c) => c.id === s.city_id)?.slug ?? null; posterId = s.poster_id; }
  } else if (item.item_type === "raw_post") {
    // The form starts from the post's facts with what the second look found filled in; the reviewer can change any of it.
    if (p.event) fields = fieldsFromExtraction(applyFound(p.event as ExtractedEvent, lookup?.found ?? []), categories.map((c) => c.slug), 0);
    const rp = (await pool.query<{ city: string | null }>(
      "SELECT c.slug AS city FROM raw_posts rp LEFT JOIN handles h ON h.handle = rp.handle LEFT JOIN cities c ON c.id = coalesce(rp.city_id, h.city_id) WHERE rp.id = $1", [item.item_id])).rows[0];
    city = rp?.city ?? null;
  } else if (item.item_type === "poster") {
    posterId = item.item_id;
    const row = (await pool.query<{ city: string | null }>("SELECT c.slug AS city FROM poster_images p LEFT JOIN cities c ON c.id = p.city_id WHERE p.id = $1", [posterId])).rows[0];
    city = row?.city ?? null;
  } else if (item.item_type === "event") {
    event = (await pool.query<{ title: string; description: string | null; path: string }>(
      "SELECT e.title, e.description, '/' || c.slug || '/events/' || e.slug AS path FROM events e JOIN cities c ON c.id = e.city_id WHERE e.id = $1", [item.item_id])).rows[0] ?? null;
  }
  const editable = ["submission", "raw_post", "poster"].includes(item.item_type);

  return (
    <>
      <p><Link href="/admin/queue">← Review queue</Link></p>
      <h1>{item.reason}</h1>
      <Msg msg={msg} />
      {item.status !== "open" && <p className="banner">This item is {item.status}: {item.resolution_note}</p>}
      <div className="two-col">
        <section className="form-card">
          {editable && (
            <form action={saveItem} className="form-grid">
              <input type="hidden" name="id" value={item.id} />
              <FieldInputs f={fields} cities={cities} city={city} categories={categories} />
              <p className="wide">
                <button className="button" name="intent" value="publish">Save and publish</button>{" "}
                {item.item_type === "submission" && <button className="button ghost" name="intent" value="save">Save only</button>}
              </p>
              <p className="wide muted small">Publishing creates the event (origin {item.item_type === "raw_post" ? "scraped" : "submitted"}), matches the venue, performers and organiser, writes the description and puts the page live.</p>
            </form>
          )}
          {item.item_type === "event" && event && (
            <form action={saveItem} className="form-grid">
              <input type="hidden" name="id" value={item.id} />
              <p className="wide"><a href={event.path} target="_blank">{event.title}</a></p>
              <label className="field wide">Description (our own words, from the facts only)
                <textarea name="description" defaultValue={event.description ?? ""} rows={6} />
              </label>
              <p className="wide"><button className="button" name="intent" value="publish">Save and publish</button>{" "}<button className="button ghost" name="intent" value="save">Save only</button></p>
            </form>
          )}
          {!editable && item.item_type !== "event" && <p>This kind of item has nothing to edit. Approve or reject it from the queue.</p>}
        </section>
        <section>
          {posterId && <Thumb posterId={posterId} alt="Poster photo" />}
          {item.item_type === "raw_post" && typeof p.url === "string" && <p><a href={p.url} rel="noopener nofollow" target="_blank">Open the source post</a></p>}
          <SecondLook lookup={lookup} />
          <Raw label="Stored details" value={p} />
        </section>
      </div>
    </>
  );
}
