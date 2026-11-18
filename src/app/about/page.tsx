import Link from "next/link";
import { Editorial, pageMeta } from "@/components/editorial";
import { liveCities } from "@/lib/queries";

// Reads the city list, so it is rendered on request rather than at build time (the database is not reachable during builds).
export const dynamic = "force-dynamic";
export const metadata = pageMeta("About Pick the Joint",
  "Pick the Joint is an independent guide to events in Indian cities. Every listing shows its source and when it was last verified.", "/about");

export default async function About() {
  const cities = await liveCities();
  return (
    <Editorial title="About Pick the Joint" path="/about">
      <p className="lead">
        Pick the Joint is an independent guide to what is on in Indian cities: concerts, comedy, theatre, workshops, college and
        community events, festivals and more. It does not sell tickets and it does not take payment for listings.
      </p>
      <h2>What you will find here</h2>
      <ul>
        <li>A page for every event, with what it is, when and where it happens, what it costs and a link to the official booking page.</li>
        <li>A page for every venue, artist and organiser, listing their upcoming and past events.</li>
        <li>Daily, weekend and weekly listings, plus pages by category and by area.</li>
        <li>An archive: events are kept after they take place, never deleted.</li>
      </ul>
      <h2>Cities covered</h2>
      <ul>{cities.map((c) => <li key={c.slug}><Link href={`/${c.slug}`}>{c.name}, {c.state}</Link></li>)}</ul>
      <p>More cities will be added over time.</p>
      <h2>How listings are made</h2>
      <p>
        Listings are gathered from organisers&apos; and venues&apos; own public announcements and other named sources, and every event page links
        to the source it came from. The full process is described on <Link href="/how-we-verify">how we collect and verify events</Link>.
      </p>
      <h2>Corrections</h2>
      <p>If a listing is wrong, or you want one changed or removed, see <Link href="/corrections">corrections and takedown</Link>.</p>
    </Editorial>
  );
}
