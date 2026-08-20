/**
 * ACRIS native join — NYC splits recorded documents across four Socrata
 * datasets keyed by document_id:
 *
 *   Master      bnx9-e6tj  doc type, amount, dates
 *   Legals      8h5j-fqxa  borough/block/lot (BBL) + street address
 *   Parties     636b-3b5g  party names (1 = grantor/mortgagor, 2 = grantee/mortgagee)
 *   References  pwkr-dpni  document -> document cross-refs (satisfaction -> mortgage)
 *
 * This adapter pulls a date window from Master (filtered to the connector's
 * document types), then batch-fetches the matching companion rows and joins
 * them in memory into complete deed/loan/satisfaction records — so the free
 * city APIs can feed the Maturity Sniffer and Cash-Poor feeds with full
 * records instead of quarantining half-records.
 *
 * Volume: Master is ~17M rows and a citywide month runs to five figures, so
 * a window is read as *pages* under an explicit row budget rather than a
 * single capped request. When a window saturates the budget the pull says
 * so (`truncated`) and reports the oldest record it reached, which lets the
 * backfill resume exactly there instead of stepping over the remainder —
 * coverage converges to complete at whatever rate the budget allows.
 *
 * Request budget: the window is read in as few Master requests as the
 * budget allows (SoDA 2.1 sets no `$limit` ceiling), companion lookups
 * batch `ID_BATCH` document_ids each, and only the companion datasets a
 * given connector actually needs are fetched.
 *
 * Workers meter two separate budgets per invocation: **external** fetches
 * (50 on the Free plan) and calls to Cloudflare services such as D1 (1,000
 * on Free). Reading N documents costs `1 + 2*ceil(N/ID_BATCH)` external
 * requests, so the 5,000-document default costs 41 — inside the external
 * cap with room to spare — while the D1 side of ingesting those rows is
 * batched (see BulkResolver in ingest.ts) to a few hundred calls, inside
 * the service cap.
 *
 * Socrata throttles by app token (~1,000 requests/rolling hour) and lumps
 * token-less callers into a shared per-IP pool, so a token configured on
 * the connector is what makes sustained crawling at this volume viable.
 */

import type { Env } from "./index";
import type { ConnectorCfg } from "./ingest";

const MASTER_ID = "bnx9-e6tj";
const LEGALS_ID = "8h5j-fqxa";
const PARTIES_ID = "636b-3b5g";
const REFS_ID = "pwkr-dpni";   // Real Property References — doc-to-doc cross refs
const DOC_CODES_ID = "7isb-wh4c"; // Document Control Codes — doc_type -> human label

/**
 * Documents pulled from one window per run. SoDA 2.1 `/resource/` endpoints
 * have **no `$limit` ceiling** (the 50,000 cap is SoDA 2.0), so this number
 * is not sized by the API — it is sized by what one Worker invocation can
 * join and write. The binding cost is the companion joins: reading N
 * documents costs 1 Master request plus 2*ceil(N/ID_BATCH) lookups, so the
 * default sits just inside the Free plan's 50 *external* subrequests.
 * Override per connector via field-map `docBudget`.
 */
const DEFAULT_DOC_BUDGET = 5_000;
const MAX_DOC_BUDGET = 50_000;
/** Rows per Master request; above this the window is read in slices. */
const REQUEST_SLICE = 10_000;
/** document_ids per companion request — 250 keeps the SoQL URL near 5KB,
 *  inside the ~8KB request-line limit servers commonly enforce. */
const ID_BATCH = 250;

const BOROUGH: Record<string, { city: string; county: string }> = {
  "1": { city: "Manhattan", county: "New York" },
  "2": { city: "Bronx", county: "Bronx" },
  "3": { city: "Brooklyn", county: "Kings" },
  "4": { city: "Queens", county: "Queens" },
  "5": { city: "Staten Island", county: "Richmond" },
};

/** Default document-type filters; override per connector via field-map `where`. */
const DOC_FILTERS: Record<string, string> = {
  county_deeds: "doc_type = 'DEED'",
  county_loans: "doc_type in('MTGE','AGMT')",
  satisfactions: "doc_type = 'SAT'",
};

