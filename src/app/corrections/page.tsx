import Link from "next/link";
import { Editorial, pageMeta } from "@/components/editorial";
import { site } from "@/config";

// Rendered on request, so the contact address always reflects the current CONTACT_EMAIL setting.
export const dynamic = "force-dynamic";
export const metadata = pageMeta("Corrections and takedown",
  "How to report a wrong listing on Pick the Joint, or ask for an event, venue or profile page to be changed or removed.", "/corrections");

export default function Corrections() {
  const email = site.contactEmail;
  return (
    <Editorial title="Corrections and takedown" path="/corrections">
      <p className="lead">
        If a listing is wrong, out of date, or about you or your event and you want it changed or removed, tell us and we will act on it.
      </p>
      <h2>How to reach us</h2>
      {email
        ? <p>Email <a href={`mailto:${email}`}>{email}</a>.</p>
        : <p>A contact address for corrections is being set up and will be published on this page.</p>}
      <h2>What to include</h2>
      <ul>
        <li>The address of the page on Pick the Joint.</li>
        <li>What is wrong and what the correct information is, with a link to an official source if you have one.</li>
        <li>For a removal request: your connection to the event, venue or person.</li>
      </ul>
      <h2>What happens next</h2>
      <ul>
        <li>Corrections to facts (date, time, venue, price, cancellation) are made as soon as they are confirmed against a source.</li>
        <li>Organisers, venues and artists can ask for their own listing or profile to be removed. Removals are recorded with the reason.</li>
        <li>The public <Link href="/changelog">changelog</Link> records notable changes to the site.</li>
      </ul>
    </Editorial>
  );
}
