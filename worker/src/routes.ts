/** REST handlers backed by D1. All reads come from indexed/materialized tables. */

import { json, type Env } from "./index";
import {
  runIngestionPipeline, runSingleConnector, CONNECTOR_IDS,
  RECORD_CONNECTORS, getConnectorConfig, isSocrataUrl,
} from "./ingest";
import { encryptSecret } from "./crypto";
import { authConfigured, loginWithCode, verifySession } from "./auth";
import { aiAvailable, compileSignalRule, generateBrief, generateOutreach, recordShape, runModel } from "./ai";
import { sendTestDigest } from "./alerts";
import { dataQualitySummary } from "./integrity";
import { applyMerge } from "./resolution";
import { backfillEligible, backfillStatus, runBackfillChunk, startBackfill } from "./backfill";
import type { Provenance } from "./integrity";

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

const PUBLIC_PATHS = new Set(["/api/auth/login", "/api/webhooks/records"]);

export async function routeRequest(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);

  // One code unlocks the product: every /api route (data, CRM, admin, AI)
  // requires a valid session except login itself and HMAC-verified webhooks.
  if (!PUBLIC_PATHS.has(url.pathname) && authConfigured(env)) {
    if (!(await verifySession(env, req.headers.get("Authorization")))) {
      return json({ error: "unauthorized" }, env, 401);
    }
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.pattern);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return r.handler(req, env, params, url);
  }
  if (req.method === "POST" && url.pathname === "/api/admin/run-ingestion") {
    ctx.waitUntil(runIngestionPipeline(env, new Date()));
    return json({ ok: true, started: true }, env, 202);
  }
  return json({ error: "not_found" }, env, 404);
}

/* ------------------------------- auth ------------------------------- */

route("POST", "/api/auth/login", async (req, env) => {
  if (!authConfigured(env)) {
    // No ACCESS_CODE secret yet — open access so first-run setup isn't locked out.
    return json({ token: "open-access", authRequired: false }, env);
  }
  const body = (await req.json().catch(() => ({}))) as { code?: string };
  const token = await loginWithCode(env, body.code ?? "");
  if (!token) return json({ error: "invalid_code" }, env, 401);
  return json({ token, authRequired: true }, env);
});

/** demo → feeds include seeded rows; live → only real ingested records. */
async function getDataMode(env: Env): Promise<"demo" | "live"> {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'data_mode'")
    .first<{ value: string }>();
  return row?.value === "live" ? "live" : "demo";
}

/* ---------------------------- public settings ---------------------------- */

route("GET", "/api/settings", async (_req, env) => {
  const rows = await env.DB.prepare(
    `SELECT key, value FROM app_settings WHERE key IN
     ('data_mode','markets','ai_gateway_id','alerts_enabled','alert_email','underwriting','outreach')`
  ).all<{ key: string; value: string }>();
  const map = Object.fromEntries(rows.results.map((r) => [r.key, r.value]));
  const parse = (v: string | undefined) => {
    try {
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  };
  return json(
    {
      dataMode: map.data_mode === "live" ? "live" : "demo",
      markets: parse(map.markets) ?? [],
      aiEnabled: aiAvailable(env),
      aiGatewayId: map.ai_gateway_id || "",
      scrapingConfigured: Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN),
      alertsEnabled: map.alerts_enabled === "true",
      alertEmail: map.alert_email || "",
      alertsConfigured: Boolean(env.RESEND_API_KEY),
      underwriting: parse(map.underwriting),
      outreach: parse(map.outreach),
    },
    env
  );
});

/* ---------------------------- health ---------------------------- */

route("GET", "/api/health", async (_req, env) => {
  const last = await env.DB.prepare(
    `SELECT connector, status, finished_at, rows_ingested FROM ingestion_runs r
     WHERE started_at = (SELECT MAX(started_at) FROM ingestion_runs r2 WHERE r2.connector = r.connector)
     ORDER BY connector`
  ).all();
  return json({ ok: true, lastRuns: last.results }, env);
});

/* ----------------------------- KPIs ----------------------------- */