/** Connector ids the lien-family row shaper below knows how to fill in. */
const LIEN_FAMILY = new Set(["liens", "lis_pendens", "tax_liens"]);

/**
 * Description patterns used to resolve each lien-family connector's ACRIS
 * document-type codes from the city's own Document Control Codes lookup
 * dataset at run time. This is NOT guessing the codes — it queries the
 * authoritative code table and matches on the human-readable description,
 * so the exact code strings always come from production data. Resolved
 * filters are persisted to the connector's field map, where the operator
 * can see and override them.
 */
const FAMILY_DOC_PATTERNS: Record<string, RegExp> = {
  lis_pendens: /PENDEN/i,          // NOTICE OF PENDENCY / LIS PENDENS variants
  liens: /MECHANIC/i,              // MECHANICS LIEN (+ amendments)
  tax_liens: /TAX\s*LIEN/i,        // NYC / FEDERAL TAX LIEN variants
};

/**
 * Which Master date a window filters on.
 *
 * `recorded_datetime` walks recording history — what a backfill wants.
 * `modified_date` is "recorded OR index data last corrected", so it is the
 * only field that surfaces a correction to an old document: DOF republishes
 * documents corrected in the previous month, and such a row still carries
 * its original (possibly years-old) recorded date. An incremental pull
 * filtered on recorded_datetime would never see it.
 */
export type AcrisDateField = "recorded_datetime" | "modified_date";

export function isAcrisMaster(url: string | null): boolean {
  return Boolean(url && url.includes(MASTER_ID));
}

/**
 * A connector can use the ACRIS join if it's one of the three built-in
 * document families (deeds/loans/satisfactions, fixed codes) or a
 * lien-family connector (codes resolved at run time, or operator-set via
 * field-map `where`).
 */
export function acrisCapable(connectorId: string): boolean {
  return connectorId in DOC_FILTERS || LIEN_FAMILY.has(connectorId);
}

/** Satisfactions carry no address; every other family is parcel-bound. */
function needsLegals(connectorId: string): boolean {
  return connectorId !== "satisfactions";
}

export function acrisDocBudget(cfg: ConnectorCfg): number {
  const raw = Number(cfg.fieldMap?.docBudget);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_DOC_BUDGET;
  return Math.min(MAX_DOC_BUDGET, Math.floor(raw));
}

/**
 * Resolve a lien-family connector's `doc_type` filter by matching document
 * descriptions in the Document Control Codes dataset, then persist it to
 * the connector's field map so subsequent pulls are deterministic and the
 * operator can inspect/adjust it in Settings. Returns the SoQL filter, or
 * null when nothing matched (caller decides how loudly to fail).
 */
