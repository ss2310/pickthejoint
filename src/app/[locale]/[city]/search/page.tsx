import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { EventList, Hero } from "@/components/ui";
import { isoDay, longDay } from "@/lib/format";
import { categoryName } from "@/lib/hubs";
import { alternates, localePath, messages, setLocale } from "@/lib/locale";
import { getCity, listAreas, listCategories, listEvents } from "@/lib/queries";

// Plain filter search. The filters live in the URL, so a result page can be shared or bookmarked;
// the form is an ordinary GET form and needs no JavaScript.
export const dynamic = "force-dynamic";

type Search = { from?: string; to?: string; category?: string; area?: string; price?: string };
type Props = { params: Promise<{ locale: string; city: string }>; searchParams: Promise<Search> };

const isDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

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
    // Filter combinations are endless; only the bare search page is indexed.
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
    category && categoryName(category), area && m.inArea(area.name), from && m.fromDay(longDay(from)), to && m.untilDay(longDay(to)),
    price === "free" && m.freeEntry, price === "paid" && m.paidEntry,
  ].filter((x): x is string => Boolean(x));
  const path = `/${city.slug}/search`;

  return (
    <main>
      <Hero trail={[{ name: city.name, path: `/${city.slug}` }, { name: messages().nav.search, path }]} title={m.title(city.name)} />
      <div className="wrap page">
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

        <p className="lead" role="status">{m.status(events.length, applied, city.name)}</p>
        <EventList events={events} empty={m.empty} />
      </div>
    </main>
  );
}
