import { calendar, icsResponse } from "@/lib/feeds";
import { getCity, listEvents } from "@/lib/queries";

// Public calendar feed of a city's upcoming events. Calendar apps can subscribe to this address.
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ city: string }> }): Promise<Response> {
  const city = await getCity((await params).city);
  if (!city) return new Response("Not found", { status: 404 });
  return icsResponse(calendar(await listEvents({ cityId: city.id }), `Events in ${city.name}`), `${city.slug}-events.ics`);
}
