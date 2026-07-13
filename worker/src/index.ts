/**
 * LienWolf API — Cloudflare Worker (edge).
 *
 * Routing structure:
 *   GET  /api/health                      liveness + last ingestion status
 *   GET  /api/kpis                        dashboard metric strip
 *   GET  /api/triggers/maturities         Upcoming Maturity Sniffer feed
 *   GET  /api/triggers/cash-poor          Cash-Poor (delayed financing) feed
 *   GET  /api/triggers/permits            Permit-to-Social feed
 *   GET  /api/triggers/liens              Mechanics-lien rescue feed
 *   GET  /api/borrowers/:id/resume        Automated Borrower Resume (36-mo)
 *   POST /api/triggers/:id/status         mark viewed/contacted/dismissed
 *   POST /api/watchlist                   add entity to pipeline
 *   DELETE /api/watchlist/:entityId       remove from pipeline
 *   POST /api/webhooks/records            HMAC-verified inbound record push
 *
 * Scheduled (cron "0 11 * * 1-5"): full ingestion + rescore pipeline.
 */

import { routeRequest } from "./routes";
import { maybeSeedDailyPulls, processBackgroundWork } from "./ingest";

export interface Env {
  DB: D1Database;
  ALLOWED_ORIGIN: string;
  COUNTY_API_KEY?: string;
  PERMIT_API_KEY?: string;
  SKIP_TRACE_API_KEY?: string;
  WEBHOOK_SECRET?: string;
  ADMIN_TOKEN?: string; // legacy alias for ACCESS_CODE
  ACCESS_CODE?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  RESEND_API_KEY?: string;
  ALERT_FROM?: string;
  AI_MODEL?: string;
  AI?: { run(model: string, inputs: unknown, options?: unknown): Promise<unknown> };
}

function corsHeaders(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

export function json(data: unknown, env: Env, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(env),
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    try {
      return await routeRequest(request, env, ctx);
    } catch (err) {
      console.error("unhandled", err);
      return json({ error: "internal_error" }, env, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // One cron, everything in code: each 10-minute tick seeds the pull
    // queue when a sweep boundary (11:00/23:00 UTC) has passed, then
    // drains a bounded slice per invocation (Workers cap subrequests per
    // invocation, so pulls are spread out instead of run all at once) and
    // advances running backfills whenever no pulls are pending. Scoring
    // and the rest of the analytics tail fire when a sweep finishes
    // draining.
    ctx.waitUntil(maybeSeedDailyPulls(env).then(() => processBackgroundWork(env)));
  },
};
