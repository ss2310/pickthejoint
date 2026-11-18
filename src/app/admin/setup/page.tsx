import { admin } from "@/config";
import { setupAllowed } from "@/lib/admin-auth";
import { setup } from "../auth-actions";

export const metadata = { title: "Set the admin password" };

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const { token, error } = await searchParams;
  const allowed = await setupAllowed(token);
  return (
    <section className="form-card narrow">
      <h1>Set the admin password</h1>
      {!allowed.ok && <p className="banner banner-warn" role="alert">{allowed.reason}</p>}
      {allowed.ok && (
        <>
          <p>Choose a long password ({admin.minPasswordLength} characters or more; a passphrase of four or five unrelated words works well). It is stored only as a scrypt hash. After this, remove <code>ADMIN_SETUP_TOKEN</code> from the web service.</p>
          {error && <p className="banner banner-warn" role="alert">{error}</p>}
          <form action={setup} className="form-grid">
            <input type="hidden" name="token" value={token} />
            <label className="field wide">New password
              <input type="password" name="password" autoComplete="new-password" minLength={admin.minPasswordLength} required />
            </label>
            <label className="field wide">The same password again
              <input type="password" name="confirm" autoComplete="new-password" minLength={admin.minPasswordLength} required />
            </label>
            <p className="wide"><button type="submit" className="button">Set password and sign in</button></p>
          </form>
        </>
      )}
    </section>
  );
}
