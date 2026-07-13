/**
 * API layer — talks to the Worker at /api/*, falls back to the bundled demo
 * dataset when the API is unreachable (static preview / local UI dev without
 * `wrangler dev`). Every consumer gets the same shapes either way.
 */

import type {
  BackfillRow,
  BorrowerResume,
  ConnectorInfo,
  CustomSignal,
  DataQuality,
  IngestionRun,
  Kpis,
  Lead,
  LenderLoan,
  LenderRow,
  LoanBookEntry,
  PublicSettings,
  TriggerItem,
  TriggerKind,
} from "../types";
import {
  mockCashPoor,
  mockCustomSignals,
  mockCustomTriggers,
  mockDataQuality,
  mockIngestion,
  mockKpis,
  mockLenderLoans,
  mockLenders,
  mockLiens,
  mockLoanBook,
  mockMaturities,
  mockPermits,
  mockResumes,
  synthesizeResume,
} from "../data/mock";

const TIMEOUT_MS = 4_000;

/** Session token set after login; attached to every API call. */
let sessionToken = "";
export function setSessionToken(t: string) {
  sessionToken = t;
}

function authHeaders(): Record<string, string> {
  return sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {};
}

async function tryFetch<T>(path: string): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(`/api${path}`, { signal: controller.signal, headers: authHeaders() });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/* ------------------------------- auth ------------------------------- */

export type SettingsProbe =
  | { status: "ok"; settings: PublicSettings }
  | { status: "unauthorized" }
  | { status: "offline" };

/** Probe /api/settings distinguishing offline vs locked vs open. */
export async function probeSettings(): Promise<SettingsProbe> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch("/api/settings", { signal: controller.signal, headers: authHeaders() });
    clearTimeout(timer);
    if (res.status === 401) return { status: "unauthorized" };
    if (!res.ok) return { status: "offline" };
    return { status: "ok", settings: (await res.json()) as PublicSettings };
  } catch {
    return { status: "offline" };
  }
}

export async function loginWithCode(
  code: string
): Promise<{ ok: true; token: string } | { ok: false; error: "invalid_code" | "offline" }> {
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (res.status === 401) return { ok: false, error: "invalid_code" };
    if (!res.ok) return { ok: false, error: "offline" };
    const body = (await res.json()) as { token: string };
    return { ok: true, token: body.token };
  } catch {
    return { ok: false, error: "offline" };
  }
}

/** On-demand Apollo enrichment for one borrower (credits spent only on click). */
export async function enrichEntity(entityId: string): Promise<
  | { ok: true; contacts: ResumeContactShape[]; principalLinked: string | null }
  | { ok: false; error: string }
> {
  try {
    const res = await fetch(`/api/entities/${entityId}/enrich`, { method: "POST", headers: authHeaders() });
    const body = (await res.json().catch(() => ({}))) as {
      contacts?: Array<{ name: string; title: string | null; phone: string | null; email: string | null; linkedin: string | null; confidence: number }>;
      principalLinked?: string | null; error?: string;
    };
    if (!res.ok) return { ok: false, error: body.error ?? String(res.status) };
    return {
      ok: true,
      principalLinked: body.principalLinked ?? null,
      contacts: (body.contacts ?? []).map((c) => ({
        name: c.name, title: c.title, phone: c.phone, email: c.email, linkedin: c.linkedin,
        source: "apollo", confidence: c.confidence, verifiedAt: new Date().toISOString().slice(0, 10),
      })),
    };
  } catch {
    return { ok: false, error: "offline" };
  }
}
type ResumeContactShape = import("../types").ResumeContact;

