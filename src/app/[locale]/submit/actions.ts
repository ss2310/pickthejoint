"use server";
/**
 * The two public submission actions: reading a snapped poster into a draft,
 * and sending the form for review. Both work as plain HTML form posts (no
 * script of ours), and both answer with a redirect, so a reload never posts
 * twice. Form state lives in the draft row, reached by its random token.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { submissions as cfg } from "@/config";
import { BudgetExceededError } from "@/lib/budget-guard";
import { getPool } from "@/lib/db";
import { isLocale, localePath } from "@/lib/locale";
import { AnthropicLlm } from "@/lib/pipeline/llm";
import { localDate } from "@/lib/pipeline/text";
import { cleanImage, readPosters, storePoster, UploadError, type CleanImage } from "@/lib/posters";
import { clientIp, ipHash, rateAllow, verifyTurnstile } from "@/lib/security";
import {
  createDraft, emptyFields, fieldsFromExtraction, getDraft, liveCities, queueSubmission, readFields, readSubmitter, rejectAsBot, saveDraft,
  validate, type FieldError,
} from "@/lib/submissions";

const JOB = "submissions";

function localeOf(form: FormData) {
  const l = String(form.get("locale") ?? "");
  return isLocale(l) ? l : "en";
}

async function cityOf(form: FormData) {
  const slug = String(form.get("city") ?? "");
  return (await liveCities()).find((c) => c.slug === slug) ?? null;
}

/** Turnstile, with Cloudflare's reason written to the log when it refuses (the visitor only sees "try again"). */
async function checkHuman(form: FormData, ip: string, where: "poster" | "form"): Promise<boolean> {
  const token = form.get("cf-turnstile-response");
  const tokens = form.getAll("cf-turnstile-response").length;
  const result = await verifyTurnstile(typeof token === "string" ? token : null, ip);
  if (!result.ok) console.warn(`[turnstile] ${where} refused: ${result.reason} (tokens in form: ${tokens}, token length: ${typeof token === "string" ? token.length : 0})`);
  return result.ok;
}

export async function snapPoster(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const back = (query: string): never => redirect(localePath(`/submit?${query}`, locale));
  const ip = clientIp(await headers());
  const who = ipHash(ip);

  const file = form.get("poster");
  if (!(file instanceof File) || file.size === 0) back("upload=empty");
  const upload = file as File;
  if (upload.size > cfg.maxUploadBytes) back("upload=tooBig");
  if (!(await checkHuman(form, ip, "poster"))) back("upload=captcha");
  if (!(await rateAllow(`poster:${who}`, [cfg.limits.poster]))) back("upload=tooMany");

  let image: CleanImage | null = null;
  let problem: string | null = null;
  try {
    image = await cleanImage(Buffer.from(await upload.arrayBuffer()));
  } catch (err) {
    if (!(err instanceof UploadError)) throw err;
    problem = err.problem;
  }
  if (!image) return back(`upload=${problem}`);

  const pool = getPool();
  const city = (await cityOf(form)) ?? (await liveCities())[0];
  const note = String(form.get("poster_note") ?? "").trim().slice(0, 1500);
  // The file name is not kept: it can carry a phone's or person's name.
  let posterId: number | null = await storePoster({ channel: "public", cityId: city?.id ?? null, image, note, keepDays: cfg.draftDays });

  let read: "ok" | "none" | "failed" | "paused" = "failed";
  let fields = emptyFields();
  let many = 0;
  try {
    const cats = (await pool.query<{ slug: string }>("SELECT slug FROM categories ORDER BY sort_order")).rows.map((c) => c.slug);
    const [r] = await readPosters(pool, new AnthropicLlm(), [posterId], { jobName: JOB, subBudget: "submissions" });
    const events = r?.extraction?.events.filter((e) => e.announcement === "new_event") ?? [];
    if (r?.ok && r.extraction?.is_event_post && events.length) {
      read = "ok";
      fields = fieldsFromExtraction(events[0], cats);
      many = events.length;
    } else if (r?.ok) {
      read = "none";
    }
  } catch (err) {
    // Out of budget, or the model is unreachable: the submitter fills the form in by hand.
    if (err instanceof BudgetExceededError) read = "paused";
    else console.error(`[snap-poster] reading failed: ${(err as Error).message}`);
  }
  if (read === "none") {
    // Not an event poster: nothing to keep it for.
    await pool.query("DELETE FROM poster_images WHERE id = $1", [posterId]);
    posterId = null;
  }
  fields.note = note;
  const { token } = await createDraft({ channel: "poster", cityId: city?.id ?? null, fields, posterId, ipHash: who });
  back(`draft=${token}&read=${read}${many > 1 ? `&many=${many}` : ""}`);
}

export async function sendEvent(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const ip = clientIp(await headers());
  const who = ipHash(ip);
  const pool = getPool();

  const fields = readFields(form);
  const submitter = readSubmitter(form);
  const city = await cityOf(form);
  const token = String(form.get("draft") ?? "");
  const existing = token ? await getDraft(token) : null;
  if (existing?.fields.uncertain) fields.uncertain = existing.fields.uncertain;
  const draft = existing ?? { ...(await createDraft({ channel: "form", cityId: city?.id ?? null, fields, submitter, ipHash: who })) };
  const thanks = (): never => redirect(localePath(`/submit/thanks${city ? `?city=${city.slug}` : ""}`, locale));
  const back = (errors: Partial<Record<string, FieldError>>): Promise<never> =>
    saveDraft(draft.id, { cityId: city?.id ?? null, fields, submitter, errors }).then(() => redirect(localePath(`/submit?draft=${draft.token}#form`, locale)));

  // A filled-in hidden field means a bot: say thank you and file it as rejected.
  if (String(form.get("website") ?? "").trim()) {
    await saveDraft(draft.id, { cityId: city?.id ?? null, fields, submitter, errors: null });
    await rejectAsBot(pool, draft.id);
    thanks();
  }

  const cats = (await pool.query<{ slug: string }>("SELECT slug FROM categories")).rows.map((c) => c.slug);
  const errors = validate(fields, submitter, cats, localDate(new Date(), city?.timezone ?? "Asia/Kolkata"));
  if (!city) errors.city = "required";
  if (Object.keys(errors).length) await back(errors);
  if (!(await checkHuman(form, ip, "form"))) await back({ _form: "captcha" });
  if (!(await rateAllow(`form:${who}`, [cfg.limits.form, cfg.limits.formDaily]))) await back({ _form: "tooMany" });

  await saveDraft(draft.id, { cityId: city!.id, fields, submitter, errors: null });
  await queueSubmission(pool, new AnthropicLlm(), draft.id, { jobName: JOB, subBudget: "submissions" });
  thanks();
}
