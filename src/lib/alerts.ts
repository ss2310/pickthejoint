/**
 * Job alerts by email, through Resend. A scraper that breaks quietly is the
 * likeliest way the site goes stale, so every failed job and every run that
 * unexpectedly finds nothing sends one. If Resend is not configured the alert
 * is written to the job's log instead, clearly marked.
 */
import { alerts, site } from "../config";

export interface AlertResult { sent: boolean; reason?: string }

export async function sendAlert(subject: string, body: string, fetchFn: typeof fetch = fetch): Promise<AlertResult> {
  const text = `${body}\n\nSent by the ${site.name} jobs on ${new Date().toISOString()}.`;
  if (!alerts.resendApiKey || !alerts.from || !alerts.to) {
    const missing = [!alerts.resendApiKey && "RESEND_API_KEY", !alerts.from && "ALERT_FROM", !alerts.to && "ALERT_TO"].filter(Boolean).join(", ");
    console.error(`[alert] NOT SENT (${missing} not set). ${subject}\n${text}`);
    return { sent: false, reason: `${missing} not set` };
  }
  try {
    const res = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${alerts.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: alerts.from, to: [alerts.to], subject: `[${site.name}] ${subject}`, text }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      console.error(`[alert] Resend refused the email (${res.status}): ${detail}. ${subject}\n${text}`);
      return { sent: false, reason: `Resend ${res.status}` };
    }
    console.log(`[alert] sent: ${subject}`);
    return { sent: true };
  } catch (err) {
    console.error(`[alert] could not reach Resend: ${(err as Error).message}. ${subject}\n${text}`);
    return { sent: false, reason: (err as Error).message };
  }
}

/**
 * True when this run produced nothing although recent runs usually did: at
 * least three earlier runs to judge by, and most of them produced something.
 */
export function unexpectedlyEmpty(current: number, previous: number[]): boolean {
  if (current > 0 || previous.length < 3) return false;
  return previous.filter((n) => n > 0).length > previous.length / 2;
}
