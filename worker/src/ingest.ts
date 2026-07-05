/**
 * Ingestion pipeline (cron: weekdays 11:00 UTC, or on demand via admin API).
 *
 * Every connector runs in one of two modes, configured from Settings:
 *
 *  - **api**: pull JSON from an endpoint. Two flavors are auto-detected:
 *      · Socrata open-data resources (ACRIS, DOB, HPD, data.ny.gov — free)
 *        — recognized by the /resource/xxxx-xxxx.json URL shape; rows are
 *        translated through the connector's saved field map (AI can draft
 *        the map once from sample rows; pulls after that are deterministic).
 *      · Normalizing vendor APIs using the contract below.
 *  - **scrape**: render the configured portal URL with Cloudflare Browser
 *    Rendering (managed headless browser), then have Workers AI extract
 *    structured records — followed by a grounding verification pass that
 *    quarantines any record whose values can't be shown in the page.
 *
 * Every record then passes the same integrity gates (sanity checks →
 * quarantine on failure), carries provenance (source, method, confidence),
 * and feeds idempotent upserts, per-source stats, and scoring.
 *
 * API vendor payload contract:
 *   GET {base}/deeds?since=YYYY-MM-DD&markets=County,ST;County,ST
 *     → [{ docNumber, apn?, address, city, county, state, zip?, price,
 *          isCash, deedType?, buyerName, sellerName, recordedAt }]
 *   GET {base}/loans?since=…    → [{ docNumber, …, lenderName, lenderType?,
 *          principal, ratePct?, originatedAt, termMonths?, maturityDate?, borrowerName }]
 *   GET {base}/permits?since=…  → [{ permitNo, …, permitType, valuation, filedAt, ownerName }]
 *   GET {base}/liens?since=…    → [{ docNumber, …, lienType?, claimant, amount, filedAt, ownerName }]
 *   POST {base}/trace { names: string[] }   (Apollo-compatible enrichment)
 */

import type { Env } from "./index";
import { decryptSecret } from "./crypto";
import { rescoreTriggers } from "./scoring";
import { extractRecords, renderPageMarkdown, verifyGrounding } from "./ai";
import { maybeSendDigest } from "./alerts";
import { gateRecords, recordSourceStats, corroborate, type Provenance } from "./integrity";
import { evaluateCustomSignals } from "./signals";
import { generateMergeSuggestions } from "./resolution";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [0, 2000, 8000];

interface ConnectorResult {
  ingested: number;
  skipped: number;
  checksum: string | null;
}

export interface ConnectorCfg {
  id: string;
  enabled: boolean;
  mode: "api" | "scrape";
  baseUrl: string | null;
  scrapeUrl: string | null;
  notes: string | null;
  apiKey: string | null;
  fieldMap: { dateField?: string; where?: string; map?: Record<string, string> } | null;
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
    `SELECT enabled, mode, base_url, scrape_url, notes, field_map, api_key_ct, api_key_iv
     FROM connector_config WHERE id = ?1`
  )
    .bind(id)
    .first<{
      enabled: number; mode: string; base_url: string | null; scrape_url: string | null;
      notes: string | null; field_map: string | null; api_key_ct: string | null; api_key_iv: string | null;
    }>();

  let apiKey: string | null = null;
  const kek = env.ACCESS_CODE || env.ADMIN_TOKEN;
  if (row?.api_key_ct && row.api_key_iv && kek) {
    apiKey = await decryptSecret(kek, row.api_key_ct, row.api_key_iv);
  }
  if (!apiKey && ENV_KEY_FALLBACK[id]) apiKey = (env[ENV_KEY_FALLBACK[id]] as string | undefined) ?? null;

  let fieldMap: ConnectorCfg["fieldMap"] = null;
  if (row?.field_map) {
    try {
      fieldMap = JSON.parse(row.field_map) as ConnectorCfg["fieldMap"];
    } catch {
      fieldMap = null;
    }
  }

  return {
    id,
    enabled: Boolean(row?.enabled),
    mode: row?.mode === "scrape" ? "scrape" : "api",
    baseUrl: row?.base_url?.replace(/\/$/, "") ?? null,
    scrapeUrl: row?.scrape_url ?? null,
    notes: row?.notes ?? null,
    apiKey,
    fieldMap,
  };
}