/** Personalized outreach draft from the borrower's records. */
export async function fetchOutreach(
  entityId: string,
  channel: "email" | "sms"
): Promise<{ message: string } | { error: string }> {
  try {
    const res = await fetch(`/api/ai/outreach/${entityId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ channel }),
    });
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    if (!res.ok || !body.message) return { error: body.error ?? "ai_unavailable" };
    return { message: body.message };
  } catch {
    return { error: "offline" };
  }
}

/** AI outreach brief, generated server-side from the borrower's records. */
export async function fetchAiBrief(entityId: string): Promise<{ brief: string } | { error: string }> {
  try {
    const res = await fetch(`/api/ai/brief/${entityId}`, { method: "POST", headers: authHeaders() });
    const body = (await res.json().catch(() => ({}))) as { brief?: string; error?: string };
    if (!res.ok || !body.brief) return { error: body.error ?? "ai_unavailable" };
    return { brief: body.brief };
  } catch {
    return { error: "offline" };
  }
}

/* Raw worker feed rows are flat SQL joins; normalize to TriggerItem. */
interface RawFeedRow {
  id: string; kind: TriggerKind; score: number; urgency: TriggerItem["urgency"];
  headline: string; payload_json: string; detected_at: string; status: TriggerItem["status"];
  entity_id: string; entity_name: string; entity_kind: TriggerItem["entity"]["kind"];
  principal_name: string | null; flips_36mo: number; avg_margin_pct: number | null;
  velocity_score: number; address: string | null; city: string | null; county: string | null;
  state: string | null; est_value: number | null; lat: number | null; lng: number | null;
  phone: string | null; email: string | null;
  contact_confidence: number | null;
}

function normalizeRow(r: RawFeedRow): TriggerItem {
  return {
    id: r.id, kind: r.kind, score: r.score, urgency: r.urgency, headline: r.headline,
    payload: JSON.parse(r.payload_json || "{}"),
    detectedAt: r.detected_at, status: r.status,
    entity: {
      id: r.entity_id, name: titleCase(r.entity_name), kind: r.entity_kind,
      principalName: r.principal_name, flips36mo: r.flips_36mo,
      avgMarginPct: r.avg_margin_pct, velocityScore: r.velocity_score,
    },
    property: r.address
      ? { address: r.address, city: r.city!, county: r.county!, state: r.state!, estValue: r.est_value, lat: r.lat, lng: r.lng }
      : null,
    contact: r.phone || r.email
      ? { phone: r.phone, email: r.email, confidence: r.contact_confidence ?? 0.5 }
      : null,
  };
}

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) =>
    /^(LLC|LP|II|III|IV)$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()
  );
}

const FEED_PATHS: Record<TriggerKind, string> = {
  maturity: "/triggers/maturities",
  cash_poor: "/triggers/cash-poor",
  permit: "/triggers/permits",
  lien: "/triggers/liens",
  custom: "/triggers/custom",
};

const FEED_MOCKS: Record<TriggerKind, TriggerItem[]> = {
  maturity: mockMaturities,
  cash_poor: mockCashPoor,
  permit: mockPermits,
  lien: mockLiens,
  custom: mockCustomTriggers,
};

type Mode = "demo" | "live" | "offline";

/** Public app settings from the Worker; null when unreachable (offline demo). */
export async function getPublicSettings(): Promise<PublicSettings | null> {
  const probe = await probeSettings();
  return probe.status === "ok" ? probe.settings : null;
}

export async function getFeed(kind: TriggerKind, mode: Mode = "offline"): Promise<TriggerItem[]> {
  if (mode === "offline") return FEED_MOCKS[kind];
  const live = await tryFetch<{ items: RawFeedRow[] }>(FEED_PATHS[kind]);
  if (live) return live.items.map(normalizeRow);
  // API answered /settings but this call failed: demo keeps working, live shows truth
  return mode === "demo" ? FEED_MOCKS[kind] : [];
}

const EMPTY_SPARKS: Kpis["sparks"] = {
  newLeads: [], expiringLoans: [], cashPoor: [], liens: [], flippers: [],
};

const ZERO_KPIS: Kpis = {
  newLeads: 0,
  expiringLoans: { count: 0, principal: 0 },
  cashPoorEntities: 0,
  activeLiens: { count: 0, amount: 0 },
  permitValuation30d: 0,
  highVelocityFlippers: 0,
  sparks: EMPTY_SPARKS,
};

export async function getKpis(mode: Mode = "offline"): Promise<Kpis> {
  if (mode === "offline") return mockKpis;
  const live = await tryFetch<Omit<Kpis, "sparks">>("/kpis");
  if (live) {
    // Server numbers only — never blend in sample values. Sparklines are
    // decorative trend hints; demo mode borrows the sample shapes, live
    // shows none until real history exists.
    return { ...ZERO_KPIS, ...live, sparks: mode === "demo" ? mockKpis.sparks : EMPTY_SPARKS };
  }
  return mode === "demo" ? mockKpis : ZERO_KPIS;
}

export async function getIngestionStatus(mode: Mode = "offline"): Promise<IngestionRun[]> {
  // Pipeline status is infrastructure truth, not demo content: whenever the
  // Worker is reachable, show its real run history — even when that's "none
  // yet". Sample runs appear only in offline preview.
  if (mode !== "offline") {
    const live = await tryFetch<{ lastRuns: Array<{ connector: string; status: IngestionRun["status"]; finished_at: string; rows_ingested: number }> }>("/health");
    if (live) {
      return (live.lastRuns ?? []).map((r) => ({
        connector: r.connector, status: r.status, finishedAt: r.finished_at,
        rowsIngested: r.rows_ingested, attempts: 1,
      }));
    }
    return [];
  }
  return mockIngestion;
}

interface RawResume {
  entity: {
    id: string; name: string; kind: BorrowerResume["entity"]["kind"]; state: string | null;
    formation_date: string | null; registered_agent: string | null; principal_name: string | null;
    flips_36mo: number; avg_margin_pct: number | null; avg_hold_days: number | null;
    volume_36mo: number; velocity_score: number;
  };
  contacts: Array<{ name: string; title: string | null; phone: string | null; email: string | null; linkedin: string | null; source: string; confidence: number; verified_at: string | null }>;
  transactions: Array<{ id: string; side: "purchase" | "sale"; price: number; is_cash: number; address: string; city: string; state: string; recorded_at: string }>;
  loans: Array<{ id: string; lender_name: string; lender_type: string; principal: number; rate_pct: number | null; originated_at: string; maturity_date: string | null; status: string; address: string | null; source_id: string | null; source_url: string | null; source_method: string | null; confidence: string | null }>;
  network: BorrowerResume["network"];
}

export async function getResume(entityId: string, fallbackItem?: TriggerItem): Promise<BorrowerResume | null> {
  // Server first: backfilled/live history must win over bundled samples.
  const live = await tryFetch<RawResume>(`/borrowers/${entityId}/resume`);
  if (live?.entity) {
    const e = live.entity;
    return {
      entity: {
        id: e.id, name: titleCase(e.name), kind: e.kind, principalName: e.principal_name,
        flips36mo: e.flips_36mo ?? 0, avgMarginPct: e.avg_margin_pct,
        velocityScore: e.velocity_score ?? 0, state: e.state,
        formationDate: e.formation_date, registeredAgent: e.registered_agent,
        avgHoldDays: e.avg_hold_days, volume36mo: e.volume_36mo ?? 0,
      },
      contacts: (live.contacts ?? []).map((c) => ({
        name: c.name, title: c.title, phone: c.phone, email: c.email, linkedin: c.linkedin,
        source: c.source, confidence: c.confidence, verifiedAt: c.verified_at,
      })),
      transactions: (live.transactions ?? []).map((t) => ({
        id: t.id, side: t.side, price: t.price, isCash: Boolean(t.is_cash),
        address: t.address, city: t.city, state: t.state, recordedAt: t.recorded_at,
      })),
      loans: (live.loans ?? []).map((l) => ({
        id: l.id, lenderName: titleCase(l.lender_name), lenderType: l.lender_type,
        principal: l.principal, ratePct: l.rate_pct, originatedAt: l.originated_at,
        maturityDate: l.maturity_date, status: l.status, address: l.address ?? "",
        provenance: l.source_id
          ? { sourceId: l.source_id, sourceUrl: l.source_url, sourceMethod: l.source_method, confidence: (l.confidence ?? "direct") as import("../types").RecordConfidence }
          : null,
      })),
      activeSignals: fallbackItem
        ? [{ kind: fallbackItem.kind, headline: fallbackItem.headline, score: fallbackItem.score }]
        : [],
      network: live.network ?? null,
    };
  }
  // Offline preview / unknown entity: bundled resumes, then feed synthesis.
  const seeded = mockResumes[entityId];
  if (seeded) return seeded;
  if (fallbackItem) return synthesizeResume(fallbackItem);
  return null;
}

/* ------------------- competitor intelligence & loan book ------------------- */

interface RawLenderRow {
  lender_name: string; loans: number; ucc_filings: number; volume: number | null;
  avg_rate: number | null; maturing_90d: number; maturing_volume: number | null; payoffs_90d: number;
}

export async function getLenders(mode: Mode = "offline"): Promise<LenderRow[]> {
  if (mode !== "offline") {
    const live = await tryFetch<{ lenders: RawLenderRow[] }>("/lenders");
    if (live) {
      const rows = live.lenders.map((r) => ({
        lenderName: r.lender_name, loans: r.loans, uccFilings: r.ucc_filings,
        volume: r.volume ?? 0, avgRate: r.avg_rate, maturing90d: r.maturing_90d,
        maturingVolume: r.maturing_volume ?? 0, payoffs90d: r.payoffs_90d,
      }));
      if (rows.length || mode === "live") return rows;
    } else if (mode === "live") return [];
  }
  return mockLenders;
}

interface RawLenderLoan {
  id: string; principal: number; rate_pct: number | null; originated_at: string;
  maturity: string | null; status: string; instrument: string; source_url: string | null;
  confidence: LenderLoan["confidence"] | null; entity_id: string | null; entity_name: string | null;
  flips_36mo: number | null; velocity_score: number | null; address: string | null; city: string | null;
}

export async function getLenderLoans(name: string, mode: Mode = "offline"): Promise<LenderLoan[]> {
  if (mode !== "offline") {
    const live = await tryFetch<{ loans: RawLenderLoan[] }>(`/lenders/${encodeURIComponent(name)}/loans`);
    if (live) {
      const rows = live.loans.map((r) => ({
        id: r.id, principal: r.principal, ratePct: r.rate_pct, originatedAt: r.originated_at,
        maturity: r.maturity, status: r.status, instrument: r.instrument,
        entityId: r.entity_id, entityName: r.entity_name ? titleCase(r.entity_name) : null,
        flips36mo: r.flips_36mo, velocityScore: r.velocity_score,
        address: r.address, city: r.city, sourceUrl: r.source_url,
        confidence: r.confidence ?? "direct",
      }));
      if (rows.length || mode === "live") return rows;
    } else if (mode === "live") return [];
  }
  return mockLenderLoans[name] ?? [];
}

interface RawLoanBookRow {
  id: string; entity_id: string | null; entity_name: string | null; borrower_name: string;
  property_address: string | null; principal: number; rate_pct: number; points: number | null;
  originated_at: string; term_months: number; maturity_date: string | null;
  status: LoanBookEntry["status"]; notes: string | null;
}

export async function getLoanBook(mode: Mode = "offline"): Promise<LoanBookEntry[]> {
  if (mode !== "offline") {
    const live = await tryFetch<{ loans: RawLoanBookRow[] }>("/loanbook");
    if (live) {
      return live.loans.map((r) => ({
        id: r.id, entityId: r.entity_id, entityName: r.entity_name ? titleCase(r.entity_name) : null,
        borrowerName: titleCase(r.borrower_name), propertyAddress: r.property_address,
        principal: r.principal, ratePct: r.rate_pct, points: r.points,
        originatedAt: r.originated_at, termMonths: r.term_months, maturityDate: r.maturity_date,
        status: r.status, notes: r.notes,
      }));
    }
    return [];
  }
  return mockLoanBook;
}

export async function saveLoanBookEntry(entry: Partial<LoanBookEntry>): Promise<{ ok: boolean; id?: string }> {
  try {
    const res = await fetch("/api/loanbook", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(entry),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: res.ok, id: body.id };
  } catch {
    return { ok: false };
  }
}

export async function deleteLoanBookEntry(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/loanbook/${id}`, { method: "DELETE", headers: authHeaders() });
    return res.ok;
  } catch {
    return false;
  }
}