route("GET", "/api/kpis", async (_req, env) => {
  const mode = await getDataMode(env);
  const originFilter = mode === "live" ? "AND origin = 'live'" : "";
  const [newLeads, expiring, cashPoor, liens, permits, flippers] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) c FROM triggers WHERE status = 'new' ${originFilter}`).first<{ c: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) c, COALESCE(SUM(l.principal),0) v FROM triggers t JOIN loans l ON l.id = t.ref_id
       WHERE t.kind='maturity' AND t.status NOT IN ('dismissed','converted')
       ${mode === "live" ? "AND t.origin = 'live'" : ""}`
    ).first<{ c: number; v: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) c FROM triggers WHERE kind='cash_poor' AND status NOT IN ('dismissed','converted') ${originFilter}`
    ).first<{ c: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) c, COALESCE(SUM(json_extract(payload_json,'$.amount')),0) v
       FROM triggers WHERE kind='lien' AND status NOT IN ('dismissed','converted') ${originFilter}`
    ).first<{ c: number; v: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(valuation),0) v FROM permits WHERE filed_at >= date('now','-30 days') ${originFilter}`
    ).first<{ v: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) c FROM entities WHERE velocity_score >= 85 ${originFilter}`
    ).first<{ c: number }>(),
  ]);
  return json(
    {
      newLeads: newLeads?.c ?? 0,
      expiringLoans: { count: expiring?.c ?? 0, principal: expiring?.v ?? 0 },
      cashPoorEntities: cashPoor?.c ?? 0,
      activeLiens: { count: liens?.c ?? 0, amount: liens?.v ?? 0 },
      permitValuation30d: permits?.v ?? 0,
      highVelocityFlippers: flippers?.c ?? 0,
    },
    env
  );
});

/* --------------------------- trigger feeds --------------------------- */

const FEED_SQL = `
  SELECT t.id, t.kind, t.score, t.urgency, t.headline, t.payload_json, t.detected_at, t.status,
         e.id AS entity_id, e.name AS entity_name, e.kind AS entity_kind, e.principal_name,
         e.flips_36mo, e.avg_margin_pct, e.velocity_score,
         p.address, p.city, p.county, p.state, p.est_value, p.lat, p.lng,
         c.phone, c.email, c.confidence AS contact_confidence
  FROM triggers t
  JOIN entities e ON e.id = t.entity_id
  LEFT JOIN properties p ON p.id = t.property_id
  LEFT JOIN contacts c ON c.entity_id = e.id
  WHERE t.kind = ?1 AND t.status NOT IN ('dismissed','converted')
    AND (?3 = 'demo' OR t.origin = 'live')
  ORDER BY t.score DESC
  LIMIT ?2`;

function feedHandler(kind: string): Handler {
  return async (_req, env, _params, url) => {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    const mode = await getDataMode(env);
    const rows = await env.DB.prepare(FEED_SQL).bind(kind, limit, mode).all();
    return json({ items: rows.results }, env);
  };
}

route("GET", "/api/triggers/maturities", feedHandler("maturity"));
route("GET", "/api/triggers/cash-poor", feedHandler("cash_poor"));
route("GET", "/api/triggers/permits", feedHandler("permit"));
route("GET", "/api/triggers/liens", feedHandler("lien"));
route("GET", "/api/triggers/custom", feedHandler("custom"));

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

  const [contacts, transactions, loans, permits, liens, network] = await Promise.all([
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
       LEFT JOIN properties p ON p.id = l.property_id
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
    // Cross-LLC graph: every other entity controlled by this entity's principals
    env.DB.prepare(
      `SELECT p.name AS principal_name, ep2.role, e2.id, e2.name, e2.kind,
              e2.flips_36mo, e2.volume_36mo, e2.velocity_score
       FROM entity_principals ep
       JOIN principals p ON p.id = ep.principal_id
       JOIN entity_principals ep2 ON ep2.principal_id = p.id AND ep2.entity_id != ?1
       JOIN entities e2 ON e2.id = ep2.entity_id
       WHERE ep.entity_id = ?1`
    )
      .bind(params.id)
      .all<{ principal_name: string; role: string | null; id: string; name: string; kind: string; flips_36mo: number; volume_36mo: number; velocity_score: number }>(),
  ]);

  return json(
    {
      entity,
      contacts: contacts.results,
      transactions: transactions.results,
      loans: loans.results,
      permits: permits.results,
      liens: liens.results,
      network:
        network.results.length > 0
          ? {
              principalName: network.results[0].principal_name,
              entities: network.results.map((n) => ({
                id: n.id,
                name: n.name,
                kind: n.kind,
                flips36mo: n.flips_36mo,
                volume36mo: n.volume_36mo,
                velocityScore: n.velocity_score,
                role: n.role,
              })),
            }
          : null,
    },
    env
  );
});

/* --------------------------- watchlist (CRM) --------------------------- */

const STAGES = ["watching", "outreach", "term_sheet", "funded", "lost"];

route("GET", "/api/watchlist", async (_req, env, _params, url) => {
  const userId = url.searchParams.get("userId");
  if (!userId) return json({ error: "missing_user" }, env, 400);
  const rows = await env.DB.prepare(
    `SELECT w.entity_id, w.stage, w.note, w.follow_up_date, w.deal_value, w.created_at, w.updated_at,
            e.name AS entity_name, e.velocity_score
     FROM watchlist w JOIN entities e ON e.id = w.entity_id
     WHERE w.user_id = ?1 ORDER BY w.updated_at DESC`
  )
    .bind(userId)
    .all();
  return json({ leads: rows.results }, env);
});

