/**
 * Ingestion pipeline (queue-seeded by daily 11:00/23:00 UTC crons, drained
 * by the 10-minute tick, or on demand via the admin API).
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
import { gateRecords, recordSourceStats, corroborateStmt, type Provenance } from "./integrity";
import { acrisCapable, acrisFetch, isAcrisMaster } from "./acris";
import { evaluateCustomSignals } from "./signals";
import { generateMergeSuggestions } from "./resolution";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [0, 2000, 8000];

interface ConnectorResult {
  ingested: number;
  skipped: number;
  checksum: string | null;
  /** The source held more rows in this window than the pull budget allowed. */
  truncated?: boolean;
  /** Oldest date actually reached (YYYY-MM-DD) — where a truncated window resumes. */
  resumeCursor?: string | null;
}

export interface ConnectorCfg {
  id: string;
  enabled: boolean;
  mode: "api" | "scrape";
  baseUrl: string | null;
  scrapeUrl: string | null;
  notes: string | null;
  apiKey: string | null;
  fieldMap: {
    dateField?: string;
    where?: string;
    map?: Record<string, string>;
    /** ACRIS only: documents to read per window in one run. */
    docBudget?: number;
  } | null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

export async function vendorFetch(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 45_000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      // Socrata/vendor 4xx bodies name the exact problem (bad column, bad
      // SoQL…) — surface it instead of a bare status code.
      const body = (await res.text().catch(() => "")).slice(0, 220);
      throw new Error(`vendor ${res.status}: ${url.split("?")[0]}${body ? ` — ${body}` : ""}`);
    }
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

export function vendorUrl(cfg: ConnectorCfg, path: string, markets: string[]): string {
  const params = new URLSearchParams({ since: sinceDate(), markets: markets.join(";") });
  return `${cfg.baseUrl}/${path}?${params}`;
}

export function connectorAuthHeaders(cfg: ConnectorCfg): Record<string, string> {
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
        else if (/At$|Date$/.test(ours)) {
          if (/^\d{8}$/.test(v)) v = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
          else if (v.length >= 10) v = v.slice(0, 10);
        }
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
    "SELECT id, apn FROM properties WHERE address = ?1 AND city = ?2 AND state = ?3"
  )
    .bind(rec.address, rec.city, rec.state)
    .first<{ id: string; apn: string | null }>();
  if (byAddr) {
    // Rows first seen through an address-only source (or before this
    // connector learned to carry a parcel key) get their APN filled in the
    // moment one arrives, so later documents can match on the key instead
    // of on exact address spelling. Guarded: never overwrite a different
    // APN, and ignore the collision if that parcel already has a row.
    if (rec.apn && !byAddr.apn) {
      await env.DB.prepare(
        "UPDATE OR IGNORE properties SET apn = ?1 WHERE id = ?2 AND apn IS NULL"
      )
        .bind(rec.apn, byAddr.id)
        .run();
    }
    return byAddr.id;
  }

  const id = `prp_${crypto.randomUUID().slice(0, 12)}`;
  await env.DB.prepare(
    `INSERT INTO properties (id, apn, address, city, county, state, zip, origin)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'live')`
  )
    .bind(id, rec.apn ?? null, rec.address, rec.city, rec.county, rec.state, rec.zip ?? null)
    .run();
  return id;
}

/* --------------------- bulk resolution + batched writes --------------------- */

/**
 * Ingesting a page of records the naive way costs ~4 sequential D1 round
 * trips per row (property lookup, property insert, entity lookup, entity
 * insert) before the record itself is written. At ACRIS scale that, not the
 * HTTP fetch, is what caps how much of a window one invocation can absorb.
 *
 * The resolver below pre-resolves every property and entity a page needs in
 * a handful of round trips — grouped `IN (...)` reads, then one batched
 * write for whatever was missing — so the per-row cost collapses to a single
 * batched insert. That is what makes a large `$limit` worth asking for.
 */

/** Keep `IN (...)` lists and batches inside D1's bind/statement limits. */
const IN_CHUNK = 90;
const STMT_BATCH = 100;

