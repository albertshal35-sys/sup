/**
 * AI layer — Workers AI through Cloudflare AI Gateway (centralized billing,
 * caching, analytics). Model: @cf/moonshotai/kimi-k2.6 (configurable).
 *
 * Used for:
 *  1. Scrape normalization — turn rendered page markdown from government
 *     recorder/permit portals into structured records matching the vendor
 *     contract, so scraped sources flow through the same upsert pipeline
 *     as API vendors.
 *  2. Contact enrichment assistance — merge/rank enrichment results.
 *  3. Borrower briefs — one-click outreach brief synthesizing every signal,
 *     the 36-month history and cost of capital.
 */

import type { Env } from "./index";

const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.6";

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export function aiAvailable(env: Env): boolean {
  return Boolean(env.AI);
}

export async function runModel(env: Env, messages: ChatMessage[], maxTokens = 2048): Promise<string> {
  if (!env.AI) throw new Error("ai_binding_missing");
  const gatewayId = await getSetting(env, "ai_gateway_id");
  const model = (await getSetting(env, "ai_model")) || env.AI_MODEL || DEFAULT_MODEL;
  const options = gatewayId ? { gateway: { id: gatewayId } } : undefined;
  const res = (await env.AI.run(model, { messages, max_tokens: maxTokens }, options)) as {
    response?: string;
  };
  return res?.response ?? "";
}

async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?1")
    .bind(key)
    .first<{ value: string }>();
  return row?.value || null;
}

/** Pull the first JSON array out of a model response (handles code fences). */
function parseJsonArray<T>(text: string): T[] {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

const RECORD_SHAPES: Record<string, string> = {
  county_deeds: `{"docNumber":string,"apn":string|null,"address":string,"city":string,"county":string,"state":string,"zip":string|null,"price":number,"isCash":boolean,"deedType":string|null,"buyerName":string,"sellerName":string,"recordedAt":"YYYY-MM-DD"}`,
  county_loans: `{"docNumber":string,"apn":string|null,"address":string,"city":string,"county":string,"state":string,"lenderName":string,"lenderType":"private"|"hard_money"|"bank"|null,"principal":number,"ratePct":number|null,"originatedAt":"YYYY-MM-DD","termMonths":number|null,"maturityDate":"YYYY-MM-DD"|null,"borrowerName":string}`,
  permits: `{"permitNo":string,"address":string,"city":string,"county":string,"state":string,"permitType":"ground_up"|"structural"|"addition"|"remodel"|"other","description":string|null,"valuation":number,"filedAt":"YYYY-MM-DD","status":string|null,"contractor":string|null,"ownerName":string}`,
  liens: `{"docNumber":string,"address":string,"city":string,"county":string,"state":string,"lienType":"mechanics"|"tax"|"judgment"|null,"claimant":string,"amount":number,"filedAt":"YYYY-MM-DD","ownerName":string}`,
};

/**
 * Normalize scraped page content into structured records.
 * The markdown comes from Cloudflare Browser Rendering; the model extracts
 * only records it can ground in the page, never invents values.
 */
export async function extractRecords<T>(
  env: Env,
  connectorId: string,
  markdown: string,
  markets: string[],
  operatorNotes: string | null
): Promise<T[]> {
  const shape = RECORD_SHAPES[connectorId];
  if (!shape) return [];
  const text = await runModel(
    env,
    [
      {
        role: "system",
        content:
          "You extract public real-estate records from scraped government web pages for a lending-intelligence pipeline. " +
          "Return ONLY a JSON array — no prose. Each element must match this exact shape:\n" +
          shape +
          "\nRules: extract only records visible in the content; never fabricate values; use null when a field is absent; " +
          "normalize names to uppercase; dates to YYYY-MM-DD; dollar amounts to plain numbers. " +
          `Relevant markets: ${markets.join("; ") || "any"}.` +
          (operatorNotes ? ` Operator notes about this source: ${operatorNotes}` : ""),
      },
      { role: "user", content: markdown.slice(0, 48_000) },
    ],
    4096
  );
  return parseJsonArray<T>(text);
}

/** One-click outreach brief for a borrower, grounded in their records. */
export async function generateBrief(env: Env, context: string): Promise<string> {
  return runModel(
    env,
    [
      {
        role: "system",
        content:
          "You are an analyst for a private/hard-money real-estate lender. Write a tight outreach brief for the borrower " +
          "described in the data: 1) who they are and how they operate, 2) why they need capital right now (signals), " +
          "3) pricing angle vs their demonstrated cost of capital, 4) suggested opening line. " +
          "Under 180 words, plain text, no markdown headers. Ground every claim in the provided data only.",
      },
      { role: "user", content: context.slice(0, 24_000) },
    ],
    1024
  );
}

/** Personalized outreach draft (email or SMS) grounded in borrower records. */
export async function generateOutreach(
  env: Env,
  channel: "email" | "sms",
  context: string,
  identity: string
): Promise<string> {
  const constraints =
    channel === "sms"
      ? "Write ONE text message under 300 characters. Casual-professional, no links, no placeholders."
      : "Write a short email: subject line on the first line prefixed 'Subject: ', then a blank line, then 90-130 words. No placeholders like [Name] — use the actual data.";
  return runModel(
    env,
    [
      {
        role: "system",
        content:
          "You write first-touch outreach for a private/hard-money real-estate lender contacting a borrower. " +
          "Reference their actual situation (their project, their maturing note, their rates) without sounding like surveillance — " +
          "frame it as being active in the same market. One concrete value hook (rate, speed, or certainty of close). One clear ask. " +
          constraints +
          ` Sender identity: ${identity}. Ground every claim in the provided data; never invent facts.`,
      },
      { role: "user", content: context.slice(0, 24_000) },
    ],
    1024
  );
}

/* ---------------------- Browser Rendering (scraping) ---------------------- */

/**
 * Fetch a rendered page as markdown via the Browser Rendering REST API —
 * a managed headless browser, so JS-heavy government portals render fully.
 * Requires CF_ACCOUNT_ID (var) + CF_API_TOKEN (secret w/ Browser Rendering).
 */
export async function renderPageMarkdown(env: Env, url: string): Promise<string> {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) throw new Error("browser_rendering_not_configured");
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/markdown`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        gotoOptions: { waitUntil: "networkidle0", timeout: 45_000 },
      }),
    }
  );
  if (!res.ok) throw new Error(`browser_rendering ${res.status}`);
  const body = (await res.json()) as { success: boolean; result?: string };
  if (!body.success || !body.result) throw new Error("browser_rendering_empty");
  return body.result;
}
