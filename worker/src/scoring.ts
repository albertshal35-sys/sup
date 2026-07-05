/**
 * Trigger materialization — turns raw records into scored, deduplicated
 * lead rows in `triggers`. Runs as the last stage of the daily pipeline.
 *
 * Business rules:
 *  1. MATURITY  — active private/hard-money loans originated 8–10 months ago
 *                 (refi window). Score rises as maturity approaches; boosted
 *                 by borrower velocity.
 *  2. CASH_POOR — entities with >= 2 all-cash purchases recorded in the last
 *                 60 days (delayed-financing candidates). Score scales with
 *                 cash deployed and recency.
 *  3. PERMIT    — ground_up/structural permits filed in the last 30 days with
 *                 valuation >= $250k and a matched entity.
 *  4. LIEN      — active mechanics liens filed in the last 21 days (frozen
 *                 draw → rescue capital). Score scales with amount and any
 *                 co-occurring maturing note on the same entity.
 */

import type { Env } from "./index";
import { recomputeCashFlags } from "./acris";

export async function rescoreTriggers(env: Env): Promise<number> {
  let emitted = 0;

  // ACRIS deeds land as cash-until-proven-financed; reconcile against the
  // latest mortgage pulls before the cash-poor rule reads them.
  await recomputeCashFlags(env);

  /* 1 — Upcoming Maturity Sniffer */
  const maturities = await env.DB.prepare(
    `SELECT l.id AS loan_id, l.entity_id, l.property_id, l.principal, l.rate_pct, l.lender_name,
            CAST(julianday(COALESCE(l.maturity_date, date(l.originated_at, '+' || COALESCE(l.term_months,12) || ' months'))) - julianday('now') AS INTEGER) AS days_to_maturity,
            e.velocity_score, e.flips_36mo
     FROM loans l JOIN entities e ON e.id = l.entity_id
     WHERE l.status = 'active'
       AND l.lender_type IN ('private','hard_money')
       AND l.originated_at BETWEEN date('now','-10 months') AND date('now','-8 months')`
  ).all<{
    loan_id: string; entity_id: string; property_id: string; principal: number;
    rate_pct: number; lender_name: string; days_to_maturity: number;
    velocity_score: number; flips_36mo: number;
  }>();

  for (const m of maturities.results) {
    const urgencyScore = Math.max(0, 100 - m.days_to_maturity); // closer = hotter
    const score = Math.min(100, Math.round(urgencyScore * 0.7 + m.velocity_score * 0.3));
    emitted += await upsertTrigger(env, {
      kind: "maturity",
      entityId: m.entity_id,
      propertyId: m.property_id,
      refId: m.loan_id,
      score,
      headline: `Note matures in ~${m.days_to_maturity} days — $${fmtK(m.principal)} with ${m.lender_name}`,
      payload: {
        principal: m.principal,
        lender: m.lender_name,
        rate: m.rate_pct,
        daysToMaturity: m.days_to_maturity,
      },
    });
  }

  /* 2 — Cash-Poor Trigger */
  const cashPoor = await env.DB.prepare(
    `SELECT tx.entity_id, COUNT(*) AS buys, SUM(tx.price) AS cash_deployed,
            MAX(tx.recorded_at) AS last_buy, MIN(tx.recorded_at) AS first_buy,
            (SELECT property_id FROM transactions t2 WHERE t2.entity_id = tx.entity_id
              AND t2.is_cash = 1 AND t2.side='purchase'
              ORDER BY t2.price DESC LIMIT 1) AS flagship_property
     FROM transactions tx
     WHERE tx.is_cash = 1 AND tx.side = 'purchase'
       AND tx.recorded_at >= date('now','-60 days')
       AND tx.entity_id IS NOT NULL
     GROUP BY tx.entity_id
     HAVING COUNT(*) >= 2`
  ).all<{
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
  const bigPermits = await env.DB.prepare(
    `SELECT p.id AS permit_id, p.entity_id, p.property_id, p.valuation, p.permit_type
     FROM permits p
     WHERE p.filed_at >= date('now','-30 days')
       AND p.permit_type IN ('ground_up','structural')
       AND p.valuation >= 250000
       AND p.entity_id IS NOT NULL`
  ).all<{ permit_id: string; entity_id: string; property_id: string; valuation: number; permit_type: string }>();

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

  const freshLiens = await env.DB.prepare(
    `SELECT li.id AS lien_id, li.entity_id, li.property_id, li.amount, li.claimant, li.lien_type,
            CAST(julianday('now') - julianday(li.filed_at) AS INTEGER) AS age_days,
            EXISTS (
              SELECT 1 FROM triggers t
              WHERE t.kind = 'maturity' AND t.entity_id = li.entity_id
                AND t.status NOT IN ('dismissed','converted')
            ) AS has_maturing_note
     FROM liens li
     WHERE li.status = 'active'
       AND li.filed_at >= date('now','-45 days')
       AND li.entity_id IS NOT NULL`
  ).all<{ lien_id: string; entity_id: string; property_id: string; amount: number; claimant: string; lien_type: string; age_days: number; has_maturing_note: number }>();

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
