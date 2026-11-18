import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { EntityPage, entityMetadata, type EntityKind } from "@/components/entity-page";
import { getOrganiser } from "@/lib/queries";
import { organiserLd } from "@/lib/schema";

export const revalidate = 600;

const kind: EntityKind = { base: "organisers", label: "Organisers", filter: (id) => ({ organiserId: id }), ld: organiserLd };
type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = await getOrganiser((await params).slug);
  return p ? entityMetadata(kind, p) : {};
}

export default async function OrganiserPage({ params }: Props) {
  const p = await getOrganiser((await params).slug);
  if (!p) notFound();
  return <EntityPage kind={kind} p={p} />;
}