export async function resolveAcrisDocTypes(env: Env, cfg: ConnectorCfg): Promise<string | null> {
  const pattern = FAMILY_DOC_PATTERNS[cfg.id];
  if (!pattern || !cfg.baseUrl) return null;
  const base = resourceBase(cfg.baseUrl, DOC_CODES_ID);
  const { rows } = await fetchJson<Record<string, string>>(`${base}?$limit=500`, cfg.apiKey);
  const cols = docCodeColumns(rows);
  if (!cols) return null;

  const codes = [
    ...new Set(
      rows
        .filter((r) => pattern.test(String(r[cols.desc] ?? "")))
        .map((r) => String(r[cols.code] ?? "").trim().replace(/'/g, ""))
        .filter(Boolean)
    ),
  ].slice(0, 6);
  if (codes.length === 0) return null;

  const where = `doc_type in(${codes.map((c) => `'${c}'`).join(",")})`;
  const fieldMap = { ...(cfg.fieldMap ?? {}), where };
  await env.DB.prepare(
    "UPDATE connector_config SET field_map = ?1, updated_at = datetime('now') WHERE id = ?2"
  )
    .bind(JSON.stringify(fieldMap), cfg.id)
    .run();
  cfg.fieldMap = fieldMap;
  return where;
}

/**
 * The Document Control Codes dataset names its columns `doc__type` and
 * `doc__type_description` (two underscores) — not the `doc_type` used by
 * every other ACRIS dataset. Detect them from the payload rather than
 * hardcoding either spelling, so a rename upstream degrades to "no
 * labels" instead of a 400.
 */
function docCodeColumns(rows: Record<string, unknown>[]): { code: string; desc: string } | null {
  if (rows.length === 0) return null;
  const keys = Object.keys(rows[0]);
  const desc = keys.find((k) => /doc_*type/i.test(k) && /desc/i.test(k));
  const code = keys.find((k) => /doc_*type/i.test(k) && !/desc/i.test(k) && !/class/i.test(k));
  return code && desc ? { code, desc } : null;
}

/**
 * Party 1 / 2 role names per document type, straight from the Document
 * Control Codes table (guide fields 5-7: "Party type N name for this
 * document type").
 *
 * This replaces an assumption the lien-family shaper used to make out loud:
 * that party 1 is always the property-side party. That holds for deeds
 * (GRANTOR/GRANTEE) and mortgages (MORTGAGOR/MORTGAGEE), but the city
 * publishes the actual roles per doc type, so there is no reason to guess
 * for mechanic's liens, notices of pendency or tax liens.
 */
export interface PartyRoles { party1: string | null; party2: string | null }

async function fetchPartyRoles(cfg: ConnectorCfg): Promise<Map<string, PartyRoles>> {
  const out = new Map<string, PartyRoles>();
  if (!cfg.baseUrl) return out;
  const base = resourceBase(cfg.baseUrl, DOC_CODES_ID);
  const { rows } = await fetchJson<Record<string, string>>(`${base}?$limit=500`, cfg.apiKey);
  const cols = docCodeColumns(rows);
  if (!cols) return out;
  const keys = rows.length > 0 ? Object.keys(rows[0]) : [];
  const p1 = keys.find((k) => /party_*1/i.test(k));
  const p2 = keys.find((k) => /party_*2/i.test(k));
  if (!p1 || !p2) return out;
  for (const r of rows) {
    const code = String(r[cols.code] ?? "").trim();
    if (code) out.set(code, { party1: String(r[p1] ?? "").trim() || null, party2: String(r[p2] ?? "").trim() || null });
  }
  return out;
}

/** Roles naming the side that owns / is burdened by the property. */
const PROPERTY_SIDE = /OWNER|MORTGAGOR|GRANTOR|DEBTOR|DEFENDANT|SELLER|ASSIGNOR|BORROWER/i;
/** Roles naming the side asserting the claim. */
const CLAIM_SIDE = /LIENOR|CLAIMANT|MORTGAGEE|GRANTEE|CREDITOR|PLAINTIFF|BUYER|ASSIGNEE|LENDER/i;

/**
 * Decide which party slot is the property owner and which is the claimant
 * for one document type. Falls back to the historical party1=owner
 * convention when the code table says nothing useful.
 */
function orientParties(roles: PartyRoles | undefined): { ownerFirst: boolean } {
  const p1 = roles?.party1 ?? "", p2 = roles?.party2 ?? "";
  if (PROPERTY_SIDE.test(p1) || CLAIM_SIDE.test(p2)) return { ownerFirst: true };
  if (PROPERTY_SIDE.test(p2) || CLAIM_SIDE.test(p1)) return { ownerFirst: false };
  return { ownerFirst: true };
}

interface MasterRow {
  document_id: string;
  crfn?: string;
  doc_type?: string;
  document_amt?: string;
  document_date?: string;
  recorded_datetime?: string;
  /** "Date Document was Recorded or Index Data was Last Corrected" (guide, Master field 9). */
  modified_date?: string;
  /** "Reported percentage of interest transferred" (guide, Master field 13). */
  percent_trans?: string;
}
interface LegalRow {
  document_id: string;
  borough?: string;
  block?: string;
  lot?: string;
  easement?: string;
  air_rights?: string;
  property_type?: string;
  street_number?: string;
  street_name?: string;
  unit?: string;
}
interface PartyRow {
  document_id: string;
  party_type?: string;
  name?: string;
}
interface RefRow {
  document_id: string;
  reference_by_doc_id?: string;
  reference_by_crfn_?: string;
}

const BANKISH =
  /\b(BANK|BANC|N\.?A\.?|FSB|FCU|CREDIT UNION|CHASE|CITIBANK|CITIZENS|WELLS FARGO|HSBC|TD|SANTANDER|CAPITAL ONE|SAVINGS|BANCORP|MORGAN|GOLDMAN|FLAGSTAR|VALLEY NATIONAL|M&T|KEYBANK|PNC)\b/i;

async function fetchJson<T>(url: string, token: string | null): Promise<{ raw: string; rows: T[] }> {
  const res = await fetch(url, { headers: token ? { "X-App-Token": token } : {} });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 220);
    throw new Error(`acris ${res.status}: ${url.split("?")[0]}${body ? ` — ${body}` : ""}`);
  }
  const raw = await res.text();
  const rows = JSON.parse(raw) as T[];
  if (!Array.isArray(rows)) throw new Error("acris_unexpected_payload");
  return { raw, rows };
}

