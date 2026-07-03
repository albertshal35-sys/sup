/**
 * Ingestion pipeline (cron: weekdays 11:00 UTC, or on demand via admin API).
 *
 * Every connector runs in one of two modes, configured from Settings:
 *
 *  - **api**: pull normalized JSON from a vendor endpoint (contract below).
 *  - **scrape**: render the configured government/portal URL with Cloudflare
 *    Browser Rendering (managed headless browser), then have Workers AI
 *    (@cf/moonshotai/kimi-k2.6 via AI Gateway) extract structured records
 *    from the page — county recorder searches, Accela permit portals and
 *    clerk sites rarely have public APIs, so scraping is the default path.
 *
 * Both modes feed the same idempotent upsert layer (doc/permit numbers are
 * unique), the same retry/audit harness, and the same scoring stage.
 *
 * API vendor payload contract:
 *   GET {base}/deeds?since=YYYY-MM-DD&markets=County,ST;County,ST
 *     → [{ docNumber, apn?, address, city, county, state, zip?, price,
 *          isCash, deedType?, buyerName, sellerName, recordedAt }]
 *   GET {base}/loans?since=…    → [{ docNumber, apn?, address, city, county,
 *          state, lenderName, lenderType?, principal, ratePct?,
 *          originatedAt, termMonths?, maturityDate?, borrowerName }]
 *   GET {base}/permits?since=…  → [{ permitNo, address, city, county, state,
 *          permitType, description?, valuation, filedAt, status?,
 *          contractor?, ownerName }]
 *   GET {base}/liens?since=…    → [{ docNumber, address, city, county, state,
 *          lienType?, claimant, amount, filedAt, ownerName }]
 *   POST {base}/trace { names: string[] }   (Apollo-compatible enrichment)
 *     → [{ entityName, contactName, title?, phone?, email?, linkedin?,
 *          confidence }]
 */

import type { Env } from "./index";
import { decryptSecret } from "./crypto";
import { rescoreTriggers } from "./scoring";
import { extractRecords, renderPageMarkdown } from "./ai";
import { maybeSendDigest } from "./alerts";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [0, 2000, 8000];

interface ConnectorResult {
  ingested: number;
  skipped: number;
  checksum: string | null;
}

