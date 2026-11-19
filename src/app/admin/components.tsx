/** Small pieces shared by the admin pages. Server components only. */
import type { LookupResult, Need } from "@/lib/pipeline/second-look";
import type { SubmissionFields } from "@/lib/submissions";

export const ist = (d: Date | string | null | undefined) =>
  d ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(new Date(d)) : "–";

export const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export function Msg({ msg }: { msg?: string }) {
  return msg ? <p className="banner" role="status">{msg}</p> : null;
}

/** A stored poster photo, admin only (the image route checks the session). Opens full size in a new tab. */
export function Thumb({ posterId, alt }: { posterId: number; alt: string }) {
  const src = `/admin/posters/${posterId}/image`;
  return (
    // A plain img: these private photos must not go through the public image optimiser.
    // eslint-disable-next-line @next/next/no-img-element
    <a href={src} target="_blank"><img src={src} alt={alt} className="thumb" loading="lazy" /></a>
  );
}

/** A JSON value, folded away. */
export function Raw({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="raw">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

const LOOKED_FOR: Record<Need, string> = { title: "Title", venue: "Venue", date: "Date", city: "City" };
const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

/**
 * What the second look found for a queued post: each fact with the page it came from, the short note,
 * and anything that was found but left out, with the reason. Shown on the queue and on the edit page.
 */
export function SecondLook({ lookup }: { lookup: LookupResult | null }) {
  if (!lookup) return null;
  const nothing = lookup.found.length === 0;
  return (
    <div className={`banner${nothing ? " banner-warn" : ""}`}>
      <p className="small">
        <strong>Second look</strong> · {ist(lookup.at)} · looked for: {lookup.needed.map((n) => LOOKED_FOR[n].toLowerCase()).join(", ")}
      </p>
      {nothing ? <p><strong>Nothing found.</strong></p> : (
        <ul className="facts-list">
          {lookup.found.map((f) => (
            <li key={f.field}>
              {LOOKED_FOR[f.field]}: <strong>{f.value}</strong> <span className="muted small">{f.confidence.toFixed(2)}</span>
              {f.differsFromPost && <> <span className="tag tag-warn">the post said: {f.differsFromPost}</span></>}
              <ul className="small notes">
                {f.sources.map((s) => (
                  <li key={s.url}>
                    from <a href={s.url} rel="noopener nofollow" target="_blank">{s.title || host(s.url)}</a> ({host(s.url)}{s.strength === "weak" ? ", a weak source" : ""})
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {lookup.note && <p className="small">{lookup.note}</p>}
      {lookup.leftOut.length > 0 && (
        <>
          <p className="small muted">Found but left out:</p>
          <ul className="small notes">
            {lookup.leftOut.map((l, i) => <li key={i}>{LOOKED_FOR[l.field]}: {l.value} ({l.reason})</li>)}
          </ul>
        </>
      )}
    </div>
  );
}

/** The event facts, as inputs. Used for submissions, queued posts and posters. */
export function FieldInputs({ f, cities, city, categories }: {
  f: SubmissionFields; cities: { slug: string; name: string }[]; city: string | null; categories: { slug: string; name: string }[];
}) {
  const unsure = new Set(f.uncertain ?? []);
  const mark = (name: string) => (unsure.has(name) ? " (unsure)" : "");
  return (
    <>
      <label className="field">City
        <select name="city" defaultValue={city ?? cities[0]?.slug}>{cities.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}</select>
      </label>
      <label className="field wide">Title{mark("title")}<input type="text" name="title" defaultValue={f.title} required /></label>
      <label className="field">Date{mark("date")}<input type="date" name="date" defaultValue={f.date} required /></label>
      <label className="field">Start time{mark("start_time")}<input type="time" name="start_time" defaultValue={f.start_time} /></label>
      <label className="field">Last day{mark("end_date")}<input type="date" name="end_date" defaultValue={f.end_date} /></label>
      <label className="field">End time{mark("end_time")}<input type="time" name="end_time" defaultValue={f.end_time} /></label>
      <label className="field wide">Venue{mark("venue")}<input type="text" name="venue" defaultValue={f.venue} required /></label>
      <label className="field wide">Venue address<input type="text" name="venue_address" defaultValue={f.venue_address} /></label>
      <label className="field">Area{mark("area")}<input type="text" name="area" defaultValue={f.area} /></label>
      <label className="field">Category{mark("category")}
        <select name="category" defaultValue={f.category}>
          <option value="">(none)</option>
          {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
        </select>
      </label>
      <label className="field">Price{mark("price")}<input type="text" name="price" defaultValue={f.price} /></label>
      <label className="field check"><input type="checkbox" name="is_free" defaultChecked={f.is_free} /> Free entry</label>
      <label className="field wide">Booking link{mark("booking_url")}<input type="url" name="booking_url" defaultValue={f.booking_url} /></label>
      <label className="field wide">Instagram post<input type="url" name="instagram_url" defaultValue={f.instagram_url} /></label>
      <label className="field wide">Performers (comma-separated)<input type="text" name="performers" defaultValue={f.performers} /></label>
      <label className="field wide">Organiser{mark("organiser")}<input type="text" name="organiser" defaultValue={f.organiser} /></label>
      <label className="field wide">Note (not published)<textarea name="note" defaultValue={f.note} rows={2} /></label>
    </>
  );
}
