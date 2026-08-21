/**
 * Trigger materialization — turns raw records into scored, deduplicated
 * lead rows in `triggers`. Runs as the last stage of the daily pipeline.
 *
 * Business rules:
 *  1. MATURITY  — active private/hard-money loans whose assumed maturity is
 *                 near. Ranked by how near, not filtered to a narrow band,
 *                 because ACRIS states no term and the assumed one is a
 *                 guess. Boosted by borrower velocity and by equity.
 *  2. CASH_POOR — entities with >= 2 genuine all-cash purchases in the window
 *                 (delayed-financing candidates). Score scales with cash
 *                 deployed and recency.
 *  3. PERMIT    — ground_up/structural permits with valuation >= $250k and a
 *                 matched entity.
 *  4. LIEN      — active liens, each type carrying its own urgency window
 *                 (frozen draw → rescue capital). Score scales with amount
 *                 and any co-occurring maturing note on the same entity.
 *
 * Every window is measured from the source's own publication watermark, not
 * from today — see watermark.ts. ACRIS publishes monthly in arrears, so a
 * window anchored to `now` asks about a period the source has not published
 * yet and quietly matches nothing.
 */

import type { Env } from "./index";
import { recomputeCashFlags } from "./acris";
import { watermark, windowStart, type Watermark } from "./watermark";

/**
 * Debt position against the parcel's estimated market value.
 *
 * Returns nulls when value is unknown rather than substituting a guess: a
 * fabricated LTV would rank leads confidently and wrongly, which is worse
 * than ranking them on urgency alone. Note the value is derived from NYC
 * assessed value grossed up by the statutory assessment ratio (see
 * pluto.ts) — good enough to sort by, not an appraisal.
 */
export function positionOf(
  principal: number,
  estMarketValue: number | null | undefined
): { ltvPct: number | null; equity: number | null } {
  if (!estMarketValue || estMarketValue <= 0 || !Number.isFinite(principal)) {
    return { ltvPct: null, equity: null };
  }
  return {
    ltvPct: Math.round((principal / estMarketValue) * 100),
    equity: Math.round(estMarketValue - principal),
  };
}

/**
 * Turn LTV into a 0-100 desirability score. Lower leverage is a better
 * refi: there is room to lend against. Above ~85% the deal is effectively
 * unfundable for a private lender, so it bottoms out rather than going
 * negative and dragging an otherwise urgent lead off the board.
 */
export function equityScore(ltvPct: number): number {
  if (ltvPct <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round(100 - (ltvPct / 85) * 100)));
}

/**
 * A conveyance below this is not a purchase in any sense a lender cares
 * about. ACRIS is full of $0 and $10 deeds — intra-family transfers, LLC
 * restructurings, correction deeds — and with no floor two of them in a
 * window produced a "$0 cash deployed across 2 buys" lead, burying the real
 * ones.
 */
const MIN_CASH_PURCHASE = 50_000;

/** Maturity is *ranked* across this span rather than filtered to a slice. */
const MATURITY_MIN_MONTHS = 6;
const MATURITY_MAX_MONTHS = 14;

/**
 * Private notes this far past their assumed maturity are near-certainly
 * resolved — repaid, refinanced or foreclosed — and ACRIS simply never
 * published a satisfaction that matched. Counting them in a parcel's debt
 * stack would understate equity on every lead. Bank mortgages are left in:
 * a 30-year amortizing loan really is still outstanding.
 */
const STALE_PRIVATE_NOTE_MONTHS = 24;