export async function getMarkets(env: Env): Promise<string[]> {
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

/* ----------------------------- Socrata adapter ----------------------------- */

/** NYC Open Data / data.ny.gov resource endpoints — free, paginated, SoQL. */
export function isSocrataUrl(url: string | null): boolean {
  return Boolean(url && /\/resource\/[a-z0-9]{4}-[a-z0-9]{4}(\.json)?$/i.test(url));
}

/**
 * Fetch a date window from a Socrata resource and translate rows through
 * the connector's field map: { dateField, where?, map: { ourField: theirField } }.
 * Map values starting with "=" are constants (e.g. "state": "=NY"); the
 * optional `where` is ANDed into the SoQL query — how ACRIS-style datasets
 * get filtered to the right document types (e.g. "doc_type = 'MTGE'").
 */
export async function socrataFetch(
  cfg: ConnectorCfg,
  window: { from: string; to: string },
  limit = 1000
): Promise<{ raw: string; rows: Record<string, unknown>[] }> {
  if (!cfg.fieldMap?.dateField || !cfg.fieldMap.map) throw new Error("field_map_missing");
  const dateField = cfg.fieldMap.dateField.replace(/[^a-z0-9_]/gi, "");
  const extra = cfg.fieldMap.where?.replace(/;/g, "").trim();
  const params = new URLSearchParams({
    $where: `${dateField} >= '${window.from}' AND ${dateField} < '${window.to}'${extra ? ` AND (${extra})` : ""}`,
    $limit: String(limit),
    $order: `${dateField} DESC`,
  });
  const headers: Record<string, string> = cfg.apiKey ? { "X-App-Token": cfg.apiKey } : {};
  const raw = await vendorFetch(`${cfg.baseUrl}?${params}`, { headers });
  const source = JSON.parse(raw) as Record<string, unknown>[];
  if (!Array.isArray(source)) throw new Error("socrata_unexpected_payload");

  const NUMERIC = new Set(["price", "principal", "valuation", "amount", "ratePct", "termMonths"]);
  const rows = source.map((src) => {
    const out: Record<string, unknown> = {};
    for (const [ours, theirs] of Object.entries(cfg.fieldMap!.map!)) {
      let v: unknown = theirs.startsWith("=") ? theirs.slice(1) : src[theirs];
      if (typeof v === "string") {
        if (NUMERIC.has(ours)) v = Number(v.replace(/[$,]/g, ""));
        else if (ours === "isCash") v = v === "true" || v === "1" || v === "Y";
        else if (/At$|Date$/.test(ours) && v.length >= 10) v = v.slice(0, 10);
      }
      out[ours] = v ?? null;
    }
    return out;
  });
  return { raw, rows };
}

/* ------------------------- entity/property resolution ------------------------- */

const ENTITY_SUFFIX = /\b(LLC|L\.L\.C\.|LP|LLP|INC|CORP|TRUST|LTD)\b/i;

export function normalizeName(name: string): string {
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

const PROV_COLS = ", source_id, source_url, source_method, confidence, ingested_at";
const provBinds = (p: Provenance) => [p.sourceId, p.sourceUrl, p.method, p.confidence];

interface DeedRec extends AddressRec {
  docNumber: string; price: number; isCash: boolean; deedType?: string | null;
  buyerName: string; sellerName: string; recordedAt: string;
}

async function upsertDeeds(env: Env, rows: DeedRec[], prov: Provenance): Promise<{ ingested: number; skipped: number }> {
  let ingested = 0, skipped = 0;
  for (const r of rows) {
    if (!r?.docNumber || !r.address || !r.buyerName) { skipped++; continue; }
    const propertyId = await resolveProperty(env, r);
    const entityId = await resolveEntity(env, r.buyerName);
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO transactions
         (id, property_id, entity_id, side, price, is_cash, deed_type, buyer_name, seller_name, recorded_at, doc_number, origin${PROV_COLS})
       VALUES (?1, ?2, ?3, 'purchase', ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'live', ?11, ?12, ?13, ?14, datetime('now'))`
    )
      .bind(
        `trx_${crypto.randomUUID().slice(0, 12)}`, propertyId, entityId, Math.round(r.price || 0),
        r.isCash ? 1 : 0, r.deedType ?? null, r.buyerName, r.sellerName, r.recordedAt, r.docNumber,
        ...provBinds(prov)
      )
      .run();
    if (res.meta.changes) ingested++;
    else { skipped++; await corroborate(env, "transactions", r.docNumber, prov.method); }
  }
  return { ingested, skipped };
}

interface LoanRec extends AddressRec {
  docNumber: string; lenderName: string; lenderType?: string | null; principal: number;
  ratePct?: number | null; originatedAt: string; termMonths?: number | null;
  maturityDate?: string | null; borrowerName: string;
}

async function upsertLoans(env: Env, rows: LoanRec[], prov: Provenance): Promise<{ ingested: number; skipped: number }> {
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
          originated_at, term_months, maturity_date, doc_number, origin${PROV_COLS})
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'live', ?12, ?13, ?14, ?15, datetime('now'))`
    )
      .bind(
        `lon_${crypto.randomUUID().slice(0, 12)}`, propertyId, entityId, r.lenderName, lenderType,
        Math.round(r.principal || 0), r.ratePct ?? null, r.originatedAt, r.termMonths ?? 12,
        r.maturityDate ?? null, r.docNumber, ...provBinds(prov)
      )
      .run();
    if (res.meta.changes) ingested++;
    else { skipped++; await corroborate(env, "loans", r.docNumber, prov.method); }
  }
  return { ingested, skipped };
}

interface PermitRec extends AddressRec {
  permitNo: string; permitType: string; description?: string | null; valuation: number;
  filedAt: string; status?: string | null; contractor?: string | null; ownerName: string;
}

async function upsertPermits(env: Env, rows: PermitRec[], prov: Provenance): Promise<{ ingested: number; skipped: number }> {
  let ingested = 0, skipped = 0;
  const types = new Set(["ground_up", "structural", "addition", "demo", "remodel", "pool", "solar", "other"]);
  for (const r of rows) {
    if (!r?.permitNo || !r.address) { skipped++; continue; }
    const propertyId = await resolveProperty(env, r);
    const entityId = await resolveEntity(env, r.ownerName);
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO permits
         (id, property_id, entity_id, permit_no, permit_type, description, valuation, filed_at, status, contractor, origin${PROV_COLS})
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'live', ?11, ?12, ?13, ?14, datetime('now'))`
    )
      .bind(
        `pmt_${crypto.randomUUID().slice(0, 12)}`, propertyId, entityId, r.permitNo,
        types.has(r.permitType) ? r.permitType : "other", r.description ?? null,
        Math.round(r.valuation || 0), r.filedAt, r.status ?? "filed", r.contractor ?? null,
        ...provBinds(prov)
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

const LIEN_TYPES = new Set(["mechanics", "tax", "hoa", "judgment", "lis_pendens", "violation", "auction"]);

function makeLienUpserter(defaultType: string) {
  return async (env: Env, rows: LienRec[], prov: Provenance): Promise<{ ingested: number; skipped: number }> => {
    let ingested = 0, skipped = 0;
    for (const r of rows) {
      if (!r?.docNumber || !r.address || !r.claimant) { skipped++; continue; }
      const propertyId = await resolveProperty(env, r);
      const entityId = await resolveEntity(env, r.ownerName);
      const res = await env.DB.prepare(
        `INSERT OR IGNORE INTO liens
           (id, property_id, entity_id, lien_type, claimant, amount, filed_at, doc_number, origin${PROV_COLS})
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'live', ?9, ?10, ?11, ?12, datetime('now'))`
      )
        .bind(
          `lin_${crypto.randomUUID().slice(0, 12)}`, propertyId, entityId,
          LIEN_TYPES.has(r.lienType ?? "") ? r.lienType! : defaultType, r.claimant,
          Math.round(r.amount || 0), r.filedAt, r.docNumber, ...provBinds(prov)
        )
        .run();
      if (res.meta.changes) ingested++;
      else { skipped++; await corroborate(env, "liens", r.docNumber, prov.method); }
    }
    return { ingested, skipped };
  };
}

interface SatisfactionRec {
  docNumber: string; originalDocNumber?: string | null; lenderName: string;
  borrowerName: string; satisfiedAt: string;
}

/** Satisfactions close the loan lifecycle: match → paid_off + satisfied_at. */
async function applySatisfactions(env: Env, rows: SatisfactionRec[], _prov: Provenance): Promise<{ ingested: number; skipped: number }> {
  let ingested = 0, skipped = 0;
  for (const r of rows) {
    if (!r?.lenderName || !r.satisfiedAt) { skipped++; continue; }
    let res;
    if (r.originalDocNumber) {
      res = await env.DB.prepare(
        `UPDATE loans SET status = 'paid_off', satisfied_at = ?1
         WHERE doc_number = ?2 AND status = 'active'`
      ).bind(r.satisfiedAt, r.originalDocNumber).run();
    } else {
      res = await env.DB.prepare(
        `UPDATE loans SET status = 'paid_off', satisfied_at = ?1
         WHERE id = (
           SELECT l.id FROM loans l JOIN entities e ON e.id = l.entity_id
           WHERE l.status = 'active' AND l.lender_name = ?2 AND e.name = ?3
           ORDER BY l.originated_at DESC LIMIT 1)`
      ).bind(r.satisfiedAt, r.lenderName, normalizeName(r.borrowerName ?? "")).run();
    }
    if (res.meta.changes) ingested++; else skipped++;
  }
  return { ingested, skipped };
}

interface UccRec {
  fileNumber: string; securedParty: string; debtorName: string; filedAt: string;
  address?: string | null; city?: string | null; county?: string | null; state?: string | null;
  collateral?: string | null;
}

/** UCC filings — competitor loan activity that never hits the mortgage rolls. */
async function upsertUcc(env: Env, rows: UccRec[], prov: Provenance): Promise<{ ingested: number; skipped: number }> {
  let ingested = 0, skipped = 0;
  for (const r of rows) {
    if (!r?.fileNumber || !r.securedParty || !r.debtorName) { skipped++; continue; }
    const propertyId = r.address && r.city && r.county && r.state
      ? await resolveProperty(env, { address: r.address, city: r.city, county: r.county, state: r.state })
      : null;
    const entityId = await resolveEntity(env, r.debtorName);
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO loans
         (id, property_id, entity_id, lender_name, lender_type, principal, originated_at, term_months, doc_number, instrument, origin${PROV_COLS})
       VALUES (?1, ?2, ?3, ?4, 'private', 0, ?5, NULL, ?6, 'ucc', 'live', ?7, ?8, ?9, ?10, datetime('now'))`
    )
      .bind(
        `ucc_${crypto.randomUUID().slice(0, 12)}`, propertyId, entityId, r.securedParty,
        r.filedAt, r.fileNumber, ...provBinds(prov)
      )
      .run();
    if (res.meta.changes) ingested++; else skipped++;
  }
  return { ingested, skipped };
}

