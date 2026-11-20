// npm run parked:check -- proves a real paid call is blocked while parked (see PARKED.md): the real Claude and Apify
// clients with real keys, PARKED=true. Counts every outgoing HTTP request. Refuses to run unless PARKED=true.
import { z } from "zod";
import { AnthropicLlm } from "../src/lib/pipeline/llm";
import { HttpApifyClient } from "../src/lib/pipeline/apify";
import { budgets } from "../src/config";
import { getPool, closePool } from "../src/lib/db";

const sent: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  sent.push(String(input instanceof Request ? input.url : input));
  return realFetch(input, init);
}) as typeof fetch;

async function main() {
  if (process.env.PARKED !== "true") { console.error("Run this only with PARKED=true: otherwise it would make real paid calls."); process.exit(1); }
  console.log(`PARKED=${process.env.PARKED} ANTHROPIC_API_KEY set: ${!!process.env.ANTHROPIC_API_KEY} APIFY_TOKEN set: ${!!process.env.APIFY_TOKEN}`);
  console.log(`caps: scrape $${budgets.scrape}, model $${budgets.model}`);
  const pool = getPool();
  const before = (await pool.query("SELECT count(*)::int AS n FROM cost_log")).rows[0].n;
  try {
    await new AnthropicLlm().run([{
      id: "probe", tier: "fast", system: "Reply with ok.", content: [{ type: "text", text: "ping" }],
      schema: z.object({ ok: z.boolean() }), maxTokens: 16, effort: "low", estInputTokens: 10, estOutputTokens: 5,
    }], { jobName: "parked-proof", pool });
    console.log("Claude call: NOT BLOCKED");
  } catch (err) { console.log(`Claude call: ${(err as Error).name}: ${(err as Error).message}`); }
  try {
    await new HttpApifyClient().runActor("apify/instagram-scraper", { directUrls: [] }, { maxChargeUsd: 0.01 });
    console.log("Apify call: NOT BLOCKED");
  } catch (err) { console.log(`Apify call: ${(err as Error).name}: ${(err as Error).message}`); }
  const after = (await pool.query("SELECT count(*)::int AS n FROM cost_log")).rows[0].n;
  console.log(`cost_log rows before ${before}, after ${after}; HTTP requests sent: ${sent.length}${sent.length ? " " + sent.join(", ") : ""}`);
  const ok = after === before && sent.length === 0;
  console.log(ok ? "PASS: nothing was sent and nothing was charged" : "FAIL");
  await closePool();
  process.exit(ok ? 0 : 1);
}
main();
