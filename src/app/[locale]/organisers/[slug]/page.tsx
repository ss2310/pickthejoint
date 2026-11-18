import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { EntityPage, entityMetadata, type EntityKind } from "@/components/entity-page";
import { setLocale } from "@/lib/locale";
import { getOrganiser } from "@/lib/queries";
import { organiserLd } from "@/lib/schema";

export const revalidate = 600;

const kind: EntityKind = { base: "organisers", filter: (id) => ({ organiserId: id }), ld: organiserLd };
type Props = { params: Promise<{ locale: string; slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  setLocale(locale);
  const p = await getOrganiser(slug);
  return p ? entityMetadata(kind, p) : {};
}

export default async function OrganiserPage({ params }: Props) {
  const { locale, slug } = await params;
  setLocale(locale);
  const p = await getOrganiser(slug);
  if (!p) notFound();
  return <EntityPage kind={kind} p={p} />;
}