interface CorpRec {
  entityName: string; formationDate?: string | null; registeredAgent?: string | null;
  county?: string | null; status?: string | null;
}

/** Corporation registry — enriches known entities; never creates new ones. */
async function applyCorpRegistry(env: Env, rows: CorpRec[], _prov: Provenance): Promise<{ ingested: number; skipped: number }> {
  let ingested = 0, skipped = 0;
  for (const r of rows) {
    if (!r?.entityName) { skipped++; continue; }
    const res = await env.DB.prepare(
      `UPDATE entities SET
         formation_date = COALESCE(formation_date, ?1),
         registered_agent = COALESCE(registered_agent, ?2)
       WHERE name = ?3 AND (formation_date IS NULL OR registered_agent IS NULL)`
    )
      .bind(r.formationDate ?? null, r.registeredAgent ?? null, normalizeName(r.entityName))
      .run();
    if (res.meta.changes) ingested++; else skipped++;
  }
  return { ingested, skipped };
}

/* ------------------------------ connectors ------------------------------ */

type Upserter = (env: Env, rows: never[], prov: Provenance) => Promise<{ ingested: number; skipped: number }>;

interface ConnectorDef {
  path: string;              // vendor-contract path segment
  kind: string;              // validation gate kind
  upsert: Upserter;
}

