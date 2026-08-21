/**
 * Publication-relative time.
 *
 * Every signal window used to be written against `date('now')` — liens filed
 * in the last 21 days, cash purchases recorded in the last 60, permits filed
 * in the last 30. That is the right shape for a source that updates daily.
 * It is the wrong shape for ACRIS, which per DOF's extract guide regenerates
 * **monthly**, carrying documents recorded in the *previous* month. On any
 * given day the freshest recorded document available is roughly four to nine
 * weeks old, depending where you sit in the publication cycle.
 *
 * The consequences were not subtle: a 21-day mechanics-lien window can never
 * match anything, and the 30/45/60-day windows cover a fraction of the data
 * they appear to. The feeds looked empty and the pipeline looked healthy,
 * because nothing was failing — the questions were just being asked about a
 * period the source had not published yet.
 *
 * So windows anchor to the newest record a source has actually delivered
 * rather than to today. When a source is current the anchor *is* today and
 * behaviour is unchanged; when it lags, the window slides back with it and
 * keeps covering the same amount of real data.
 */

import type { Env } from "./index";

/**
 * Past this, a source is broken rather than lagging, and sliding the window
 * further would dress up stale records as fresh leads. The anchor stops and
 * the staleness is reported instead.
 */
export const MAX_LAG_DAYS = 180;

export interface Watermark {
  /** Date the windows count back from (YYYY-MM-DD). */
  anchor: string;
  /** How far behind today the source's newest record is. */
  lagDays: number;
  /** Newest record the source has delivered, or null when it has none. */
  newest: string | null;
  /** Lag exceeded MAX_LAG_DAYS — the anchor was clamped. */
  stale: boolean;
}

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Compute the anchor from a source's newest record and today. */
export function anchorFrom(newest: string | null, today: string): Watermark {
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const newestMs = newest ? Date.parse(`${newest}T00:00:00Z`) : NaN;

  // No data, or an unparseable date: behave exactly as before.
  if (!Number.isFinite(newestMs)) return { anchor: today, lagDays: 0, newest: null, stale: false };

  const lagDays = Math.max(0, Math.round((todayMs - newestMs) / DAY));
  // A source reporting the future (clock skew, a mis-parsed date) must never
  // push the window past today.
  if (lagDays === 0) return { anchor: today, lagDays: 0, newest, stale: false };

  const stale = lagDays > MAX_LAG_DAYS;
  return {
    anchor: stale ? iso(todayMs - MAX_LAG_DAYS * DAY) : iso(newestMs),
    lagDays,
    newest,
    stale,
  };
}

/** Read a source's newest record date and turn it into an anchor. */
export async function watermark(
  env: Env,
  table: "transactions" | "liens" | "permits" | "loans",
  dateCol: "recorded_at" | "filed_at" | "originated_at"
): Promise<Watermark> {
  // Live rows only: seeded demo data carries today's dates and would mask a
  // lagging live source behind a healthy-looking anchor.
  const row = await env.DB.prepare(
    `SELECT MAX(${dateCol}) AS newest FROM ${table} WHERE origin = 'live'`
  ).first<{ newest: string | null }>();
  const today = new Date().toISOString().slice(0, 10);
  return anchorFrom(row?.newest ?? null, today);
}

/** `date(anchor, '-N days')` — the start of a window ending at the anchor. */
export function windowStart(w: Watermark, days: number): string {
  return iso(Date.parse(`${w.anchor}T00:00:00Z`) - days * DAY);
}
