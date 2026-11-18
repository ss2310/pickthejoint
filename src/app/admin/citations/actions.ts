"use server";
/** Citation tracker forms (Prompt 8). Each checks the session, does one thing and returns with a message. */
import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { requireAdmin } from "@/lib/admin-session";
import { ImportError, importFirstPartyCsv, importRun, saveFirstParty, saveManualResult, type FirstPartySource } from "@/lib/citations";

const PATH = "/admin/citations";
const back = (msg: string, extra = ""): never => redirect(`${PATH}?msg=${encodeURIComponent(msg)}${extra}`);
const text = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const optNum = (f: FormData, k: string) => { const s = text(f, k); return s === "" || Number.isNaN(Number(s)) ? null : Number(s); };

/** The public page shows the new week at once. */
function refresh() {
  revalidatePath("/", "layout");
}

async function readFile(f: FormData, name: string, maxBytes: number): Promise<string> {
  const file = f.get(name);
  if (!(file instanceof File) || file.size === 0) back("Choose a file first.");
  if ((file as File).size > maxBytes) back(`That file is over ${Math.round(maxBytes / 1_000_000)} MB.`);
  return (file as File).text();
}

export async function uploadRun(form: FormData) {
  await requireAdmin();
  const body = await readFile(form, "file", 8_000_000);
  try {
    let raw: unknown;
    try { raw = JSON.parse(body); } catch { throw new ImportError("That file is not JSON."); }
    const r = await importRun(raw);
    refresh();
    const parts = [`Imported ${r.imported} checks for the week of ${r.weekStart}: ${r.answered} answered, ${r.cited} cited pickthejoint.com, ${r.mentioned} named it. Cost $${r.costUsd.toFixed(4)}.`];
    if (r.skipped.length) parts.push(`${r.skipped.length} skipped (no matching question or engine).`);
    if (r.overBudget) parts.push(`Over budget: ${r.overBudget}.`);
    back(parts.join(" "), `&week=${r.weekStart}`);
  } catch (err) {
    unstable_rethrow(err);
    back(err instanceof ImportError ? err.message : `Import failed: ${(err as Error).message}`);
  }
}

export async function addManualResult(form: FormData) {
  await requireAdmin();
  try {
    const answered = form.get("answered") !== "no";
    await saveManualResult({
      queryId: Number(form.get("query_id")), engine: text(form, "engine"), weekStart: text(form, "week"), answered,
      cited: form.get("cited") === "on", mentioned: form.get("mentioned") === "on", competitors: text(form, "competitors"),
      screenshotUrl: text(form, "screenshot"), note: text(form, "note"),
    });
    refresh();
    back("Check saved.", `&week=${text(form, "week")}`);
  } catch (err) {
    unstable_rethrow(err);
    back(err instanceof ImportError ? err.message : `Not saved: ${(err as Error).message}`);
  }
}

const source = (f: FormData): FirstPartySource => (text(f, "source") === "search_console" ? "search_console" : "bing_ai");

export async function addFirstParty(form: FormData) {
  await requireAdmin();
  const week = text(form, "week");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) back("Choose the week.");
  await saveFirstParty(source(form), week, {
    citations: optNum(form, "citations"), cited_pages: optNum(form, "cited_pages"), impressions: optNum(form, "impressions"),
    clicks: optNum(form, "clicks"), avg_position: optNum(form, "avg_position"),
  }, text(form, "note") || null);
  back("Saved.");
}

export async function uploadFirstPartyCsv(form: FormData) {
  await requireAdmin();
  const csv = await readFile(form, "file", 5_000_000);
  try {
    const r = await importFirstPartyCsv(source(form), csv);
    back(`Read ${r.rows} daily rows into ${r.weeks.length} week(s): ${r.weeks.join(", ")}.`);
  } catch (err) {
    unstable_rethrow(err);
    back(err instanceof ImportError ? err.message : `Import failed: ${(err as Error).message}`);
  }
}