export const RECORD_CONNECTORS: Record<string, ConnectorDef> = {
  county_deeds: { path: "deeds", kind: "deed", upsert: upsertDeeds as Upserter },
  county_loans: { path: "loans", kind: "loan", upsert: upsertLoans as Upserter },
  permits: { path: "permits", kind: "permit", upsert: upsertPermits as Upserter },
  liens: { path: "liens", kind: "lien", upsert: makeLienUpserter("mechanics") as Upserter },
  lis_pendens: { path: "liens", kind: "lien", upsert: makeLienUpserter("lis_pendens") as Upserter },
  violations: { path: "liens", kind: "lien", upsert: makeLienUpserter("violation") as Upserter },
  tax_liens: { path: "liens", kind: "lien", upsert: makeLienUpserter("tax") as Upserter },
  auctions: { path: "liens", kind: "lien", upsert: makeLienUpserter("auction") as Upserter },
  satisfactions: { path: "satisfactions", kind: "satisfaction", upsert: applySatisfactions as Upserter },
  ucc_filings: { path: "ucc", kind: "ucc", upsert: upsertUcc as Upserter },
  corp_registry: { path: "corporations", kind: "corp", upsert: applyCorpRegistry as Upserter },
};

/**
 * Shared acquisition + integrity path. Used by both daily pulls and the
 * historical backfill (which passes an explicit date window).
 */
