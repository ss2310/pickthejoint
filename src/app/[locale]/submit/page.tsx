import type { Metadata } from "next";
import { Hero } from "@/components/ui";
import { parked, submissions as cfg } from "@/config";
import { categoryName } from "@/lib/hubs";
import { alternates, getLocale, messages, setLocale } from "@/lib/locale";
import { getPool } from "@/lib/db";
import { FACT_KEYS, storedFacts } from "@/lib/practical";
import { listAreas, listCategories, liveCities } from "@/lib/queries";
import { emptyFields, getDraft, type FieldError, type SubmissionFields } from "@/lib/submissions";
import { sendEvent, snapPoster } from "./actions";

// Drafts change on every post; nothing here is cached.
export const dynamic = "force-dynamic";

type Search = { draft?: string; read?: string; many?: string; upload?: string; event?: string };

/** The listed event a "practical details" form is for, or null. */
async function factsEvent(id: number | null | undefined) {
  if (!id || !Number.isInteger(id)) return null;
  const { rows } = await getPool().query<{ id: number; title: string; local_date: string; city_slug: string }>(
    `SELECT e.id, e.title, e.local_date::text, c.slug AS city_slug FROM events e JOIN cities c ON c.id = e.city_id
     WHERE e.id = $1 AND e.is_published AND c.is_live AND e.status IN ('scheduled', 'postponed')`, [id]);
  return rows[0] ?? null;
}

/** The practical questions as inputs (Prompt 11). Every one may be left empty. */
function PracticalInputs({ values, err, invalid }: {
  values: Partial<Record<string, string>>; err: (name: string) => React.ReactNode; invalid: (name: string) => Record<string, unknown>;
}) {
  const m = messages().practical;
  return (
    <>
      {FACT_KEYS.map((key) => (
        <label key={key} className={key === "doors_time" ? "field" : "field wide"}>{m.labels[key]}
          {key === "doors_time"
            ? <input type="time" name="fact_doors_time" defaultValue={values[key] ?? ""} {...invalid("fact_doors_time")} />
            : <input type="text" name={`fact_${key}`} defaultValue={values[key] ?? ""} maxLength={240} />}
          {m.hints[key] && <span className="hint">{m.hints[key]}</span>}
          {err(`fact_${key}`)}
        </label>
      ))}
    </>
  );
}
type Props = { params: Promise<{ locale: string }>; searchParams: Promise<Search> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  setLocale((await params).locale);
  const m = messages().submit;
  const q = await searchParams;
  return {
    title: m.title,
    description: m.metaDescription,
    alternates: alternates("/submit"),
    // A draft's address carries its private token: never indexed.
    robots: q.draft || q.upload ? { index: false, follow: false } : undefined,
  };
}

/** Uncertain field keys from a poster reading, in the label the form uses. */
const LABEL_KEY: Record<string, keyof ReturnType<typeof messages>["submit"]> = {
  title: "eventTitle", date: "date", start_time: "startTime", end_date: "endDate", end_time: "endTime", venue: "venue",
  area: "area", category: "category", price: "price", is_free: "isFree", booking_url: "bookingUrl", organiser: "organiser",
};

