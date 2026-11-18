import Link from "next/link";
import { redirect } from "next/navigation";
import { accountExists } from "@/lib/admin-auth";
import { isAdmin } from "@/lib/admin-session";
import { login } from "../auth-actions";

export const metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  wrong: "That password is not right.",
  locked: "Too many failed attempts. Wait 15 minutes and try again.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await isAdmin()) redirect("/admin");
  const error = (await searchParams).error;
  const exists = await accountExists();
  return (
    <section className="form-card narrow">
      <h1>Sign in</h1>
      {!exists && <p className="banner banner-warn">No admin password has been set yet. Set it once at <Link href="/admin/setup">/admin/setup</Link> with ADMIN_SETUP_TOKEN (see docs/HANDOFF.md).</p>}
      {error && <p className="banner banner-warn" role="alert">{ERRORS[error] ?? "Could not sign in."}</p>}
      <form action={login} className="form-grid">
        <label className="field wide">Password
          <input type="password" name="password" autoComplete="current-password" required autoFocus />
        </label>
        <p className="wide"><button type="submit" className="button">Sign in</button></p>
      </form>
    </section>
  );
}