route("POST", "/api/watchlist", async (req, env) => {
  const body = (await req.json().catch(() => ({}))) as {
    userId?: string;
    entityId?: string;
    stage?: string;
    note?: string;
    followUp?: string | null;
    dealValue?: number | null;
  };
  if (!body.userId || !body.entityId) return json({ error: "missing_fields" }, env, 400);
  const stage = body.stage && STAGES.includes(body.stage) ? body.stage : "watching";
  await env.DB.prepare(
    `INSERT INTO watchlist (id, user_id, entity_id, stage, note, follow_up_date, deal_value)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (user_id, entity_id) DO UPDATE SET
       stage = excluded.stage, note = excluded.note,
       follow_up_date = excluded.follow_up_date, deal_value = excluded.deal_value,
       updated_at = datetime('now')`
  )
    .bind(
      crypto.randomUUID(),
      body.userId,
      body.entityId,
      stage,
      body.note ?? null,
      body.followUp ?? null,
      body.dealValue ?? null
    )
    .run();
  return json({ ok: true }, env, 201);
});

route("POST", "/api/watchlist/:entityId/events", async (req, env, params) => {
  const body = (await req.json().catch(() => ({}))) as {
    userId?: string;
    kind?: string;
    text?: string;
  };
  const kinds = ["added", "stage", "note", "call", "email", "follow_up"];
  if (!body.userId || !body.kind || !kinds.includes(body.kind)) {
    return json({ error: "invalid_event" }, env, 400);
  }
  await env.DB.prepare(
    "INSERT INTO lead_events (id, user_id, entity_id, kind, text) VALUES (?1, ?2, ?3, ?4, ?5)"
  )
    .bind(crypto.randomUUID(), body.userId, params.entityId, body.kind, body.text ?? "")
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

/* ------------------------------- admin ------------------------------- */

route("GET", "/api/admin/connectors", async (_req, env) => {
  const rows = await env.DB.prepare(
    `SELECT cc.id, cc.label, cc.enabled, cc.base_url, cc.api_key_last4,
            cc.mode, cc.scrape_url, cc.notes, cc.field_map,
            r.status AS run_status, r.finished_at AS run_finished, r.rows_ingested AS run_rows
     FROM connector_config cc
     LEFT JOIN ingestion_runs r ON r.connector = cc.id
       AND r.started_at = (SELECT MAX(started_at) FROM ingestion_runs r2 WHERE r2.connector = cc.id)
     ORDER BY cc.rowid`
  ).all<{
    id: string; label: string; enabled: number; base_url: string | null; api_key_last4: string | null;
    mode: string; scrape_url: string | null; notes: string | null; field_map: string | null;
    run_status: string | null; run_finished: string | null; run_rows: number | null;
  }>();
  return json(
    {
      connectors: rows.results.map((r) => ({
        id: r.id,
        label: r.label,
        enabled: Boolean(r.enabled),
        baseUrl: r.base_url,
        apiKeyLast4: r.api_key_last4,
        mode: r.mode === "scrape" ? "scrape" : "api",
        scrapeUrl: r.scrape_url,
        notes: r.notes,
        fieldMap: r.field_map,
        isSocrata: isSocrataUrl(r.base_url),
        lastRun: r.run_status
          ? { status: r.run_status, finishedAt: r.run_finished, rowsIngested: r.run_rows ?? 0 }
          : null,
      })),
    },
    env
  );
});

route("PUT", "/api/admin/connectors/:id", async (req, env, params) => {
  if (!(CONNECTOR_IDS as readonly string[]).includes(params.id)) {
    return json({ error: "unknown_connector" }, env, 404);
  }
  const body = (await req.json().catch(() => ({}))) as {
    enabled?: boolean;
    baseUrl?: string;
    apiKey?: string;
    mode?: string;
    scrapeUrl?: string;
    notes?: string;
    fieldMap?: string;
  };
  if (typeof body.enabled === "boolean") {
    await env.DB.prepare(
      "UPDATE connector_config SET enabled = ?1, updated_at = datetime('now') WHERE id = ?2"
    )
      .bind(body.enabled ? 1 : 0, params.id)
      .run();
  }
  if (typeof body.baseUrl === "string") {
    await env.DB.prepare(
      "UPDATE connector_config SET base_url = ?1, updated_at = datetime('now') WHERE id = ?2"
    )
      .bind(body.baseUrl.trim() || null, params.id)
      .run();
  }
  if (body.mode === "api" || body.mode === "scrape") {
    await env.DB.prepare(
      "UPDATE connector_config SET mode = ?1, updated_at = datetime('now') WHERE id = ?2"
    )
      .bind(body.mode, params.id)
      .run();
  }
  if (typeof body.scrapeUrl === "string") {
    await env.DB.prepare(
      "UPDATE connector_config SET scrape_url = ?1, updated_at = datetime('now') WHERE id = ?2"
    )
      .bind(body.scrapeUrl.trim() || null, params.id)
      .run();
  }
  if (typeof body.notes === "string") {
    await env.DB.prepare(
      "UPDATE connector_config SET notes = ?1, updated_at = datetime('now') WHERE id = ?2"
    )
      .bind(body.notes.trim() || null, params.id)
      .run();
  }
  if (typeof body.fieldMap === "string") {
    const trimmed = body.fieldMap.trim();
    if (trimmed) {
      try {
        JSON.parse(trimmed);
      } catch {
        return json({ error: "field_map_invalid_json" }, env, 400);
      }
    }
    await env.DB.prepare(
      "UPDATE connector_config SET field_map = ?1, updated_at = datetime('now') WHERE id = ?2"
    )
      .bind(trimmed || null, params.id)
      .run();
  }
  if (typeof body.apiKey === "string" && body.apiKey.length > 0) {
    const kek = env.ACCESS_CODE || env.ADMIN_TOKEN;
    if (!kek) return json({ error: "access_code_not_configured" }, env, 503);
    const { ct, iv } = await encryptSecret(kek, body.apiKey);
    await env.DB.prepare(
      `UPDATE connector_config SET api_key_ct = ?1, api_key_iv = ?2, api_key_last4 = ?3,
       updated_at = datetime('now') WHERE id = ?4`
    )
      .bind(ct, iv, body.apiKey.slice(-4), params.id)
      .run();
  }
  return json({ ok: true }, env);
});

route("POST", "/api/admin/connectors/:id/run", async (_req, env, params) => {
  const started = await runSingleConnector(env, params.id);
  if (!started) return json({ error: "connector_disabled_or_unconfigured" }, env, 409);
  return json({ ok: true }, env, 202);
});

route("PUT", "/api/admin/settings", async (req, env) => {
  const body = (await req.json().catch(() => ({}))) as {
    dataMode?: string;
    markets?: string[];
    aiGatewayId?: string;
    alertsEnabled?: boolean;
    alertEmail?: string;
    underwriting?: Record<string, unknown>;
    outreach?: Record<string, unknown>;
  };
  if (body.dataMode === "demo" || body.dataMode === "live") {
    await env.DB.prepare(
      "INSERT INTO app_settings (key, value) VALUES ('data_mode', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
    )
      .bind(body.dataMode)
      .run();
  }
  const upsertSetting = async (key: string, value: string) => {
    await env.DB.prepare(
      "INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
    )
      .bind(key, value)
      .run();
  };
  if (typeof body.alertsEnabled === "boolean") await upsertSetting("alerts_enabled", String(body.alertsEnabled));
  if (typeof body.alertEmail === "string") await upsertSetting("alert_email", body.alertEmail.trim().slice(0, 200));
  if (body.underwriting && typeof body.underwriting === "object") {
    await upsertSetting("underwriting", JSON.stringify(body.underwriting).slice(0, 2000));
  }
  if (body.outreach && typeof body.outreach === "object") {
    await upsertSetting("outreach", JSON.stringify(body.outreach).slice(0, 2000));
  }
  if (typeof body.aiGatewayId === "string") {
    await env.DB.prepare(
      "INSERT INTO app_settings (key, value) VALUES ('ai_gateway_id', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
    )
      .bind(body.aiGatewayId.trim())
      .run();
  }
  if (Array.isArray(body.markets)) {
    const clean = body.markets.map((m) => String(m).slice(0, 60)).slice(0, 50);
    await env.DB.prepare(
      "INSERT INTO app_settings (key, value) VALUES ('markets', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
    )
      .bind(JSON.stringify(clean))
      .run();
  }
  return json({ ok: true }, env);
});

route("POST", "/api/admin/purge-demo", async (_req, env) => {
  // children first, then parents; count what went away
  const tables = [
    "triggers",
    "liens",
    "permits",
    "loans",
    "transactions",
    "entity_principals",
    "principals",
    "properties",
    "entities",
  ];
  let deleted = 0;
  for (const t of tables) {
    const res =
      t === "entity_principals"
        ? await env.DB.prepare(
            "DELETE FROM entity_principals WHERE principal_id IN (SELECT id FROM principals WHERE origin = 'demo')"
          ).run()
        : await env.DB.prepare(`DELETE FROM ${t} WHERE origin = 'demo'`).run();
    deleted += res.meta.changes ?? 0;
  }
  // Reset the infrastructure surfaces too — audit rows and source baselines
  // restart from truth on the next real run.
  await env.DB.prepare("DELETE FROM ingestion_runs").run();
  await env.DB.prepare("DELETE FROM source_stats").run();
  return json({ ok: true, deleted }, env);
});

/* ------------------------------- AI ------------------------------- */

route("POST", "/api/ai/brief/:entityId", async (_req, env, params) => {
  if (!aiAvailable(env)) return json({ error: "ai_not_configured" }, env, 503);
  const [entity, loans, triggers, txs] = await Promise.all([
    env.DB.prepare("SELECT * FROM entities WHERE id = ?1").bind(params.entityId).first(),
    env.DB.prepare(
      "SELECT lender_name, principal, rate_pct, originated_at, maturity_date, status FROM loans WHERE entity_id = ?1 ORDER BY originated_at DESC LIMIT 10"
    ).bind(params.entityId).all(),
    env.DB.prepare(
      "SELECT kind, headline, score FROM triggers WHERE entity_id = ?1 AND status NOT IN ('dismissed','converted') ORDER BY score DESC LIMIT 10"
    ).bind(params.entityId).all(),
    env.DB.prepare(
      "SELECT side, price, is_cash, recorded_at FROM transactions WHERE entity_id = ?1 ORDER BY recorded_at DESC LIMIT 20"
    ).bind(params.entityId).all(),
  ]);
  if (!entity) return json({ error: "not_found" }, env, 404);
  try {
    const brief = await generateBrief(
      env,
      JSON.stringify({ entity, loans: loans.results, signals: triggers.results, transactions: txs.results })
    );
    return json({ brief }, env);
  } catch (err) {
    return json({ error: "ai_failed", detail: String(err).slice(0, 200) }, env, 502);
  }
});

route("POST", "/api/admin/alerts/test", async (_req, env) => {
  if (!env.RESEND_API_KEY) return json({ error: "resend_not_configured" }, env, 503);
  const res = await sendTestDigest(env);
  return json(res, env, res.ok ? 200 : 502);
});

route("POST", "/api/ai/outreach/:entityId", async (req, env, params) => {
  if (!aiAvailable(env)) return json({ error: "ai_not_configured" }, env, 503);
  const body = (await req.json().catch(() => ({}))) as { channel?: string };
  const channel = body.channel === "sms" ? "sms" : "email";
  const [entity, loans, triggers, identityRow] = await Promise.all([
    env.DB.prepare("SELECT * FROM entities WHERE id = ?1").bind(params.entityId).first(),
    env.DB.prepare(
      "SELECT lender_name, principal, rate_pct, originated_at, maturity_date, status FROM loans WHERE entity_id = ?1 ORDER BY originated_at DESC LIMIT 10"
    ).bind(params.entityId).all(),
    env.DB.prepare(
      "SELECT kind, headline, score FROM triggers WHERE entity_id = ?1 AND status NOT IN ('dismissed','converted') ORDER BY score DESC LIMIT 10"
    ).bind(params.entityId).all(),
    env.DB.prepare("SELECT value FROM app_settings WHERE key = 'outreach'").first<{ value: string }>(),
  ]);
  if (!entity) return json({ error: "not_found" }, env, 404);
  // Sender identity from Settings → Outreach; unset fields fall back to a
  // neutral descriptor rather than feeding the model blanks.
  let identity = "a private real-estate lender";
  try {
    const cfg = JSON.parse(identityRow?.value ?? "{}") as { senderName?: string; company?: string };
    const parts = [cfg.senderName, cfg.company].filter((s): s is string => Boolean(s && s.trim()));
    if (parts.length) identity = parts.join(" at ");
  } catch {
    // keep fallback
  }
  try {
    const message = await generateOutreach(
      env,
      channel,
      JSON.stringify({ entity, loans: loans.results, signals: triggers.results }),
      identity
    );
    return json({ message }, env);
  } catch (err) {
    return json({ error: "ai_failed", detail: String(err).slice(0, 200) }, env, 502);
  }
});

/* ------------------------ data quality (Settings) ------------------------ */

route("GET", "/api/admin/data-quality", async (_req, env) => {
  const [summary, quarantine, merges] = await Promise.all([
    dataQualitySummary(env),
    env.DB.prepare(
      `SELECT id, connector, record_kind, payload_json, reasons_json, source_url, created_at
       FROM quarantine WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50`
    ).all(),
    env.DB.prepare(
      `SELECT m.id, m.reason, m.score, m.created_at,
              ea.name AS name_a, eb.name AS name_b, m.entity_a, m.entity_b
       FROM merge_suggestions m
       JOIN entities ea ON ea.id = m.entity_a
       JOIN entities eb ON eb.id = m.entity_b
       WHERE m.status = 'pending' ORDER BY m.score DESC LIMIT 25`
    ).all(),
  ]);
  return json({ ...summary, quarantine: quarantine.results, merges: merges.results }, env);
});

route("POST", "/api/admin/quarantine/:id", async (req, env, params) => {
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  const row = await env.DB.prepare(
    "SELECT connector, record_kind, payload_json, source_url FROM quarantine WHERE id = ?1 AND status = 'pending'"
  )
    .bind(params.id)
    .first<{ connector: string; record_kind: string; payload_json: string; source_url: string | null }>();
  if (!row) return json({ error: "not_found" }, env, 404);

  if (body.action === "approve") {
    // Operator vouched for the record — ingest it, marked as manually approved.
    const def = RECORD_CONNECTORS[row.connector];
    if (!def) return json({ error: "connector_gone" }, env, 409);
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      return json({ error: "payload_unparseable" }, env, 422);
    }
    const prov: Provenance = {
      sourceId: row.connector, sourceUrl: row.source_url, method: "api", confidence: "direct",
    };
    const result = await def.upsert(env, [rec] as never[], prov);
    await env.DB.prepare(
      "UPDATE quarantine SET status = 'approved', resolved_at = datetime('now') WHERE id = ?1"
    ).bind(params.id).run();
    return json({ ok: true, ingested: result.ingested }, env);
  }
  if (body.action === "discard") {
    await env.DB.prepare(
      "UPDATE quarantine SET status = 'discarded', resolved_at = datetime('now') WHERE id = ?1"
    ).bind(params.id).run();
    return json({ ok: true }, env);
  }
  return json({ error: "invalid_action" }, env, 400);
});

route("POST", "/api/admin/merges/:id", async (req, env, params) => {
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action === "merge") {
    const ok = await applyMerge(env, params.id);
    return ok ? json({ ok: true }, env) : json({ error: "not_found" }, env, 404);
  }
  if (body.action === "dismiss") {
    await env.DB.prepare(
      "UPDATE merge_suggestions SET status = 'dismissed' WHERE id = ?1 AND status = 'pending'"
    ).bind(params.id).run();
    return json({ ok: true }, env);
  }
  return json({ error: "invalid_action" }, env, 400);
});

