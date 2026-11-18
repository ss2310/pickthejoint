/**
 * Abuse protection for the public forms and the admin sign-in: a hashed
 * client address, per-address rate limits kept in Postgres, and Cloudflare
 * Turnstile verification. No raw IP address is ever stored.
 */
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { submissions } from "../config";
import { getPool } from "./db";

type HeaderSource = { get(name: string): string | null };

/**
 * The visitor's address. Behind Cloudflare the real address is in
 * CF-Connecting-IP; on the bare Railway address it is the first entry of
 * X-Forwarded-For. Either can be forged by a client that skips Cloudflare,
 * which is why the forms also need Turnstile.
 */
export function clientIp(headers: HeaderSource): string {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff) return xff;
  return headers.get("x-real-ip")?.trim() || "unknown";
}

/** A one-way hash of the address, salted so the stored value cannot be matched against a list of addresses. */
export function ipHash(ip: string): string {
  const salt = process.env.IP_HASH_SALT || submissions.turnstileSecret || "pick-the-joint";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

export interface RateLimit { max: number; windowMinutes: number }

/** Hits recorded for a key within its window. */
export async function rateCount(key: string, limit: RateLimit, pool: Pool = getPool()): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM rate_hits WHERE key = $1 AND hit_at > now() - make_interval(mins => $2)",
    [key, limit.windowMinutes],
  );
  return Number(rows[0].n);
}

export async function rateHit(key: string, pool: Pool = getPool()): Promise<void> {
  await pool.query("INSERT INTO rate_hits (key) VALUES ($1)", [key]);
}

/** Records a hit and says whether the key is still within every limit given. */
export async function rateAllow(key: string, limits: RateLimit[], pool: Pool = getPool()): Promise<boolean> {
  for (const l of limits) {
    if ((await rateCount(key, l, pool)) >= l.max) return false;
  }
  await rateHit(key, pool);
  return true;
}

export interface TurnstileResult { ok: boolean; reason?: string }

/**
 * Checks a Turnstile token with Cloudflare. Without a secret key the check is
 * skipped outside production (local work, tests) and fails in production, so
 * a missing setting can never leave the live forms open.
 */
export async function verifyTurnstile(token: string | null | undefined, ip: string, fetchFn: typeof fetch = fetch): Promise<TurnstileResult> {
  const secret = submissions.turnstileSecret;
  if (!secret) {
    return process.env.NODE_ENV === "production" ? { ok: false, reason: "turnstile not configured" } : { ok: true, reason: "skipped (no secret, not production)" };
  }
  if (!token) return { ok: false, reason: "no token" };
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip && ip !== "unknown") body.set("remoteip", ip);
    const res = await fetchFn("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", body, signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    return data.success ? { ok: true } : { ok: false, reason: (data["error-codes"] ?? []).join(",") || "rejected" };
  } catch (err) {
    return { ok: false, reason: `could not reach Turnstile: ${(err as Error).message}` };
  }
}
