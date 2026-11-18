import type { Metadata } from "next";
import { longDay } from "@/lib/format";
import { pageLd } from "@/lib/schema";
import { Breadcrumbs, JsonLd } from "./ui";

export function pageMeta(title: string, description: string, path: string): Metadata {
  return { title, description, alternates: { canonical: path }, openGraph: { title, description, url: path } };
}

/** Frame for the plain-text pages: about, how we verify, corrections, changelog. */
export function Editorial({ title, path, updated, children }: { title: string; path: string; updated: string; children: React.ReactNode }) {
  return (
    <main className="prose">
      <Breadcrumbs trail={[{ name: "Pick the Joint", path: "/" }, { name: title, path }]} />
      <h1>{title}</h1>
      {children}
      <p className="muted small updated">Updated <time dateTime={updated}>{longDay(updated)}</time>.</p>
      <JsonLd data={pageLd(path, title, new Date(`${updated}T00:00:00+05:30`))} />
    </main>
  );
}