function resourceBase(masterUrl: string, datasetId: string): string {
  return masterUrl.replace(/resource\/[a-z0-9-]+\.json.*/i, `resource/${datasetId}.json`);
}

/** Batch `document_id in(...)` lookups against a companion dataset. */
async function fetchByDocIds<T>(
  base: string,
  ids: string[],
  token: string | null,
  select: string
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batch = ids.slice(i, i + ID_BATCH).map((id) => `'${id.replace(/'/g, "")}'`);
    const params = new URLSearchParams({
      $where: `document_id in(${batch.join(",")})`,
      $select: select,
      $limit: "10000",
    });
    const { rows } = await fetchJson<T>(`${base}?${params}`, token);
    out.push(...rows);
  }
  return out;
}

/**
 * Read a Master date window newest-first, up to the connector's document
 * budget, in as few requests as the budget allows.
 *
 * Newest-first matters: it makes a saturated window resumable from its
 * oldest record, so nothing between that point and the window's start is
 * silently stepped over. Each request asks for one row *more* than it
 * intends to keep — if that probe row comes back, the window provably holds
 * more than the budget and `truncated` is a fact rather than a guess.
 */
async function fetchMasterWindow(
  cfg: ConnectorCfg,
  filter: string,
  window: { from: string; to: string },
  dateField: AcrisDateField
): Promise<{ raw: string; master: MasterRow[]; truncated: boolean }> {
  const budget = acrisDocBudget(cfg);
  const master: MasterRow[] = [];
  // Every slice feeds the checksum: keying it on the first alone would
  // report "unchanged" for a window whose later slices moved.
  const payloads: string[] = [];
  let truncated = false;

  while (master.length < budget) {
    const want = Math.min(REQUEST_SLICE, budget - master.length);
    const params = new URLSearchParams({
      $where: `${dateField} >= '${window.from}' AND ${dateField} < '${window.to}' AND (${filter})`,
      // document_id breaks ties so $offset slicing is stable across requests.
      $order: `${dateField} DESC, document_id DESC`,
      $limit: String(want + 1), // +1 = the truncation probe
      $offset: String(master.length),
      $select: "document_id,crfn,doc_type,document_amt,document_date,recorded_datetime,modified_date,percent_trans",
    });
    const { raw, rows } = await fetchJson<MasterRow>(`${cfg.baseUrl}?${params}`, cfg.apiKey);
    payloads.push(raw);

    if (rows.length > want) {
      master.push(...rows.slice(0, want)); // drop the probe row
      truncated = true;
      break;
    }
    master.push(...rows);
    if (rows.length <= want) break; // source ran out before the budget did
  }
  return { raw: payloads.join(""), master, truncated };
}

/** Prefer a real taxable parcel over easement / air-rights rows on the same doc. */
function pickPrimaryLegal(rows: LegalRow[]): LegalRow {
  const scored = [...rows].sort((a, b) => {
    const flag = (r: LegalRow) =>
      (String(r.easement ?? "").toUpperCase() === "Y" ? 2 : 0) +
      (String(r.air_rights ?? "").toUpperCase() === "Y" ? 1 : 0);
    if (flag(a) !== flag(b)) return flag(a) - flag(b);
    const num = (v?: string) => Number(v ?? 0) || 0;
    return num(a.block) - num(b.block) || num(a.lot) - num(b.lot);
  });
  return scored[0];
}

