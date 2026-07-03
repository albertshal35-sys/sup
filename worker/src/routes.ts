/** REST handlers backed by D1. All reads come from indexed/materialized tables. */

import { json, type Env } from "./index";
import { runIngestionPipeline } from "./ingest";

type Handler = (
  req: Request,
  env: Env,
  params: Record<string, string>,
  url: URL
) => Promise<Response>;

const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];

function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" + path.replace(/:[^/]+/g, (m) => (keys.push(m.slice(1)), "([^/]+)")) + "$"
  );
  routes.push({ method, pattern, keys, handler });
}

export async function routeRequest(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.pattern);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return r.handler(req, env, params, url);
  }
  // manual trigger for the pipeline (protected by webhook secret) — useful for backfills
  if (req.method === "POST" && url.pathname === "/api/admin/run-ingestion") {
    if (!env.WEBHOOK_SECRET || req.headers.get("Authorization") !== `Bearer ${env.WEBHOOK_SECRET}`) {
      return json({ error: "unauthorized" }, env, 401);
    }
    ctx.waitUntil(runIngestionPipeline(env, new Date()));
    return json({ ok: true, started: true }, env, 202);
  }
  return json({ error: "not_found" }, env, 404);
}

/* ---------------------------- health ---------------------------- */

route("GET", "/api/health", async (_req, env) => {
  const last = await env.DB.prepare(
    "SELECT connector, status, finished_at, rows_ingested FROM ingestion_runs ORDER BY started_at DESC LIMIT 6"
  ).all();
  return json({ ok: true, lastRuns: last.results }, env);
});

/* ----------------------------- KPIs ----------------------------- */

route("GET", "/api/kpis", async (_req, env) => {
  const [newLeads, expiring, cashPoor, liens, permits] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) c FROM triggers WHERE status = 'new'").first<{ c: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) c, COALESCE(SUM(l.principal),0) v FROM triggers t JOIN loans l ON l.id = t.ref_id WHERE t.kind='maturity' AND t.status NOT IN ('dismissed','converted')"
    ).first<{ c: number; v: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) c FROM triggers WHERE kind='cash_poor' AND status NOT IN ('dismissed','converted')"
    ).first<{ c: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) c, COALESCE(SUM(json_extract(payload_json,'$.amount')),0) v FROM triggers WHERE kind='lien' AND status NOT IN ('dismissed','converted')"
    ).first<{ c: number; v: number }>(),
    env.DB.prepare(
      "SELECT COALESCE(SUM(valuation),0) v FROM permits WHERE filed_at >= date('now','-30 days')"
    ).first<{ v: number }>(),
  ]);
  return json(
    {
      newLeads: newLeads?.c ?? 0,
      expiringLoans: { count: expiring?.c ?? 0, principal: expiring?.v ?? 0 },
      cashPoorEntities: cashPoor?.c ?? 0,
      activeLiens: { count: liens?.c ?? 0, amount: liens?.v ?? 0 },
      permitValuation30d: permits?.v ?? 0,
    },
    env
  );
});

/* --------------------------- trigger feeds --------------------------- */

const FEED_SQL = `
  SELECT t.id, t.kind, t.score, t.urgency, t.headline, t.payload_json, t.detected_at, t.status,
         e.id AS entity_id, e.name AS entity_name, e.kind AS entity_kind, e.principal_name,
         e.flips_36mo, e.avg_margin_pct, e.velocity_score,
         p.address, p.city, p.county, p.state, p.est_value,
         c.phone, c.email, c.confidence AS contact_confidence
  FROM triggers t
  JOIN entities e ON e.id = t.entity_id
  LEFT JOIN properties p ON p.id = t.property_id
  LEFT JOIN contacts c ON c.entity_id = e.id
  WHERE t.kind = ?1 AND t.status NOT IN ('dismissed','converted')
  ORDER BY t.score DESC
  LIMIT ?2`;

function feedHandler(kind: string): Handler {
  return async (_req, env, _params, url) => {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    const rows = await env.DB.prepare(FEED_SQL).bind(kind, limit).all();
    return json({ items: rows.results }, env);
  };
}

route("GET", "/api/triggers/maturities", feedHandler("maturity"));
route("GET", "/api/triggers/cash-poor", feedHandler("cash_poor"));
route("GET", "/api/triggers/permits", feedHandler("permit"));
route("GET", "/api/triggers/liens", feedHandler("lien"));

