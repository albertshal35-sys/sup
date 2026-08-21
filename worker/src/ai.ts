/**
 * AI layer — Workers AI through Cloudflare AI Gateway (centralized billing,
 * caching, analytics). Models are chosen per role, not once for the app —
 * see DEFAULT_EXTRACT_MODEL / DEFAULT_PROSE_MODEL below.
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
import {
  GROUNDING_SCHEMA, listSchema, objectSchema, RECORD_SHAPES, shapeHint,
  type JsonSchema, type Shape,
} from "./schema";

/**
 * Models are chosen per *role*, not once for the whole app, because the two
 * kinds of call have opposite economics.
 *
 * `extract` is where essentially all the tokens go — scrape normalization,
 * grounding verification, field auto-mapping, rate reading. Every one of
 * them wants a rigid JSON object out, which JSON mode enforces directly, so
 * a small model does the job and the integrity gates catch what it gets
 * wrong. `prose` is a handful of calls a day whose output a customer reads,
 * so it keeps the stronger model.
 *
 * At the time of writing kimi-k2.6 runs $0.95/M in and $4.00/M out while
 * gemma-4 runs $0.10/M and $0.30/M — roughly 10x — and kimi additionally
 * requires a paid billing method, so the split also decides whether the
 * free daily neuron allocation covers anything at all. Both are overridable
 * per deployment; see the settings keys below.
 */
const DEFAULT_EXTRACT_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const DEFAULT_PROSE_MODEL = "@cf/moonshotai/kimi-k2.6";

export type ModelRole = "extract" | "prose";

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface RunOpts {
  role?: ModelRole;
  maxTokens?: number;
  /** JSON Schema the reply must satisfy. Enables Workers AI JSON mode. */
  schema?: JsonSchema;
}

/**
 * Models that rejected `response_format`. Workers AI JSON-mode support
 * varies by model, and a rejection costs a wasted call — so remember it for
 * the life of the isolate and go straight to the plain call next time. The
 * prompt still carries the shape, so an unconstrained model degrades to the
 * previous behaviour rather than failing.
 */
const noJsonMode = new Set<string>();

export function aiAvailable(env: Env): boolean {
  return Boolean(env.AI);
}

/** Which model serves a role, most specific setting first. */
export async function modelFor(env: Env, role: ModelRole): Promise<string> {
  const specific = await getSetting(env, role === "prose" ? "ai_model_prose" : "ai_model_extract");
  // `ai_model` / AI_MODEL remain honoured as the both-roles override, so an
  // existing deployment that pinned a model keeps it until it opts in.
  const shared = (await getSetting(env, "ai_model")) || env.AI_MODEL || null;
  return specific || shared || (role === "prose" ? DEFAULT_PROSE_MODEL : DEFAULT_EXTRACT_MODEL);
}

export async function runModel(env: Env, messages: ChatMessage[], opts: RunOpts = {}): Promise<string> {
  if (!env.AI) throw new Error("ai_binding_missing");
  const { role = "extract", maxTokens = 2048, schema } = opts;
  const gatewayId = await getSetting(env, "ai_gateway_id");
  const model = await modelFor(env, role);
  const options = gatewayId ? { gateway: { id: gatewayId } } : undefined;

  const call = async (withSchema: boolean) => {
    const input: Record<string, unknown> = { messages, max_tokens: maxTokens };
    if (withSchema && schema) input.response_format = { type: "json_schema", json_schema: schema };
    const res = (await env.AI!.run(model, input, options)) as {
      response?: string | Record<string, unknown>;
      choices?: Array<{ message?: { content?: string } }>;
    };
    // Workers AI response shapes differ by model, and in JSON mode some
    // return the parsed object rather than a string — normalize to text so
    // every caller keeps one parsing path.
    const raw = res?.response ?? res?.choices?.[0]?.message?.content ?? "";
    return typeof raw === "string" ? raw : JSON.stringify(raw);
  };

  if (schema && !noJsonMode.has(model)) {
    try {
      return await call(true);
    } catch (err) {
      // Constrained decoding is an optimization, never a hard dependency.
      noJsonMode.add(model);
      console.warn(`json mode unsupported on ${model}; falling back`, err);
    }
  }
  return call(false);
}

async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?1")
    .bind(key)
    .first<{ value: string }>();
  return row?.value || null;
}

