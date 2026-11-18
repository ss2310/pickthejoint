/**
 * The single-admin login (Prompt 6). One account, the owner's:
 *   - the password is stored only as a scrypt hash (salted, parameters kept
 *     with the hash so they can be raised later);
 *   - a session is a random 256-bit cookie value, of which only a SHA-256 hash
 *     is stored; the cookie is HttpOnly, Secure in production and SameSite=Strict;
 *   - failed sign-ins are rate limited per address (security.ts);
 *   - the password is first set on /admin/setup, which needs ADMIN_SETUP_TOKEN
 *     and locks itself once an account exists.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { Pool } from "pg";
import { admin } from "../config";
import { getPool } from "./db";

export const SESSION_COOKIE = "ptj_admin";

const SCRYPT = { N: 32768, r: 8, p: 1, keyLen: 64 };

function scrypt(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password, salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p, keyLen } = SCRYPT;
  const key = await scrypt(password.normalize("NFKC"), salt, keyLen, { N, r, p, maxmem: 128 * N * r * 2 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const N = Number(n), R = Number(r), P = Number(p);
  const expected = Buffer.from(hash, "base64");
  const key = await scrypt(password.normalize("NFKC"), Buffer.from(salt, "base64"), expected.length, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Why a new password is not strong enough, or null if it is. */
export function passwordProblem(password: string): string | null {
  if (password.length < admin.minPasswordLength) return `Use at least ${admin.minPasswordLength} characters.`;
  if (password.length > 200) return "Use at most 200 characters.";
  if (new Set(password).size < 6) return "Use more different characters.";
  if (/^(.)\1+$/.test(password) || /^(?:password|pickthejoint|qwerty|123456)/i.test(password)) return "That password is too easy to guess.";
  return null;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** True when the two strings are equal, compared in constant time. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(sha256(a)), y = Buffer.from(sha256(b));
  return timingSafeEqual(x, y) && a.length > 0;
}

export async function accountExists(pool: Pool = getPool()): Promise<boolean> {
  return (await pool.query("SELECT 1 FROM admin_account WHERE id = 1")).rowCount === 1;
}

/** A pasted token or variable value, without the spaces and quotes that copying tends to add. */
export const cleanToken = (t: string | null | undefined) => (t ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();

/** Whether the setup page is open at all (before any token is checked), and why not. */
export async function setupOpen(pool: Pool = getPool()): Promise<{ ok: boolean; reason?: string }> {
  if (cleanToken(admin.setupToken).length < 24) return { ok: false, reason: "Setup is closed. ADMIN_SETUP_TOKEN (at least 24 characters) is not set on the web service." };
  if ((await accountExists(pool)) && !admin.allowReset) return { ok: false, reason: "The admin password is already set. Setup is locked." };
  return { ok: true };
}

/** Whether setup may go ahead with this token, and why not. */
export async function setupAllowed(token: string | null | undefined, pool: Pool = getPool()): Promise<{ ok: boolean; reason?: string }> {
  const open = await setupOpen(pool);
  if (!open.ok) return open;
  if (!cleanToken(token) || !sameSecret(cleanToken(token), cleanToken(admin.setupToken))) {
    return { ok: false, reason: "That setup token does not match ADMIN_SETUP_TOKEN on the web service." };
  }
  return { ok: true };
}

/** Sets (or, with ADMIN_RESET=on, replaces) the password and signs every session out. */
export async function setPassword(password: string, pool: Pool = getPool()): Promise<void> {
  const hash = await hashPassword(password);
  await pool.query(
    `INSERT INTO admin_account (id, password_hash) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`, [hash]);
  await pool.query("DELETE FROM admin_sessions");
}

export async function checkLogin(password: string, pool: Pool = getPool()): Promise<boolean> {
  const { rows } = await pool.query<{ password_hash: string }>("SELECT password_hash FROM admin_account WHERE id = 1");
  if (!rows[0]) {
    // Spend the same time as a real check so the response does not reveal whether an account exists.
    await hashPassword(password);
    return false;
  }
  return verifyPassword(password, rows[0].password_hash);
}

/** Starts a session and returns the cookie value. */
export async function createSession(pool: Pool = getPool()): Promise<{ token: string; expires: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + admin.sessionHours * 3_600_000);
  await pool.query("INSERT INTO admin_sessions (token_hash, expires_at) VALUES ($1, $2)", [sha256(token), expires]);
  await pool.query("DELETE FROM admin_sessions WHERE expires_at < now()");
  return { token, expires };
}

export async function sessionValid(token: string | undefined, pool: Pool = getPool()): Promise<boolean> {
  if (!token || token.length > 100) return false;
  const { rowCount } = await pool.query(
    "UPDATE admin_sessions SET last_seen_at = now() WHERE token_hash = $1 AND expires_at > now()", [sha256(token)]);
  return rowCount === 1;
}

export async function endSession(token: string | undefined, pool: Pool = getPool()): Promise<void> {
  if (token) await pool.query("DELETE FROM admin_sessions WHERE token_hash = $1", [sha256(token)]);
}
