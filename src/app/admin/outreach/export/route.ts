import type { NextRequest } from "next/server";
import { SESSION_COOKIE, sessionValid } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";
import { outreachCsv, outreachList } from "@/lib/outreach";

export const dynamic = "force-dynamic";

/** The outreach list as CSV, for the signed-in admin only. */
export async function GET(req: NextRequest): Promise<Response> {
  if (!(await sessionValid(req.cookies.get(SESSION_COOKIE)?.value))) return new Response("Not found", { status: 404 });
  const csv = outreachCsv(await outreachList(getPool()));
  const day = new Date().toISOString().slice(0, 10);
  return new Response(`﻿${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="pickthejoint-outreach-${day}.csv"`,
      "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