function chunked<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Run statements in batched round trips; returns each statement's row count. */
async function runBatched(env: Env, stmts: D1PreparedStatement[]): Promise<number[]> {
  const changes: number[] = [];
  for (const group of chunked(stmts, STMT_BATCH)) {
    const results = await env.DB.batch(group);
    for (const r of results) changes.push(r.meta?.changes ?? 0);
  }
  return changes;
}

const placeholders = (n: number) => Array.from({ length: n }, (_, i) => `?${i + 1}`).join(",");

/** A parcel is identified by its APN when it has one, else by its address. */
function propKey(rec: AddressRec): string {
  return rec.apn
    ? `a|${rec.apn}|${rec.county}|${rec.state}`
    : `s|${rec.address}|${rec.city}|${rec.state}`;
}

class BulkResolver {
  private props = new Map<string, string>();
  private ents = new Map<string, string>();

  constructor(private env: Env) {}

  /** Resolve everything this page needs. Safe to call once per page. */
  async warm(records: AddressRec[], names: (string | null | undefined)[]): Promise<void> {
    await this.warmProperties(records);
    await this.warmEntities(names);
  }

  property(rec: AddressRec): string | null {
    return this.props.get(propKey(rec)) ?? null;
  }

  entity(rawName: string | null | undefined): string | null {
    const name = normalizeName(rawName ?? "");
    return name ? this.ents.get(name) ?? null : null;
  }

