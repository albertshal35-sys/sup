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

const LIEN_SHAPE = `{"docNumber":string,"address":string,"city":string,"county":string,"state":string,"lienType":"mechanics"|"tax"|"judgment"|"lis_pendens"|"violation"|"auction"|null,"claimant":string,"amount":number,"filedAt":"YYYY-MM-DD","ownerName":string}`;

const RECORD_SHAPES: Record<string, string> = {
  county_deeds: `{"docNumber":string,"apn":string|null,"address":string,"city":string,"county":string,"state":string,"zip":string|null,"price":number,"isCash":boolean,"deedType":string|null,"buyerName":string,"sellerName":string,"recordedAt":"YYYY-MM-DD"}`,
  county_loans: `{"docNumber":string,"apn":string|null,"address":string,"city":string,"county":string,"state":string,"lenderName":string,"lenderType":"private"|"hard_money"|"bank"|null,"principal":number,"ratePct":number|null,"originatedAt":"YYYY-MM-DD","termMonths":number|null,"maturityDate":"YYYY-MM-DD"|null,"borrowerName":string}`,
  permits: `{"permitNo":string,"address":string,"city":string,"county":string,"state":string,"permitType":"ground_up"|"structural"|"addition"|"remodel"|"other","description":string|null,"valuation":number,"filedAt":"YYYY-MM-DD","status":string|null,"contractor":string|null,"ownerName":string}`,
  liens: LIEN_SHAPE,
  lis_pendens: LIEN_SHAPE,
  violations: LIEN_SHAPE,
  tax_liens: LIEN_SHAPE,
  auctions: LIEN_SHAPE,
  satisfactions: `{"docNumber":string,"originalDocNumber":string|null,"address":string|null,"city":string|null,"county":string|null,"state":string|null,"lenderName":string,"borrowerName":string,"satisfiedAt":"YYYY-MM-DD"}`,
  ucc_filings: `{"fileNumber":string,"securedParty":string,"debtorName":string,"filedAt":"YYYY-MM-DD","address":string|null,"city":string|null,"county":string|null,"state":string|null,"collateral":string|null}`,
  corp_registry: `{"entityName":string,"formationDate":"YYYY-MM-DD"|null,"registeredAgent":string|null,"county":string|null,"status":string|null}`,
};

/** Target shape for a connector's records (used by the field auto-mapper). */
export function recordShape(connectorId: string): string | null {
  return RECORD_SHAPES[connectorId] ?? null;
}

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

/**
 * Grounding verification — the second AI pass that keeps extraction honest.
 * Each extracted record must show its identifying fields (document number,
 * amount, names, date) literally present in the source content; records
 * that can't prove themselves get quarantined upstream. Returns one boolean
 * per record; on model failure it returns all-false so nothing unverified
 * slips through.
 */
export async function verifyGrounding(
  env: Env,
  records: unknown[],
  markdown: string
): Promise<boolean[]> {
  if (records.length === 0) return [];
  const batch = records.slice(0, 25);
  try {
    const text = await runModel(
      env,
      [
        {
          role: "system",
          content:
            "You audit data extraction. For each numbered record, answer whether its key identifying values " +
            "(document/permit number, dollar amount, party names, date) are all literally present in the SOURCE text. " +
            'Return ONLY a JSON array: [{"i":number,"grounded":boolean}] — one entry per record, no prose. ' +
            "grounded=false if any key value does not appear in the source.",
        },
        {
          role: "user",
          content: `RECORDS:\n${batch.map((r, i) => `${i}: ${JSON.stringify(r)}`).join("\n")}\n\nSOURCE:\n${markdown.slice(0, 40_000)}`,
        },
      ],
      2048
    );
    const verdicts = parseJsonArray<{ i: number; grounded: boolean }>(text);
    const out = new Array<boolean>(records.length).fill(false);
    for (const v of verdicts) {
      if (typeof v?.i === "number" && v.i >= 0 && v.i < batch.length) out[v.i] = Boolean(v.grounded);
    }
    return out;
  } catch {
    return new Array<boolean>(records.length).fill(false);
  }
}

/** Rule schema the signal compiler targets and the evaluator understands. */
export const SIGNAL_RULE_SHAPE = `{
  "record": "deed" | "loan" | "permit" | "lien",
  "label": string,
  "filters": {
    "windowDays": number,
    "isCash": boolean | null,
    "minAmount": number | null,
    "maxAmount": number | null,
    "counties": string[] | null,
    "cities": string[] | null,
    "minFlips": number | null,
    "minVelocity": number | null,
    "lenderTypes": string[] | null,
    "minRate": number | null,
    "permitTypes": string[] | null,
    "lienTypes": string[] | null
  }
}`;

/**
 * Compile a plain-English rule into deterministic JSON. The model writes
 * the rule once; every evaluation afterward is plain SQL/JS with zero AI
 * involvement, so hits stay auditable.
 */
export async function compileSignalRule(env: Env, prompt: string): Promise<Record<string, unknown> | null> {
  const text = await runModel(
    env,
    [
      {
        role: "system",
        content:
          "You compile a real-estate lender's plain-English signal description into a JSON rule. " +
          "Return ONLY one JSON object matching exactly this shape (null for unused filters):\n" +
          SIGNAL_RULE_SHAPE +
          '\nNYC borough → county: Brooklyn="Kings", Queens="Queens", Bronx="Bronx", Manhattan="New York", Staten Island="Richmond". ' +
          'If the description cannot be expressed with these filters, return {"error":"<what is unsupported>"}.',
      },
      { role: "user", content: prompt.slice(0, 2_000) },
    ],
    1024
  );
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
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
