import type { Metadata } from "next";
import { site } from "@/config";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: site.name, template: `%s | ${site.name}` },
  description: "What's on in Indian cities: concerts, comedy, theatre, workshops and more, with sources and verification dates.",
  verification: { other: { "msvalidate.01": "71ACA715D63E96E43398544061E40E64" } },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IN">
      <body>{children}</body>
    </html>
  );
}
