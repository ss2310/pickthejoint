import { Editorial, pageMeta } from "@/components/editorial";
import { changelog } from "@/content/changelog";
import { longDay } from "@/lib/format";

export const metadata = pageMeta("Changelog", "A dated record of notable changes to Pick the Joint.", "/changelog");

export default function Changelog() {
  return (
    <Editorial title="Changelog" path="/changelog" updated={changelog[0].date}>
      <p className="lead">A dated record of notable changes to the site, newest first.</p>
      {changelog.map((c) => (
        <section key={`${c.date}-${c.title}`}>
          <h2>{c.title}</h2>
          <p className="muted small"><time dateTime={c.date}>{longDay(c.date)}</time></p>
          <p>{c.detail}</p>
        </section>
      ))}
    </Editorial>
  );
}
