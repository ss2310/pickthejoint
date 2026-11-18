import type { Metadata } from "next";
import { Breadcrumbs } from "./ui";

export function pageMeta(title: string, description: string, path: string): Metadata {
  return { title, description, alternates: { canonical: path }, openGraph: { title, description, url: path } };
}

/** Frame for the plain-text pages: about, how we verify, corrections, changelog. */
export function Editorial({ title, path, children }: { title: string; path: string; children: React.ReactNode }) {
  return (
    <main className="prose">
      <Breadcrumbs trail={[{ name: "Pick the Joint", path: "/" }, { name: title, path }]} />
      <h1>{title}</h1>
      {children}
    </main>
  );
}
