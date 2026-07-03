/**
 * Data-integrity layer — the gate every record passes before it can touch
 * the database, plus the monitoring that notices when a source goes bad.
 *
 *  - Validation gates: structural and sanity checks per record kind.
 *    Failures land in `quarantine` with machine-readable reasons for
 *    review in Settings → Data quality; they never pollute live tables.
 *  - Source stats: per-connector daily row counts, the baseline for
 *    freshness/anomaly detection ("this source normally returns ~400
 *    rows/day; today it returned 6 — probably broken, not quiet").
 *  - Provenance: every upserted row carries its connector, source URL,
 *    acquisition method and a confidence tier. A record seen from two
 *    independent methods is upgraded to `corroborated`.
 */

import type { Env } from "./index";

export type Confidence = "corroborated" | "direct" | "extracted";

export interface Provenance {
  sourceId: string;
  sourceUrl: string | null;
  method: "api" | "scrape";
  confidence: Confidence;
}

/* ------------------------------ validation ------------------------------ */

const MAX_AMOUNTS: Record<string, number> = {
  deed: 250_000_000,
  loan: 100_000_000,
  permit: 500_000_000,
  lien: 50_000_000,
};

function isPlausibleDate(s: unknown): boolean {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(s)) return false;
  const t = new Date(s).getTime();
  if (!Number.isFinite(t)) return false;
  const year = Number(s.slice(0, 4));
  return year >= 1900 && t <= Date.now() + 86_400_000; // 1-day clock skew
}

function inMarkets(rec: { county?: string; state?: string }, markets: string[]): boolean {
  if (markets.length === 0) return true;
  if (!rec.county || !rec.state) return false;
  const key = `${rec.county}, ${rec.state}`.toLowerCase();
  return markets.some((m) => m.toLowerCase() === key);
}

/**
 * Sanity-check one record. Returns the list of failed checks — empty means
 * the record may be upserted. Kinds without an amount/date contract (corp
 * registry rows) validate only what they carry.
 */
export function validateRecord(
  kind: string,
  rec: Record<string, unknown>,
  markets: string[]
): string[] {
  const reasons: string[] = [];
  const str = (k: string) => (typeof rec[k] === "string" ? (rec[k] as string).trim() : "");

  const dateField =
    kind === "deed" ? "recordedAt"
    : kind === "loan" || kind === "ucc" ? "originatedAt"
    : kind === "satisfaction" ? "satisfiedAt"
    : kind === "corp" ? "" : "filedAt";
  if (dateField) {
    if (!isPlausibleDate(rec[dateField])) reasons.push(`${dateField} is missing, malformed, or in the future`);
  }

  const amountField =
    kind === "deed" ? "price" : kind === "loan" ? "principal"
    : kind === "permit" ? "valuation" : kind === "lien" ? "amount" : "";
  if (amountField) {
    const v = Number(rec[amountField]);
    if (!Number.isFinite(v) || v < 0) reasons.push(`${amountField} is not a plausible dollar amount`);
    else if (v > (MAX_AMOUNTS[kind] ?? 500_000_000)) reasons.push(`${amountField} exceeds the plausibility ceiling`);
  }

  const nameField =
    kind === "deed" ? "buyerName" : kind === "loan" ? "borrowerName"
    : kind === "permit" || kind === "lien" ? "ownerName"
    : kind === "ucc" ? "debtorName" : kind === "corp" ? "entityName" : "";
  if (nameField && (str(nameField).length < 2 || str(nameField).length > 200)) {
    reasons.push(`${nameField} is missing or implausible`);
  }

  // Address-bearing kinds must be inside coverage markets.
  if (kind !== "ucc" && kind !== "corp" && kind !== "satisfaction") {
    if (!str("address")) reasons.push("address is empty");
    if (!inMarkets(rec as { county?: string; state?: string }, markets)) {
      reasons.push("outside configured coverage markets");
    }
  }

  if (typeof rec.ratePct === "number" && (rec.ratePct < 0 || rec.ratePct > 30)) {
    reasons.push("ratePct outside 0-30% plausibility band");
  }

  return reasons;
}