  private async warmProperties(records: AddressRec[]): Promise<void> {
    const unique = new Map<string, AddressRec>();
    for (const r of records) if (r?.address) unique.set(propKey(r), r);
    if (unique.size === 0) return;
    const recs = [...unique.values()];

    const apns = [...new Set(recs.map((r) => r.apn).filter(Boolean))] as string[];
    const addrs = [...new Set(recs.map((r) => r.address))];

    const byApn = new Map<string, string>();
    for (const c of chunked(apns, IN_CHUNK)) {
      const res = await this.env.DB.prepare(
        `SELECT id, apn, county, state FROM properties WHERE apn IN (${placeholders(c.length)})`
      )
        .bind(...c)
        .all<{ id: string; apn: string; county: string; state: string }>();
      for (const row of res.results) byApn.set(`${row.apn}|${row.county}|${row.state}`, row.id);
    }

    const byAddr = new Map<string, { id: string; apn: string | null }>();
    for (const c of chunked(addrs, IN_CHUNK)) {
      const res = await this.env.DB.prepare(
        `SELECT id, apn, address, city, state FROM properties WHERE address IN (${placeholders(c.length)})`
      )
        .bind(...c)
        .all<{ id: string; apn: string | null; address: string; city: string; state: string }>();
      for (const row of res.results) {
        const k = `${row.address}|${row.city}|${row.state}`;
        if (!byAddr.has(k)) byAddr.set(k, { id: row.id, apn: row.apn });
      }
    }

    const inserts: D1PreparedStatement[] = [];
    const backfills: D1PreparedStatement[] = [];
    const createdApnKeys: { apn: string; county: string; state: string; key: string }[] = [];

    for (const [key, rec] of unique) {
      const apnHit = rec.apn ? byApn.get(`${rec.apn}|${rec.county}|${rec.state}`) : undefined;
      if (apnHit) {
        this.props.set(key, apnHit);
        continue;
      }
      const addrKey = `${rec.address}|${rec.city}|${rec.state}`;
      const addrHit = byAddr.get(addrKey);
      if (addrHit) {
        this.props.set(key, addrHit.id);
        // Same APN backfill the per-row path does: a property first seen
        // through an address-only source gets its parcel key the moment a
        // document supplies one.
        if (rec.apn && !addrHit.apn) {
          backfills.push(
            this.env.DB.prepare(
              "UPDATE OR IGNORE properties SET apn = ?1 WHERE id = ?2 AND apn IS NULL"
            ).bind(rec.apn, addrHit.id)
          );
          addrHit.apn = rec.apn; // don't queue the same backfill twice
        }
        continue;
      }

      const id = `prp_${crypto.randomUUID().slice(0, 12)}`;
      this.props.set(key, id);
      byAddr.set(addrKey, { id, apn: rec.apn ?? null });
      if (rec.apn) {
        byApn.set(`${rec.apn}|${rec.county}|${rec.state}`, id);
        createdApnKeys.push({ apn: rec.apn, county: rec.county, state: rec.state, key });
      }
      inserts.push(
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO properties (id, apn, address, city, county, state, zip, origin)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'live')`
        ).bind(id, rec.apn ?? null, rec.address, rec.city, rec.county, rec.state, rec.zip ?? null)
      );
    }

    await runBatched(this.env, inserts);
    await runBatched(this.env, backfills);

    // `properties` is UNIQUE (apn, county, state). If a concurrent
    // invocation created one of these parcels between our read and our
    // write, OR IGNORE dropped our insert and the id we handed out points
    // at nothing. Re-read the parcels we believe we just created and adopt
    // whatever id actually won, so no record can reference a missing row.
    if (createdApnKeys.length > 0) {
      for (const c of chunked(createdApnKeys, IN_CHUNK)) {
        const res = await this.env.DB.prepare(
          `SELECT id, apn, county, state FROM properties WHERE apn IN (${placeholders(c.length)})`
        )
          .bind(...c.map((k) => k.apn))
          .all<{ id: string; apn: string; county: string; state: string }>();
        const actual = new Map(res.results.map((r) => [`${r.apn}|${r.county}|${r.state}`, r.id]));
        for (const k of c) {
          const winner = actual.get(`${k.apn}|${k.county}|${k.state}`);
          if (winner) this.props.set(k.key, winner);
        }
      }
    }
  }

  private async warmEntities(names: (string | null | undefined)[]): Promise<void> {
    const unique = [...new Set(names.map((n) => normalizeName(n ?? "")).filter(Boolean))];
    if (unique.length === 0) return;

    for (const c of chunked(unique, IN_CHUNK)) {
      const res = await this.env.DB.prepare(
        `SELECT id, name FROM entities WHERE name IN (${placeholders(c.length)})`
      )
        .bind(...c)
        .all<{ id: string; name: string }>();
      for (const row of res.results) this.ents.set(row.name, row.id);
    }

    const inserts: D1PreparedStatement[] = [];
    for (const name of unique) {
      if (this.ents.has(name)) continue;
      const id = `ent_${crypto.randomUUID().slice(0, 12)}`;
      const kind = ENTITY_SUFFIX.test(name) ? (/TRUST/.test(name) ? "trust" : "llc") : "individual";
      this.ents.set(name, id);
      inserts.push(
        this.env.DB.prepare("INSERT INTO entities (id, kind, name, origin) VALUES (?1, ?2, ?3, 'live')")
          .bind(id, kind, name)
      );
    }
    await runBatched(this.env, inserts);
  }
}

/* ------------------------------ record upserts ------------------------------ */

const PROV_COLS = ", source_id, source_url, source_method, confidence, ingested_at";
const provBinds = (p: Provenance) => [p.sourceId, p.sourceUrl, p.method, p.confidence];

interface DeedRec extends AddressRec {
  docNumber: string; price: number; isCash: boolean; deedType?: string | null;
  buyerName: string; sellerName: string; recordedAt: string;
  sourceModifiedAt?: string | null; percentTransferred?: number | null;
}

async function upsertDeeds(env: Env, rows: DeedRec[], prov: Provenance): Promise<{ ingested: number; skipped: number }> {
  const usable = rows.filter((r) => r?.docNumber && r.address && r.buyerName);
  let skipped = rows.length - usable.length;
  if (usable.length === 0) return { ingested: 0, skipped };

  const resolver = new BulkResolver(env);
  await resolver.warm(usable, usable.map((r) => r.buyerName));

  const ready = usable.filter((r) => resolver.property(r));
  skipped += usable.length - ready.length;

  const stmts = ready.map((r) =>
    env.DB.prepare(
      `INSERT INTO transactions
         (id, property_id, entity_id, side, price, is_cash, deed_type, buyer_name, seller_name,
          recorded_at, doc_number, source_modified_at, percent_transferred, origin${PROV_COLS})
       VALUES (?1, ?2, ?3, 'purchase', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'live', ?13, ?14, ?15, ?16, datetime('now'))
       ON CONFLICT(doc_number) WHERE doc_number IS NOT NULL DO UPDATE SET
         property_id = excluded.property_id, entity_id = excluded.entity_id,
         price = excluded.price, deed_type = excluded.deed_type,
         buyer_name = excluded.buyer_name, seller_name = excluded.seller_name,
         recorded_at = excluded.recorded_at, percent_transferred = excluded.percent_transferred,
         source_modified_at = excluded.source_modified_at, ingested_at = datetime('now')
       WHERE excluded.source_modified_at > COALESCE(transactions.source_modified_at, '')`
    ).bind(
      `trx_${crypto.randomUUID().slice(0, 12)}`, resolver.property(r), resolver.entity(r.buyerName),
      Math.round(r.price || 0), r.isCash ? 1 : 0, r.deedType ?? null, r.buyerName, r.sellerName,
      r.recordedAt, r.docNumber, r.sourceModifiedAt ?? null, r.percentTransferred ?? null,
      ...provBinds(prov)
    )
  );
  const changes = await runBatched(env, stmts);

  let ingested = 0;
  const corroborations: D1PreparedStatement[] = [];
  for (let i = 0; i < ready.length; i++) {
    if (changes[i]) ingested++;
    else { skipped++; corroborations.push(corroborateStmt(env, "transactions", ready[i].docNumber, prov.method)); }
  }
  await runBatched(env, corroborations);
  return { ingested, skipped };
}

interface LoanRec extends AddressRec {
  docNumber: string; lenderName: string; lenderType?: string | null; principal: number;
  ratePct?: number | null; originatedAt: string; termMonths?: number | null;
  maturityDate?: string | null; borrowerName: string;
  sourceModifiedAt?: string | null;
}

async function upsertLoans(env: Env, rows: LoanRec[], prov: Provenance): Promise<{ ingested: number; skipped: number }> {
  const allowedTypes = new Set(["private", "hard_money", "bank", "credit_union", "seller"]);
  const usable = rows.filter((r) => r?.docNumber && r.address && r.lenderName);
  let skipped = rows.length - usable.length;
  if (usable.length === 0) return { ingested: 0, skipped };

  const resolver = new BulkResolver(env);
  await resolver.warm(usable, usable.map((r) => r.borrowerName));

  const ready = usable.filter((r) => resolver.property(r));
  skipped += usable.length - ready.length;

  const stmts = ready.map((r) =>
    env.DB.prepare(
      `INSERT INTO loans
         (id, property_id, entity_id, lender_name, lender_type, principal, rate_pct,
          originated_at, term_months, maturity_date, doc_number, source_modified_at, origin${PROV_COLS})
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'live', ?13, ?14, ?15, ?16, datetime('now'))
       ON CONFLICT(doc_number) WHERE doc_number IS NOT NULL DO UPDATE SET
         property_id = excluded.property_id, entity_id = excluded.entity_id,
         lender_name = excluded.lender_name, lender_type = excluded.lender_type,
         principal = excluded.principal, originated_at = excluded.originated_at,
         source_modified_at = excluded.source_modified_at, ingested_at = datetime('now')
       WHERE excluded.source_modified_at > COALESCE(loans.source_modified_at, '')`
    ).bind(
      `lon_${crypto.randomUUID().slice(0, 12)}`, resolver.property(r), resolver.entity(r.borrowerName),
      r.lenderName, allowedTypes.has(r.lenderType ?? "") ? r.lenderType! : "private",
      Math.round(r.principal || 0), r.ratePct ?? null, r.originatedAt, r.termMonths ?? 12,
      r.maturityDate ?? null, r.docNumber, r.sourceModifiedAt ?? null, ...provBinds(prov)
    )
  );
  const changes = await runBatched(env, stmts);

  let ingested = 0;
  const corroborations: D1PreparedStatement[] = [];
  for (let i = 0; i < ready.length; i++) {
    if (changes[i]) ingested++;
    else { skipped++; corroborations.push(corroborateStmt(env, "loans", ready[i].docNumber, prov.method)); }
  }
  await runBatched(env, corroborations);
  return { ingested, skipped };
}

interface PermitRec extends AddressRec {
  permitNo: string; permitType: string; description?: string | null; valuation: number;
  filedAt: string; status?: string | null; contractor?: string | null; ownerName: string;
}

async function upsertPermits(env: Env, rows: PermitRec[], prov: Provenance): Promise<{ ingested: number; skipped: number }> {
  const types = new Set(["ground_up", "structural", "addition", "demo", "remodel", "pool", "solar", "other"]);
  const usable = rows.filter((r) => r?.permitNo && r.address);
  let skipped = rows.length - usable.length;
  if (usable.length === 0) return { ingested: 0, skipped };

  const resolver = new BulkResolver(env);
  await resolver.warm(usable, usable.map((r) => r.ownerName));

  const ready = usable.filter((r) => resolver.property(r));
  skipped += usable.length - ready.length;

  const stmts = ready.map((r) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO permits
         (id, property_id, entity_id, permit_no, permit_type, description, valuation, filed_at, status, contractor, origin${PROV_COLS})
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'live', ?11, ?12, ?13, ?14, datetime('now'))`
    ).bind(
      `pmt_${crypto.randomUUID().slice(0, 12)}`, resolver.property(r), resolver.entity(r.ownerName),
      r.permitNo, types.has(r.permitType) ? r.permitType : "other", r.description ?? null,
      Math.round(r.valuation || 0), r.filedAt, r.status ?? "filed", r.contractor ?? null,
      ...provBinds(prov)
    )
  );
  const changes = await runBatched(env, stmts);
  const ingested = changes.filter(Boolean).length;
  return { ingested, skipped: skipped + (ready.length - ingested) };
}

