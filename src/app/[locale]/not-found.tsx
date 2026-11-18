import { Hero, Link } from "@/components/ui";
import { messages } from "@/lib/locale";

export default function NotFound() {
  const m = messages().notFound;
  return (
    <main>
      <Hero trail={[{ name: "Pick the Joint", path: "/" }]} title={m.title} oneLanguage>
        <p className="lead">{m.lead}</p>
      </Hero>
      <div className="wrap page">
        <p><Link className="button" href="/">{m.button}</Link></p>
      </div>
    </main>
  );
}
