import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { HubPage, hubMetadata } from "@/components/hub-page";
import { resolveHub } from "@/lib/hubs";
import { setLocale } from "@/lib/locale";
import { getCity, listCategories } from "@/lib/queries";

// City home. Rebuilt at most every 10 minutes, so new listings and the day rolling over show up without a deploy.
export const revalidate = 600;

type Props = { params: Promise<{ locale: string; city: string }> };

async function load(params: Props["params"]) {
  const p = await params;
  setLocale(p.locale);
  const city = await getCity(p.city);
  if (!city) return null;
  return { city, hub: resolveHub(city, undefined, await listCategories())! };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = await load(params);
  return found ? hubMetadata(found.hub) : {};
}

export default async function CityHome({ params }: Props) {
  const found = await load(params);
  if (!found) notFound();
  return <HubPage city={found.city} hub={found.hub} />;
}
