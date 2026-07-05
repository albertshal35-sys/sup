/**
 * Apollo.io contact enrichment — on demand, per borrower, never in bulk.
 *
 * Endpoints (docs.apollo.io):
 *   POST /api/v1/people/match          person enrichment (name + organization_name,
 *                                      reveal_personal_emails / reveal_phone_number)
 *   POST /api/v1/mixed_people/search   people at an organization by title
 * Auth: X-Api-Key header. Each successful match consumes Apollo credits,
 * which is why enrichment only runs when the operator clicks Enrich on a
 * specific borrower — trivial records never spend a credit.
 *
 * Enrichment also feeds the borrower network: a matched person is upserted
 * into principals and linked to the entity, so enriching two LLCs owned by
 * the same person connects them into one full picture.
 */

import type { Env } from "./index";
import { getConnectorConfig, normalizeName } from "./ingest";

const APOLLO = "https://api.apollo.io/api/v1";
const TITLES = ["owner", "founder", "principal", "managing member", "president", "manager", "ceo"];

interface ApolloPerson {
  name?: string;
  first_name?: string;
  last_name?: string;
  title?: string | null;
  email?: string | null;
  linkedin_url?: string | null;
  sanitized_phone?: string | null;
  organization?: { name?: string; phone?: string | null } | null;
}

function usableEmail(e: string | null | undefined): string | null {
  if (!e || /not_unlocked|domain\.com$/i.test(e)) return null;
  return e;
}

/** Strip entity-suffix noise so Apollo sees the operating name. */
function orgQuery(name: string): string {
  return name.replace(/\b(LLC|L\.L\.C\.|LP|LLP|INC|CORP|LTD)\.?\b/gi, "").replace(/\s+/g, " ").trim();
}

async function apolloPost<T>(key: string, path: string, body: Record<string, unknown>): Promise<T | null> {
  const res = await fetch(`${APOLLO}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": key },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error("apollo_key_rejected");
    if (res.status === 429) throw new Error("apollo_rate_limited");
    return null;
  }
  return (await res.json()) as T;
}

export async function enrichEntity(env: Env, entityId: string): Promise<
  | { ok: true; contacts: Array<Record<string, unknown>>; principalLinked: string | null }
  | { ok: false; error: string }
> {
  const entity = await env.DB.prepare(
    "SELECT id, name, kind, principal_name FROM entities WHERE id = ?1"
  ).bind(entityId).first<{ id: string; name: string; kind: string; principal_name: string | null }>();
  if (!entity) return { ok: false, error: "not_found" };

  const cfg = await getConnectorConfig(env, "skip_trace");
  if (!cfg.apiKey) return { ok: false, error: "apollo_key_missing" };

  const persons: ApolloPerson[] = [];
  try {
    // Best shot first: a known principal name + the operating company name.
    if (entity.principal_name || entity.kind === "individual") {
      const matchName = entity.principal_name ?? entity.name;
      const match = await apolloPost<{ person?: ApolloPerson }>(cfg.apiKey, "/people/match", {
        name: matchName,
        organization_name: entity.kind === "individual" ? undefined : orgQuery(entity.name),
        reveal_personal_emails: true,
        reveal_phone_number: false, // phone reveal is webhook-async on Apollo
      });
      if (match?.person?.name || match?.person?.first_name) persons.push(match.person);
    }
    // Fallback: who runs this company?
    if (persons.length === 0 && entity.kind !== "individual") {
      const search = await apolloPost<{ people?: ApolloPerson[] }>(cfg.apiKey, "/mixed_people/search", {
        q_organization_name: orgQuery(entity.name),
        person_titles: TITLES,
        per_page: 3,
      });
      persons.push(...(search?.people ?? []).slice(0, 3));
    }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 80) };
  }

  if (persons.length === 0) return { ok: true, contacts: [], principalLinked: null };

  const contacts: Array<Record<string, unknown>> = [];
  let principalLinked: string | null = null;

  for (const [i, p] of persons.entries()) {
    const fullName = (p.name || `${p.first_name ?? ""} ${p.last_name ?? ""}`).trim();
    if (!fullName) continue;
    const email = usableEmail(p.email);
    const phone = p.sanitized_phone || p.organization?.phone || null;
    const confidence = i === 0 ? 0.9 : 0.7;

    const contactId = `con_${crypto.randomUUID().slice(0, 12)}`;
    await env.DB.prepare(
      `INSERT INTO contacts (id, entity_id, name, title, phone, email, linkedin, source, confidence, verified_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'apollo', ?8, date('now'))`
    ).bind(contactId, entityId, fullName, p.title ?? null, phone, email, p.linkedin_url ?? null, confidence).run();
    contacts.push({ id: contactId, name: fullName, title: p.title ?? null, phone, email, linkedin: p.linkedin_url ?? null, source: "apollo", confidence });

    // Wire the person into the cross-LLC network graph.
    if (i === 0 && entity.kind !== "individual") {
      const pname = normalizeName(fullName);
      let principal = await env.DB.prepare("SELECT id FROM principals WHERE name = ?1")
        .bind(pname).first<{ id: string }>();
      if (!principal) {
        principal = { id: `pri_${crypto.randomUUID().slice(0, 12)}` };
        await env.DB.prepare(
          "INSERT INTO principals (id, name, phone, email, linkedin, origin) VALUES (?1, ?2, ?3, ?4, ?5, 'live')"
        ).bind(principal.id, pname, phone, email, p.linkedin_url ?? null).run();
      }
      await env.DB.prepare(
        `INSERT OR IGNORE INTO entity_principals (id, principal_id, entity_id, role, source, confidence)
         VALUES (?1, ?2, ?3, ?4, 'apollo', ?5)`
      ).bind(`ep_${crypto.randomUUID().slice(0, 12)}`, principal.id, entityId, p.title ?? "principal", confidence).run();
      await env.DB.prepare(
        "UPDATE entities SET principal_name = COALESCE(principal_name, ?1) WHERE id = ?2"
      ).bind(fullName, entityId).run();
      principalLinked = fullName;
    }
  }
  return { ok: true, contacts, principalLinked };
}
