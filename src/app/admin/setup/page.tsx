import { admin } from "@/config";
import { setupOpen } from "@/lib/admin-auth";
import { setup } from "../auth-actions";

export const metadata = { title: "Set the admin password" };

/**
 * One-time setup. The token is pasted into the form (not carried in the
 * address), so characters such as + & # in it cannot be mangled and it never
 * lands in a log as part of a URL.
 */
export default async function SetupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const open = await setupOpen();
  return (
    <section className="form-card narrow">
      <h1>Set the admin password</h1>
      {!open.ok && <p className="banner banner-warn" role="alert">{open.reason}</p>}
      {open.ok && (
        <>
          <p>Paste the value of <code>ADMIN_SETUP_TOKEN</code> from the web service, then choose a long password ({admin.minPasswordLength} characters or more; a passphrase of four or five unrelated words works well). It is stored only as a scrypt hash. Afterwards, delete <code>ADMIN_SETUP_TOKEN</code> from the web service.</p>
          {error && <p className="banner banner-warn" role="alert">{error}</p>}
          <form action={setup} className="form-grid">
            <label className="field wide">Setup token
              <input type="password" name="token" autoComplete="off" required />
            </label>
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