/** Split rows into upsertable and quarantined; persist the rejects. */
export async function gateRecords<T extends Record<string, unknown>>(
  env: Env,
  connector: string,
  kind: string,
  rows: T[],
  markets: string[],
  sourceUrl: string | null
): Promise<{ valid: T[]; quarantined: number }> {
  const valid: T[] = [];
  let quarantined = 0;
  for (const rec of rows) {
    if (!rec || typeof rec !== "object") { quarantined++; continue; }
    const reasons = validateRecord(kind, rec, markets);
    if (reasons.length === 0) {
      valid.push(rec);
      continue;
    }
    quarantined++;
    await env.DB.prepare(
      `INSERT INTO quarantine (id, connector, record_kind, payload_json, reasons_json, source_url)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
      .bind(
        `qtn_${crypto.randomUUID().slice(0, 12)}`, connector, kind,
        JSON.stringify(rec).slice(0, 8_000), JSON.stringify(reasons), sourceUrl
      )
      .run();
  }
  return { valid, quarantined };
}

/* ------------------------------ monitoring ------------------------------ */

export async function recordSourceStats(
  env: Env,
  connector: string,
  ingested: number,
  quarantined: number
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO source_stats (connector, day, rows_ingested, rows_quarantined)
     VALUES (?1, date('now'), ?2, ?3)
     ON CONFLICT (connector, day) DO UPDATE SET
       rows_ingested = rows_ingested + excluded.rows_ingested,
       rows_quarantined = rows_quarantined + excluded.rows_quarantined`
  )
    .bind(connector, ingested, quarantined)
    .run();
}

export interface SourceAnomaly {
  connector: string;
  today: number;
  baseline: number;
}

/**
 * A source is anomalous when today's volume collapses versus its own
 * 14-day median. Requires enough history that quiet days don't false-alarm.
 */
export async function detectAnomalies(env: Env): Promise<SourceAnomaly[]> {
  const rows = await env.DB.prepare(
    `SELECT connector,
            SUM(CASE WHEN day = date('now') THEN rows_ingested ELSE 0 END) AS today,
            COUNT(CASE WHEN day < date('now') THEN 1 END) AS history_days
     FROM source_stats
     WHERE day >= date('now', '-14 days')
     GROUP BY connector`
  ).all<{ connector: string; today: number; history_days: number }>();

  const anomalies: SourceAnomaly[] = [];
  for (const r of rows.results) {
    if (r.history_days < 5) continue;
    const med = await env.DB.prepare(
      `SELECT rows_ingested FROM source_stats
       WHERE connector = ?1 AND day < date('now') AND day >= date('now','-14 days')
       ORDER BY rows_ingested LIMIT 1 OFFSET ?2`
    )
      .bind(r.connector, Math.floor(r.history_days / 2))
      .first<{ rows_ingested: number }>();
    const baseline = med?.rows_ingested ?? 0;
    if (baseline >= 20 && r.today < baseline * 0.25) {
      anomalies.push({ connector: r.connector, today: r.today, baseline });
    }
  }
  return anomalies;
}

/** Data-quality summary for Settings and the daily digest. */
export async function dataQualitySummary(env: Env): Promise<{
  pendingQuarantine: number;
  quarantined7d: number;
  ingested7d: number;
  anomalies: SourceAnomaly[];
}> {
  const [pending, week] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS c FROM quarantine WHERE status = 'pending'").first<{ c: number }>(),
    env.DB.prepare(
      `SELECT SUM(rows_ingested) AS i, SUM(rows_quarantined) AS q
       FROM source_stats WHERE day >= date('now','-7 days')`
    ).first<{ i: number | null; q: number | null }>(),
  ]);
  return {
    pendingQuarantine: pending?.c ?? 0,
    quarantined7d: week?.q ?? 0,
    ingested7d: week?.i ?? 0,
    anomalies: await detectAnomalies(env),
  };
}

/* ------------------------------ corroboration ------------------------------ */

/**
 * When a doc arrives that already exists from a *different* acquisition
 * method (API vs scrape), the two independent observations corroborate
 * each other — upgrade the stored row.
 */
export async function corroborate(
  env: Env,
  table: "transactions" | "loans" | "liens",
  docNumber: string,
  incomingMethod: string
): Promise<void> {
  await env.DB.prepare(
    `UPDATE ${table} SET confidence = 'corroborated'
     WHERE doc_number = ?1 AND confidence != 'corroborated'
       AND source_method IS NOT NULL AND source_method != ?2`
  )
    .bind(docNumber, incomingMethod)
    .run();
}
