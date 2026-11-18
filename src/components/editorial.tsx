import type { Metadata } from "next";
import { longDay } from "@/lib/format";
import { pageLd } from "@/lib/schema";
import { Hero, JsonLd } from "./ui";

export function pageMeta(title: string, description: string, path: string): Metadata {
  return { title, description, alternates: { canonical: path }, openGraph: { title, description, url: path } };
}

/** Frame for the plain-text pages: about, how we verify, corrections, changelog. */
export function Editorial({ title, path, updated, children }: { title: string; path: string; updated: string; children: React.ReactNode }) {
  return (
    <main>
      <Hero trail={[{ name: "Pick the Joint", path: "/" }, { name: title, path }]} title={title} />
      <div className="wrap page">
        <div className="prose">
          {children}
          <p className="muted small updated">Updated <time dateTime={updated}>{longDay(updated)}</time>.</p>
        </div>
      </div>
      <JsonLd data={pageLd(path, title, new Date(`${updated}T00:00:00+05:30`))} />
    </main>
  );
}