/* ------------------------ custom signals ------------------------ */

route("GET", "/api/admin/signals", async (_req, env) => {
  const rows = await env.DB.prepare(
    "SELECT id, name, prompt, rule_json, enabled, last_run_at, total_hits, created_at FROM custom_signals ORDER BY created_at DESC"
  ).all();
  return json({ signals: rows.results }, env);
});

// Step 1: compile plain English to a deterministic rule the user confirms.
route("POST", "/api/admin/signals/compile", async (req, env) => {
  if (!aiAvailable(env)) return json({ error: "ai_not_configured" }, env, 503);
  const body = (await req.json().catch(() => ({}))) as { prompt?: string };
  if (!body.prompt?.trim()) return json({ error: "prompt_required" }, env, 400);
  const rule = await compileSignalRule(env, body.prompt.trim());
  if (!rule) return json({ error: "compile_failed" }, env, 502);
  if (typeof rule.error === "string") return json({ error: "unsupported", detail: rule.error }, env, 422);
  return json({ rule }, env);
});

// Step 2: save the confirmed rule. Evaluation is deterministic from here on.
route("POST", "/api/admin/signals", async (req, env) => {
  const body = (await req.json().catch(() => ({}))) as {
    name?: string; prompt?: string; rule?: Record<string, unknown>;
  };
  if (!body.name?.trim() || !body.prompt?.trim() || !body.rule || typeof body.rule !== "object") {
    return json({ error: "name_prompt_rule_required" }, env, 400);
  }
  if (!["deed", "loan", "permit", "lien"].includes(String(body.rule.record))) {
    return json({ error: "invalid_rule_record" }, env, 422);
  }
  const id = `sig_${crypto.randomUUID().slice(0, 12)}`;
  await env.DB.prepare(
    "INSERT INTO custom_signals (id, name, prompt, rule_json) VALUES (?1, ?2, ?3, ?4)"
  )
    .bind(id, body.name.trim().slice(0, 80), body.prompt.trim().slice(0, 1000), JSON.stringify(body.rule))
    .run();
  const { evaluateCustomSignals } = await import("./signals");
  const hits = await evaluateCustomSignals(env);
  return json({ ok: true, id, hits }, env, 201);
});