interface ConnectorCfg {
  id: string;
  enabled: boolean;
  mode: "api" | "scrape";
  baseUrl: string | null;
  scrapeUrl: string | null;
  notes: string | null;
  apiKey: string | null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

async function vendorFetch(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 45_000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`vendor ${res.status}: ${url.split("?")[0]}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------- config access --------------------------- */

const ENV_KEY_FALLBACK: Record<string, keyof Env> = {
  county_deeds: "COUNTY_API_KEY",
  county_loans: "COUNTY_API_KEY",
  permits: "PERMIT_API_KEY",
  liens: "COUNTY_API_KEY",
  skip_trace: "SKIP_TRACE_API_KEY",
};

export async function getConnectorConfig(env: Env, id: string): Promise<ConnectorCfg> {
  const row = await env.DB.prepare(
    `SELECT enabled, mode, base_url, scrape_url, notes, api_key_ct, api_key_iv
     FROM connector_config WHERE id = ?1`
  )
    .bind(id)
    .first<{
      enabled: number; mode: string; base_url: string | null; scrape_url: string | null;
      notes: string | null; api_key_ct: string | null; api_key_iv: string | null;
    }>();

  let apiKey: string | null = null;
  const kek = env.ACCESS_CODE || env.ADMIN_TOKEN;
  if (row?.api_key_ct && row.api_key_iv && kek) {
    apiKey = await decryptSecret(kek, row.api_key_ct, row.api_key_iv);
  }
  if (!apiKey) apiKey = (env[ENV_KEY_FALLBACK[id]] as string | undefined) ?? null;

  return {
    id,
    enabled: Boolean(row?.enabled),
    mode: row?.mode === "scrape" ? "scrape" : "api",
    baseUrl: row?.base_url?.replace(/\/$/, "") ?? null,
    scrapeUrl: row?.scrape_url ?? null,
    notes: row?.notes ?? null,
    apiKey,
  };
}

async function getMarkets(env: Env): Promise<string[]> {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'markets'").first<{ value: string }>();
  try {
    return row ? (JSON.parse(row.value) as string[]) : [];
  } catch {
    return [];
  }
}

function sinceDate(): string {
  const d = new Date(Date.now() - 2 * 86_400_000); // 2-day overlap; upserts dedupe
  return d.toISOString().slice(0, 10);
}

function vendorUrl(cfg: ConnectorCfg, path: string, markets: string[]): string {
  const params = new URLSearchParams({ since: sinceDate(), markets: markets.join(";") });
  return `${cfg.baseUrl}/${path}?${params}`;
}

function authHeaders(cfg: ConnectorCfg): Record<string, string> {
  return cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
}

/* ------------------------- entity/property resolution ------------------------- */

const ENTITY_SUFFIX = /\b(LLC|L\.L\.C\.|LP|LLP|INC|CORP|TRUST|LTD)\b/i;

function normalizeName(name: string): string {
  return name.toUpperCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
}

async function resolveEntity(env: Env, rawName: string | null | undefined): Promise<string | null> {
  if (!rawName) return null;
  const name = normalizeName(rawName);
  if (!name) return null;
  const existing = await env.DB.prepare("SELECT id FROM entities WHERE name = ?1").bind(name).first<{ id: string }>();
  if (existing) return existing.id;
  const id = `ent_${crypto.randomUUID().slice(0, 12)}`;
  const kind = ENTITY_SUFFIX.test(name) ? (/TRUST/.test(name) ? "trust" : "llc") : "individual";
  await env.DB.prepare("INSERT INTO entities (id, kind, name, origin) VALUES (?1, ?2, ?3, 'live')")
    .bind(id, kind, name)
    .run();
  return id;
}

interface AddressRec {
  apn?: string | null;
  address: string;
  city: string;
  county: string;
  state: string;
  zip?: string | null;
}

async function resolveProperty(env: Env, rec: AddressRec): Promise<string> {
  if (rec.apn) {
    const byApn = await env.DB.prepare(
      "SELECT id FROM properties WHERE apn = ?1 AND county = ?2 AND state = ?3"
    )
      .bind(rec.apn, rec.county, rec.state)
      .first<{ id: string }>();
    if (byApn) return byApn.id;
  }
  const byAddr = await env.DB.prepare(
    "SELECT id FROM properties WHERE address = ?1 AND city = ?2 AND state = ?3"
  )
    .bind(rec.address, rec.city, rec.state)
    .first<{ id: string }>();
  if (byAddr) return byAddr.id;

  const id = `prp_${crypto.randomUUID().slice(0, 12)}`;
  await env.DB.prepare(
    `INSERT INTO properties (id, apn, address, city, county, state, zip, origin)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'live')`
  )
    .bind(id, rec.apn ?? null, rec.address, rec.city, rec.county, rec.state, rec.zip ?? null)
    .run();
  return id;
}

/* ------------------------------ record upserts ------------------------------ */

interface DeedRec extends AddressRec {
  docNumber: string; price: number; isCash: boolean; deedType?: string | null;
  buyerName: string; sellerName: string; recordedAt: string;
}

async function upsertDeeds(env: Env, rows: DeedRec[]): Promise<{ ingested: number; skipped: number }> {
  let ingested = 0, skipped = 0;
  for (const r of rows) {
    if (!r?.docNumber || !r.address || !r.buyerName) { skipped++; continue; }
    const propertyId = await resolveProperty(env, r);
    const entityId = await resolveEntity(env, r.buyerName);
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO transactions
         (id, property_id, entity_id, side, price, is_cash, deed_type, buyer_name, seller_name, recorded_at, doc_number, origin)
       VALUES (?1, ?2, ?3, 'purchase', ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'live')`
    )
      .bind(
        `trx_${crypto.randomUUID().slice(0, 12)}`, propertyId, entityId, Math.round(r.price || 0),
        r.isCash ? 1 : 0, r.deedType ?? null, r.buyerName, r.sellerName, r.recordedAt, r.docNumber
      )
      .run();
    if (res.meta.changes) ingested++; else skipped++;
  }
  return { ingested, skipped };
}

interface LoanRec extends AddressRec {
  docNumber: string; lenderName: string; lenderType?: string | null; principal: number;
  ratePct?: number | null; originatedAt: string; termMonths?: number | null;
  maturityDate?: string | null; borrowerName: string;
}

