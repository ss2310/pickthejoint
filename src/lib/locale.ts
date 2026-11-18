/**
 * The language of the page being rendered. English lives at the plain paths
 * (/indore/...), Hindi under /hi/ with the same paths. Middleware maps both
 * onto the app's [locale] segment.
 *
 * A page (and its metadata function) calls `setLocale` first; everything it
 * renders then reads the language with `getLocale`, without every component
 * and query having to be handed it. The value is held per request by React's
 * `cache`. Outside a page render (jobs, feeds, tests) nothing is set and the
 * language is English.
 */
import { cache } from "react";
import { defaultLocale, locales, type Locale } from "../config";
import { en, type Messages } from "../locales/en";
import { hi } from "../locales/hi";

const store = cache((): { locale: Locale } => ({ locale: defaultLocale }));

export const isLocale = (value: string): value is Locale => (locales as readonly string[]).includes(value);

/** Sets the language for this request and returns it; an unknown value means English. */
export function setLocale(value: string): Locale {
  const locale = isLocale(value) ? value : defaultLocale;
  store().locale = locale;
  return locale;
}

export function getLocale(): Locale {
  return store().locale;
}

const DICTIONARIES: Record<Locale, Messages> = { en, hi };

/** The interface text for a language (the current one by default). */
export function messages(locale: Locale = getLocale()): Messages {
  return DICTIONARIES[locale];
}

/** A site path in a language: "/indore/today" in English, "/hi/indore/today" in Hindi. */
export function localePath(path: string, locale: Locale = getLocale()): string {
  if (locale === defaultLocale) return path;
  return path === "/" ? `/${locale}` : `/${locale}${path}`;
}

/** BCP 47 tags used for <html lang>, hreflang, dates and structured data. */
export const LANG_TAG: Record<Locale, string> = { en: "en-IN", hi: "hi-IN" };

/**
 * Canonical address plus the hreflang links between the two versions of a
 * page. `onlyDefault` is for pages that exist in English only.
 */
export function alternates(path: string, opts: { onlyDefault?: boolean } = {}, locale: Locale = getLocale()) {
  if (opts.onlyDefault) return { canonical: path };
  const languages: Record<string, string> = { "x-default": path };
  for (const l of locales) languages[LANG_TAG[l]] = localePath(path, l);
  return { canonical: localePath(path, locale), languages };
}
