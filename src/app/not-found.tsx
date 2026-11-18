import Link from "next/link";
import { Hero } from "@/components/ui";

export default function NotFound() {
  return (
    <main>
      <Hero trail={[{ name: "Pick the Joint", path: "/" }]} title="This page is not here">
        <p className="lead">The page may have moved, or the address may be mistyped.</p>
      </Hero>
      <div className="wrap page">
        <p><Link className="button" href="/">See what is on</Link></p>
      </div>
    </main>
  );
}