async function upsertLoans(env: Env, rows: LoanRec[]): Promise<{ ingested: number; skipped: number }> {
  let ingested = 0, skipped = 0;
  const allowedTypes = new Set(["private", "hard_money", "bank", "credit_union", "seller"]);
  for (const r of rows) {
    if (!r?.docNumber || !r.address || !r.lenderName) { skipped++; continue; }
    const propertyId = await resolveProperty(env, r);
    const entityId = await resolveEntity(env, r.borrowerName);
    const lenderType = allowedTypes.has(r.lenderType ?? "") ? r.lenderType! : "private";
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO loans
         (id, property_id, entity_id, lender_name, lender_type, principal, rate_pct,
          originated_at, term_months, maturity_date, doc_number, origin)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'live')`
    )
      .bind(
        `lon_${crypto.randomUUID().slice(0, 12)}`, propertyId, entityId, r.lenderName, lenderType,
        Math.round(r.principal || 0), r.ratePct ?? null, r.originatedAt, r.termMonths ?? 12,
        r.maturityDate ?? null, r.docNumber
      )
      .run();
    if (res.meta.changes) ingested++; else skipped++;
  }
  return { ingested, skipped };
}

interface PermitRec extends AddressRec {
  permitNo: string; permitType: string; description?: string | null; valuation: number;
  filedAt: string; status?: string | null; contractor?: string | null; ownerName: string;
}

async function upsertPermits(env: Env, rows: PermitRec[]): Promise<{ ingested: number; skipped: number }> {
  let ingested = 0, skipped = 0;
  const types = new Set(["ground_up", "structural", "addition", "demo", "remodel", "pool", "solar", "other"]);
  for (const r of rows) {
    if (!r?.permitNo || !r.address) { skipped++; continue; }
    const propertyId = await resolveProperty(env, r);
    const entityId = await resolveEntity(env, r.ownerName);
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO permits
         (id, property_id, entity_id, permit_no, permit_type, description, valuation, filed_at, status, contractor, origin)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'live')`
    )
      .bind(
        `pmt_${crypto.randomUUID().slice(0, 12)}`, propertyId, entityId, r.permitNo,
        types.has(r.permitType) ? r.permitType : "other", r.description ?? null,
        Math.round(r.valuation || 0), r.filedAt, r.status ?? "filed", r.contractor ?? null
      )
      .run();
    if (res.meta.changes) ingested++; else skipped++;
  }
  return { ingested, skipped };
}

interface LienRec extends AddressRec {
  docNumber: string; lienType?: string | null; claimant: string; amount: number;
  filedAt: string; ownerName: string;
}