/** NYC's canonical parcel key: borough(1) + block(5) + lot(4), zero-padded. */
function toBbl(legal: LegalRow | undefined): string | null {
  if (!legal) return null;
  const boro = String(legal.borough ?? "").trim();
  const block = Number(legal.block ?? 0);
  const lot = Number(legal.lot ?? 0);
  if (!BOROUGH[boro] || !block || !lot) return null;
  return `${boro}${String(block).padStart(5, "0")}${String(lot).padStart(4, "0")}`;
}

/**
 * Percentage of interest transferred, when ACRIS reports one. The field is
 * null far more often than not, and a stated 0 means "not reported" rather
 * than "nothing conveyed", so both collapse to null.
 */
function pctTransferred(raw: string | undefined): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return n;
}

/** Primary name plus any co-parties, so co-borrowers aren't dropped. */
function joinNames(names: string[]): string {
  const seen = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (seen.length === 0) return "";
  // Keep the field inside the 200-char plausibility gate in integrity.ts.
  const joined = seen.slice(0, 4).join(" & ");
  return joined.length > 200 ? seen[0].slice(0, 200) : joined;
}

export interface AcrisPull {
  raw: string;
  rows: Record<string, unknown>[];
  /** The window held more documents than the row budget allowed. */
  truncated: boolean;
  /** Oldest `recorded_datetime` date reached (YYYY-MM-DD), for resumption. */
  oldestRecorded: string | null;
}

/**
 * Pull + join one date window. Returns rows shaped for the connector's
 * existing gates/upserts (DeedRec / LoanRec / SatisfactionRec).
 */
