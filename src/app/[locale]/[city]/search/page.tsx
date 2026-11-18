import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { AskBox, EventList, Hero } from "@/components/ui";
import { isoDay, longDay } from "@/lib/format";
import { categoryName } from "@/lib/hubs";
import { alternates, getLocale, localePath, messages, setLocale } from "@/lib/locale";
import { AnthropicLlm } from "@/lib/pipeline/llm";
import { getCity, listAreas, listCategories, listEvents } from "@/lib/queries";
import { naturalSearch, type SearchOutcome } from "@/lib/search";
import { clientIp, ipHash } from "@/lib/security";
import { crawlerToken } from "@/middleware";
import type { Understood } from "@/locales/en";

// Search. The filters live in the URL, so a result page can be shared or bookmarked; both forms are ordinary GET
// forms and need no JavaScript. `q` is a search in plain words (Prompt 7): it is read into the same filters.
export const dynamic = "force-dynamic";

type Search = { q?: string; from?: string; to?: string; category?: string; area?: string; price?: string };
type Props = { params: Promise<{ locale: string; city: string }>; searchParams: Promise<Search> };

const isDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const one = (v: unknown): string | undefined => (typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined);

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const p = await params;
  setLocale(p.locale);
  const city = await getCity(p.city);
  if (!city) return {};
  const m = messages().search;
  const filtered = Object.values(await searchParams).some(Boolean);
  return {
    title: m.title(city.name),
    description: m.description(city.name),
    alternates: alternates(`/${city.slug}/search`),
    // Filter combinations and searches are endless; only the bare search page is indexed.
    robots: filtered ? { index: false, follow: true } : undefined,
  };
}

export default async function SearchPage({ params, searchParams }: Props) {
  const p = await params;
  setLocale(p.locale);
  const city = await getCity(p.city);
  if (!city) notFound();
  const m = messages().search;
  const q = await searchParams;
  const [categories, areas] = await Promise.all([listCategories(), listAreas(city.id)]);
  const path = `/${city.slug}/search`;
  const today = isoDay(new Date(), city.timezone);
  const query = (one(q.q) ?? "").trim();

  let outcome: SearchOutcome | null = null;
  if (query) {
    const h = await headers();
    outcome = await naturalSearch(new AnthropicLlm(), {
      query, city, locale: getLocale(), who: ipHash(clientIp(h)), allowModel: !crawlerToken(h.get("user-agent")),
    });
    if (outcome.otherCity) redirect(localePath(`/${outcome.otherCity}/search?q=${encodeURIComponent(query)}`));
  }

  // The filter form shows what is applied: the plain-words search's reading of the query, or the chosen filters.
  const category = categories.find((c) => c.slug === (outcome ? outcome.parsed.category : one(q.category)));
  const area = areas.find((a) => a.slug === (outcome ? outcome.parsed.area : one(q.area)));
  const from = outcome ? outcome.dates?.from : isDate(one(q.from)) ? one(q.from) : undefined;
  const to = outcome ? outcome.dates?.to : isDate(one(q.to)) ? one(q.to) : undefined;
  const priceParam = outcome ? outcome.parsed.price : one(q.price);
  const price = priceParam === "free" || priceParam === "paid" ? priceParam : undefined;

  const events = outcome
    ? outcome.events
    : await listEvents({
      cityId: city.id, from: from ?? today, to, categoryId: category?.id, areaId: area?.id,
      free: price === "free" ? true : price === "paid" ? false : undefined,
      // A search that starts in the past includes events that are over.
      when: from && from < today ? "any" : "upcoming",
    });

  let status: string[];
  if (outcome) {
    const u = outcome.parsed;
    const d = outcome.dates;
    const kind = u.when === "today" || u.when === "tonight" || u.when === "tomorrow" ? u.when : d && d.from === d.to ? "day" : "range";
    const understood: Understood = {
      category: category && categoryName(category), area: area?.name, price,
      when: d ? { kind, from: longDay(d.from), to: longDay(d.to) } : undefined,
      words: u.keywords.length ? u.keywords : undefined, anyWords: outcome.keywordMode === "any",
    };
    status = [m.understood(understood)];
    if (outcome.relaxed) status.push(m.relaxed(u.keywords));
    status.push(m.found(events.length));
  } else {
    const applied = [
      category && categoryName(category), area && m.inArea(area.name), from && m.fromDay(longDay(from)), to && m.untilDay(longDay(to)),
      price === "free" && m.freeEntry, price === "paid" && m.paidEntry,
    ].filter((x): x is string => Boolean(x));
    status = [m.status(events.length, applied, city.name)];
  }

  return (
    <main>
      <Hero trail={[{ name: city.name, path: `/${city.slug}` }, { name: messages().nav.search, path }]} title={m.title(city.name)}>
        <AskBox city={city} query={query} />
      </Hero>
      <div className="wrap page">
        <div className="lead search-status" role="status">
          {status.map((line) => <p key={line}>{line}</p>)}
        </div>

        <h2 className="filters-heading">{m.filtersHeading}</h2>
        <form method="get" action={localePath(path)} className="filters">
          <label>{m.from} <input type="date" name="from" defaultValue={from} /></label>
          <label>{m.until} <input type="date" name="to" defaultValue={to} /></label>
          <label>{m.category}
            <select name="category" defaultValue={category?.slug ?? ""}>
              <option value="">{m.any}</option>
              {categories.map((c) => <option key={c.slug} value={c.slug}>{categoryName(c)}</option>)}
            </select>
          </label>
          <label>{m.area}
            <select name="area" defaultValue={area?.slug ?? ""}>
              <option value="">{m.any}</option>
              {areas.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
            </select>
          </label>
          <label>{m.price}
            <select name="price" defaultValue={price ?? ""}>
              <option value="">{m.any}</option>
              <option value="free">{m.free}</option>
              <option value="paid">{m.paid}</option>
            </select>
          </label>
          <button type="submit" className="button">{m.submit}</button>
        </form>

        <EventList events={events} empty={m.empty} />
      </div>
    </main>
  );
}