interface LienRec extends AddressRec {
  docNumber: string; lienType?: string | null; claimant: string; amount: number;
  filedAt: string; ownerName: string; sourceModifiedAt?: string | null;
}

const LIEN_TYPES = new Set(["mechanics", "tax", "hoa", "judgment", "lis_pendens", "violation", "auction"]);

function makeLienUpserter(defaultType: string) {
  return async (env: Env, rows: LienRec[], prov: Provenance): Promise<{ ingested: number; skipped: number }> => {
    const usable = rows.filter((r) => r?.docNumber && r.address && r.claimant);
    let skipped = rows.length - usable.length;
    if (usable.length === 0) return { ingested: 0, skipped };

    const resolver = new BulkResolver(env);
    await resolver.warm(usable, usable.map((r) => r.ownerName));

    const ready = usable.filter((r) => resolver.property(r));
    skipped += usable.length - ready.length;

    const stmts = ready.map((r) =>
      env.DB.prepare(
        `INSERT INTO liens
           (id, property_id, entity_id, lien_type, claimant, amount, filed_at, doc_number,
            source_modified_at, origin${PROV_COLS})
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'live', ?10, ?11, ?12, ?13, datetime('now'))
         ON CONFLICT(doc_number) WHERE doc_number IS NOT NULL DO UPDATE SET
           property_id = excluded.property_id, entity_id = excluded.entity_id,
           claimant = excluded.claimant, amount = excluded.amount, filed_at = excluded.filed_at,
           source_modified_at = excluded.source_modified_at, ingested_at = datetime('now')
         WHERE excluded.source_modified_at > COALESCE(liens.source_modified_at, '')`
      ).bind(
        `lin_${crypto.randomUUID().slice(0, 12)}`, resolver.property(r), resolver.entity(r.ownerName),
        LIEN_TYPES.has(r.lienType ?? "") ? r.lienType! : defaultType, r.claimant,
        Math.round(r.amount || 0), r.filedAt, r.docNumber, r.sourceModifiedAt ?? null,
        ...provBinds(prov)
      )
    );
    const changes = await runBatched(env, stmts);

    let ingested = 0;
    const corroborations: D1PreparedStatement[] = [];
    for (let i = 0; i < ready.length; i++) {
      if (changes[i]) ingested++;
      else { skipped++; corroborations.push(corroborateStmt(env, "liens", ready[i].docNumber, prov.method)); }
    }
    await runBatched(env, corroborations);
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
  let truncated = false;
  let resumeCursor: string | null = null;

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
    // Open-data portals publish with a lag (ACRIS often runs weeks behind),
    // so a tight window returns nothing. Daily pulls scan back 45 days —
    // idempotent doc-number upserts make the overlap free.
    const lookbackDays = isAcrisMaster(cfg.baseUrl) || isSocrataUrl(cfg.baseUrl) ? 45 : 2;
    const w = window ?? {
      from: new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10),
      to: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    };
    if (isAcrisMaster(cfg.baseUrl) && acrisCapable(cfg.id)) {
      // NYC ACRIS: native multi-dataset join (Master + Legals + Parties,
      // plus References for satisfactions). Lien-family connectors resolve
      // their doc_type codes from the city's code table on first pull; the
      // filter persists to the field map.
      //
      // A caller-supplied window means the historical backfill is walking
      // recording history, so it filters on recorded_datetime. A routine
      // catch-up pull filters on modified_date instead: DOF republishes
      // documents "recorded OR corrected" each month, and a corrected 2019
      // document still carries its 2019 recorded date — filtering on
      // recorded_datetime would never surface the correction.
      const result = await acrisFetch(env, cfg, w, window ? "recorded_datetime" : "modified_date");
      raw = result.raw;
      rows = result.rows;
      truncated = result.truncated;
      resumeCursor = result.oldestRecorded;
    } else if (isSocrataUrl(cfg.baseUrl)) {
      const result = await socrataFetch(cfg, w);
      raw = result.raw;
      rows = result.rows;
    } else {
      raw = await vendorFetch(vendorUrl(cfg, def.path, markets), { headers: connectorAuthHeaders(cfg) });
      rows = JSON.parse(raw) as Record<string, unknown>[];
    }
  }

  const { valid, quarantined } = await gateRecords(env, cfg.id, def.kind, rows, markets, sourceUrl);
  const prov: Provenance = { sourceId: cfg.id, sourceUrl, method, confidence };
  const { ingested, skipped } = await def.upsert(env, valid as never[], prov);
  await recordSourceStats(env, cfg.id, ingested, quarantined + groundingQuarantined);
  return {
    ingested,
    skipped: skipped + quarantined + groundingQuarantined,
    checksum: await sha256Hex(raw),
    truncated,
    resumeCursor,
  };
}

