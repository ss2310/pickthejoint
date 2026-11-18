import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getPool } from "@/lib/db";

// Placeholder city home (Prompt 1). Server-rendered; real hub content arrives in Prompt 3.
export const dynamic = "force-dynamic";

interface City { id: number; slug: string; name: string; state: string }

async function getCity(slug: string): Promise<City | null> {
  const { rows } = await getPool().query<City>(
    "SELECT id, slug, name, state FROM cities WHERE slug = $1 AND is_live",
    [slug.toLowerCase()],
  );
  return rows[0] ?? null;
}

export async function generateMetadata({ params }: { params: Promise<{ city: string }> }): Promise<Metadata> {
  const city = await getCity((await params).city);
  if (!city) return {};
  return {
    title: `Events in ${city.name}`,
    description: `Concerts, comedy, theatre, workshops and more happening in ${city.name}. Coming soon.`,
    robots: { index: false, follow: true }, // placeholder: keep out of the index until real content exists
  };
}

export default async function CityHome({ params }: { params: Promise<{ city: string }> }) {
  const city = await getCity((await params).city);
  if (!city) notFound();
  return (
    <main>
      <h1>Events in {city.name}</h1>
      <p>
        Pick the Joint is building a complete, verified guide to what&apos;s on in {city.name}, {city.state}:
        gigs, comedy, theatre, workshops, college and community events, with the source and a
        &ldquo;last verified&rdquo; date on every listing.
      </p>
      <p className="muted">Listings are coming soon.</p>
    </main>
  );
}
