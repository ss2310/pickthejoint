import { after } from "next/server";
import { inbound, parked } from "@/config";
import { getPool } from "@/lib/db";
import { handleInbound, verifyWebhook } from "@/lib/inbound-email";
import { AnthropicLlm } from "@/lib/pipeline/llm";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Resend's webhook for the poster email address (event: email.received).
 * The signature is checked against the raw body; the email itself is fetched
 * and read after the response, so Resend gets its 200 at once.
 */
export async function POST(req: Request): Promise<Response> {
  // Parked (see PARKED.md): acknowledged so the sender does not retry, but not read (reading a poster is a paid call).
  if (parked.on) return new Response("Parked: poster email is off");
  if (!inbound.webhookSecret) return new Response("Poster email is not set up", { status: 503 });
  const body = await req.text();
  const ok = verifyWebhook(inbound.webhookSecret, {
    id: req.headers.get("svix-id"), timestamp: req.headers.get("svix-timestamp"), signature: req.headers.get("svix-signature"),
  }, body);
  if (!ok) return new Response("Bad signature", { status: 401 });
  let payload: { type: string; data?: { email_id?: string; from?: string; subject?: string } };
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  after(async () => {
    try {
      const report = await handleInbound(getPool(), new AnthropicLlm(), payload);
      console.log(`[poster-email] ${JSON.stringify({ status: report.status, reason: report.reason, posters: report.posters })}`);
    } catch (err) {
      console.error(`[poster-email] failed: ${(err as Error).message}`);
    }
  });
  return new Response("ok");
}
