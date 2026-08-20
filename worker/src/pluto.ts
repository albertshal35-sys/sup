/**
 * PLUTO enrichment — the city's tax-lot file, joined on BBL.
 *
 * PLUTO (64uk-42ks) carries ~70 fields per tax lot: lot and building area,
 * unit count, year built, zoning, building class, owner of record, assessed
 * value and coordinates. It is keyed by BBL, which the ACRIS join already
 * produces, so this is a join rather than an integration — no new identity
 * resolution, no address matching.
 *
 * It runs as an enrichment, not a record stream: PLUTO describes what a
 * parcel *is*, it does not emit events. Properties are synced in batches,
 * newest-first by the parcels we care about, and re-synced when the file is
 * republished (roughly quarterly).
 *
 * ## On assessed value
 *
 * NYC does not assess at market value. Under RPTL 1802 Class 1 (1-3 family
 * homes) is assessed at 6% of market value and Classes 2-4 at 45%. Taking
 * `assesstot` as a value would understate a Class 1 property by roughly
 * 16x, which would make every LTV in the product meaningless — a $500K note
 * against a $3M house would read as 278% LTV.
 *
 * So the raw figure is kept in `assessed_value` and a derived
 * `est_market_value` is grossed back up by the ratio implied by the
 * building class. That derivation is an *estimate*: the ratios are
 * statutory but assessed values lag the market and carry caps and
 * exemptions. It is good enough to rank leads by equity; it is not an
 * appraisal, and nothing in the product should present it as one.
 */

import type { Env } from "./index";
import type { ConnectorCfg } from "./ingest";

const PLUTO_ID = "64uk-42ks";

/** BBLs per request — same URL-length reasoning as the ACRIS companion joins. */
const BBL_BATCH = 250;
/** Parcels enriched per run, bounded like every other pass in the pipeline. */
const DEFAULT_SYNC_BUDGET = 2_000;
/** Re-sync a parcel after this long; PLUTO republishes a few times a year. */
const RESYNC_AFTER_DAYS = 120;

export interface PlutoRow {
  bbl?: string;
  lotarea?: string;
  bldgarea?: string;
  unitstotal?: string;
  numfloors?: string;
  yearbuilt?: string;
  bldgclass?: string;
  zonedist1?: string;
  ownername?: string;
  assesstot?: string;
  latitude?: string;
  longitude?: string;
}

/**
 * NYC tax class from the DOF building-class letter.
 *
 * Class 1 is 1-3 family residential: building classes A and B throughout,
 * plus C0 (three-family). Class 2 is residential with 4+ units (the rest of
 * C, plus D). Everything else — commercial, industrial, vacant, utility —
 * assesses at the same 45% ratio as Class 2, so it is folded into "4" here
 * rather than modelled in full: the only thing that changes downstream is
 * the ratio, and those share one.
 */
export function taxClassOf(bldgClass: string | null | undefined): "1" | "2" | "4" | null {
  const c = (bldgClass ?? "").trim().toUpperCase();
  if (!c) return null;
  const letter = c[0];
  if (letter === "A" || letter === "B") return "1";
  if (c.startsWith("C0")) return "1"; // three-family homes assess as Class 1
  if (letter === "C" || letter === "D") return "2";
  return "4";
}

/** Statutory assessment ratios (RPTL 1802). */
const ASSESSMENT_RATIO: Record<string, number> = { "1": 0.06, "2": 0.45, "4": 0.45 };

/**
 * Gross assessed value back up to an estimated market value. Returns null
 * rather than guessing when the class is unknown — a wrong ratio is worse
 * than no number, because it would silently rank leads by a bad estimate.
 */
export function estimateMarketValue(
  assessed: number | null | undefined,
  taxClass: string | null | undefined
): number | null {
  const ratio = taxClass ? ASSESSMENT_RATIO[taxClass] : undefined;
  if (!ratio || !assessed || !Number.isFinite(assessed) || assessed <= 0) return null;
  return Math.round(assessed / ratio);
}

const num = (v: string | undefined): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
};

/** Shape one PLUTO row into the columns `properties` stores. */
export function plutoFacts(row: PlutoRow) {
  const bldgClass = (row.bldgclass ?? "").trim() || null;
  const taxClass = taxClassOf(bldgClass);
  const assessed = num(row.assesstot);
  return {
    lotArea: num(row.lotarea),
    bldgArea: num(row.bldgarea),
    unitsTotal: num(row.unitstotal),
    numFloors: num(row.numfloors),
    yearBuilt: num(row.yearbuilt),
    bldgClass,
    zoning: (row.zonedist1 ?? "").trim() || null,
    ownerName: (row.ownername ?? "").trim() || null,
    assessedValue: assessed,
    taxClass,
    estMarketValue: estimateMarketValue(assessed, taxClass),
    lat: num(row.latitude),
    lng: num(row.longitude),
  };
}

