import { ImageResponse } from "next/og";
import { site } from "@/config";
import { clock, longDate } from "@/lib/format";
import { getEvent } from "@/lib/queries";
import { EVENT_IMAGE_SHAPES, type EventImageShape } from "@/lib/schema";

/**
 * Our own image for an event: a plain card with the title, date, venue and
 * city in the site's style. Posters are never rehosted (hard rule 4), so this
 * is what structured data and link previews use. Served at 1:1, 4:3 and 16:9.
 */
export const dynamic = "force-dynamic";

const PAPER = "#fffdf8";
const INK = "#1d1b18";
const MUTED = "#645e55";
const ACCENT = "#b43a0a";

export async function GET(_req: Request, { params }: { params: Promise<{ city: string; slug: string; shape: string }> }): Promise<Response> {
  const { city, slug, shape } = await params;
  const size = EVENT_IMAGE_SHAPES[shape as EventImageShape];
  const e = size ? await getEvent(city, slug) : null;
  if (!e || !size) return new Response("Not found", { status: 404 });

  const [width, height] = size;
  const when = `${longDate(e.starts_at, e.timezone)}${e.start_time_known ? `, ${clock(e.starts_at, e.timezone)}` : ""}`;
  const where = [e.venue_name, e.area_name, e.city_name].filter(Boolean).join(", ");
  const titleSize = e.title.length > 70 ? 56 : e.title.length > 40 ? 68 : 84;
  const status = e.status === "cancelled" ? "CANCELLED" : e.status === "postponed" ? "POSTPONED" : null;

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: PAPER, color: INK, padding: 72, borderTop: `20px solid ${INK}` }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 30, fontWeight: 700, letterSpacing: 3, color: ACCENT, textTransform: "uppercase" }}>
            {status ?? e.category_name ?? "Event"}
          </div>
          <div style={{ display: "flex", marginTop: 24, fontSize: titleSize, fontWeight: 800, lineHeight: 1.1, letterSpacing: -1 }}>{e.title}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 40, fontWeight: 700, borderTop: `3px solid ${INK}`, paddingTop: 28 }}>{when}</div>
          <div style={{ display: "flex", marginTop: 12, fontSize: 34, color: MUTED }}>{where}</div>
          <div style={{ display: "flex", marginTop: 40, fontSize: 28, fontWeight: 800 }}>{site.name}</div>
        </div>
      </div>
    ),
    { width, height, headers: { "Cache-Control": "public, max-age=3600, s-maxage=3600" } },
  );
}
