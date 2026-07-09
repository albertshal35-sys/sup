/**
 * ACRIS native join — NYC splits recorded documents across three Socrata
 * datasets keyed by document_id:
 *
 *   Master  bnx9-e6tj  doc type, amount, dates
 *   Legals  8h5j-fqxa  borough/block/lot + street address
 *   Parties 636b-3b5g  party names (1 = grantor/mortgagor, 2 = grantee/mortgagee)
 *
 * This adapter pulls a date window from Master (filtered to the connector's
 * document types), then batch-fetches the matching Legals and Parties rows
 * and joins them in memory into complete deed/loan/satisfaction records —
 * so the free city APIs can feed the Maturity Sniffer and Cash-Poor feeds
 * with full records instead of quarantining half-records.
 *
 * Request budget (free-tier friendly): Master limit 150/pull, id batches of
 * 40 → ≤ 9 subrequests per connector per run.
 */

import type { Env } from "./index";
import type { ConnectorCfg } from "./ingest";

const MASTER_ID = "bnx9-e6tj";
const LEGALS_ID = "8h5j-fqxa";
const PARTIES_ID = "636b-3b5g";
const DOC_CODES_ID = "7isb-wh4c"; // Document Control Codes — doc_type -> human label

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

export function isAcrisMaster(url: string | null): boolean {
  return Boolean(url && url.includes(MASTER_ID));
}

/**
 * A connector is ACRIS-joinable if it's one of the three built-in document
 * families (deeds/loans/satisfactions) or the operator has supplied an
 * explicit `doc_type` filter via field-map `where` — e.g. after running
 * "Discover ACRIS doc types" in Test source and pasting in the real code
 * for Mechanic's Lien / Notice of Pendency / NYC Tax Lien. We deliberately
 * don't guess those codes: ACRIS's `doc_type` values aren't documented
 * anywhere reliable, so shipping a wrong guess would silently return 0 rows
 * forever, which is the exact failure mode this is meant to fix.
 */
export function acrisCapable(connectorId: string, hasWhereOverride = false): boolean {
  return connectorId in DOC_FILTERS || (LIEN_FAMILY.has(connectorId) && hasWhereOverride);
}

interface MasterRow {
  document_id: string;
  doc_type?: string;
  document_amt?: string;
  document_date?: string;
  recorded_datetime?: string;
}
interface LegalRow {
  document_id: string;
  borough?: string;
  street_number?: string;
  street_name?: string;
  unit?: string;
}
interface PartyRow {
  document_id: string;
  party_type?: string;
  name?: string;
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
  for (let i = 0; i < ids.length; i += 40) {
    const batch = ids.slice(i, i + 40).map((id) => `'${id.replace(/'/g, "")}'`);
    const params = new URLSearchParams({
      $where: `document_id in(${batch.join(",")})`,
      $select: select,
      $limit: "2000",
    });
    const { rows } = await fetchJson<T>(`${base}?${params}`, token);
    out.push(...rows);
  }
  return out;
}

/**
 * Pull + join one date window. Returns rows shaped for the connector's
 * existing gates/upserts (DeedRec / LoanRec / SatisfactionRec).
 */
