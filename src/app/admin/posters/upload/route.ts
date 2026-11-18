import { after, type NextRequest } from "next/server";
import { submissions as cfg } from "@/config";
import { SESSION_COOKIE, sessionValid } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";
import { AnthropicLlm } from "@/lib/pipeline/llm";
import { cleanImage, inboxPosters, storePoster, UploadError } from "@/lib/posters";

export const dynamic = "force-dynamic";
// Reading a dozen posters takes a while; it runs after the response (see below).
export const maxDuration = 300;

// A relative Location: behind Cloudflare and Railway the request URL the server sees is not the public one.
const see = (_req: NextRequest, msg: string) =>
  new Response(null, { status: 303, headers: { Location: `/admin/posters?msg=${encodeURIComponent(msg)}` } });

/**
 * The admin's poster inbox: several photos at once (from WhatsApp or Telegram
 * groups). Each is cleaned and stored straight away; reading them with the
 * vision model happens after the response, so a big batch never times out at
 * Cloudflare. Each event found becomes a draft in review_queue.
 */
export async function POST(req: NextRequest): Promise<Response> {
  // The session cookie is SameSite=Strict, so a form on another site cannot post here signed in.
  if (!(await sessionValid(req.cookies.get(SESSION_COOKIE)?.value))) return new Response("Not found", { status: 404 });

  const form = await req.formData();
  const files = form.getAll("posters").filter((f): f is File => f instanceof File && f.size > 0).slice(0, cfg.maxInboxFiles);
  if (files.length === 0) return see(req, "Choose at least one photo.");
  const pool = getPool();
  const city = (await pool.query<{ id: number }>("SELECT id FROM cities WHERE slug = $1", [String(form.get("city") ?? "")])).rows[0];
  const note = String(form.get("note") ?? "").trim() || null;
  const ids: number[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    try {
      const image = await cleanImage(Buffer.from(await file.arrayBuffer()));
      ids.push(await storePoster({ channel: "admin", cityId: city?.id ?? null, image, originalName: file.name, note, keepDays: cfg.keepDaysUnused }, pool));
    } catch (err) {
      if (!(err instanceof UploadError)) throw err;
      skipped.push(`${file.name} (${err.problem})`);
    }
  }
  after(async () => {
    try {
      const results = await inboxPosters(pool, new AnthropicLlm(), ids, "admin", { jobName: "poster-inbox" });
      console.log(`[poster-inbox] ${JSON.stringify(results)}`);
    } catch (err) {
      console.error(`[poster-inbox] reading failed: ${(err as Error).message}`);
      const failed = await pool.query<{ id: number }>(
        "UPDATE poster_images SET extraction_state = 'failed', extraction_error = $2 WHERE id = ANY($1::bigint[]) AND extraction_state = 'pending' RETURNING id",
        [ids, (err as Error).message.slice(0, 300)]);
      for (const { id } of failed.rows) {
        await pool.query("INSERT INTO review_queue (item_type, item_id, reason, payload) VALUES ('poster', $1, 'poster could not be read', $2)",
          [id, { error: (err as Error).message.slice(0, 300) }]);
      }
    }
  });
  return see(req, `${ids.length} poster${ids.length === 1 ? "" : "s"} stored and being read; reload in a minute.${skipped.length ? ` Skipped: ${skipped.join(", ")}.` : ""}`);
}
