/**
 * The poster email address (Prompt 6, step 1c), through Resend's inbound
 * email. Resend calls our webhook with the event `email.received`; the
 * webhook carries only the email's ID and attachment names, so the images are
 * fetched from Resend's API. Only mail from the allowed senders, with SPF or
 * DKIM passing, is read: anything else is dropped without spending a cent.
 * Each image goes into the same inbox as the admin's poster uploads.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { alerts, inbound, site, submissions as cfg } from "../config";
import { cleanImage, inboxPosters, storePoster, UploadError, type InboxResult } from "./posters";
import type { LlmClient } from "./pipeline/llm";

/**
 * Checks a webhook signature (Resend signs with Svix): HMAC-SHA256 over
 * "{id}.{timestamp}.{raw body}" with the base64 key after "whsec_"; the header
 * holds one or more space-separated "v1,{base64}" values. Old timestamps are
 * refused so a captured request cannot be replayed.
 */
export function verifyWebhook(
  secret: string, h: { id: string | null; timestamp: string | null; signature: string | null }, body: string, now = Date.now(),
): boolean {
  if (!secret || !h.id || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 5 * 60) return false;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = createHmac("sha256", key).update(`${h.id}.${h.timestamp}.${body}`).digest();
  return h.signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const got = Buffer.from(sig, "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

interface ReceivedWebhook { type: string; data?: { email_id?: string; from?: string; subject?: string } }
interface ReceivedEmail { from?: string; subject?: string; authentication?: { spf?: string; dkim?: string; dmarc?: string } }
interface Attachment { id: string; filename?: string; content_type?: string; size?: number; download_url?: string }

export interface InboundReport { status: "ignored" | "duplicate" | "rejected" | "processed"; reason?: string; posters: number; results?: InboxResult[] }

/** The bare address in "Name <a@b.c>" or "a@b.c". */
export function bareAddress(from: string): string {
  return (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
}

export function allowedSenders(): string[] {
  return inbound.allowedSenders.length ? inbound.allowedSenders : site.contactEmail ? [site.contactEmail.toLowerCase()] : [];
}

export async function handleInbound(
  pool: Pool, llm: LlmClient, payload: ReceivedWebhook, deps: { fetchFn?: typeof fetch; apiKey?: string } = {},
): Promise<InboundReport> {
  const fetchFn = deps.fetchFn ?? fetch;
  const apiKey = deps.apiKey ?? alerts.resendApiKey;
  if (payload.type !== "email.received" || !payload.data?.email_id) return { status: "ignored", reason: `event ${payload.type}`, posters: 0 };
  const emailId = payload.data.email_id;
  const sender = bareAddress(payload.data.from ?? "");
  if (!allowedSenders().includes(sender)) {
    console.warn(`[poster-email] dropped mail from a sender not on the list`);
    return { status: "rejected", reason: "sender not allowed", posters: 0 };
  }
  // Webhooks are retried: each email is handled once.
  const fresh = await pool.query("INSERT INTO source_state (source_key, last_fetched_at, last_status) VALUES ($1, now(), 'received') ON CONFLICT DO NOTHING",
    [`resend-inbound:${emailId}`]);
  if (fresh.rowCount === 0) return { status: "duplicate", posters: 0 };
  if (!apiKey) return { status: "rejected", reason: "RESEND_API_KEY is not set on the web service", posters: 0 };

  const api = (path: string) => fetchFn(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000),
  });
  const emailRes = await api("");
  if (!emailRes.ok) return { status: "rejected", reason: `Resend returned ${emailRes.status} for the email`, posters: 0 };
  const email = (await emailRes.json()) as ReceivedEmail;
  const auth = email.authentication ?? {};
  if (auth.spf !== "pass" && auth.dkim !== "pass") return { status: "rejected", reason: "neither SPF nor DKIM passed", posters: 0 };

  const listRes = await api("/attachments?limit=100");
  if (!listRes.ok) return { status: "rejected", reason: `Resend returned ${listRes.status} for the attachments`, posters: 0 };
  const attachments = ((await listRes.json()) as { data?: Attachment[] }).data ?? [];
  const images = attachments.filter((a) => /^image\//i.test(a.content_type ?? "") && a.download_url && (a.size ?? 0) <= cfg.maxUploadBytes).slice(0, cfg.maxInboxFiles);
  const city = (await pool.query<{ id: number }>("SELECT id FROM cities WHERE slug = $1", [inbound.city])).rows[0];
  const ids: number[] = [];
  for (const a of images) {
    try {
      const res = await fetchFn(a.download_url!, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) continue;
      const image = await cleanImage(Buffer.from(await res.arrayBuffer()));
      ids.push(await storePoster({ channel: "email", cityId: city?.id ?? null, image, originalName: a.filename ?? null, note: email.subject ?? payload.data.subject ?? null, keepDays: cfg.keepDaysUnused }, pool));
    } catch (err) {
      if (!(err instanceof UploadError)) throw err;
      console.warn(`[poster-email] skipped an attachment: ${err.problem}`);
    }
  }
  const results = await inboxPosters(pool, llm, ids, "email", { jobName: "poster-email" });
  return { status: "processed", posters: ids.length, results };
}
