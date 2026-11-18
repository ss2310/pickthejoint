import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { EntityPage, entityMetadata, type EntityKind } from "@/components/entity-page";
import { getArtist } from "@/lib/queries";
import { artistLd } from "@/lib/schema";

export const revalidate = 600;

const kind: EntityKind = { base: "artists", label: "Artists", filter: (id) => ({ artistId: id }), ld: artistLd };
type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = await getArtist((await params).slug);
  return p ? entityMetadata(kind, p) : {};
}

export default async function ArtistPage({ params }: Props) {
  const p = await getArtist((await params).slug);
  if (!p) notFound();
  return <EntityPage kind={kind} p={p} />;
}