export async function acrisFetch(
  env: Env,
  cfg: ConnectorCfg,
  window: { from: string; to: string },
  dateField: AcrisDateField = "recorded_datetime"
): Promise<AcrisPull> {
  let filter = cfg.fieldMap?.where?.replace(/;/g, "").trim() || DOC_FILTERS[cfg.id] || null;
  if (!filter) filter = await resolveAcrisDocTypes(env, cfg);
  if (!filter || !cfg.baseUrl) {
    throw new Error(
      "acris_doc_type_unresolved — could not match this connector's document class in the ACRIS code table; run Test source and paste a doc_type filter from the 'ACRIS doc types in window' list into the field-map where"
    );
  }

  let pull;
  try {
    pull = await fetchMasterWindow(cfg, filter, window, dateField);
  } catch (err) {
    // Never let an incremental pull die on a column the portal may have
    // typed differently; recorded_datetime is always present, it just
    // cannot see corrections.
    if (dateField === "modified_date") {
      pull = await fetchMasterWindow(cfg, filter, window, "recorded_datetime");
    } else throw err;
  }
  const { raw, master, truncated } = pull;
  if (master.length === 0) return { raw, rows: [], truncated: false, oldestRecorded: null };

  // Resumption keys off the same field the window was ordered by, or the
  // cursor would jump somewhere the pull never actually reached.
  const oldestRecorded =
    master
      .map((m) => ((dateField === "modified_date" ? m.modified_date : m.recorded_datetime) ?? "").slice(0, 10))
      .filter(Boolean)
      .sort()[0] ?? null;

  const ids = [...new Set(master.map((m) => m.document_id).filter(Boolean))];
  const wantLegals = needsLegals(cfg.id);
  const wantRefs = cfg.id === "satisfactions";

  const [legals, parties, refs] = await Promise.all([
    wantLegals
      ? fetchByDocIds<LegalRow>(
          resourceBase(cfg.baseUrl, LEGALS_ID), ids, cfg.apiKey,
          "document_id,borough,block,lot,easement,air_rights,property_type,street_number,street_name,unit"
        )
      : Promise.resolve([] as LegalRow[]),
    fetchByDocIds<PartyRow>(
      resourceBase(cfg.baseUrl, PARTIES_ID), ids, cfg.apiKey,
      "document_id,party_type,name"
    ),
    wantRefs
      ? fetchByDocIds<RefRow>(
          resourceBase(cfg.baseUrl, REFS_ID), ids, cfg.apiKey,
          "document_id,reference_by_doc_id,reference_by_crfn_"
        ).catch(() => [] as RefRow[]) // refs are an enrichment, never a hard failure
      : Promise.resolve([] as RefRow[]),
  ]);

  // A document can cover several parcels (blanket mortgages, assemblages).
  // doc_number is the idempotency key, so the record stays one row bound to
  // the primary parcel; the parcel count rides along as a portfolio signal.
  const legalsByDoc = new Map<string, LegalRow[]>();
  for (const l of legals) {
    const list = legalsByDoc.get(l.document_id) ?? [];
    list.push(l);
    legalsByDoc.set(l.document_id, list);
  }
  const partiesByDoc = new Map<string, { p1: string[]; p2: string[] }>();
  for (const p of parties) {
    const slot = partiesByDoc.get(p.document_id) ?? { p1: [], p2: [] };
    if (p.party_type === "1" && p.name) slot.p1.push(p.name);
    if (p.party_type === "2" && p.name) slot.p2.push(p.name);
    partiesByDoc.set(p.document_id, slot);
  }
  const refsByDoc = new Map<string, RefRow>();
  for (const r of refs) if (!refsByDoc.has(r.document_id)) refsByDoc.set(r.document_id, r);

  // Deeds and mortgages have a fixed, well-known party convention. The
  // lien family does not, so read the roles the city publishes per doc type
  // rather than assuming. Best-effort: a failure here just keeps the old
  // convention.
  const partyRoles = LIEN_FAMILY.has(cfg.id)
    ? await fetchPartyRoles(cfg).catch(() => new Map<string, PartyRoles>())
    : new Map<string, PartyRoles>();

  // Satisfactions reference their mortgage by CRFN as often as by doc id;
  // map CRFNs we saw in this window back onto document ids so the loan
  // match is exact instead of a lender+borrower name guess.
  const docIdByCrfn = new Map<string, string>();
  for (const m of master) if (m.crfn) docIdByCrfn.set(m.crfn, m.document_id);

  const rows: Record<string, unknown>[] = [];
  for (const m of master) {
    const parcels = legalsByDoc.get(m.document_id) ?? [];
    const legal = parcels.length > 0 ? pickPrimaryLegal(parcels) : undefined;
    const party = partiesByDoc.get(m.document_id) ?? { p1: [], p2: [] };
    const b = legal?.borough ? BOROUGH[legal.borough] : undefined;
    const address = legal
      ? [legal.street_number, legal.street_name, legal.unit].filter(Boolean).join(" ").trim()
      : "";
    const date = (m.document_date || m.recorded_datetime || "").slice(0, 10);
    const amount = Number(m.document_amt ?? 0);
    const common = {
      docNumber: m.document_id,
      // BBL is NYC's canonical parcel key — with it, every document on a
      // parcel converges on one property row regardless of how the street
      // address was typed on any single recording.
      apn: toBbl(legal),
      address,
      city: b?.city ?? "",
      county: b?.county ?? "",
      state: "NY",
      sourceDocType: m.doc_type ?? null,
      parcelCount: parcels.length || null,
      propertyClass: legal?.property_type ?? null,
      // Lets the upsert tell a correction from a stale re-read.
      sourceModifiedAt: (m.modified_date || m.recorded_datetime || "").slice(0, 10) || null,
    };

    if (cfg.id === "county_deeds") {
      rows.push({
        ...common,
        price: amount,
        // Cash detection is a post-pass: a purchase is all-cash when no
        // mortgage lands on the same parcel within the following weeks.
        isCash: true,
        deedType: null,
        // A deed conveying a fractional interest is not a sale of the
        // property; carrying the reported percentage keeps the flip and
        // cash-purchase signals from reading one as a full transfer.
        percentTransferred: pctTransferred(m.percent_trans),
        buyerName: joinNames(party.p2),   // grantee
        sellerName: joinNames(party.p1),  // grantor
        recordedAt: date,
      });
    } else if (cfg.id === "county_loans") {
      const lender = joinNames(party.p2); // mortgagee
      rows.push({
        ...common,
        lenderName: lender,
        lenderType: BANKISH.test(lender) ? "bank" : "private",
        principal: amount,
        ratePct: null,               // NYC recordings rarely state the rate
        originatedAt: date,
        termMonths: null,
        maturityDate: null,
        borrowerName: joinNames(party.p1), // mortgagor
      });
    } else if (cfg.id === "satisfactions") {
      const ref = refsByDoc.get(m.document_id);
      const referenced =
        ref?.reference_by_doc_id?.trim() ||
        (ref?.reference_by_crfn_ ? docIdByCrfn.get(ref.reference_by_crfn_.trim()) : null) ||
        null;
      rows.push({
        docNumber: m.document_id,
        originalDocNumber: referenced,
        lenderName: joinNames(party.p2) || joinNames(party.p1),
        borrowerName: joinNames(party.p1),
        satisfiedAt: date,
      });
    } else if (LIEN_FAMILY.has(cfg.id)) {
      // Mechanic's lien / Notice of Pendency / recorded tax lien. Which
      // party slot holds the owner and which holds the claimant is read
      // from the Document Control Codes table for this doc type, not
      // assumed (see orientParties).
      const { ownerFirst } = orientParties(m.doc_type ? partyRoles.get(m.doc_type) : undefined);
      rows.push({
        ...common,
        claimant: joinNames(ownerFirst ? party.p2 : party.p1),
        ownerName: joinNames(ownerFirst ? party.p1 : party.p2),
        amount,
        filedAt: date,
      });
    }
  }
  return { raw, rows, truncated, oldestRecorded };
}

