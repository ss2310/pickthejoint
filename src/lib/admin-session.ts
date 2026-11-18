/** Next.js glue for the admin login: read and set the session cookie, guard pages and actions. */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { admin } from "../config";
import { SESSION_COOKIE, createSession, endSession, sessionValid } from "./admin-auth";

export async function isAdmin(): Promise<boolean> {
  return sessionValid((await cookies()).get(SESSION_COOKIE)?.value);
}

/** Every admin page and action starts with this. */
export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) redirect("/admin/login");
}

export async function startSession(): Promise<void> {
  const { token, expires } = await createSession();
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", expires,
  });
}

export async function stopSession(): Promise<void> {
  const jar = await cookies();
  await endSession(jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
}

export const sessionHours = admin.sessionHours;