/**
 * Pull a list of records out of a model response.
 *
 * Accepts all three shapes this can arrive in, because which one you get
 * depends on the model: the `{"records": [...]}` envelope the schema asks
 * for, a bare top-level array (what an unconstrained model tends to emit,
 * and the pre-JSON-mode behaviour), and either of those wrapped in code
 * fences. Anything else yields an empty list rather than throwing — a
 * garbled reply is a source that produced nothing, not a pipeline error.
 */
export function parseJsonArray<T>(text: string): T[] {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  if (!cleaned) return [];

  const slice = (open: string, close: string): unknown => {
    const start = cleaned.indexOf(open);
    const end = cleaned.lastIndexOf(close);
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  };

  // Prefer the envelope: an object holding a single array of records.
  const obj = slice("{", "}");
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const arrays = Object.values(obj as Record<string, unknown>).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0] as T[];
  }

  const arr = slice("[", "]");
  return Array.isArray(arr) ? (arr as T[]) : [];
}

/** Target shape for a connector's records (used by the field auto-mapper). */
export function recordShape(connectorId: string): string | null {
  const shape = RECORD_SHAPES[connectorId];
  return shape ? shapeHint(shape) : null;
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
  const shape: Shape | undefined = RECORD_SHAPES[connectorId];
  if (!shape) return [];
  const text = await runModel(
    env,
    [
      {
        role: "system",
        content:
          "You extract public real-estate records from scraped government web pages for a lending-intelligence pipeline. " +
          'Return ONLY JSON: {"records": [...]} — no prose. Each element must match this exact shape:\n' +
          shapeHint(shape) +
          "\nRules: extract only records visible in the content; never fabricate values; use null when a field is absent; " +
          "normalize names to uppercase; dates to YYYY-MM-DD; dollar amounts to plain numbers. " +
          `Relevant markets: ${markets.join("; ") || "any"}.` +
          (operatorNotes ? ` Operator notes about this source: ${operatorNotes}` : ""),
      },
      { role: "user", content: markdown.slice(0, 48_000) },
    ],
    { maxTokens: 4096, schema: listSchema(shape) }
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
            'Return ONLY JSON: {"records":[{"i":number,"grounded":boolean}]} — one entry per record, no prose. ' +
            "grounded=false if any key value does not appear in the source.",
        },
        {
          role: "user",
          content: `RECORDS:\n${batch.map((r, i) => `${i}: ${JSON.stringify(r)}`).join("\n")}\n\nSOURCE:\n${markdown.slice(0, 40_000)}`,
        },
      ],
      { maxTokens: 2048, schema: GROUNDING_SCHEMA }
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
    { maxTokens: 1024 }
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
    { role: "prose", maxTokens: 1024 }
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
    { role: "prose", maxTokens: 1024 }
  );
}

/* ---------------------- Browser Rendering (scraping) ---------------------- */

/**
 * Fetch a rendered page as markdown via the Browser Rendering REST API —
 * a managed headless browser, so JS-heavy government portals render fully.
 * Requires CLOUDFLARE_ACCOUNT_ID (var) + CLOUDFLARE_API_TOKEN (secret w/ Browser Rendering).
 */
export async function renderPageMarkdown(env: Env, url: string): Promise<string> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) throw new Error("browser_rendering_not_configured");
  // Browser Rendering rate-limits bursts (429) — space retries out instead
  // of failing the run.
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await renderOnce(env, url);
    if (result !== "RATE_LIMITED") return result;
    await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
  }
  throw new Error("browser_rendering 429 — rate limited after 3 attempts; scrape runs are spaced out on the next cron");
}

async function renderOnce(env: Env, url: string): Promise<string> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/markdown`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        gotoOptions: { waitUntil: "networkidle0", timeout: 45_000 },
      }),
    }
  );
  if (res.status === 429) return "RATE_LIMITED";
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 220);
    throw new Error(`browser_rendering ${res.status}${res.status === 403 ? " — the CLOUDFLARE_API_TOKEN likely lacks the Browser Rendering: Edit permission" : ""}${body ? ` — ${body}` : ""}`);
  }
  const body = (await res.json()) as { success: boolean; result?: string };
  if (!body.success || !body.result) throw new Error("browser_rendering_empty");
  return body.result;
}
