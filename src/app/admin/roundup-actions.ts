"use server";
/** Admin actions for the weekly guides (Prompt 11). Nothing is published without the admin's click here. */
import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { getPool } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-session";
import { BudgetExceededError } from "@/lib/budget-guard";
import { AnthropicLlm } from "@/lib/pipeline/llm";
import { draftRoundups } from "@/lib/roundups";

const back = (msg: string, to = "/admin/roundups"): never => redirect(`${to}${to.includes("?") ? "&" : "?"}msg=${encodeURIComponent(msg)}`);
const text = (form: FormData, name: string) => String(form.get(name) ?? "").replace(/\s+/g, " ").trim();

/** Drafts this week's guide for a city now (one mid-tier call, about a cent). With "again", replaces the current draft. */
export async function generateRoundup(form: FormData): Promise<void> {
  await requireAdmin();
  let msg = "";
  try {
    const [r] = await draftRoundups(getPool(), new AnthropicLlm(), { jobName: "admin", city: text(form, "city"), force: form.get("again") === "on" });
    msg = !r ? "No live city by that name."
      : r.status === "drafted" ? `Drafted ${r.slug} (${r.events} events, $${(r.usd ?? 0).toFixed(4)}).`
        : r.status === "exists" ? `A draft for ${r.slug} already exists. Tick "draft again" to replace it.`
          : r.status === "too few events" ? `Not drafted: only ${r.events} events in ${r.slug}.`
            : r.status === "published already" ? `${r.slug} is already published; unpublish it first to draft it again.`
              : `Could not draft ${r.slug}: ${r.error ?? r.status}`;
  } catch (err) {
    unstable_rethrow(err);
    msg = err instanceof BudgetExceededError ? "Not drafted: the roundup budget for this month is used up." : `Could not draft: ${(err as Error).message}`;
  }
  back(msg);
}

/** Publishes a draft (or takes a published guide down again). */
export async function setRoundupStatus(form: FormData): Promise<void> {
  await requireAdmin();
  const publish = text(form, "status") === "published";
  const { rows } = await getPool().query<{ slug: string }>(
    `UPDATE roundups SET status = $2, published_at = CASE WHEN $2 = 'published' THEN coalesce(published_at, now()) ELSE published_at END, updated_at = now()
     WHERE id = $1 RETURNING slug`, [Number(form.get("id")), publish ? "published" : "draft"]);
  revalidatePath("/", "layout");
  back(rows[0] ? (publish ? `Published ${rows[0].slug}.` : `${rows[0].slug} is a draft again and no longer public.`) : "Not found.");
}

/** Saves the admin's own wording of the headline and overview. No model is called. */
export async function saveRoundupText(form: FormData): Promise<void> {
  await requireAdmin();
  const id = Number(form.get("id"));
  const fields = { title: text(form, "title"), intro: text(form, "intro"), title_hi: text(form, "title_hi"), intro_hi: text(form, "intro_hi") };
  if (!fields.title || !fields.intro) back("The English headline and overview cannot be empty.", `/admin/roundups/${id}`);
  await getPool().query(
    "UPDATE roundups SET title = $2, intro = $3, title_hi = nullif($4, ''), intro_hi = nullif($5, ''), updated_at = now() WHERE id = $1",
    [id, fields.title, fields.intro, fields.title_hi, fields.intro_hi]);
  revalidatePath("/", "layout");
  back("Saved.", `/admin/roundups/${id}`);
}

/** Deletes a draft nobody needs. A published guide cannot be deleted here, so its address keeps working. */
export async function deleteRoundup(form: FormData): Promise<void> {
  await requireAdmin();
  const res = await getPool().query("DELETE FROM roundups WHERE id = $1 AND status = 'draft'", [Number(form.get("id"))]);
  back(res.rowCount ? "Draft deleted." : "Only drafts can be deleted.");
}
