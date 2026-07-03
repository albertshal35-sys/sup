/**
 * Entity resolution — finds probable duplicate borrower entities (name
 * variants of the same LLC, not distinct LLCs run by the same principal;
 * those belong in the borrower network) and lets the operator merge them.
 *
 * Candidates are generated deterministically; nothing merges without an
 * explicit approval in Settings → Data quality.
 */

import type { Env } from "./index";

/** Aggressive normalization: casing, punctuation, entity-suffix noise. */
export function coreName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[.,'&-]/g, " ")
    .replace(/\b(LLC|L L C|LP|LLP|LLLP|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|TRUST|LTD|LIMITED|HOLDINGS?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Scan for duplicate-looking entities and file merge suggestions. */
export async function generateMergeSuggestions(env: Env): Promise<number> {
  const entities = await env.DB.prepare(
    `SELECT id, name FROM entities ORDER BY created_at LIMIT 5000`
  ).all<{ id: string; name: string }>();

  const byCore = new Map<string, { id: string; name: string }[]>();
  for (const e of entities.results) {
    const core = coreName(e.name);
    if (core.length < 4) continue;
    const list = byCore.get(core) ?? [];
    list.push(e);
    byCore.set(core, list);
  }

  let created = 0;
  for (const [core, group] of byCore) {
    if (group.length < 2) continue;
    // Suggest merging each later duplicate into the earliest entity.
    const [keep, ...dupes] = group;
    for (const dupe of dupes.slice(0, 5)) {
      const res = await env.DB.prepare(
        `INSERT OR IGNORE INTO merge_suggestions (id, entity_a, entity_b, reason, score)
         VALUES (?1, ?2, ?3, ?4, 0.85)`
      )
        .bind(
          `mrg_${crypto.randomUUID().slice(0, 12)}`,
          keep.id,
          dupe.id,
          `Both normalize to "${core}" — "${keep.name}" vs "${dupe.name}"`
        )
        .run();
      if (res.meta.changes) created++;
    }
  }
  return created;
}

/**
 * Execute an approved merge: repoint every reference from entity B onto
 * entity A, then remove B. Trigger rows that would collide with an existing
 * (kind, entity, ref) on A are dropped rather than duplicated.
 */
export async function applyMerge(env: Env, suggestionId: string): Promise<boolean> {
  const sug = await env.DB.prepare(
    "SELECT entity_a, entity_b FROM merge_suggestions WHERE id = ?1 AND status = 'pending'"
  )
    .bind(suggestionId)
    .first<{ entity_a: string; entity_b: string }>();
  if (!sug) return false;
  const { entity_a: a, entity_b: b } = sug;

  const steps: Array<[string, unknown[]]> = [
    ["UPDATE transactions SET entity_id = ?1 WHERE entity_id = ?2", [a, b]],
    ["UPDATE loans SET entity_id = ?1 WHERE entity_id = ?2", [a, b]],
    ["UPDATE permits SET entity_id = ?1 WHERE entity_id = ?2", [a, b]],
    ["UPDATE liens SET entity_id = ?1 WHERE entity_id = ?2", [a, b]],
    ["UPDATE contacts SET entity_id = ?1 WHERE entity_id = ?2", [a, b]],
    ["UPDATE loan_book SET entity_id = ?1 WHERE entity_id = ?2", [a, b]],
    ["UPDATE OR IGNORE triggers SET entity_id = ?1 WHERE entity_id = ?2", [a, b]],
    ["DELETE FROM triggers WHERE entity_id = ?1", [b]],
    ["UPDATE OR IGNORE entity_principals SET entity_id = ?1 WHERE entity_id = ?2", [a, b]],
    ["DELETE FROM entity_principals WHERE entity_id = ?1", [b]],
    ["UPDATE OR IGNORE watchlist SET entity_id = ?1 WHERE entity_id = ?2", [a, b]],
    ["DELETE FROM watchlist WHERE entity_id = ?1", [b]],
    ["DELETE FROM merge_suggestions WHERE id != ?3 AND (entity_a IN (?1,?2) OR entity_b IN (?1,?2))", [a, b, suggestionId]],
    ["DELETE FROM entities WHERE id = ?1", [b]],
  ];
  for (const [sql, binds] of steps) {
    await env.DB.prepare(sql).bind(...binds).run();
  }
  await env.DB.prepare(
    "UPDATE merge_suggestions SET status = 'merged' WHERE id = ?1"
  )
    .bind(suggestionId)
    .run();
  return true;
}
