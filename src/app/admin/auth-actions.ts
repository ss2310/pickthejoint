"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { submissions as cfg } from "@/config";
import { checkLogin, passwordProblem, setPassword, setupAllowed } from "@/lib/admin-auth";
import { startSession, stopSession } from "@/lib/admin-session";
import { clientIp, ipHash, rateCount, rateHit } from "@/lib/security";

const ALL_ADDRESSES = { max: 50, windowMinutes: 15 };

export async function login(form: FormData): Promise<void> {
  const who = ipHash(clientIp(await headers()));
  const key = `login:${who}`;
  // Failed attempts are counted per address and across all addresses.
  if ((await rateCount(key, cfg.limits.login)) >= cfg.limits.login.max || (await rateCount("login:all", ALL_ADDRESSES)) >= ALL_ADDRESSES.max) {
    redirect("/admin/login?error=locked");
  }
  const password = String(form.get("password") ?? "");
  if (!password || !(await checkLogin(password))) {
    await rateHit(key);
    await rateHit("login:all");
    redirect("/admin/login?error=wrong");
  }
  await startSession();
  redirect("/admin");
}

export async function logout(): Promise<void> {
  await stopSession();
  redirect("/admin/login");
}

export async function setup(form: FormData): Promise<void> {
  const token = String(form.get("token") ?? "");
  // The token is never put back into an address.
  const back = (error: string): never => redirect(`/admin/setup?error=${encodeURIComponent(error)}`);
  const who = ipHash(clientIp(await headers()));
  if ((await rateCount(`setup:${who}`, cfg.limits.login)) >= cfg.limits.login.max) back("Too many attempts. Wait 15 minutes.");
  const allowed = await setupAllowed(token);
  if (!allowed.ok) {
    await rateHit(`setup:${who}`);
    back(allowed.reason!);
  }
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? "")) back("The two passwords do not match.");
  const problem = passwordProblem(password);
  if (problem) back(problem);
  await setPassword(password);
  await startSession();
  redirect("/admin?setup=done");
}
