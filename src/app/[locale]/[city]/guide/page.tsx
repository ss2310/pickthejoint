import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { guidePath } from "@/components/roundup-article";
import { Hero, Link } from "@/components/ui";
import { getPool } from "@/lib/db";
import { longDay } from "@/lib/format";
import { alternates, getLocale, messages, setLocale } from "@/lib/locale";
import { getCity } from "@/lib/queries";
import { listRoundups } from "@/lib/roundups";

export const revalidate = 600;

type Props = { params: Promise<{ locale: string; city: string }> };

async function load(params: Props["params"]) {
  const p = await params;
  setLocale(p.locale);
  return getCity(p.city);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const city = await load(params);
  if (!city) return {};
  const g = messages().guide;
  return { title: g.indexTitle(city.name), description: g.indexDescription(city.name), alternates: alternates(`/${city.slug}/guide`) };
}

export default async function GuideIndex({ params }: Props) {
  const city = await load(params);
  if (!city) notFound();
  const g = messages().guide;
  const guides = await listRoundups(getPool(), city.id, getLocale());
  return (
    <main>
      <Hero trail={[{ name: city.name, path: `/${city.slug}` }, { name: g.indexHeading(city.name), path: `/${city.slug}/guide` }]} title={g.indexHeading(city.name)}>
        <p className="lead">{g.indexDescription(city.name)}</p>
      </Hero>
      <div className="wrap page">
        {guides.length === 0 ? <p className="empty">{g.none}</p> : (
          <ol className="guide-list">
            {guides.map((r) => (
              <li key={r.id}>
                <h2><Link href={guidePath(city.slug, r.slug)}>{r.title}</Link></h2>
                <p className="muted small">{g.period(longDay(r.period_start), longDay(r.period_end))}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </main>
  );
}