/* ------------------------------ CRM sync ------------------------------ */
/* Local pipeline state is source of truth for the demo; these mirror it to
   the Worker best-effort so multi-device state works once deployed. */

const DEMO_USER = "usr_01";

export async function syncLeadUpsert(lead: Lead): Promise<void> {
  try {
    await fetch("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        userId: DEMO_USER,
        entityId: lead.entityId,
        stage: lead.stage,
        note: lead.note,
        followUp: lead.followUp,
        dealValue: lead.dealValue,
      }),
    });
  } catch {
    /* offline demo */
  }
}

export async function syncLeadRemove(entityId: string): Promise<void> {
  try {
    await fetch(`/api/watchlist/${entityId}?userId=${DEMO_USER}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
  } catch {
    /* offline demo */
  }
}

export async function setTriggerStatus(id: string, status: string): Promise<void> {
  try {
    await fetch(`/api/triggers/${id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ status }),
    });
  } catch {
    /* offline demo — state persists client-side only */
  }
}

/* ------------------------------ admin API ------------------------------ */

async function adminFetch<T>(
  path: string,
  init?: RequestInit
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/admin${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
        ...init?.headers,
      },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const detail = typeof body.detail === "string" && body.detail ? ` — ${body.detail}` : "";
      return { ok: false, error: `${String(body.error ?? res.status)}${detail}` };
    }
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, error: "api_unreachable" };
  }
}

