import { calendar, icsResponse } from "@/lib/feeds";
import { isLocale, localePath } from "@/lib/locale";
import { getEvent, movedEventSlug } from "@/lib/queries";
import { eventPath } from "@/lib/schema";

// "Add to calendar": one event as an .ics file that any calendar app can open.
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ locale: string; city: string; slug: string }> }): Promise<Response> {
  const { locale, city, slug } = await params;
  const e = await getEvent(city, slug);
  if (!e) {
    // The event's address changed when its title or date was corrected: send the old calendar link on.
    const moved = await movedEventSlug(city, slug);
    if (!moved) return new Response("Not found", { status: 404 });
    const path = `${eventPath({ city_slug: city.toLowerCase(), slug: moved })}/calendar.ics`;
    return new Response(null, { status: 308, headers: { Location: localePath(path, isLocale(locale) ? locale : "en") } });
  }
  return icsResponse(calendar([e], e.title), `${e.slug}.ics`);
}