export default async function SubmitPage({ params, searchParams }: Props) {
  const locale = setLocale((await params).locale);
  const m = messages().submit;
  // Parked (see PARKED.md): nobody is moderating and housekeeping is off, so the form is closed.
  if (parked.on) {
    return (
      <main>
        <Hero trail={[{ name: m.title, path: "/submit" }]} title={m.title}><p className="lead">{messages().site.parkedSubmit}</p></Hero>
      </main>
    );
  }
  const q = await searchParams;
  const draft = q.draft ? await getDraft(q.draft) : null;
  const [cities, categories] = await Promise.all([liveCities(), listCategories()]);
  const areas = (await Promise.all(cities.map((c) => listAreas(c.id)))).flat();
  const f: SubmissionFields = draft?.fields ?? emptyFields();
  const who = draft?.submitter ?? { name: "", contact: "" };
  const errors: Partial<Record<string, FieldError>> = draft?.form_errors ?? {};
  const cityId = draft?.city_id ?? cities[0]?.id;
  const err = (name: string) => errors[name] ? <span className="field-error" id={`${name}-error`}>{m.errors[errors[name]!]}</span> : null;
  const invalid = (name: string) => (errors[name] ? { "aria-invalid": true, "aria-describedby": `${name}-error` } : {});
  const uncertain = (f.uncertain ?? []).map((k) => LABEL_KEY[k]).filter(Boolean).map((k) => String(m[k]));
  const siteKey = cfg.turnstileSiteKey;
  const turnstile = siteKey ? <div className="cf-turnstile" data-sitekey={siteKey} data-language={getLocale()} /> : null;
  const p = messages().practical;
  // Practical details for an event already listed: from its page's link, or a draft of that form sent back with an error.
  const forId = draft ? draft.fields.for_event : q.event ? Number(q.event) : null;
  const target = forId ? await factsEvent(forId) : null;
  const known = target ? await storedFacts(getPool(), target.id) : {};

  if (forId) {
    return (
      <main>
        <Hero trail={[{ name: m.title, path: "/submit" }]} title={target ? p.forHeading(target.title) : m.title}>
          <p className="lead">{target ? p.forLead : p.forNotFound}</p>
        </Hero>
        {target && (
          <div className="wrap page narrow">
            {Object.keys(errors).length > 0 && (
              <p className="banner banner-warn" role="alert">{errors._form ? m.errors[errors._form] : errors._facts ? m.errors[errors._facts] : m.errorSummary}</p>
            )}
            <section aria-labelledby="form-heading" className="form-card" id="form">
              <h2 id="form-heading">{p.formHeading}</h2>
              <p className="muted small">{p.formLead}</p>
              <form action={sendEvent} className="form-grid" key={draft ? `${draft.token}-${draft.updated_at.valueOf()}` : "facts"}>
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="for_event" value={target.id} />
                <input type="hidden" name="city" value={target.city_slug} />
                {draft && <input type="hidden" name="draft" value={draft.token} />}
                <div className="hp" aria-hidden="true">
                  <label>Website <input type="text" name="website" tabIndex={-1} autoComplete="off" /></label>
                </div>
                <PracticalInputs values={draft?.fields.practical ?? known} err={err} invalid={invalid} />
                <label className="field wide">{m.note}
                  <textarea name="note" defaultValue={f.note} maxLength={1500} rows={3} />
                </label>
                <fieldset className="wide">
                  <legend>{m.aboutYou}</legend>
                  <p className="muted small">{m.aboutYouNote}</p>
                  <div className="form-grid">
                    <label className="field">{m.name} *
                      <input type="text" name="name" defaultValue={who.name} maxLength={120} autoComplete="name" required {...invalid("name")} />{err("name")}
                    </label>
                    <label className="field">{m.contact} *
                      <input type="text" name="contact" defaultValue={who.contact} maxLength={200} autoComplete="email" required {...invalid("contact")} />{err("contact")}
                    </label>
                  </div>
                </fieldset>
                {turnstile && <div className="wide"><p className="muted small">{m.captchaNote}</p>{turnstile}</div>}
                <p className="wide"><button type="submit" className="button">{m.send}</button></p>
              </form>
            </section>
          </div>
        )}
        {target && siteKey && <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />}
      </main>
    );
  }

  return (
    <main>
      <Hero trail={[{ name: m.title, path: "/submit" }]} title={m.title}>
        <p className="lead">{m.lead}</p>
      </Hero>
      <div className="wrap page narrow">
        {q.upload && <p className="banner banner-warn" role="alert">{m.uploadErrors[q.upload] ?? m.uploadErrors.unreadable}</p>}

        {!draft && (
          <section aria-labelledby="poster-heading" className="form-card">
            <h2 id="poster-heading">{m.posterHeading}</h2>
            <p>{m.posterLead}</p>
            <form action={snapPoster} className="form-grid">
              <input type="hidden" name="locale" value={locale} />
              {cities.length > 1 && (
                <label className="field">{m.city}
                  <select name="city" defaultValue={cities[0]?.slug}>{cities.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}</select>
                </label>
              )}
              {cities.length === 1 && <input type="hidden" name="city" value={cities[0].slug} />}
              <label className="field wide">{m.posterFile}
                <input type="file" name="poster" accept="image/jpeg,image/png,image/webp" required />
                <span className="hint">{m.posterFileHint}</span>
              </label>
              <label className="field wide">{m.posterNote}
                <input type="text" name="poster_note" maxLength={500} />
              </label>
              <div className="wide">{turnstile}</div>
              <p className="wide"><button type="submit" className="button">{m.posterButton}</button></p>
              <p className="wide muted small">{m.posterPrivacy}</p>
            </form>
          </section>
        )}

        {draft && q.read === "ok" && (
          <div className="banner" role="status">
            <p>{m.posterRead}</p>
            {uncertain.length > 0 && <p><strong>{m.posterUnsure(uncertain)}</strong></p>}
            {Number(q.many) > 1 && <p>{m.posterMany(Number(q.many))}</p>}
          </div>
        )}
        {draft && q.read === "none" && <p className="banner banner-warn" role="status">{m.posterNone}</p>}
        {draft && q.read === "failed" && <p className="banner banner-warn" role="status">{m.posterFailed}</p>}
        {draft && q.read === "paused" && <p className="banner banner-warn" role="status">{m.posterPaused}</p>}
        {Object.keys(errors).length > 0 && (
          <p className="banner banner-warn" role="alert">{errors._form ? m.errors[errors._form] : m.errorSummary}</p>
        )}

        <section aria-labelledby="form-heading" className="form-card" id="form">
          <h2 id="form-heading">{m.formHeading}</h2>
          <p className="muted small">{m.formLead}</p>
          {draft?.poster_id && <p className="small">{m.posterAttached}</p>}
          {/* Keyed by the draft (and its last save), so the browser builds the form afresh with the draft's values:
              after a client-side redirect, selects and checkboxes would otherwise keep their old state. */}
          <form action={sendEvent} className="form-grid" key={draft ? `${draft.token}-${draft.updated_at.valueOf()}` : "new"}>
            <input type="hidden" name="locale" value={locale} />
            {draft && <input type="hidden" name="draft" value={draft.token} />}
            {/* A field people never see. Bots fill it in. */}
            <div className="hp" aria-hidden="true">
              <label>Website <input type="text" name="website" tabIndex={-1} autoComplete="off" /></label>
            </div>

            <label className="field">{m.city} *
              <select name="city" defaultValue={cities.find((c) => c.id === cityId)?.slug} required {...invalid("city")}>
                {cities.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
              </select>{err("city")}
            </label>
            <label className="field wide">{m.eventTitle} *
              <input type="text" name="title" defaultValue={f.title} maxLength={160} required {...invalid("title")} />{err("title")}
            </label>
            <label className="field">{m.date} *
              <input type="date" name="date" defaultValue={f.date} required {...invalid("date")} />{err("date")}
            </label>
            <label className="field">{m.startTime}
              <input type="time" name="start_time" defaultValue={f.start_time} {...invalid("start_time")} /><span className="hint">{m.timeHint}</span>{err("start_time")}
            </label>
            <label className="field">{m.endDate}
              <input type="date" name="end_date" defaultValue={f.end_date} {...invalid("end_date")} />{err("end_date")}
            </label>
            <label className="field">{m.endTime}
              <input type="time" name="end_time" defaultValue={f.end_time} {...invalid("end_time")} />{err("end_time")}
            </label>
            <label className="field wide">{m.venue} *
              <input type="text" name="venue" defaultValue={f.venue} maxLength={160} required {...invalid("venue")} />{err("venue")}
            </label>
            <label className="field wide">{m.venueAddress}
              <input type="text" name="venue_address" defaultValue={f.venue_address} maxLength={300} />
            </label>
            <label className="field">{m.area}
              <input type="text" name="area" defaultValue={f.area} list="areas" maxLength={80} />
              <datalist id="areas">{areas.map((a) => <option key={a.id} value={a.name} />)}</datalist>
            </label>
            <label className="field">{m.category} *
              <select name="category" defaultValue={f.category} required {...invalid("category")}>
                <option value="">{m.choose}</option>
                {categories.map((c) => <option key={c.slug} value={c.slug}>{categoryName(c)}</option>)}
              </select>{err("category")}
            </label>
            <label className="field">{m.price}
              <input type="text" name="price" defaultValue={f.price} maxLength={120} /><span className="hint">{m.priceHint}</span>
            </label>
            <label className="field check"><input type="checkbox" name="is_free" defaultChecked={f.is_free} /> {m.isFree}</label>
            <label className="field wide">{m.bookingUrl}
              <input type="url" name="booking_url" defaultValue={f.booking_url} maxLength={500} placeholder="https://" {...invalid("booking_url")} /><span className="hint">{m.bookingHint}</span>{err("booking_url")}
            </label>
            <label className="field wide">{m.instagramUrl}
              <input type="url" name="instagram_url" defaultValue={f.instagram_url} maxLength={300} placeholder="https://www.instagram.com/p/..." {...invalid("instagram_url")} /><span className="hint">{m.instagramHint}</span>{err("instagram_url")}
            </label>
            <label className="field wide">{m.performers}
              <input type="text" name="performers" defaultValue={f.performers} maxLength={400} /><span className="hint">{m.performersHint}</span>
            </label>
            <label className="field wide">{m.organiser}
              <input type="text" name="organiser" defaultValue={f.organiser} maxLength={160} />
            </label>
            <details className="wide" open={!!f.practical || !!errors.fact_doors_time}>
              <summary>{p.formHeading}</summary>
              <p className="muted small">{p.formLead}</p>
              <div className="form-grid">
                <PracticalInputs values={f.practical ?? {}} err={err} invalid={invalid} />
              </div>
            </details>
            <label className="field wide">{m.note}
              <textarea name="note" defaultValue={f.note} maxLength={1500} rows={3} />
            </label>

            <fieldset className="wide">
              <legend>{m.aboutYou}</legend>
              <p className="muted small">{m.aboutYouNote}</p>
              <div className="form-grid">
                <label className="field">{m.name} *
                  <input type="text" name="name" defaultValue={who.name} maxLength={120} autoComplete="name" required {...invalid("name")} />{err("name")}
                </label>
                <label className="field">{m.contact} *
                  <input type="text" name="contact" defaultValue={who.contact} maxLength={200} autoComplete="email" required {...invalid("contact")} />{err("contact")}
                </label>
              </div>
            </fieldset>

            {turnstile && <div className="wide"><p className="muted small">{m.captchaNote}</p>{turnstile}</div>}
            <p className="wide"><button type="submit" className="button">{m.send}</button></p>
          </form>
        </section>
      </div>
      {siteKey && <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />}
    </main>
  );
}
