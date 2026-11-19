import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { site } from "@/config";
import { isAdmin } from "@/lib/admin-session";
import { logout } from "./auth-actions";
import "../globals.css";

// Private, English only, never indexed, never cached.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: `Admin | ${site.name}`, template: `%s | Admin | ${site.name}` },
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const signedIn = await isAdmin();
  return (
    <html lang="en-IN">
      <body className="admin">
        <header className="admin-bar">
          <div className="wrap">
            <Link href="/admin" className="brand"><span className="mark" aria-hidden="true" />{site.name} admin</Link>
            {signedIn && (
              <nav aria-label="Admin">
                <Link href="/admin">Overview</Link>
                <Link href="/admin/queue">Review queue</Link>
                <Link href="/admin/posters">Poster inbox</Link>
                <Link href="/admin/handles">Handles</Link>
                <Link href="/admin/venues">Venues</Link>
                <Link href="/admin/artists">Artists</Link>
                <Link href="/admin/coverage">Coverage</Link>
                <Link href="/admin/outreach">Outreach</Link>
                <Link href="/admin/events">Events</Link>
                <Link href="/admin/roundups">Weekly guides</Link>
                <Link href="/admin/search">Search</Link>
                <Link href="/admin/citations">AI citations</Link>
                <form action={logout}><button type="submit" className="linkish">Sign out</button></form>
              </nav>
            )}
          </div>
        </header>
        <main className="wrap admin-main">{children}</main>
      </body>
    </html>
  );
}
