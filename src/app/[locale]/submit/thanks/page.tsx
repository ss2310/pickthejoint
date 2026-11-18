import type { Metadata } from "next";
import { Hero, Link } from "@/components/ui";
import { messages, setLocale } from "@/lib/locale";
import { getCity } from "@/lib/queries";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<{ city?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  setLocale((await params).locale);
  return { title: messages().submit.thanksTitle, robots: { index: false, follow: true } };
}

export default async function ThanksPage({ params, searchParams }: Props) {
  setLocale((await params).locale);
  const m = messages().submit;
  const city = (await searchParams).city ? await getCity((await searchParams).city!) : null;
  return (
    <main>
      <Hero trail={[{ name: m.title, path: "/submit" }, { name: m.thanksTitle, path: "/submit/thanks" }]} title={m.thanksTitle}>
        <p className="lead">{m.thanksLead}</p>
      </Hero>
      <div className="wrap page narrow">
        <p className="actions">
          {city && <Link className="button" href={`/${city.slug}`}>{m.thanksBack(city.name)}</Link>}
          <Link href="/submit">{m.thanksAgain}</Link>
        </p>
      </div>
    </main>
  );
}
