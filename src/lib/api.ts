/**
 * API layer — talks to the Worker at /api/*, falls back to the bundled demo
 * dataset when the API is unreachable (static preview / local UI dev without
 * `wrangler dev`). Every consumer gets the same shapes either way.
 */

import type {
  BorrowerResume,
  ConnectorInfo,
  IngestionRun,
  Kpis,
  Lead,
  PublicSettings,
  TriggerItem,
  TriggerKind,
} from "../types";
import {
  mockCashPoor,
  mockIngestion,
  mockKpis,
  mockLiens,
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
  state: string | null; est_value: number | null; phone: string | null; email: string | null;
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
      ? { address: r.address, city: r.city!, county: r.county!, state: r.state!, estValue: r.est_value }
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
};

const FEED_MOCKS: Record<TriggerKind, TriggerItem[]> = {
  maturity: mockMaturities,
  cash_poor: mockCashPoor,
  permit: mockPermits,
  lien: mockLiens,
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

export async function getKpis(mode: Mode = "offline"): Promise<Kpis> {
  if (mode === "offline") return mockKpis;
  const live = await tryFetch<Omit<Kpis, "sparks" | "highVelocityFlippers">>("/kpis");
  if (live) return { ...mockKpis, ...live };
  return mode === "demo"
    ? mockKpis
    : {
        ...mockKpis,
        newLeads: 0,
        expiringLoans: { count: 0, principal: 0 },
        cashPoorEntities: 0,
        activeLiens: { count: 0, amount: 0 },
        permitValuation30d: 0,
        highVelocityFlippers: 0,
      };
}

export async function getIngestionStatus(mode: Mode = "offline"): Promise<IngestionRun[]> {
  if (mode !== "offline") {
    const live = await tryFetch<{ lastRuns: Array<{ connector: string; status: IngestionRun["status"]; finished_at: string; rows_ingested: number }> }>("/health");
    if (live?.lastRuns?.length) {
      return live.lastRuns.map((r) => ({
        connector: r.connector, status: r.status, finishedAt: r.finished_at,
        rowsIngested: r.rows_ingested, attempts: 1,
      }));
    }
    if (mode === "live") return [];
  }
  return mockIngestion;
}

export async function getResume(entityId: string, fallbackItem?: TriggerItem): Promise<BorrowerResume | null> {
  // Worker resume payload needs reshaping too; for now the demo resumes cover
  // the seeded entities and any feed row can synthesize a skeleton.
  const seeded = mockResumes[entityId];
  if (seeded) return seeded;
  if (fallbackItem) return synthesizeResume(fallbackItem);
  return null;
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
    if (!res.ok) return { ok: false, error: String(body.error ?? res.status) };
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
    }
  ) => adminFetch<{ ok: boolean }>(`/connectors/${id}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  }),
  runConnector: (id: string) =>
    adminFetch<{ ok: boolean }>(`/connectors/${id}/run`, { method: "POST" }),
  runAll: () => adminFetch<{ ok: boolean }>("/run-ingestion", { method: "POST" }),
  saveSettings: (patch: { dataMode?: "demo" | "live"; markets?: string[]; aiGatewayId?: string }) =>
    adminFetch<{ ok: boolean }>("/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  purgeDemo: () => adminFetch<{ ok: boolean; deleted: number }>("/purge-demo", { method: "POST" }),
};
