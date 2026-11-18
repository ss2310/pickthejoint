/**
 * Filter step: decide from the caption alone whether a post announces an
 * event. Keyword rules settle the clear cases for free; only unclear captions
 * go to the fast model. "event" and "maybe" continue to extraction.
 */
import { z } from "zod";
import type { LlmRequest } from "./llm";

export type FilterLabel = "event" | "maybe" | "not_event";
export type RuleVerdict = FilterLabel | "unclear";

const MONTH = "jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?";
const DATE_SIGNALS: RegExp[] = [
  new RegExp(`\\b\\d{1,2}(st|nd|rd|th)?\\s*(${MONTH})\\b`, "i"),
  new RegExp(`\\b(${MONTH})\\s*\\d{1,2}(st|nd|rd|th)?\\b`, "i"),
  /\b\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?\b/,
  /\b(mon|tues?|wed(nes)?|thur?s?|fri|sat(ur)?|sun)(day)?\b/i,
  /\b(today|tonight|tomorrow|this weekend|this week|next week|coming (soon )?this)\b/i,
  /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i,
  /\b(onwards|doors open)\b/i,
  /(आज|कल|शनिवार|रविवार|सोमवार|मंगलवार|बुधवार|गुरुवार|शुक्रवार|बजे|तारीख)/,
  /\b(aaj|kal|shaniwar|raviwar|baje)\b/i,
];
const EVENT_SIGNALS: RegExp[] = [
  /\b(tickets?|passes|book(ing)?s? (now|open)|book your|register|registrations?|rsvp|entry|cover charge|guest ?list|early bird|limited seats|walk[- ]?ins?)\b/i,
  /\b(live|gig|concert|performing|performance|line[- ]?up|ft\.?|feat\.?|featuring|headlin\w+|dj|open mic|stand[- ]?up|comedy|showcase)\b/i,
  /\b(workshop|masterclass|meetup|meet[- ]?up|screening|exhibition|flea|pop[- ]?up|festival|fest|carnival|garba|mela|marathon|tournament|quiz|karaoke|jam|brunch|sundowner|party|night)\b/i,
  /\b(join us|save the date|see you (there|on|this)|mark your calendars?|block your (dates?|calendars?))\b/i,
  /\b(bookmyshow|district|insider|townscript|skillbox|allevents|sortmyscene)\b/i,
  /(कार्यक्रम|आयोजन|टिकट|प्रवेश|महोत्सव|उत्सव|संध्या|कवि सम्मेलन|नाटक)/,
];

const count = (text: string, patterns: RegExp[]) => patterns.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);

/**
 * Free first pass.
 *  - a date or time signal plus an event word: "event"
 *  - almost no caption: "maybe" (the facts, if any, are on the poster)
 *  - no signal of either kind: "not_event"
 *  - anything else: "unclear" (ask the fast model)
 */
export function ruleFilter(caption: string): RuleVerdict {
  const text = caption.trim();
  if (text.replace(/[#@]\S+/g, "").replace(/[^\p{L}\p{N}]+/gu, "").length < 12) return "maybe";
  const dates = count(text, DATE_SIGNALS);
  const events = count(text, EVENT_SIGNALS);
  if (dates >= 1 && events >= 1) return "event";
  if (dates === 0 && events === 0) return "not_event";
  return "unclear";
}

export const FilterSchema = z.object({
  label: z.enum(["event", "maybe", "not_event"]),
  confidence: z.number(),
});
export type FilterAnswer = z.infer<typeof FilterSchema>;

const SYSTEM = `You sort Instagram captions from venues, promoters and listing accounts in Indian cities.
Decide whether the post announces a specific upcoming event the public can attend (a gig, show, party night, workshop, festival, screening, match screening, market, talk).

- "event": it announces or promotes a specific upcoming event, or announces that one is cancelled, postponed or changed.
- "maybe": it might, but the caption alone does not settle it (the details may be on the poster image).
- "not_event": anything else: recaps and thank-you posts about past events, menus and food photos, offers and discounts with no event, hiring, generic brand posts, memes, giveaways without an event.

Captions may be in English, Hindi or Hinglish. Give your confidence in the label from 0 to 1.`;

export function filterRequest(id: string, caption: string, handle: string, handleType: string): LlmRequest<FilterAnswer> {
  const text = `Account: @${handle} (${handleType})\n\nCaption:\n${caption.slice(0, 2500)}`;
  return {
    id, tier: "fast", system: SYSTEM, content: [{ type: "text", text }], schema: FilterSchema,
    maxTokens: 200, effort: "low",
    estInputTokens: 260 + Math.ceil(text.length / 3), estOutputTokens: 30,
  };
}