export const admin = {
  getConnectors: () => adminFetch<{ connectors: ConnectorInfo[] }>("/connectors"),
  saveConnector: (
    id: string,
    patch: {
      enabled?: boolean;
      baseUrl?: string;
      apiKey?: string;
      mode?: "api" | "scrape";
      scrapeUrl?: string;
      notes?: string;
      fieldMap?: string;
    }
  ) => adminFetch<{ ok: boolean }>(`/connectors/${id}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  }),
  testConnector: (id: string) =>
    adminFetch<{ steps: Array<{ label: string; ok: boolean; detail: string }>; rows: number; valid: number }>(
      `/connectors/${id}/test`, { method: "POST" }
    ),
  automapConnector: (id: string) =>
    adminFetch<{ ok: boolean; fieldMap: Record<string, unknown> }>(`/connectors/${id}/automap`, { method: "POST" }),
  runConnector: (id: string) =>
    adminFetch<{ ok: boolean }>(`/connectors/${id}/run`, { method: "POST" }),
  runAll: () => adminFetch<{ ok: boolean }>("/run-ingestion", { method: "POST" }),
  activateAllSources: () =>
    adminFetch<{ ok: boolean; enabled: string[]; backfills: string[]; pulls: string[]; notes: string[] }>(
      "/sources/activate-all", { method: "POST" }
    ),
  pipelineDoctor: () =>
    adminFetch<{
      connectors: Array<{
        id: string; enabled: boolean; mode: string; verdict: string; queued: boolean;
        lastRun: { status: string; finished_at: string | null; rows_ingested: number; rows_skipped: number; error: string | null } | null;
        backfill: { status: string; rowsTotal: number; error: string | null } | null;
      }>;
      feeds: Array<{ kind: string; ready: boolean; detail: string }>;
      openTriggers: number;
    }>("/pipeline/doctor"),
  saveSettings: (patch: {
    dataMode?: "demo" | "live";
    markets?: string[];
    aiGatewayId?: string;
    alertsEnabled?: boolean;
    alertEmail?: string;
    underwriting?: Record<string, unknown>;
    outreach?: Record<string, unknown>;
  }) =>
    adminFetch<{ ok: boolean }>("/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  purgeDemo: () => adminFetch<{ ok: boolean; deleted: number }>("/purge-demo", { method: "POST" }),
  testAlerts: () => adminFetch<{ ok: boolean; error?: string }>("/alerts/test", { method: "POST" }),

  /* ---- data quality ---- */
  getDataQuality: async (): Promise<DataQuality | null> => {
    const res = await adminFetch<{
      pendingQuarantine: number; quarantined7d: number; ingested7d: number;
      totals?: Record<string, number>;
      anomalies: DataQuality["anomalies"];
      quarantine: Array<{ id: string; connector: string; record_kind: string; payload_json: string; reasons_json: string; source_url: string | null; created_at: string }>;
      merges: Array<{ id: string; name_a: string; name_b: string; reason: string; score: number }>;
    }>("/data-quality");
    if (!res.ok) return null;
    const d = res.data;
    return {
      pendingQuarantine: d.pendingQuarantine, quarantined7d: d.quarantined7d, ingested7d: d.ingested7d,
      totals: d.totals ?? {},
      anomalies: d.anomalies,
      quarantine: d.quarantine.map((q) => ({
        id: q.id, connector: q.connector, recordKind: q.record_kind,
        payload: safeJson(q.payload_json), reasons: safeJson(q.reasons_json, []) as unknown as string[],
        sourceUrl: q.source_url, createdAt: q.created_at,
      })),
      merges: d.merges.map((m) => ({ id: m.id, nameA: titleCase(m.name_a), nameB: titleCase(m.name_b), reason: m.reason, score: m.score })),
    };
  },
  quarantineAction: (id: string, action: "approve" | "discard") =>
    adminFetch<{ ok: boolean }>(`/quarantine/${id}`, { method: "POST", body: JSON.stringify({ action }) }),
  mergeAction: (id: string, action: "merge" | "dismiss") =>
    adminFetch<{ ok: boolean }>(`/merges/${id}`, { method: "POST", body: JSON.stringify({ action }) }),

  /* ---- custom signals ---- */
  getSignals: async (): Promise<CustomSignal[]> => {
    const res = await adminFetch<{ signals: Array<{ id: string; name: string; prompt: string; rule_json: string; enabled: number; last_run_at: string | null; total_hits: number }> }>("/signals");
    if (!res.ok) return [];
    return res.data.signals.map((s) => ({
      id: s.id, name: s.name, prompt: s.prompt, rule: safeJson(s.rule_json),
      enabled: Boolean(s.enabled), lastRunAt: s.last_run_at, totalHits: s.total_hits,
    }));
  },
  compileSignal: (prompt: string) =>
    adminFetch<{ rule: Record<string, unknown> } | { error: string; detail?: string }>("/signals/compile", {
      method: "POST", body: JSON.stringify({ prompt }),
    }),
  createSignal: (name: string, prompt: string, rule: Record<string, unknown>) =>
    adminFetch<{ ok: boolean; id: string; hits: number }>("/signals", {
      method: "POST", body: JSON.stringify({ name, prompt, rule }),
    }),
  toggleSignal: (id: string, enabled: boolean) =>
    adminFetch<{ ok: boolean }>(`/signals/${id}`, { method: "POST", body: JSON.stringify({ enabled }) }),
  deleteSignal: (id: string) => adminFetch<{ ok: boolean }>(`/signals/${id}`, { method: "DELETE" }),

  /* ---- backfill ---- */
  getBackfill: async (): Promise<{ backfills: BackfillRow[]; eligible: string[] } | null> => {
    const res = await adminFetch<{ backfills: BackfillRow[]; eligible: string[] }>("/backfill");
    return res.ok ? res.data : null;
  },
  startBackfill: (id: string) => adminFetch<{ ok: boolean }>(`/backfill/${id}`, { method: "POST" }),
  chunkBackfill: (id: string) =>
    adminFetch<{ ok: boolean; done: boolean; ingested: number }>(`/backfill/${id}/chunk`, { method: "POST" }),
};

/** Offline demo fallbacks for the Settings data-quality surfaces. */
export const offlineAdminData = {
  dataQuality: mockDataQuality,
  signals: mockCustomSignals,
};

function safeJson(s: string, fallback: unknown = {}): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return fallback as Record<string, unknown>;
  }
}