function plutoUrl(cfg: ConnectorCfg): string {
  // Reuse whichever Socrata host the operator configured for ACRIS so a
  // mirror or a proxied host keeps working.
  const base = cfg.baseUrl ?? "https://data.cityofnewyork.us/resource/x.json";
  return base.replace(/resource\/[a-z0-9-]+\.json.*/i, `resource/${PLUTO_ID}.json`);
}

async function fetchPluto(url: string, token: string | null): Promise<PlutoRow[]> {
  const res = await fetch(url, { headers: token ? { "X-App-Token": token } : {} });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 220);
    throw new Error(`pluto ${res.status}: ${url.split("?")[0]}${body ? ` — ${body}` : ""}`);
  }
  const rows = JSON.parse(await res.text()) as PlutoRow[];
  if (!Array.isArray(rows)) throw new Error("pluto_unexpected_payload");
  return rows;
}

/**
 * Enrich parcels that have a BBL but no (or stale) PLUTO facts. Bounded per
 * run; returns how many parcels were filled in.
 */
export async function syncPluto(env: Env, cfg: ConnectorCfg, budget = DEFAULT_SYNC_BUDGET): Promise<number> {
  const due = await env.DB.prepare(
    `SELECT id, apn FROM properties
     WHERE apn IS NOT NULL AND state = 'NY'
       AND (pluto_synced_at IS NULL OR julianday('now') - julianday(pluto_synced_at) > ?1)
     ORDER BY pluto_synced_at IS NOT NULL, id
     LIMIT ?2`
  )
    .bind(RESYNC_AFTER_DAYS, budget)
    .all<{ id: string; apn: string }>();
  if (due.results.length === 0) return 0;

  const idByBbl = new Map<string, string>();
  for (const p of due.results) idByBbl.set(p.apn, p.id);
  const bbls = [...idByBbl.keys()];

  const base = plutoUrl(cfg);
  let updated = 0;

  for (let i = 0; i < bbls.length; i += BBL_BATCH) {
    const batch = bbls.slice(i, i + BBL_BATCH);
    const params = new URLSearchParams({
      $where: `bbl in(${batch.map((b) => `'${b.replace(/'/g, "")}'`).join(",")})`,
      $select: "bbl,lotarea,bldgarea,unitstotal,numfloors,yearbuilt,bldgclass,zonedist1,ownername,assesstot,latitude,longitude",
      $limit: "10000",
    });
    const rows = await fetchPluto(`${base}?${params}`, cfg.apiKey);

    const stmts = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const bbl = (row.bbl ?? "").trim();
      const id = idByBbl.get(bbl);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const f = plutoFacts(row);
      stmts.push(
        env.DB.prepare(
          `UPDATE properties SET
             lot_area = ?1, bldg_area = ?2, units_total = ?3, num_floors = ?4,
             year_built = COALESCE(?5, year_built), bldg_class = ?6, zoning = ?7,
             owner_name = ?8, assessed_value = ?9, tax_class = ?10, est_market_value = ?11,
             lat = COALESCE(?12, lat), lng = COALESCE(?13, lng),
             sqft = COALESCE(?2, sqft),
             pluto_synced_at = datetime('now')
           WHERE id = ?14`
        ).bind(
          f.lotArea, f.bldgArea, f.unitsTotal, f.numFloors, f.yearBuilt, f.bldgClass, f.zoning,
          f.ownerName, f.assessedValue, f.taxClass, f.estMarketValue, f.lat, f.lng, id
        )
      );
    }
    // Parcels PLUTO has no row for are stamped too, so a BBL that simply
    // isn't in the tax-lot file doesn't get retried on every single run.
    for (const [bbl, id] of idByBbl) {
      if (batch.includes(bbl) && !seen.has(id)) {
        stmts.push(
          env.DB.prepare("UPDATE properties SET pluto_synced_at = datetime('now') WHERE id = ?1").bind(id)
        );
      }
    }

    for (let j = 0; j < stmts.length; j += 100) {
      const results = await env.DB.batch(stmts.slice(j, j + 100));
      updated += results.filter((r) => r.meta?.changes).length;
    }
  }
  return updated;
}
