import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { EventList, Hero } from "@/components/ui";
import { isoDay, longDay, plural } from "@/lib/format";
import { getCity, listAreas, listCategories, listEvents } from "@/lib/queries";

// Plain filter search. The filters live in the URL, so a result page can be shared or bookmarked;
// the form is an ordinary GET form and needs no JavaScript.
export const dynamic = "force-dynamic";

type Search = { from?: string; to?: string; category?: string; area?: string; price?: string };
type Props = { params: Promise<{ city: string }>; searchParams: Promise<Search> };

const isDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const city = await getCity((await params).city);
  if (!city) return {};
  const filtered = Object.values(await searchParams).some(Boolean);
  return {
    title: `Search events in ${city.name}`,
    description: `Find events in ${city.name} by date, category, area and price.`,
    alternates: { canonical: `/${city.slug}/search` },
    // Filter combinations are endless; only the bare search page is indexed.
    robots: filtered ? { index: false, follow: true } : undefined,
  };
}

export default async function SearchPage({ params, searchParams }: Props) {
  const city = await getCity((await params).city);
  if (!city) notFound();
  const q = await searchParams;
  const [categories, areas] = await Promise.all([listCategories(), listAreas(city.id)]);
  const category = categories.find((c) => c.slug === q.category);
  const area = areas.find((a) => a.slug === q.area);
  const from = isDate(q.from) ? q.from : undefined;
  const to = isDate(q.to) ? q.to : undefined;
  const price = q.price === "free" || q.price === "paid" ? q.price : undefined;
  const today = isoDay(new Date(), city.timezone);

  const events = await listEvents({
    cityId: city.id, from: from ?? today, to, categoryId: category?.id, areaId: area?.id,
    free: price === "free" ? true : price === "paid" ? false : undefined,
    // A search that starts in the past includes events that are over.
    when: from && from < today ? "any" : "upcoming",
  });
  const applied = [
    category && category.name, area && `in ${area.name}`, from && `from ${longDay(from)}`, to && `until ${longDay(to)}`,
    price === "free" && "free entry", price === "paid" && "paid entry",
  ].filter(Boolean);

  return (
    <main>
      <Hero trail={[{ name: city.name, path: `/${city.slug}` }, { name: "Search", path: `/${city.slug}/search` }]} title={`Search events in ${city.name}`} />
      <div className="wrap page">
      <form method="get" action={`/${city.slug}/search`} className="filters">
        <label>From <input type="date" name="from" defaultValue={from} /></label>
        <label>Until <input type="date" name="to" defaultValue={to} /></label>
        <label>Category
          <select name="category" defaultValue={category?.slug ?? ""}>
            <option value="">Any</option>
            {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
          </select>
        </label>
        <label>Area
          <select name="area" defaultValue={area?.slug ?? ""}>
            <option value="">Any</option>
            {areas.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
          </select>
        </label>
        <label>Price
          <select name="price" defaultValue={price ?? ""}>
            <option value="">Any</option>
            <option value="free">Free</option>
            <option value="paid">Paid</option>
          </select>
        </label>
        <button type="submit" className="button">Show events</button>
      </form>

      <p className="lead" role="status">
        {plural(events.length, "event")} {events.length === 1 ? "matches" : "match"}
        {applied.length ? `: ${applied.join(", ")}.` : `: everything coming up in ${city.name}.`}
      </p>
      <EventList events={events} empty="No listed events match these filters. Try a wider date range or fewer filters." />
      </div>
    </main>
  );
}
