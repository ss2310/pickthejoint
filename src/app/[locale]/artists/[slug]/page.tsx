import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { EntityPage, entityMetadata, type EntityKind } from "@/components/entity-page";
import { setLocale } from "@/lib/locale";
import { getArtist } from "@/lib/queries";
import { artistLd } from "@/lib/schema";

export const revalidate = 600;

const kind: EntityKind = { base: "artists", filter: (id) => ({ artistId: id }), ld: artistLd };
type Props = { params: Promise<{ locale: string; slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  setLocale(locale);
  const p = await getArtist(slug);
  return p ? entityMetadata(kind, p) : {};
}

export default async function ArtistPage({ params }: Props) {
  const { locale, slug } = await params;
  setLocale(locale);
  const p = await getArtist(slug);
  if (!p) notFound();
  return <EntityPage kind={kind} p={p} />;
}