route("POST", "/api/admin/signals/:id", async (req, env, params) => {
  const body = (await req.json().catch(() => ({}))) as { enabled?: boolean };
  if (typeof body.enabled !== "boolean") return json({ error: "enabled_required" }, env, 400);
  await env.DB.prepare("UPDATE custom_signals SET enabled = ?1 WHERE id = ?2")
    .bind(body.enabled ? 1 : 0, params.id)
    .run();
  return json({ ok: true }, env);
});

route("DELETE", "/api/admin/signals/:id", async (_req, env, params) => {
  await env.DB.prepare("DELETE FROM custom_signals WHERE id = ?1").bind(params.id).run();
  await env.DB.prepare("DELETE FROM triggers WHERE kind = 'custom' AND ref_id LIKE ?1")
    .bind(`${params.id}:%`)
    .run();
  return json({ ok: true }, env);
});

/* ------------------------ competitor intelligence ------------------------ */

route("GET", "/api/lenders", async (_req, env) => {
  const mode = await getDataMode(env);
  const rows = await env.DB.prepare(
    `SELECT l.lender_name,
            COUNT(*) AS loans,
            SUM(CASE WHEN l.instrument = 'ucc' THEN 1 ELSE 0 END) AS ucc_filings,
            SUM(l.principal) AS volume,
            AVG(CASE WHEN l.rate_pct > 0 THEN l.rate_pct END) AS avg_rate,
            SUM(CASE WHEN l.status = 'active'
                      AND date(COALESCE(l.maturity_date, date(l.originated_at, '+' || COALESCE(l.term_months,12) || ' months')))
                          BETWEEN date('now') AND date('now','+90 days')
                     THEN 1 ELSE 0 END) AS maturing_90d,
            SUM(CASE WHEN l.status = 'active'
                      AND date(COALESCE(l.maturity_date, date(l.originated_at, '+' || COALESCE(l.term_months,12) || ' months')))
                          BETWEEN date('now') AND date('now','+90 days')
                     THEN l.principal ELSE 0 END) AS maturing_volume,
            SUM(CASE WHEN l.satisfied_at >= date('now','-90 days') THEN 1 ELSE 0 END) AS payoffs_90d
     FROM loans l
     WHERE l.lender_type IN ('private','hard_money')
       AND (?1 = 'demo' OR l.origin = 'live')
     GROUP BY l.lender_name
     HAVING COUNT(*) >= 1
     ORDER BY volume DESC
     LIMIT 100`
  )
    .bind(mode)
    .all();
  return json({ lenders: rows.results }, env);
});

