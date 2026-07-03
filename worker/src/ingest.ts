/**
 * Hardened daily ingestion pipeline (cron: weekdays 11:00 UTC).
 *
 * Design goals:
 *  - Each connector runs independently; one failing source never blocks the rest.
 *  - Exponential-backoff retries (3 attempts) around every vendor call.
 *  - Every run writes an audit row to ingestion_runs (status, counts, checksum)
 *    so reliability is observable from the dashboard.
 *  - Idempotent upserts keyed on (doc_number/permit_no + county) — re-running
 *    a day is safe.
 *  - Scoring is a separate, final stage that only runs against committed data.
 *
 * The vendor connectors below are production-shaped stubs: they define the
 * fetch/normalize/upsert contract and read API keys from env, but return
 * empty sets until real vendor credentials + endpoints are configured.
 */

import type { Env } from "./index";
import { rescoreTriggers } from "./scoring";

interface ConnectorResult {
  ingested: number;
  skipped: number;
  checksum: string | null;
}

type Connector = (env: Env) => Promise<ConnectorResult>;

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [0, 2000, 8000];

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

/** Fetch with timeout + non-2xx as error, so retries engage uniformly. */
async function vendorFetch(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`vendor ${res.status}: ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Connectors — one per source. Swap stub bodies for real vendor APIs. */
/* ------------------------------------------------------------------ */

const countyDeeds: Connector = async (env) => {
  if (!env.COUNTY_API_KEY) return { ingested: 0, skipped: 0, checksum: null };
  // Example contract:
  //   const raw = await vendorFetch(`https://api.recorder-vendor.com/v2/deeds?since=yesterday`, {
  //     headers: { Authorization: `Bearer ${env.COUNTY_API_KEY}` } });
  //   normalize → INSERT OR IGNORE INTO transactions ... keyed on doc_number
  const raw = "[]";
  return { ingested: 0, skipped: 0, checksum: await sha256Hex(raw) };
};

const countyLoans: Connector = async (env) => {
  if (!env.COUNTY_API_KEY) return { ingested: 0, skipped: 0, checksum: null };
  // Deeds of trust / mortgages recorded yesterday → loans table.
  // maturity_date = COALESCE(recorded, originated_at + term_months).
  const raw = "[]";
  return { ingested: 0, skipped: 0, checksum: await sha256Hex(raw) };
};

const permits: Connector = async (env) => {
  if (!env.PERMIT_API_KEY) return { ingested: 0, skipped: 0, checksum: null };
  // Municipal portals / Shovels-style aggregator → permits table,
  // filtered to structural/ground_up/addition above a valuation floor.
  const raw = "[]";
  return { ingested: 0, skipped: 0, checksum: await sha256Hex(raw) };
};

const liens: Connector = async (env) => {
  if (!env.COUNTY_API_KEY) return { ingested: 0, skipped: 0, checksum: null };
  // Mechanics liens + lis pendens recorded yesterday → liens table.
  const raw = "[]";
  return { ingested: 0, skipped: 0, checksum: await sha256Hex(raw) };
};

const skipTrace: Connector = async (env) => {
  if (!env.SKIP_TRACE_API_KEY) return { ingested: 0, skipped: 0, checksum: null };
  // For entities that gained a trigger but have no contact rows with
  // confidence >= 0.8: resolve principals via SoS filings, then phone/email
  // via skip-trace vendor → contacts table.
  const raw = "[]";
  return { ingested: 0, skipped: 0, checksum: await sha256Hex(raw) };
};

const CONNECTORS: Array<[name: string, run: Connector]> = [
  ["county_deeds", countyDeeds],
  ["county_loans", countyLoans],
  ["permits", permits],
  ["liens", liens],
  ["skip_trace", skipTrace],
];

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

async function runWithAudit(env: Env, name: string, connector: Connector): Promise<void> {
  const runId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO ingestion_runs (id, connector, started_at, status) VALUES (?1, ?2, datetime('now'), 'running')"
  )
    .bind(runId, name)
    .run();

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (BACKOFF_MS[attempt - 1]) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
      const result = await connector(env);
      await env.DB.prepare(
        `UPDATE ingestion_runs SET finished_at = datetime('now'), status = 'ok',
         rows_ingested = ?1, rows_skipped = ?2, attempts = ?3, checksum = ?4 WHERE id = ?5`
      )
        .bind(result.ingested, result.skipped, attempt, result.checksum, runId)
        .run();
      return;
    } catch (err) {
      lastError = err;
      console.warn(`connector ${name} attempt ${attempt} failed`, err);
    }
  }
  await env.DB.prepare(
    "UPDATE ingestion_runs SET finished_at = datetime('now'), status = 'failed', attempts = ?1, error = ?2 WHERE id = ?3"
  )
    .bind(MAX_ATTEMPTS, String(lastError).slice(0, 500), runId)
    .run();
}

export async function runIngestionPipeline(env: Env, scheduledFor: Date): Promise<void> {
  console.log(`ingestion pipeline start ${scheduledFor.toISOString()}`);

  // Sources run sequentially to stay inside D1 write limits; each is
  // independently retried and audited.
  for (const [name, connector] of CONNECTORS) {
    await runWithAudit(env, name, connector);
  }

  // Final stage: recompute materialized triggers + entity performance
  // snapshots from whatever data committed above.
  await runWithAudit(env, "scoring", async () => {
    const emitted = await rescoreTriggers(env);
    return { ingested: emitted, skipped: 0, checksum: null };
  });

  console.log("ingestion pipeline complete");
}

// referenced by connector stubs' documented contract
void vendorFetch;
