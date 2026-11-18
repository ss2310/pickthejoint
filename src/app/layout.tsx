import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, DM_Sans } from "next/font/google";
import Link from "next/link";
import { JsonLd } from "@/components/ui";
import { site } from "@/config";
import { siteLd } from "@/lib/schema";
import "./globals.css";

// Fonts are downloaded at build time and served from our own site: no request to Google from a visitor's browser.
const display = Bricolage_Grotesque({ subsets: ["latin"], weight: ["600", "700", "800"], variable: "--font-display", display: "swap" });
const body = DM_Sans({ subsets: ["latin"], variable: "--font-body", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: site.name, template: `%s | ${site.name}` },
  description: "What's on in Indian cities: concerts, comedy, theatre, workshops and more, with sources and verification dates.",
  verification: { other: { "msvalidate.01": "71ACA715D63E96E43398544061E40E64" } },
  openGraph: { siteName: site.name, locale: "en_IN", type: "website" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IN" className={`${display.variable} ${body.variable}`}>
      <body>
        <a className="skip" href="#content">Skip to content</a>
        <header className="site-header">
          <div className="wrap">
            <Link href="/" className="brand"><span className="mark" aria-hidden="true" />{site.name}</Link>
            <nav aria-label="Site">
              <Link href="/about">About</Link>
              <Link href="/how-we-verify">How we verify</Link>
            </nav>
          </div>
        </header>
        <div id="content">{children}</div>
        <footer className="site-footer">
          <div className="wrap">
            <Link href="/" className="brand"><span className="mark" aria-hidden="true" />{site.name}</Link>
            <p>{site.name} lists events from named public sources and links to the official booking page. It does not sell tickets.</p>
            <nav aria-label="Footer">
              <Link href="/about">About</Link>
              <Link href="/how-we-verify">How we collect and verify events</Link>
              <Link href="/corrections">Corrections and takedown</Link>
              <Link href="/changelog">Changelog</Link>
            </nav>
          </div>
        </footer>
        <JsonLd data={siteLd()} />
      </body>
    </html>
  );
}
