import type { NextRequest } from "next/server";
import { SESSION_COOKIE, sessionValid } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

/** A stored poster photo, for the signed-in admin only. Never cached, never indexed. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!(await sessionValid(req.cookies.get(SESSION_COOKIE)?.value))) return new Response("Not found", { status: 404 });
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return new Response("Not found", { status: 404 });
  const row = (await getPool().query<{ bytes: Buffer; media_type: string }>("SELECT bytes, media_type FROM poster_images WHERE id = $1", [id])).rows[0];
  if (!row) return new Response("Deleted or never stored", { status: 404 });
  return new Response(new Uint8Array(row.bytes), {
    headers: {
      "Content-Type": row.media_type, "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow",
      "Content-Disposition": `inline; filename="poster-${id}.jpg"`, "X-Content-Type-Options": "nosniff",
    },
  });
}
