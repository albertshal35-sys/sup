/**
 * Custom signals — operator-defined rules, described in plain English in
 * Settings, compiled ONCE to a deterministic JSON rule by the AI, then
 * evaluated here with plain SQL after every pipeline run. No model is
 * involved at evaluation time, so every hit is reproducible and auditable.
 */

import type { Env } from "./index";
import { upsertTrigger } from "./scoring";

export interface SignalRule {
  record: "deed" | "loan" | "permit" | "lien";
  label?: string;
  filters?: {
    windowDays?: number | null;
    isCash?: boolean | null;
    minAmount?: number | null;
    maxAmount?: number | null;
    counties?: string[] | null;
    cities?: string[] | null;
    minFlips?: number | null;
    minVelocity?: number | null;
    lenderTypes?: string[] | null;
    minRate?: number | null;
    permitTypes?: string[] | null;
    lienTypes?: string[] | null;
  };
}

const RECORD_SQL: Record<SignalRule["record"], { table: string; date: string; amount: string; propCol: string }> = {
  deed: { table: "transactions", date: "recorded_at", amount: "price", propCol: "property_id" },
  loan: { table: "loans", date: "originated_at", amount: "principal", propCol: "property_id" },
  permit: { table: "permits", date: "filed_at", amount: "valuation", propCol: "property_id" },
  lien: { table: "liens", date: "filed_at", amount: "amount", propCol: "property_id" },
};

interface HitRow {
  id: string;
  entity_id: string | null;
  property_id: string | null;
  amount: number;
  event_date: string;
}

/** Evaluate one compiled rule; returns matching record rows. */
async function evaluateRule(env: Env, rule: SignalRule): Promise<HitRow[]> {
  const def = RECORD_SQL[rule.record];
  if (!def) return [];
  const f = rule.filters ?? {};
  const windowDays = Math.min(365, Math.max(1, f.windowDays ?? 30));

  const where: string[] = [
    `r.${def.date} >= date('now', '-${windowDays} days')`,
    "r.entity_id IS NOT NULL",
  ];
  const binds: unknown[] = [];
  let bindIdx = 1;
  const push = (clause: string, value: unknown) => {
    where.push(clause.replace("?", `?${bindIdx}`));
    binds.push(value);
    bindIdx++;
  };

  if (rule.record === "deed" && typeof f.isCash === "boolean") {
    where.push(`r.is_cash = ${f.isCash ? 1 : 0} AND r.side = 'purchase'`);
  }
  if (f.minAmount != null) push(`r.${def.amount} >= ?`, Math.round(f.minAmount));
  if (f.maxAmount != null) push(`r.${def.amount} <= ?`, Math.round(f.maxAmount));
  if (f.minRate != null && rule.record === "loan") push("r.rate_pct >= ?", f.minRate);
  if (f.minFlips != null) push("e.flips_36mo >= ?", Math.round(f.minFlips));
  if (f.minVelocity != null) push("e.velocity_score >= ?", Math.round(f.minVelocity));

  const inList = (col: string, values: string[] | null | undefined) => {
    const vals = (values ?? []).filter((v) => typeof v === "string" && v.length < 60).slice(0, 12);
    if (vals.length === 0) return;
    where.push(`${col} IN (${vals.map(() => `?${bindIdx++}`).join(",")})`);
    binds.push(...vals);
  };
  inList("p.county", f.counties);
  inList("p.city", f.cities);
  if (rule.record === "loan") inList("r.lender_type", f.lenderTypes);
  if (rule.record === "permit") inList("r.permit_type", f.permitTypes);
  if (rule.record === "lien") inList("r.lien_type", f.lienTypes);

  const needsProperty = Boolean(f.counties?.length || f.cities?.length);
  const sql = `
    SELECT r.id, r.entity_id, r.${def.propCol} AS property_id,
           r.${def.amount} AS amount, r.${def.date} AS event_date
    FROM ${def.table} r
    JOIN entities e ON e.id = r.entity_id
    ${needsProperty ? `JOIN properties p ON p.id = r.${def.propCol}` : `LEFT JOIN properties p ON p.id = r.${def.propCol}`}
    WHERE ${where.join(" AND ")}
    LIMIT 200`;

  const res = await env.DB.prepare(sql).bind(...binds).all<HitRow>();
  return res.results;
}

/** Run every enabled custom signal; materialize hits as `custom` triggers. */
export async function evaluateCustomSignals(env: Env): Promise<number> {
  const signals = await env.DB.prepare(
    "SELECT id, name, rule_json FROM custom_signals WHERE enabled = 1"
  ).all<{ id: string; name: string; rule_json: string }>();

  let emitted = 0;
  for (const sig of signals.results) {
    let rule: SignalRule;
    try {
      rule = JSON.parse(sig.rule_json) as SignalRule;
    } catch {
      continue;
    }
    let hits: HitRow[] = [];
    try {
      hits = await evaluateRule(env, rule);
    } catch (err) {
      console.warn(`custom signal ${sig.id} evaluation failed`, err);
      continue;
    }
    for (const h of hits) {
      if (!h.entity_id) continue;
      emitted += await upsertTrigger(env, {
        kind: "custom",
        entityId: h.entity_id,
        propertyId: h.property_id,
        refId: `${sig.id}:${h.id}`, // one trigger per record per signal
        score: 70,
        headline: `${sig.name} — $${Math.round(h.amount / 1000)}K on ${h.event_date}`,
        payload: { signalId: sig.id, signalName: sig.name, amount: h.amount, eventDate: h.event_date },
      });
    }
    await env.DB.prepare(
      "UPDATE custom_signals SET last_run_at = datetime('now'), total_hits = total_hits + ?1 WHERE id = ?2"
    )
      .bind(hits.length, sig.id)
      .run();
  }
  return emitted;
}