/**
 * Manual "Run now" on the enrichment connector: enrich the top 5 open-signal
 * borrowers that still lack a confident contact — bounded, never scheduled.
 * (Per-borrower enrichment lives on the resume's Enrich button.)
 */
async function runSkipTrace(env: Env, _cfg: ConnectorCfg): Promise<ConnectorResult> {
  const { enrichEntity } = await import("./apollo"); // dynamic import avoids a circular module init
  const targets = await env.DB.prepare(
    `SELECT DISTINCT e.id FROM triggers t
     JOIN entities e ON e.id = t.entity_id
     WHERE t.status NOT IN ('dismissed','converted')
       AND NOT EXISTS (
         SELECT 1 FROM contacts c WHERE c.entity_id = e.id AND c.confidence >= 0.8
       )
     ORDER BY t.score DESC
     LIMIT 5`
  ).all<{ id: string }>();
  let ingested = 0, skipped = 0;
  for (const t of targets.results) {
    const res = await enrichEntity(env, t.id);
    if (res.ok && res.contacts.length > 0) ingested += res.contacts.length;
    else skipped++;
    if (!res.ok && (res.error === "apollo_key_missing" || res.error === "apollo_key_rejected")) {
      throw new Error(res.error);
    }
  }
  return { ingested, skipped, checksum: null };
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

/* ----------------------- background work queue ----------------------- */

/**
 * Workers cap upstream fetches per invocation (50 on the Free plan), and a
 * single ACRIS-join pull costs up to ~9. Running every connector inside one
 * cron invocation therefore fails silently partway through once enough
 * sources are enabled — the connectors that happen to run first ingest fine
 * and the rest never do, which reads as "the pipeline is broken" with no
 * error anywhere. So the pipeline never does that: the twice-daily cron
 * only *seeds* a queue, and the existing 10-minute tick drains a couple of
 * pulls per invocation, each safely inside the budget. Analytics (scoring,
 * custom signals, entity resolution, digest) run once, when the queue
 * empties.
 */
const PULLS_PER_TICK = 2;

/**
 * Sweep slots are computed in code because only ONE cron trigger is
 * registered (Cloudflare caps schedules per account on the Free plan —
 * registering separate 11:00/23:00 crons made the whole trigger deploy
 * fail). Each UTC day has two sweep boundaries, 11:00 and 23:00; the
 * 10-minute tick seeds the queue the first time it runs inside a new
 * slot, which also self-recovers after downtime.
 */
function currentSweepSlot(now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  const hour = now.getUTCHours();
  if (hour >= 23) return `${day}:23`;
  if (hour >= 11) return `${day}:11`;
  const prev = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  return `${prev}:23`;
}

/** Seed the queue once per sweep slot; no-op (one cheap read) otherwise. */
export async function maybeSeedDailyPulls(env: Env): Promise<void> {
  const slot = currentSweepSlot();
  const last = await env.DB.prepare(
    "SELECT value FROM app_settings WHERE key = 'last_sweep_slot'"
  ).first<{ value: string }>();
  if (last?.value === slot) return;
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('last_sweep_slot', ?1)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`
  ).bind(slot).run();
  await seedDailyPulls(env);
}

/** Enqueue every runnable connector for a pull; self-heal missing backfills. */
export async function seedDailyPulls(env: Env): Promise<number> {
  const { backfillEligible, startBackfill } = await import("./backfill");
  let queued = 0;
  for (const id of CONNECTOR_IDS) {
    if (id === "skip_trace") continue; // Apollo enrichment is on-demand only — credits are never spent in bulk
    const cfg = await getConnectorConfig(env, id);
    if (!connectorRunnable(cfg)) continue; // not yet configured — skip silently
    const res = await env.DB.prepare(
      "INSERT OR IGNORE INTO pull_queue (connector, enqueued_at) VALUES (?1, datetime('now'))"
    ).bind(id).run();
    if (res.meta.changes) queued++;

    // Self-heal: an enabled, eligible connector should always have its
    // 36-month history crawling without a per-connector Start click. Only
    // never-started connectors are picked up — done/error states are left
    // for the operator (restarting an errored crawl in a loop would just
    // hammer a broken source).
    const state = await env.DB.prepare(
      "SELECT status FROM backfill_state WHERE connector = ?1"
    ).bind(id).first<{ status: string }>();
    if (!state && (await backfillEligible(env, id))) await startBackfill(env, id);
  }
  console.log(`seeded ${queued} daily pulls`);
  return queued;
}

/**
 * One bounded slice of background work, called by every 10-minute tick:
 * drain up to PULLS_PER_TICK queued pulls; when the queue is empty, advance
 * running backfills instead. Queue rows are deleted before running so a
 * connector that crashes the invocation can't wedge the queue.
 */
export async function processBackgroundWork(env: Env): Promise<void> {
  const pending = await env.DB.prepare(
    "SELECT connector FROM pull_queue ORDER BY enqueued_at LIMIT ?1"
  ).bind(PULLS_PER_TICK).all<{ connector: string }>();

  if (pending.results.length === 0) {
    const { continueBackfills } = await import("./backfill");
    await continueBackfills(env);
    return;
  }

  const markets = await getMarkets(env);
  for (const p of pending.results) {
    await env.DB.prepare("DELETE FROM pull_queue WHERE connector = ?1").bind(p.connector).run();
    const cfg = await getConnectorConfig(env, p.connector);
    if (!connectorRunnable(cfg)) continue;
    await runWithAudit(env, p.connector, () => runConnector(env, cfg, markets));
  }

  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM pull_queue").first<{ n: number }>();
  if ((left?.n ?? 0) === 0) await runPipelineTail(env);
}

/** Scoring + analytics tail — runs when a seeded sweep finishes draining. */
export async function runPipelineTail(env: Env): Promise<void> {
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
}

/**
 * Manual "Run full pipeline now": seed the queue and drain the first slice
 * immediately; the 10-minute tick finishes the rest within the hour.
 */
export async function runIngestionPipeline(env: Env, scheduledFor: Date): Promise<void> {
  console.log(`ingestion pipeline start ${scheduledFor.toISOString()}`);
  await seedDailyPulls(env);
  await processBackgroundWork(env);

  console.log("ingestion pipeline complete");
}
