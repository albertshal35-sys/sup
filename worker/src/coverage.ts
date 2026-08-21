/**
 * Coverage diagnostic — "where is the volume going?", answered from the data
 * rather than inferred from the pipeline's own status flags.
 *
 * The existing pipeline doctor reports whether connectors *ran*. That is a
 * different question from whether they produced anything usable, and the gap
 * between the two is where the failures hide: a connector can run cleanly
 * every sweep while every record it pulls is quarantined for being outside a
 * mistyped market, or while every signal window asks about a period the
 * source has not published yet.
 *
 * This reports the things that actually decide feed volume — how much data
 * exists, how far behind the source is, what got rejected and why, and how
 * many rows each signal's window currently reaches.
 */

import type { Env } from "./index";
import { marketKey } from "./integrity";
import { watermark, windowStart, type Watermark } from "./watermark";

export interface CoverageReport {
  dataMode: string;
  markets: { configured: string[]; matched: Record<string, number>; unmatched: string[] };
  counts: Record<string, number>;
  sources: Array<{ source: string; newest: string | null; lagDays: number; stale: boolean }>;
  windows: Array<{ signal: string; from: string; to: string; rowsInWindow: number }>;
  quarantine: Array<{ reason: string; count: number }>;
  notes: string[];
}

const count = async (env: Env, sql: string, binds: unknown[] = []): Promise<number> => {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
};

export async function coverageReport(env: Env): Promise<CoverageReport> {
  const notes: string[] = [];

  const setting = async (key: string) =>
    (await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?1").bind(key).first<{ value: string }>())?.value ?? null;

  const dataMode = (await setting("data_mode")) ?? "demo";
  let markets: string[] = [];
  try {
    markets = JSON.parse((await setting("markets")) ?? "[]") as string[];
  } catch {
    notes.push("markets setting is not valid JSON — the coverage gate is treating it as empty");
  }

  /* ---- what exists ---- */
  const counts: Record<string, number> = {
    transactions: await count(env, "SELECT COUNT(*) n FROM transactions WHERE origin='live'"),
    loans: await count(env, "SELECT COUNT(*) n FROM loans WHERE origin='live'"),
    liens: await count(env, "SELECT COUNT(*) n FROM liens WHERE origin='live'"),
    permits: await count(env, "SELECT COUNT(*) n FROM permits WHERE origin='live'"),
    entities: await count(env, "SELECT COUNT(*) n FROM entities WHERE origin='live'"),
    properties: await count(env, "SELECT COUNT(*) n FROM properties WHERE origin='live'"),
    propertiesWithParcelKey: await count(env, "SELECT COUNT(*) n FROM properties WHERE apn IS NOT NULL"),
    propertiesPriced: await count(env, "SELECT COUNT(*) n FROM properties WHERE est_market_value IS NOT NULL"),
    triggers: await count(env, "SELECT COUNT(*) n FROM triggers"),
    quarantined: await count(env, "SELECT COUNT(*) n FROM quarantine"),
    nominalDeeds: await count(env, "SELECT COUNT(*) n FROM transactions WHERE side='purchase' AND price < 50000"),
  };

  /* ---- how current each source is ---- */
  const marks: Array<[string, Watermark]> = [
    ["deeds", await watermark(env, "transactions", "recorded_at")],
    ["loans", await watermark(env, "loans", "originated_at")],
    ["liens", await watermark(env, "liens", "filed_at")],
    ["permits", await watermark(env, "permits", "filed_at")],
  ];
  const sources = marks.map(([source, w]) => ({
    source, newest: w.newest, lagDays: w.lagDays, stale: w.stale,
  }));
  for (const [source, w] of marks) {
    if (w.stale) {
      notes.push(`${source}: newest record is ${w.lagDays} days old — that is a stopped source, not a lagging one`);
    } else if (w.newest === null && counts.transactions + counts.loans > 0) {
      notes.push(`${source}: no live rows yet`);
    }
  }

  /* ---- what each signal window actually reaches ---- */
  const deed = marks[0][1], lien = marks[2][1], permit = marks[3][1];
  const windows = [
    {
      signal: "cash_poor",
      from: windowStart(deed, 60),
      to: deed.anchor,
      rowsInWindow: await count(
        env,
        `SELECT COUNT(*) n FROM transactions WHERE side='purchase' AND is_cash=1
           AND price >= 50000 AND recorded_at BETWEEN ?1 AND ?2`,
        [windowStart(deed, 60), deed.anchor]
      ),
    },
    {
      signal: "liens",
      from: windowStart(lien, 45),
      to: lien.anchor,
      rowsInWindow: await count(
        env,
        "SELECT COUNT(*) n FROM liens WHERE status='active' AND filed_at BETWEEN ?1 AND ?2",
        [windowStart(lien, 45), lien.anchor]
      ),
    },
    {
      signal: "permits",
      from: windowStart(permit, 30),
      to: permit.anchor,
      rowsInWindow: await count(
        env,
        `SELECT COUNT(*) n FROM permits WHERE valuation >= 250000
           AND permit_type IN ('ground_up','structural') AND filed_at BETWEEN ?1 AND ?2`,
        [windowStart(permit, 30), permit.anchor]
      ),
    },
    {
      signal: "maturity",
      from: "originated -14 months",
      to: "originated -6 months",
      rowsInWindow: await count(
        env,
        `SELECT COUNT(*) n FROM loans WHERE status='active' AND lender_type IN ('private','hard_money')
           AND originated_at BETWEEN date('now','-14 months') AND date('now','-6 months')`
      ),
    },
  ];

  /* ---- markets: which configured entries match real data ---- */
  const seen = await env.DB.prepare(
    `SELECT county, state, COUNT(*) n FROM properties WHERE origin='live' GROUP BY county, state`
  ).all<{ county: string; state: string; n: number }>();
  const byKey = new Map<string, number>();
  for (const r of seen.results) byKey.set(marketKey(r.county, r.state), r.n);

  const matched: Record<string, number> = {};
  const unmatched: string[] = [];
  for (const m of markets) {
    const [c, st] = m.split(",");
    const key = st ? marketKey(c, st) : "";
    const n = key ? byKey.get(key) ?? 0 : 0;
    matched[m] = n;
    if (n === 0) unmatched.push(m);
  }
  if (unmatched.length > 0) {
    notes.push(
      `market(s) matching no stored records: ${unmatched.join("; ")} — every incoming record outside the matched set is quarantined`
    );
  }
  if (markets.length === 0) {
    notes.push("no markets configured — the coverage gate is open, so nothing is rejected on geography");
  }

  /* ---- why records were rejected ---- */
  const q = await env.DB.prepare(
    "SELECT reasons_json, COUNT(*) n FROM quarantine GROUP BY reasons_json ORDER BY n DESC LIMIT 8"
  ).all<{ reasons_json: string; n: number }>();
  const quarantine = q.results.map((r) => ({ reason: r.reasons_json.slice(0, 160), count: r.n }));

  if (dataMode !== "live" && counts.transactions > 0) {
    notes.push("data mode is demo — the feeds read seeded rows, not the live ones counted here");
  }

  return { dataMode, markets: { configured: markets, matched, unmatched }, counts, sources, windows, quarantine, notes };
}