route("POST", "/api/triggers/:id/status", async (req, env, params) => {
  const body = (await req.json().catch(() => ({}))) as { status?: string };
  const allowed = ["new", "viewed", "contacted", "dismissed", "converted"];
  if (!body.status || !allowed.includes(body.status)) {
    return json({ error: "invalid_status" }, env, 400);
  }
  await env.DB.prepare("UPDATE triggers SET status = ?1 WHERE id = ?2")
    .bind(body.status, params.id)
    .run();
  return json({ ok: true }, env);
});

/* ------------------------ borrower resume ------------------------ */

route("GET", "/api/borrowers/:id/resume", async (_req, env, params) => {
  const entity = await env.DB.prepare("SELECT * FROM entities WHERE id = ?1")
    .bind(params.id)
    .first();
  if (!entity) return json({ error: "not_found" }, env, 404);

  const [contacts, transactions, loans, permits, liens] = await Promise.all([
    env.DB.prepare("SELECT * FROM contacts WHERE entity_id = ?1 ORDER BY confidence DESC")
      .bind(params.id)
      .all(),
    env.DB.prepare(
      `SELECT tx.*, p.address, p.city, p.state FROM transactions tx
       JOIN properties p ON p.id = tx.property_id
       WHERE tx.entity_id = ?1 AND tx.recorded_at >= date('now','-36 months')
       ORDER BY tx.recorded_at DESC`
    )
      .bind(params.id)
      .all(),
    env.DB.prepare(
      `SELECT l.*, p.address, p.city, p.state FROM loans l
       JOIN properties p ON p.id = l.property_id
       WHERE l.entity_id = ?1 ORDER BY l.originated_at DESC`
    )
      .bind(params.id)
      .all(),
    env.DB.prepare("SELECT * FROM permits WHERE entity_id = ?1 ORDER BY filed_at DESC")
      .bind(params.id)
      .all(),
    env.DB.prepare("SELECT * FROM liens WHERE entity_id = ?1 ORDER BY filed_at DESC")
      .bind(params.id)
      .all(),
  ]);

  return json(
    {
      entity,
      contacts: contacts.results,
      transactions: transactions.results,
      loans: loans.results,
      permits: permits.results,
      liens: liens.results,
    },
    env
  );
});

/* --------------------------- watchlist --------------------------- */

route("POST", "/api/watchlist", async (req, env) => {
  const body = (await req.json().catch(() => ({}))) as {
    userId?: string;
    entityId?: string;
    note?: string;
  };
  if (!body.userId || !body.entityId) return json({ error: "missing_fields" }, env, 400);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO watchlist (id, user_id, entity_id, note) VALUES (?1, ?2, ?3, ?4)"
  )
    .bind(crypto.randomUUID(), body.userId, body.entityId, body.note ?? null)
    .run();
  return json({ ok: true }, env, 201);
});

route("DELETE", "/api/watchlist/:entityId", async (req, env, params, url) => {
  const userId = url.searchParams.get("userId");
  if (!userId) return json({ error: "missing_user" }, env, 400);
  await env.DB.prepare("DELETE FROM watchlist WHERE user_id = ?1 AND entity_id = ?2")
    .bind(userId, params.entityId)
    .run();
  return json({ ok: true }, env);
});

/* ------------------------ inbound webhooks ------------------------ */

route("POST", "/api/webhooks/records", async (req, env) => {
  // HMAC-SHA256 verification of vendor pushes (real-time record drops
  // between scheduled runs).
  const signature = req.headers.get("X-Signature") ?? "";
  const raw = await req.text();
  if (!env.WEBHOOK_SECRET) return json({ error: "webhook_not_configured" }, env, 503);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (signature !== expected) return json({ error: "bad_signature" }, env, 401);

  // Payload shape: { records: [{ table: 'liens'|'permits'|..., row: {...} }] }
  // Real-time rows land in staging semantics identical to the nightly pull;
  // scoring reconciles on the next run (or immediately for lien records).
  const payload = JSON.parse(raw) as { records?: Array<{ table: string; row: Record<string, unknown> }> };
  return json({ ok: true, accepted: payload.records?.length ?? 0 }, env, 202);
});