export async function acrisFetch(
  _env: Env,
  cfg: ConnectorCfg,
  window: { from: string; to: string }
): Promise<{ raw: string; rows: Record<string, unknown>[] }> {
  const filter = cfg.fieldMap?.where?.replace(/;/g, "").trim() || DOC_FILTERS[cfg.id];
  if (!filter || !cfg.baseUrl) throw new Error("acris_not_applicable");

  const masterParams = new URLSearchParams({
    $where: `recorded_datetime >= '${window.from}' AND recorded_datetime < '${window.to}' AND (${filter})`,
    $order: "recorded_datetime DESC",
    $limit: "150",
    $select: "document_id,doc_type,document_amt,document_date,recorded_datetime",
  });
  const { raw, rows: master } = await fetchJson<MasterRow>(`${cfg.baseUrl}?${masterParams}`, cfg.apiKey);
  if (master.length === 0) return { raw, rows: [] };

  const ids = [...new Set(master.map((m) => m.document_id).filter(Boolean))];
  const [legals, parties] = await Promise.all([
    fetchByDocIds<LegalRow>(
      resourceBase(cfg.baseUrl, LEGALS_ID), ids, cfg.apiKey,
      "document_id,borough,street_number,street_name,unit"
    ),
    fetchByDocIds<PartyRow>(
      resourceBase(cfg.baseUrl, PARTIES_ID), ids, cfg.apiKey,
      "document_id,party_type,name"
    ),
  ]);

  const legalByDoc = new Map<string, LegalRow>();
  for (const l of legals) if (!legalByDoc.has(l.document_id)) legalByDoc.set(l.document_id, l);
  const partiesByDoc = new Map<string, { p1: string | null; p2: string | null }>();
  for (const p of parties) {
    const slot = partiesByDoc.get(p.document_id) ?? { p1: null, p2: null };
    if (p.party_type === "1" && !slot.p1) slot.p1 = p.name ?? null;
    if (p.party_type === "2" && !slot.p2) slot.p2 = p.name ?? null;
    partiesByDoc.set(p.document_id, slot);
  }

  const rows: Record<string, unknown>[] = [];
  for (const m of master) {
    const legal = legalByDoc.get(m.document_id);
    const party = partiesByDoc.get(m.document_id) ?? { p1: null, p2: null };
    const b = legal?.borough ? BOROUGH[legal.borough] : undefined;
    const address = legal
      ? [legal.street_number, legal.street_name, legal.unit].filter(Boolean).join(" ").trim()
      : "";
    const date = (m.document_date || m.recorded_datetime || "").slice(0, 10);
    const amount = Number(m.document_amt ?? 0);
    const common = {
      docNumber: m.document_id,
      address,
      city: b?.city ?? "",
      county: b?.county ?? "",
      state: "NY",
      sourceDocType: m.doc_type ?? null,
    };

    if (cfg.id === "county_deeds") {
      rows.push({
        ...common,
        price: amount,
        // Cash detection is a post-pass: a purchase is all-cash when no
        // mortgage lands on the same parcel within the following weeks.
        isCash: true,
        deedType: null,
        buyerName: party.p2 ?? "",   // grantee
        sellerName: party.p1 ?? "",  // grantor
        recordedAt: date,
      });
    } else if (cfg.id === "county_loans") {
      const lender = party.p2 ?? ""; // mortgagee
      rows.push({
        ...common,
        lenderName: lender,
        lenderType: BANKISH.test(lender) ? "bank" : "private",
        principal: amount,
        ratePct: null,               // NYC recordings rarely state the rate
        originatedAt: date,
        termMonths: null,
        maturityDate: null,
        borrowerName: party.p1 ?? "", // mortgagor
      });
    } else if (cfg.id === "satisfactions") {
      rows.push({
        docNumber: m.document_id,
        originalDocNumber: null,     // XREF dataset lookup is a future add
        lenderName: party.p2 ?? party.p1 ?? "",
        borrowerName: party.p1 ?? "",
        satisfiedAt: date,
      });
    } else if (LIEN_FAMILY.has(cfg.id)) {
      // Mechanic's lien / Notice of Pendency / recorded tax lien — same
      // party convention as deeds/mortgages (party1 = the property-side
      // party, party2 = the other side), which is our best-effort mapping
      // until confirmed per doc class via Discover ACRIS doc types.
      rows.push({
        ...common,
        claimant: party.p2 ?? "",
        ownerName: party.p1 ?? "",
        amount,
        filedAt: date,
      });
    }
  }
  return { raw, rows };
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

  const codes = rows.map((r) => `'${r.doc_type.replace(/'/g, "")}'`).join(",");
  const codesBase = resourceBase(cfg.baseUrl, DOC_CODES_ID);
  const codeParams = new URLSearchParams({
    $where: `doc_type in(${codes})`,
    $select: "doc_type, doc_type_description",
    $limit: "60",
  });
  let labels = new Map<string, string>();
  try {
    const { rows: codeRows } = await fetchJson<{ doc_type: string; doc_type_description?: string }>(
      `${codesBase}?${codeParams}`, cfg.apiKey
    );
    labels = new Map(codeRows.map((c) => [c.doc_type, c.doc_type_description ?? ""]));
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
     WHERE source_id = 'county_deeds' AND side = 'purchase'
       AND recorded_at >= date('now','-120 days')`
  ).run();
}
