import type { Metadata, Viewport } from "next";
import PlainLink from "next/link";
import { notFound } from "next/navigation";
import { JsonLd, Link } from "@/components/ui";
import { parking, site } from "@/config";
import { LANG_TAG, isLocale, messages, setLocale } from "@/lib/locale";
import { siteLd } from "@/lib/schema";
import "../globals.css";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = setLocale((await params).locale);
  return {
    metadataBase: new URL(site.url),
    title: { default: site.name, template: `%s | ${site.name}` },
    description: messages(locale).site.description,
    verification: { other: { "msvalidate.01": "71ACA715D63E96E43398544061E40E64" } },
    openGraph: { siteName: site.name, locale: LANG_TAG[locale].replace("-", "_"), type: "website" },
  };
}

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children, params }: Readonly<{ children: React.ReactNode }> & Props) {
  const raw = (await params).locale;
  if (!isLocale(raw)) notFound();
  const locale = setLocale(raw);
  const m = messages(locale).site;
  return (
    <html lang={LANG_TAG[locale]}>
      <body>
        <a className="skip" href="#content">{m.skip}</a>
        <header className="site-header">
          <div className="wrap">
            <Link href="/" className="brand"><span className="mark" aria-hidden="true" />{site.name}</Link>
            {/* The editorial pages are in English only for now, so these links are plain paths in both languages. */}
            <nav aria-label={m.navLabel}>
              <PlainLink href="/about">{m.navAbout}</PlainLink>
              <PlainLink href="/how-we-verify">{m.navVerify}</PlainLink>
              <Link href="/submit">{messages(locale).submit.nav}</Link>
            </nav>
          </div>
        </header>
        {/* Parked (PARKED.md): one plain line on every page, in the page's language. */}
        {parking.on && <p className="paused-notice" role="status"><span className="wrap">{m.paused(site.name)}</span></p>}
        <div id="content">{children}</div>
        <footer className="site-footer">
          <div className="wrap">
            <Link href="/" className="brand"><span className="mark" aria-hidden="true" />{site.name}</Link>
            <p>{m.footer(site.name)}</p>
            <nav aria-label={m.footerLabel}>
              <PlainLink href="/about">{m.navAbout}</PlainLink>
              <PlainLink href="/how-we-verify">{m.footerVerify}</PlainLink>
              <PlainLink href="/corrections">{m.footerCorrections}</PlainLink>
              <PlainLink href="/changelog">{m.footerChangelog}</PlainLink>
              <Link href="/ai-citations">{m.footerCitations}</Link>
              <Link href="/submit">{messages(locale).submit.nav}</Link>
            </nav>
          </div>
        </footer>
        <JsonLd data={siteLd()} />
      </body>
    </html>
  );
}