export async function acquireAndIngest(
  env: Env,
  cfg: ConnectorCfg,
  markets: string[],
  window?: { from: string; to: string }
): Promise<ConnectorResult> {
  const def = RECORD_CONNECTORS[cfg.id];
  let raw: string;
  let rows: Record<string, unknown>[];
  let method: Provenance["method"];
  let confidence: Provenance["confidence"];
  let sourceUrl: string | null;
  let groundingQuarantined = 0;

  if (cfg.mode === "scrape") {
    if (!cfg.scrapeUrl) throw new Error("scrape_url_missing");
    method = "scrape";
    confidence = "extracted";
    sourceUrl = cfg.scrapeUrl;
    raw = await renderPageMarkdown(env, cfg.scrapeUrl);
    const extracted = ((await extractRecords(env, cfg.id, raw, markets, cfg.notes)) as Record<string, unknown>[]).slice(0, 25);
    // Grounding pass: records that can't prove their values in the page are quarantined.
    const grounded = await verifyGrounding(env, extracted, raw);
    rows = [];
    for (let i = 0; i < extracted.length; i++) {
      if (grounded[i]) rows.push(extracted[i]);
      else {
        await env.DB.prepare(
          `INSERT INTO quarantine (id, connector, record_kind, payload_json, reasons_json, source_url)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
        )
          .bind(
            `qtn_${crypto.randomUUID().slice(0, 12)}`, cfg.id, def.kind,
            JSON.stringify(extracted[i]).slice(0, 8_000),
            JSON.stringify(["failed grounding verification against the source page"]),
            cfg.scrapeUrl
          )
          .run();
      }
    }
    groundingQuarantined = extracted.length - rows.length;
  } else {
    if (!cfg.baseUrl) throw new Error("base_url_missing");
    method = "api";
    confidence = "direct";
    sourceUrl = cfg.baseUrl;
    if (isSocrataUrl(cfg.baseUrl)) {
      const w = window ?? { from: sinceDate(), to: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) };
      const result = await socrataFetch(cfg, w);
      raw = result.raw;
      rows = result.rows;
    } else {
      raw = await vendorFetch(vendorUrl(cfg, def.path, markets), { headers: authHeaders(cfg) });
      rows = JSON.parse(raw) as Record<string, unknown>[];
    }
  }

  const { valid, quarantined } = await gateRecords(env, cfg.id, def.kind, rows, markets, sourceUrl);
  const prov: Provenance = { sourceId: cfg.id, sourceUrl, method, confidence };
  const { ingested, skipped } = await def.upsert(env, valid as never[], prov);
  await recordSourceStats(env, cfg.id, ingested, quarantined + groundingQuarantined);
  return { ingested, skipped: skipped + quarantined + groundingQuarantined, checksum: await sha256Hex(raw) };
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

export const CONNECTOR_IDS = [
  "county_deeds", "county_loans", "permits", "liens",
  "lis_pendens", "violations", "tax_liens", "auctions",
  "satisfactions", "ucc_filings", "corp_registry", "skip_trace",
] as const;

export function connectorRunnable(cfg: ConnectorCfg): boolean {
  if (!cfg.enabled) return false;
  return cfg.mode === "scrape" ? Boolean(cfg.scrapeUrl) : Boolean(cfg.baseUrl);
}

async function runConnector(env: Env, cfg: ConnectorCfg, markets: string[]): Promise<ConnectorResult> {
  return cfg.id === "skip_trace" ? runSkipTrace(env, cfg) : acquireAndIngest(env, cfg, markets);
}

/* ------------------------------ orchestration ------------------------------ */

export async function runWithAudit(
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

  // Operator-defined rules and duplicate-entity detection run on fresh data.
  await runWithAudit(env, "custom_signals", async () => ({
    ingested: await evaluateCustomSignals(env),
    skipped: 0,
    checksum: null,
  }));
  await runWithAudit(env, "resolution", async () => ({
    ingested: await generateMergeSuggestions(env),
    skipped: 0,
    checksum: null,
  }));

  await maybeSendDigest(env);

  console.log("ingestion pipeline complete");
}
