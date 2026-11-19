import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { RoundupArticle, guidePath } from "@/components/roundup-article";
import { getPool } from "@/lib/db";
import { alternates, getLocale, localePath, setLocale } from "@/lib/locale";
import { getRoundup, roundupEvents } from "@/lib/roundups";

// A published guide changes only when an event in it changes; rebuilt at most every 10 minutes.
export const revalidate = 600;

type Props = { params: Promise<{ locale: string; city: string; week: string }> };

async function load(params: Props["params"]) {
  const p = await params;
  setLocale(p.locale);
  return getRoundup(getPool(), p.city, p.week, getLocale());
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const r = await load(params);
  if (!r) return {};
  const path = guidePath(r.city_slug, r.slug);
  const description = r.intro.length > 300 ? `${r.intro.slice(0, 297).replace(/\s+\S*$/, "")}…` : r.intro;
  return {
    title: r.title, description, alternates: alternates(path),
    openGraph: { title: r.title, description, url: localePath(path), type: "article", publishedTime: r.published_at?.toISOString() },
  };
}

export default async function GuidePage({ params }: Props) {
  const r = await load(params);
  if (!r) notFound();
  return <RoundupArticle r={r} events={await roundupEvents(r, getLocale())} />;
}