route("GET", "/api/lenders/:name/loans", async (_req, env, params) => {
  const mode = await getDataMode(env);
  const rows = await env.DB.prepare(
    `SELECT l.id, l.principal, l.rate_pct, l.originated_at, l.term_months, l.status, l.instrument,
            l.source_url, l.confidence,
            COALESCE(l.maturity_date, date(l.originated_at, '+' || COALESCE(l.term_months,12) || ' months')) AS maturity,
            e.id AS entity_id, e.name AS entity_name, e.flips_36mo, e.velocity_score,
            p.address, p.city
     FROM loans l
     LEFT JOIN entities e ON e.id = l.entity_id
     LEFT JOIN properties p ON p.id = l.property_id
     WHERE l.lender_name = ?1 AND (?2 = 'demo' OR l.origin = 'live')
     ORDER BY l.status = 'active' DESC, maturity ASC
     LIMIT 100`
  )
    .bind(decodeURIComponent(params.name), mode)
    .all();
  return json({ loans: rows.results }, env);
});

/* ------------------------ loan book ------------------------ */

route("GET", "/api/loanbook", async (_req, env) => {
  const rows = await env.DB.prepare(
    `SELECT lb.*, e.name AS entity_name FROM loan_book lb
     LEFT JOIN entities e ON e.id = lb.entity_id
     ORDER BY lb.status IN ('current','late','extended') DESC, lb.maturity_date ASC`
  ).all();
  return json({ loans: rows.results }, env);
});

