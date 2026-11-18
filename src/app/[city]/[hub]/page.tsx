import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { HubPage, hubMetadata } from "@/components/hub-page";
import { resolveHub } from "@/lib/hubs";
import { getCity, listCategories } from "@/lib/queries";

// /{city}/today, /this-weekend, /this-week, /past and /{city}/{category}.
export const revalidate = 600;

type Props = { params: Promise<{ city: string; hub: string }> };

async function load(params: Props["params"]) {
  const { city: citySlug, hub: segment } = await params;
  const city = await getCity(citySlug);
  if (!city) return null;
  const hub = resolveHub(city, segment, await listCategories());
  return hub ? { city, hub } : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = await load(params);
  return found ? hubMetadata(found.hub) : {};
}

export default async function Hub({ params }: Props) {
  const found = await load(params);
  if (!found) notFound();
  return <HubPage city={found.city} hub={found.hub} />;
}
