import { calendar, icsResponse } from "@/lib/feeds";
import { getEvent } from "@/lib/queries";

// "Add to calendar": one event as an .ics file that any calendar app can open.
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ city: string; slug: string }> }): Promise<Response> {
  const { city, slug } = await params;
  const e = await getEvent(city, slug);
  if (!e) return new Response("Not found", { status: 404 });
  return icsResponse(calendar([e], e.title), `${e.slug}.ics`);
}