/**
 * Sample the Master dataset for a date window with NO type filter, group by
 * doc_type, and join the counts against the Document Control Codes lookup
 * dataset for human-readable labels. This is the antidote to guessing:
 * point Test source at it once and read off the exact code for "Mechanic's
 * Lien" / "Notice of Pendency" / "NYC Tax Lien" instead of hoping a filter
 * string is right.
 */
export async function discoverDocTypes(
  cfg: ConnectorCfg,
  window: { from: string; to: string }
): Promise<{ docType: string; count: number; description: string | null }[]> {
  if (!cfg.baseUrl) return [];
  const params = new URLSearchParams({
    $select: "doc_type, count(document_id) as n",
    $where: `recorded_datetime >= '${window.from}' AND recorded_datetime < '${window.to}'`,
    $group: "doc_type",
    $order: "n DESC",
    $limit: "30",
  });
  const { rows } = await fetchJson<{ doc_type: string; n: string }>(`${cfg.baseUrl}?${params}`, cfg.apiKey);
  if (rows.length === 0) return [];

  const codesBase = resourceBase(cfg.baseUrl, DOC_CODES_ID);
  let labels = new Map<string, string>();
  try {
    // The lookup table is small (a few hundred rows) and its column names
    // don't match the Master dataset's, so pull it whole and match in
    // memory rather than filtering server-side on a guessed column name.
    const { rows: codeRows } = await fetchJson<Record<string, string>>(`${codesBase}?$limit=500`, cfg.apiKey);
    const cols = docCodeColumns(codeRows);
    if (cols) {
      labels = new Map(
        codeRows.map((c) => [String(c[cols.code] ?? "").trim(), String(c[cols.desc] ?? "").trim()])
      );
    }
  } catch {
    // Lookup dataset is best-effort — the codes + counts alone are still useful.
  }

  return rows.map((r) => ({
    docType: r.doc_type,
    count: Number(r.n) || 0,
    description: labels.get(r.doc_type) || null,
  }));
}

/**
 * Post-pass cash detection for ACRIS deeds: flip is_cash off wherever a
 * mortgage was recorded against the same parcel within 45 days of the
 * purchase. Runs with scoring so it always reflects the latest loans pull.
 * Covers the FULL deed history, not just recent windows — backfill pulls
 * deeds and mortgages on independent schedules, so any recency guard here
 * would leave whichever arrived first permanently mis-flagged.
 */
export async function recomputeCashFlags(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE transactions SET is_cash = CASE WHEN EXISTS (
        SELECT 1 FROM loans l
        WHERE l.property_id = transactions.property_id
          AND l.instrument = 'mortgage'
          AND julianday(l.originated_at) BETWEEN julianday(transactions.recorded_at) - 5
                                             AND julianday(transactions.recorded_at) + 45
      ) THEN 0 ELSE 1 END
     WHERE source_id = 'county_deeds' AND side = 'purchase'`
  ).run();
}