export async function rescoreTriggers(env: Env): Promise<number> {
  let emitted = 0;

  // ACRIS deeds land as cash-until-proven-financed; reconcile against the
  // latest mortgage pulls before the cash-poor rule reads them.
  await recomputeCashFlags(env);

  /* 1 — Upcoming Maturity Sniffer */
  const maturities = await env.DB.prepare(
    `SELECT l.id AS loan_id, l.entity_id, l.property_id, l.principal, l.rate_pct, l.lender_name,
            CAST(julianday(COALESCE(l.maturity_date, date(l.originated_at, '+' || COALESCE(l.term_months,12) || ' months'))) - julianday('now') AS INTEGER) AS days_to_maturity,
            e.velocity_score, e.flips_36mo,
            p.est_market_value, p.units_total, p.year_built, p.bldg_class,
            -- Every still-active recorded lien against the same parcel, so
            -- equity is measured against the whole debt stack rather than
            -- just the note that happens to be maturing.
            (SELECT COALESCE(SUM(l2.principal), 0) FROM loans l2
              WHERE l2.property_id = l.property_id AND l2.status = 'active'
                AND l2.instrument = 'mortgage'
                -- Drop private notes long past their assumed maturity: almost
                -- all are resolved and simply never had a satisfaction match.
                AND NOT (l2.lender_type IN ('private','hard_money')
                         AND date(l2.originated_at, '+' || (COALESCE(l2.term_months,12) + ?1) || ' months') < date('now'))
              ) AS stack_principal
     FROM loans l
     JOIN entities e ON e.id = l.entity_id
     LEFT JOIN properties p ON p.id = l.property_id
     WHERE l.status = 'active'
       AND l.lender_type IN ('private','hard_money')
       AND l.originated_at BETWEEN date('now', '-' || ?3 || ' months') AND date('now', '-' || ?2 || ' months')`
  )
    .bind(STALE_PRIVATE_NOTE_MONTHS, MATURITY_MIN_MONTHS, MATURITY_MAX_MONTHS)
    .all<{
    loan_id: string; entity_id: string; property_id: string; principal: number;
    rate_pct: number; lender_name: string; days_to_maturity: number;
    velocity_score: number; flips_36mo: number;
    est_market_value: number | null; units_total: number | null;
    year_built: number | null; bldg_class: string | null; stack_principal: number;
  }>();

  for (const m of maturities.results) {
    const urgencyScore = Math.max(0, 100 - m.days_to_maturity); // closer = hotter
    const { ltvPct, equity } = positionOf(m.stack_principal || m.principal, m.est_market_value);

    // Equity is what decides whether a refi is fundable at all, so once it
    // is known it carries real weight. Without PLUTO the term is simply
    // absent rather than assumed — an unenriched parcel scores on urgency
    // and velocity exactly as it did before.
    const score = Math.min(100, Math.round(
      ltvPct === null
        ? urgencyScore * 0.7 + m.velocity_score * 0.3
        : urgencyScore * 0.5 + m.velocity_score * 0.2 + equityScore(ltvPct) * 0.3
    ));

    emitted += await upsertTrigger(env, {
      kind: "maturity",
      entityId: m.entity_id,
      propertyId: m.property_id,
      refId: m.loan_id,
      score,
      headline:
        `Note matures in ~${m.days_to_maturity} days — $${fmtK(m.principal)} with ${m.lender_name}` +
        (ltvPct !== null ? ` · ~${ltvPct}% LTV, ~$${fmtK(equity!)} equity` : ""),
      payload: {
        principal: m.principal,
        lender: m.lender_name,
        rate: m.rate_pct,
        daysToMaturity: m.days_to_maturity,
        stackPrincipal: m.stack_principal || null,
        estMarketValue: m.est_market_value,
        ltvPct,
        equity,
        unitsTotal: m.units_total,
        yearBuilt: m.year_built,
        bldgClass: m.bldg_class,
      },
    });
  }

  /* 2 — Cash-Poor Trigger */
  const deedMark = await watermark(env, "transactions", "recorded_at");
  const cashPoor = await env.DB.prepare(
    `SELECT tx.entity_id, COUNT(*) AS buys, SUM(tx.price) AS cash_deployed,
            MAX(tx.recorded_at) AS last_buy, MIN(tx.recorded_at) AS first_buy,
            (SELECT property_id FROM transactions t2 WHERE t2.entity_id = tx.entity_id
              AND t2.is_cash = 1 AND t2.side='purchase' AND t2.price >= ?3
              ORDER BY t2.price DESC LIMIT 1) AS flagship_property
     FROM transactions tx
     WHERE tx.is_cash = 1 AND tx.side = 'purchase'
       AND tx.recorded_at BETWEEN ?1 AND ?2
       AND tx.entity_id IS NOT NULL
       -- A nominal or fractional conveyance is not a cash purchase.
       AND tx.price >= ?3
       AND (tx.percent_transferred IS NULL OR tx.percent_transferred >= 100)
     GROUP BY tx.entity_id
     HAVING COUNT(*) >= 2`
  )
    .bind(windowStart(deedMark, 60), deedMark.anchor, MIN_CASH_PURCHASE)
    .all<{
    entity_id: string; buys: number; cash_deployed: number;
    last_buy: string; first_buy: string; flagship_property: string;
  }>();

  for (const c of cashPoor.results) {
    const magnitude = Math.min(50, Math.round(c.cash_deployed / 100_000)); // $5M caps it
    const score = Math.min(100, 40 + magnitude + c.buys * 5);
    emitted += await upsertTrigger(env, {
      kind: "cash_poor",
      entityId: c.entity_id,
      propertyId: c.flagship_property,
      refId: null,
      score,
      headline: `$${fmtK(c.cash_deployed)} cash deployed across ${c.buys} buys in the last 60 days`,
      payload: { cashDeployed: c.cash_deployed, buys: c.buys },
    });
  }

  /* 3 — Permit-to-Social Matching */
  const permitMark = await watermark(env, "permits", "filed_at");
  const bigPermits = await env.DB.prepare(
    `SELECT p.id AS permit_id, p.entity_id, p.property_id, p.valuation, p.permit_type
     FROM permits p
     WHERE p.filed_at BETWEEN ?1 AND ?2
       AND p.permit_type IN ('ground_up','structural')
       AND p.valuation >= 250000
       AND p.entity_id IS NOT NULL`
  )
    .bind(windowStart(permitMark, 30), permitMark.anchor)
    .all<{ permit_id: string; entity_id: string; property_id: string; valuation: number; permit_type: string }>();

  for (const p of bigPermits.results) {
    const score = Math.min(100, 50 + Math.round(p.valuation / 60_000));
    emitted += await upsertTrigger(env, {
      kind: "permit",
      entityId: p.entity_id,
      propertyId: p.property_id,
      refId: p.permit_id,
      score,
      headline: `$${fmtK(p.valuation)} ${p.permit_type === "ground_up" ? "ground-up" : "structural"} permit filed`,
      payload: { valuation: p.valuation, permitType: p.permit_type },
    });
  }

  /* 4 — Distress monitoring: liens, lis pendens, violations, tax liens,
         auction calendar. Each event type carries its own base urgency and
         rescue-capital framing. */
  const DISTRESS: Record<string, { base: number; headline: (amt: string, claimant: string) => string; window: number }> = {
    mechanics: { base: 55, window: 21, headline: (a, c) => `$${a} mechanics lien by ${c} — draw likely frozen` },
    lis_pendens: { base: 74, window: 45, headline: (a, c) => `Lis pendens filed by ${c} — pre-foreclosure, rescue window open` },
    auction: { base: 78, window: 45, headline: (a, c) => `Scheduled for foreclosure auction (${c}) — last-chance refinance` },
    tax: { base: 52, window: 45, headline: (a, c) => `$${a} tax lien (${c}) — municipal pressure building` },
    violation: { base: 42, window: 30, headline: (a, c) => `${c} violation, $${a} in penalties — project likely stalled` },
    judgment: { base: 58, window: 45, headline: (a, c) => `$${a} judgment lien by ${c}` },
  };

  const lienMark = await watermark(env, "liens", "filed_at");
  const freshLiens = await env.DB.prepare(
    `SELECT li.id AS lien_id, li.entity_id, li.property_id, li.amount, li.claimant, li.lien_type,
            -- Age is measured against the publication watermark, not today.
            -- Measured against now, a 21-day mechanics window can never
            -- match a source that publishes a month in arrears.
            CAST(julianday(?2) - julianday(li.filed_at) AS INTEGER) AS age_days,
            EXISTS (
              SELECT 1 FROM triggers t
              WHERE t.kind = 'maturity' AND t.entity_id = li.entity_id
                AND t.status NOT IN ('dismissed','converted')
            ) AS has_maturing_note
     FROM liens li
     WHERE li.status = 'active'
       AND li.filed_at BETWEEN ?1 AND ?2
       AND li.entity_id IS NOT NULL`
  )
    .bind(windowStart(lienMark, 45), lienMark.anchor)
    .all<{ lien_id: string; entity_id: string; property_id: string; amount: number; claimant: string; lien_type: string; age_days: number; has_maturing_note: number }>();

  for (const li of freshLiens.results) {
    const def = DISTRESS[li.lien_type] ?? DISTRESS.mechanics;
    if (li.age_days > def.window) continue;
    const score = Math.min(
      100,
      def.base + Math.round(li.amount / 10_000) + (li.has_maturing_note ? 15 : 0)
    );
    emitted += await upsertTrigger(env, {
      kind: "lien",
      entityId: li.entity_id,
      propertyId: li.property_id,
      refId: li.lien_id,
      score,
      headline: def.headline(fmtK(li.amount), li.claimant),
      payload: { amount: li.amount, claimant: li.claimant, lienType: li.lien_type },
    });
  }

  return emitted;
}

export async function upsertTrigger(
  env: Env,
  t: {
    kind: string;
    entityId: string;
    propertyId: string | null;
    refId: string | null;
    score: number;
    headline: string;
    payload: Record<string, unknown>;
  }
): Promise<number> {
  const urgency = t.score >= 90 ? "critical" : t.score >= 78 ? "hot" : "warm";
  const res = await env.DB.prepare(
    `INSERT INTO triggers (id, kind, entity_id, property_id, ref_id, score, urgency, headline, payload_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT (kind, entity_id, ref_id) DO UPDATE SET
       score = excluded.score, urgency = excluded.urgency,
       headline = excluded.headline, payload_json = excluded.payload_json`
  )
    .bind(
      crypto.randomUUID(),
      t.kind,
      t.entityId,
      t.propertyId,
      t.refId,
      t.score,
      urgency,
      t.headline,
      JSON.stringify(t.payload)
    )
    .run();
  return res.success ? 1 : 0;
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  return `${Math.round(n / 1000)}K`;
}
