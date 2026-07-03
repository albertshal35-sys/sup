/**
 * API layer — talks to the Worker at /api/*, falls back to the bundled demo
 * dataset when the API is unreachable (static preview / local UI dev without
 * `wrangler dev`). Every consumer gets the same shapes either way.
 */

import type { BorrowerResume, IngestionRun, Kpis, Lead, TriggerItem, TriggerKind } from "../types";
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

const TIMEOUT_MS = 3_000;

async function tryFetch<T>(path: string): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(`/api${path}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
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

export async function getFeed(kind: TriggerKind): Promise<TriggerItem[]> {
  const live = await tryFetch<{ items: RawFeedRow[] }>(FEED_PATHS[kind]);
  if (live && live.items.length > 0) return live.items.map(normalizeRow);
  return FEED_MOCKS[kind];
}

export async function getKpis(): Promise<Kpis> {
  const live = await tryFetch<Omit<Kpis, "sparks" | "highVelocityFlippers">>("/kpis");
  if (live) return { ...mockKpis, ...live };
  return mockKpis;
}

export async function getIngestionStatus(): Promise<IngestionRun[]> {
  const live = await tryFetch<{ lastRuns: Array<{ connector: string; status: IngestionRun["status"]; finished_at: string; rows_ingested: number }> }>("/health");
  if (live?.lastRuns?.length) {
    return live.lastRuns.map((r) => ({
      connector: r.connector, status: r.status, finishedAt: r.finished_at,
      rowsIngested: r.rows_ingested, attempts: 1,
    }));
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: DEMO_USER,
        entityId: lead.entityId,
        stage: lead.stage,
        note: lead.note,
        followUp: lead.followUp,
      }),
    });
  } catch {
    /* offline demo */
  }
}

export async function syncLeadRemove(entityId: string): Promise<void> {
  try {
    await fetch(`/api/watchlist/${entityId}?userId=${DEMO_USER}`, { method: "DELETE" });
  } catch {
    /* offline demo */
  }
}

export async function setTriggerStatus(id: string, status: string): Promise<void> {
  try {
    await fetch(`/api/triggers/${id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  } catch {
    /* offline demo — state persists client-side only */
  }
}