route("POST", "/api/loanbook", async (req, env) => {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = typeof b.id === "string" && b.id.startsWith("lbk_") ? b.id : `lbk_${crypto.randomUUID().slice(0, 12)}`;
  const statuses = new Set(["current", "late", "extended", "paid_off", "defaulted"]);
  const principal = Math.round(Number(b.principal) || 0);
  const ratePct = Number(b.ratePct) || 0;
  if (!b.borrowerName || principal <= 0 || !b.originatedAt) {
    return json({ error: "borrower_principal_date_required" }, env, 400);
  }
  const termMonths = Math.round(Number(b.termMonths)) || 12;
  const maturity = typeof b.maturityDate === "string" && b.maturityDate ? b.maturityDate : null;
  await env.DB.prepare(
    `INSERT INTO loan_book (id, entity_id, borrower_name, property_address, principal, rate_pct, points,
                            originated_at, term_months, maturity_date, status, notes)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, COALESCE(?10, date(?8, '+' || ?9 || ' months')), ?11, ?12)
     ON CONFLICT (id) DO UPDATE SET
       entity_id = excluded.entity_id, borrower_name = excluded.borrower_name,
       property_address = excluded.property_address, principal = excluded.principal,
       rate_pct = excluded.rate_pct, points = excluded.points, originated_at = excluded.originated_at,
       term_months = excluded.term_months, maturity_date = excluded.maturity_date,
       status = excluded.status, notes = excluded.notes, updated_at = datetime('now')`
  )
    .bind(
      id,
      typeof b.entityId === "string" && b.entityId ? b.entityId : null,
      String(b.borrowerName).slice(0, 120),
      typeof b.propertyAddress === "string" && b.propertyAddress ? b.propertyAddress.slice(0, 160) : null,
      principal,
      ratePct,
      b.points == null ? null : Number(b.points),
      String(b.originatedAt).slice(0, 10),
      termMonths,
      maturity,
      statuses.has(String(b.status)) ? String(b.status) : "current",
      typeof b.notes === "string" && b.notes ? b.notes.slice(0, 1000) : null
    )
    .run();
  return json({ ok: true, id }, env, 201);
});

