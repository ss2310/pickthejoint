import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { HubPage, hubMetadata } from "@/components/hub-page";
import { resolveHub } from "@/lib/hubs";
import { getCity, listAreas } from "@/lib/queries";

export const revalidate = 600;

type Props = { params: Promise<{ city: string; area: string }> };

async function load(params: Props["params"]) {
  const { city: citySlug, area: areaSlug } = await params;
  const city = await getCity(citySlug);
  if (!city) return null;
  const area = (await listAreas(city.id)).find((a) => a.slug === areaSlug);
  return area ? { city, hub: resolveHub(city, undefined, [], new Date(), area)! } : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = await load(params);
  return found ? hubMetadata(found.hub) : {};
}

export default async function AreaHub({ params }: Props) {
  const found = await load(params);
  if (!found) notFound();
  return <HubPage city={found.city} hub={found.hub} />;
}
