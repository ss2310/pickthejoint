import Link from "next/link";
import { Editorial, pageMeta } from "@/components/editorial";

export const metadata = pageMeta("How we collect and verify events",
  "Where Pick the Joint's event listings come from, how facts are checked before publishing, and what the last-verified date means.", "/how-we-verify");

export default function HowWeVerify() {
  return (
    <Editorial title="How we collect and verify events" path="/how-we-verify">
      <p className="lead">
        Every listing on Pick the Joint comes from a named public source, and an event is published only when its title, date and
        venue could be established with confidence. Anything uncertain is held for a person to review instead.
      </p>
      <h2>Where listings come from</h2>
      <ul>
        <li>Public announcements by venues, organisers and artists on their own Instagram accounts, from a list of accounts we maintain for each city.</li>
        <li>Event announcements published by local news outlets.</li>
        <li>Details sent to us by organisers.</li>
      </ul>
      <p>The source of each event is linked on its page under &ldquo;Source&rdquo;. Where more than one source confirms an event, all are listed.</p>
      <h2>How facts are checked</h2>
      <ol>
        <li>Each announcement is read, including the poster image, and the facts are extracted: title, date and time, venue, price, booking link, performers and organiser.</li>
        <li>A fact is recorded only if the source states it. Missing details are left blank; they are never filled in by guesswork.</li>
        <li>If the title, the date or the venue is unclear, the event is not published. It goes to a review queue.</li>
        <li>Two announcements about the same event are merged into one listing, with both sources attached.</li>
        <li>When an organiser announces a cancellation, postponement or change, the listing is updated and marked.</li>
      </ol>
      <p>Reading and extraction are done with automated tools, including AI models. Descriptions are written in our own words from the extracted facts.</p>
      <h2>What &ldquo;last verified&rdquo; means</h2>
      <p>
        The &ldquo;last verified&rdquo; date on an event page is the most recent time the listing was checked against a source. Plans change:
        always confirm on the official booking or organiser page before travelling.
      </p>
      <h2>What we do not do</h2>
      <ul>
        <li>We do not sell tickets. Booking links go to the official page.</li>
        <li>We do not copy posters, photos or captions. We link to the original post.</li>
        <li>Pages about people list professional, public facts only.</li>
      </ul>
      <p>Found a mistake? See <Link href="/corrections">corrections and takedown</Link>.</p>
    </Editorial>
  );
}