async function upsertLiens(env: Env, rows: LienRec[]): Promise<{ ingested: number; skipped: number }> {
  let ingested = 0, skipped = 0;
  const types = new Set(["mechanics", "tax", "hoa", "judgment", "lis_pendens"]);
  for (const r of rows) {
    if (!r?.docNumber || !r.address || !r.claimant) { skipped++; continue; }
    const propertyId = await resolveProperty(env, r);
    const entityId = await resolveEntity(env, r.ownerName);
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO liens
         (id, property_id, entity_id, lien_type, claimant, amount, filed_at, doc_number, origin)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'live')`
    )
      .bind(
        `lin_${crypto.randomUUID().slice(0, 12)}`, propertyId, entityId,
        types.has(r.lienType ?? "") ? r.lienType! : "mechanics", r.claimant,
        Math.round(r.amount || 0), r.filedAt, r.docNumber
      )
      .run();
    if (res.meta.changes) ingested++; else skipped++;
  }
  return { ingested, skipped };
}

/* ------------------------------ connectors ------------------------------ */

type Upserter = (env: Env, rows: never[]) => Promise<{ ingested: number; skipped: number }>;

const RECORD_CONNECTORS: Record<string, { path: string; upsert: Upserter }> = {
  county_deeds: { path: "deeds", upsert: upsertDeeds as Upserter },
  county_loans: { path: "loans", upsert: upsertLoans as Upserter },
  permits: { path: "permits", upsert: upsertPermits as Upserter },
  liens: { path: "liens", upsert: upsertLiens as Upserter },
};

/** API or scrape+AI — both produce normalized records for the same upsert. */
async function runRecordConnector(
  env: Env,
  cfg: ConnectorCfg,
  markets: string[]
): Promise<ConnectorResult> {
  const def = RECORD_CONNECTORS[cfg.id];
  let raw: string;
  let rows: never[];

  if (cfg.mode === "scrape") {
    if (!cfg.scrapeUrl) throw new Error("scrape_url_missing");
    raw = await renderPageMarkdown(env, cfg.scrapeUrl);
    rows = (await extractRecords(env, cfg.id, raw, markets, cfg.notes)) as never[];
  } else {
    if (!cfg.baseUrl) throw new Error("base_url_missing");
    raw = await vendorFetch(vendorUrl(cfg, def.path, markets), { headers: authHeaders(cfg) });
    rows = JSON.parse(raw) as never[];
  }

  const { ingested, skipped } = await def.upsert(env, rows);
  return { ingested, skipped, checksum: await sha256Hex(raw) };
}

/** Contact enrichment (Apollo-compatible API). */
async function runSkipTrace(env: Env, cfg: ConnectorCfg): Promise<ConnectorResult> {
  if (!cfg.baseUrl) throw new Error("base_url_missing");
  const targets = await env.DB.prepare(
    `SELECT DISTINCT e.id, e.name FROM triggers t
     JOIN entities e ON e.id = t.entity_id
     WHERE t.status NOT IN ('dismissed','converted')
       AND NOT EXISTS (
         SELECT 1 FROM contacts c WHERE c.entity_id = e.id AND c.confidence >= 0.8
       )
     LIMIT 50`
  ).all<{ id: string; name: string }>();
  if (targets.results.length === 0) return { ingested: 0, skipped: 0, checksum: null };

  const raw = await vendorFetch(`${cfg.baseUrl}/trace`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(cfg) },
    body: JSON.stringify({ names: targets.results.map((t) => t.name) }),
  });
  const rows = JSON.parse(raw) as Array<{
    entityName: string; contactName: string; title?: string; phone?: string;
    email?: string; linkedin?: string; confidence: number;
  }>;
  let ingested = 0, skipped = 0;
  for (const r of rows) {
    const entity = targets.results.find((t) => normalizeName(t.name) === normalizeName(r.entityName));
    if (!entity) { skipped++; continue; }
    await env.DB.prepare(
      `INSERT INTO contacts (id, entity_id, name, title, phone, email, linkedin, source, confidence, verified_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'skip_trace', ?8, date('now'))`
    )
      .bind(
        `con_${crypto.randomUUID().slice(0, 12)}`, entity.id, r.contactName, r.title ?? null,
        r.phone ?? null, r.email ?? null, r.linkedin ?? null, r.confidence
      )
      .run();
    ingested++;
  }
  return { ingested, skipped, checksum: await sha256Hex(raw) };
}

export const CONNECTOR_IDS = ["county_deeds", "county_loans", "permits", "liens", "skip_trace"] as const;

function connectorRunnable(cfg: ConnectorCfg): boolean {
  if (!cfg.enabled) return false;
  return cfg.mode === "scrape" ? Boolean(cfg.scrapeUrl) : Boolean(cfg.baseUrl);
}

async function runConnector(env: Env, cfg: ConnectorCfg, markets: string[]): Promise<ConnectorResult> {
  return cfg.id === "skip_trace" ? runSkipTrace(env, cfg) : runRecordConnector(env, cfg, markets);
}

/* ------------------------------ orchestration ------------------------------ */

async function runWithAudit(
  env: Env,
  name: string,
  run: () => Promise<ConnectorResult>
): Promise<void> {
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
      const result = await run();
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

/** Run one connector (admin "Run now"). Returns false if disabled/unconfigured. */
export async function runSingleConnector(env: Env, id: string): Promise<boolean> {
  if (!(CONNECTOR_IDS as readonly string[]).includes(id)) return false;
  const cfg = await getConnectorConfig(env, id);
  if (!connectorRunnable(cfg)) return false;
  const markets = await getMarkets(env);
  await runWithAudit(env, id, () => runConnector(env, cfg, markets));
  await runWithAudit(env, "scoring", async () => ({
    ingested: await rescoreTriggers(env),
    skipped: 0,
    checksum: null,
  }));
  return true;
}

export async function runIngestionPipeline(env: Env, scheduledFor: Date): Promise<void> {
  console.log(`ingestion pipeline start ${scheduledFor.toISOString()}`);
  const markets = await getMarkets(env);

  for (const id of CONNECTOR_IDS) {
    const cfg = await getConnectorConfig(env, id);
    if (!connectorRunnable(cfg)) continue; // not yet configured — skip silently
    await runWithAudit(env, id, () => runConnector(env, cfg, markets));
  }

  await runWithAudit(env, "scoring", async () => ({
    ingested: await rescoreTriggers(env),
    skipped: 0,
    checksum: null,
  }));

  await maybeSendDigest(env);

  console.log("ingestion pipeline complete");
}
