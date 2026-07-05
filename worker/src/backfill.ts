/**
 * Historical backfill — walks a connector's source backwards month by month
 * to 36 months so borrower resumes and rate history are complete, not just
 * complete-from-deploy-day.
 *
 * Free-tier friendly by design: one month-window chunk per invocation per
 * connector, bounded row counts, cursor persisted in `backfill_state`.
 * A chunk runs when the operator clicks "Continue backfill" in Settings and
 * automatically after each daily cron, so an idle deploy still finishes the
 * crawl over a few weeks without ever brushing the daily write budget.
 * Only API-mode sources can backfill (a scraped portal page has no history).
 */

import type { Env } from "./index";
import {
  acquireAndIngest,
  connectorRunnable,
  getConnectorConfig,
  getMarkets,
  isSocrataUrl,
  RECORD_CONNECTORS,
} from "./ingest";
import { acrisCapable, isAcrisMaster } from "./acris";

export const BACKFILL_MONTHS = 36;
const CHUNKS_PER_CRON = 2; // connectors advanced per scheduled run

function monthShift(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export async function backfillEligible(env: Env, id: string): Promise<boolean> {
  if (!RECORD_CONNECTORS[id]) return false;
  const cfg = await getConnectorConfig(env, id);
  if (!cfg.enabled || cfg.mode !== "api" || !cfg.baseUrl) return false;
  if (isAcrisMaster(cfg.baseUrl) && acrisCapable(id)) return true; // join needs no field map
  return !isSocrataUrl(cfg.baseUrl) || Boolean(cfg.fieldMap?.dateField);
}

/** Start (or restart) a connector's crawl from today back to -36 months. */
export async function startBackfill(env: Env, id: string): Promise<boolean> {
  if (!(await backfillEligible(env, id))) return false;
  const today = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO backfill_state (connector, cursor_date, target_date, status, rows_total, error, updated_at)
     VALUES (?1, ?2, ?3, 'running', 0, NULL, datetime('now'))
     ON CONFLICT (connector) DO UPDATE SET
       cursor_date = excluded.cursor_date, target_date = excluded.target_date,
       status = 'running', rows_total = 0, error = NULL, updated_at = datetime('now')`
  )
    .bind(id, today, monthShift(today, -BACKFILL_MONTHS))
    .run();
  return true;
}

/** Pull one month-window chunk for a running backfill. */
export async function runBackfillChunk(env: Env, id: string): Promise<{ done: boolean; ingested: number }> {
  const state = await env.DB.prepare(
    "SELECT cursor_date, target_date FROM backfill_state WHERE connector = ?1 AND status = 'running'"
  )
    .bind(id)
    .first<{ cursor_date: string; target_date: string }>();
  if (!state) return { done: true, ingested: 0 };

  const cfg = await getConnectorConfig(env, id);
  if (!connectorRunnable(cfg) || cfg.mode !== "api") {
    await env.DB.prepare(
      "UPDATE backfill_state SET status = 'error', error = 'connector not runnable in api mode', updated_at = datetime('now') WHERE connector = ?1"
    ).bind(id).run();
    return { done: true, ingested: 0 };
  }

  const to = state.cursor_date;
  const from = monthShift(to, -1) < state.target_date ? state.target_date : monthShift(to, -1);
  try {
    const markets = await getMarkets(env);
    const result = await acquireAndIngest(env, cfg, markets, { from, to });
    const done = from <= state.target_date;
    await env.DB.prepare(
      `UPDATE backfill_state SET cursor_date = ?1, status = ?2, rows_total = rows_total + ?3, updated_at = datetime('now')
       WHERE connector = ?4`
    )
      .bind(from, done ? "done" : "running", result.ingested, id)
      .run();
    return { done, ingested: result.ingested };
  } catch (err) {
    await env.DB.prepare(
      "UPDATE backfill_state SET status = 'error', error = ?1, updated_at = datetime('now') WHERE connector = ?2"
    )
      .bind(String(err).slice(0, 300), id)
      .run();
    return { done: true, ingested: 0 };
  }
}

/** Advance a couple of running backfills after each cron run. */
export async function continueBackfills(env: Env): Promise<void> {
  const running = await env.DB.prepare(
    "SELECT connector FROM backfill_state WHERE status = 'running' ORDER BY updated_at LIMIT ?1"
  )
    .bind(CHUNKS_PER_CRON)
    .all<{ connector: string }>();
  for (const r of running.results) {
    await runBackfillChunk(env, r.connector);
  }
}

export async function backfillStatus(env: Env): Promise<
  Array<{ connector: string; status: string; cursorDate: string | null; targetDate: string | null; rowsTotal: number; error: string | null; pctComplete: number }>
> {
  const rows = await env.DB.prepare(
    "SELECT connector, status, cursor_date, target_date, rows_total, error FROM backfill_state"
  ).all<{ connector: string; status: string; cursor_date: string | null; target_date: string | null; rows_total: number; error: string | null }>();
  const today = Date.now();
  return rows.results.map((r) => {
    let pct = 0;
    if (r.status === "done") pct = 100;
    else if (r.cursor_date && r.target_date) {
      const total = today - new Date(r.target_date).getTime();
      const covered = today - new Date(r.cursor_date).getTime();
      pct = total > 0 ? Math.min(99, Math.round((covered / total) * 100)) : 0;
    }
    return {
      connector: r.connector, status: r.status, cursorDate: r.cursor_date,
      targetDate: r.target_date, rowsTotal: r.rows_total, error: r.error, pctComplete: pct,
    };
  });
}
