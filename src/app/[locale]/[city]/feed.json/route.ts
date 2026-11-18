import { jsonFeed } from "@/lib/feeds";
import { getCity, listEvents } from "@/lib/queries";

// Public JSON feed of a city's upcoming events.
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ city: string }> }): Promise<Response> {
  const city = await getCity((await params).city);
  if (!city) return new Response("Not found", { status: 404 });
  return Response.json(jsonFeed(city, await listEvents({ cityId: city.id })), {
    headers: { "Cache-Control": "public, max-age=600", "Access-Control-Allow-Origin": "*" },
  });
}
