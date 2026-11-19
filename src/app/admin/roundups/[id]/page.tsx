import Link from "next/link";
import { notFound } from "next/navigation";
import { RoundupArticle } from "@/components/roundup-article";
import { getPool } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-session";
import { setLocale } from "@/lib/locale";
import { getRoundupById, roundupEvents } from "@/lib/roundups";
import { saveRoundupText, setRoundupStatus } from "../../roundup-actions";
import { Msg } from "../../components";

export const metadata = { title: "Weekly guide" };

/** The guide as it will look, in either language, with its wording editable. */
export default async function RoundupPreview({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; lang?: string }> }) {
  await requireAdmin();
  const { msg, lang } = await searchParams;
  const locale = lang === "hi" ? "hi" : "en";
  const pool = getPool();
  const id = Number((await params).id);
  const raw = (await pool.query<{ title: string; intro: string; title_hi: string | null; intro_hi: string | null; status: string }>(
    "SELECT title, intro, title_hi, intro_hi, status FROM roundups WHERE id = $1", [id])).rows[0];
  if (!raw) notFound();
  setLocale(locale);
  const r = (await getRoundupById(pool, id, locale))!;
  // The preview renders in the chosen language; the admin pages themselves use no locale text.
  const events = await roundupEvents(r, locale);

  return (
    <>
      <p><Link href="/admin/roundups">← Weekly guides</Link> · {locale === "en" ? <Link href={`/admin/roundups/${id}?lang=hi`}>See it in Hindi</Link> : <Link href={`/admin/roundups/${id}`}>See it in English</Link>}</p>
      <Msg msg={msg} />
      <form action={setRoundupStatus}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="status" value={raw.status === "published" ? "draft" : "published"} />
        <button className={raw.status === "published" ? "button ghost" : "button"}>{raw.status === "published" ? "Unpublish" : "Publish this guide"}</button>
      </form>
      <div className="preview-frame" lang={locale === "hi" ? "hi-IN" : "en-IN"}>
        <RoundupArticle r={r} events={events} preview />
      </div>
      <section className="form-card">
        <h2>Change the wording</h2>
        <p className="small muted">The event lists are not edited here: they follow the listings. Keep to facts in the listings.</p>
        <form action={saveRoundupText} className="form-grid">
          <input type="hidden" name="id" value={id} />
          <label className="field wide">Headline (English)<input type="text" name="title" defaultValue={raw.title} required /></label>
          <label className="field wide">Overview (English)<textarea name="intro" defaultValue={raw.intro} rows={6} required /></label>
          <label className="field wide">Headline (Hindi)<input type="text" name="title_hi" defaultValue={raw.title_hi ?? ""} lang="hi" /></label>
          <label className="field wide">Overview (Hindi)<textarea name="intro_hi" defaultValue={raw.intro_hi ?? ""} rows={6} lang="hi" /></label>
          <p className="wide"><button className="button">Save the wording</button></p>
        </form>
      </section>
    </>
  );
}