route("DELETE", "/api/loanbook/:id", async (_req, env, params) => {
  await env.DB.prepare("DELETE FROM loan_book WHERE id = ?1").bind(params.id).run();
  return json({ ok: true }, env);
});

/* ------------------------ historical backfill ------------------------ */

route("GET", "/api/admin/backfill", async (_req, env) => {
  const status = await backfillStatus(env);
  const eligible: string[] = [];
  for (const id of Object.keys(RECORD_CONNECTORS)) {
    if (await backfillEligible(env, id)) eligible.push(id);
  }
  return json({ backfills: status, eligible }, env);
});

route("POST", "/api/admin/backfill/:id", async (_req, env, params) => {
  const ok = await startBackfill(env, params.id);
  if (!ok) return json({ error: "not_eligible" }, env, 409);
  const chunk = await runBackfillChunk(env, params.id); // kick the first window immediately
  return json({ ok: true, firstChunk: chunk }, env, 202);
});

route("POST", "/api/admin/backfill/:id/chunk", async (_req, env, params) => {
  const chunk = await runBackfillChunk(env, params.id);
  return json({ ok: true, ...chunk }, env);
});

/* ------------------------ Socrata field auto-mapping ------------------------ */

route("POST", "/api/admin/connectors/:id/automap", async (_req, env, params) => {
  if (!aiAvailable(env)) return json({ error: "ai_not_configured" }, env, 503);
  const shape = recordShape(params.id);
  if (!shape) return json({ error: "unknown_connector" }, env, 404);
  const cfg = await getConnectorConfig(env, params.id);
  if (!cfg.baseUrl || !isSocrataUrl(cfg.baseUrl)) return json({ error: "not_a_socrata_source" }, env, 409);

  const sampleRes = await fetch(`${cfg.baseUrl}?$limit=3`, {
    headers: cfg.apiKey ? { "X-App-Token": cfg.apiKey } : {},
  });
  if (!sampleRes.ok) return json({ error: `sample_fetch_${sampleRes.status}` }, env, 502);
  const sample = (await sampleRes.text()).slice(0, 12_000);

  const text = await runModel(
    env,
    [
      {
        role: "system",
        content:
          "You map an open-data dataset's field names onto a target record shape. Given sample rows, return ONLY a JSON object: " +
          '{"dateField": "<the dataset field to filter/order by date>", "where": <SoQL filter string or null>, "map": {<targetField>: <datasetField or "=CONSTANT">}} ' +
          "covering every target field you can. Use \"=NY\"-style constants for fixed values the dataset implies but does not carry. " +
          'Use "where" to restrict multi-purpose datasets to the relevant records (e.g. "doc_type = \'MTGE\'"). ' +
          "Target shape:\n" + shape,
      },
      { role: "user", content: sample },
    ],
    1024
  );
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return json({ error: "automap_failed" }, env, 502);
  let mapping: unknown;
  try {
    mapping = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return json({ error: "automap_failed" }, env, 502);
  }
  await env.DB.prepare(
    "UPDATE connector_config SET field_map = ?1, updated_at = datetime('now') WHERE id = ?2"
  )
    .bind(JSON.stringify(mapping), params.id)
    .run();
  return json({ ok: true, fieldMap: mapping }, env);
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

  const payload = JSON.parse(raw) as { records?: Array<{ table: string; row: Record<string, unknown> }> };
  return json({ ok: true, accepted: payload.records?.length ?? 0 }, env, 202);
});
