/**
 * Interest-rate intelligence for recorded notes.
 *
 * ACRIS publishes an *index*, not the instrument: doc type, amount, dates,
 * parties, parcel. It does not publish the interest rate — which is why
 * `acris.ts` sets `ratePct: null` and why the product's rate intel has had
 * no live source. The rate is written in the scanned instrument itself.
 *
 * So this module is deliberately split in two:
 *
 *   1. `rateFromText` — a pure parser over instrument text. Fully tested,
 *      independent of how the text was obtained.
 *   2. `enrichLoanRate` — orchestration: get text for a document, parse it,
 *      fall back to a model pass, and record the result with provenance.
 *
 * The seam between them matters, because step 2 depends on something this
 * codebase cannot yet verify: a URL that yields readable text for a given
 * ACRIS document id. The default below is ACRIS Document Search's detail
 * page, and the honest caveat is that the detail page carries the *index*
 * — the rate usually lives in the document image behind it. Treat a low
 * hit-rate as expected until the image path is confirmed, and override
 * `docUrlTemplate` in the connector's field map rather than editing code.
 *
 * Cost control follows the Apollo pattern: enrichment is bounded and
 * demand-driven — the top open maturity leads that still lack a rate — not
 * a pass over the document stream. At ACRIS volume, OCR of everything would
 * be both slow and pointless; the rate only matters for a note you are
 * about to quote against.
 */

import type { Env } from "./index";
import { renderPageMarkdown, runModel, aiAvailable } from "./ai";

/** `{doc}` is replaced with the ACRIS document id. */
export const DEFAULT_DOC_URL = "https://a836-acris.nyc.gov/DS/DocumentSearch/DocumentDetail?doc_id={doc}";

/** Same plausibility band the integrity gate enforces on ratePct. */
const MIN_RATE = 0.5;
const MAX_RATE = 30;

export interface RateHit {
  ratePct: number;
  /** 0-1. Reflects how clearly the text tied this number to the note rate. */
  confidence: number;
  /** The phrase it came from, so a human can check the machine's work. */
  evidence: string;
}

/**
 * Phrases that mark a percentage as the note's actual rate, and phrases
 * that mark it as something else. A mortgage states several percentages —
 * the note rate, the default rate, a late charge, sometimes a prepayment
 * penalty — and picking the wrong one is worse than picking none, because
 * a confident wrong rate is what the operator would quote against.
 */
const NOTE_RATE_CUES = /\b(per\s+annum|interest\s+rate|rate\s+of\s+interest|bears?\s+interest|annual\s+rate|initial\s+rate|note\s+rate)\b/i;
const OTHER_RATE_CUES = /\b(default|late\s+(charge|fee|payment)|penalt|prepay|maximum\s+legal|usur|overdue|delinquen)\b/i;

/**
 * The clause a percentage sits in, which is what qualifies it.
 *
 * Scoping by a fixed character window does not work: instruments state the
 * note rate and the default rate within a line or two of each other, so a
 * window wide enough to catch "per annum" also catches the neighbouring
 * "upon default" and throws away the very rate being looked for. A rate is
 * qualified by its own sentence, so that is the unit to read.
 *
 * Bounded, because some recorded instruments are one sentence for a page.
 */
/** Sentence-end offsets, used to scope each percentage to its own clause. */
function clauseBoundaries(body: string): number[] {
  // A terminator is punctuation followed by whitespace or end-of-text. The
  // lookahead is what keeps the decimal point in "11.25%" — the exact place
  // the rate lives — from being read as the end of a sentence.
  return [...body.matchAll(/[.;](?=\s|$)/g)].map((m) => (m.index ?? 0) + 1);
}

function clauseAround(body: string, at: number, bounds: number[]): string {
  let start = 0;
  let end = body.length;
  for (const b of bounds) {
    if (b <= at) start = b;
    else { end = b; break; }
  }
  // Bounded: some recorded instruments run a full page without a full stop.
  start = Math.max(start, at - 400);
  end = Math.min(end, at + 400);
  return body.slice(start, Math.max(end, at + 1)).trim();
}

/**
 * Find the note's interest rate in instrument text.
 *
 * Every percentage is judged by its own clause rather than by position, so
 * a document stating "11.25% per annum" and, two lines later, "24% per
 * annum upon default" yields 11.25 — both read as rates, but only one is
 * the note's.
 */
export function rateFromText(text: string | null | undefined): RateHit | null {
  const body = (text ?? "").replace(/\s+/g, " ");
  if (!body) return null;

  const bounds = clauseBoundaries(body);
  let best: RateHit | null = null;
  // Percentages written as digits, with or without a space before the sign.
  for (const m of body.matchAll(/(\d{1,2}(?:\.\d{1,4})?)\s*(?:%|percent\b|per\s+cent\b)/gi)) {
    const value = Number(m[1]);
    if (!Number.isFinite(value) || value < MIN_RATE || value > MAX_RATE) continue;

    const clause = clauseAround(body, m.index ?? 0, bounds);
    // A rate qualified by default/late/penalty language is a different rate
    // in the same instrument; never let it win.
    if (OTHER_RATE_CUES.test(clause)) continue;

    const confidence = NOTE_RATE_CUES.test(clause) ? 0.85 : 0.45;
    if (!best || confidence > best.confidence) {
      best = { ratePct: value, confidence, evidence: clause.slice(0, 240) };
    }
  }
  return best;
}

/** Ask the model when the text has a rate the pattern could not pin down. */
async function rateFromModel(env: Env, text: string): Promise<RateHit | null> {
  if (!aiAvailable(env)) return null;
  const reply = await runModel(env, [
    {
      role: "system",
      content:
        "You read recorded mortgage instruments. Return ONLY the note's stated annual interest rate " +
        'as JSON: {"ratePct": number} — or {"ratePct": null} if the document does not state one. ' +
        "Never return a default rate, late charge, or penalty rate. Do not explain.",
    },
    { role: "user", content: text.slice(0, 6000) },
  ], 128);

  try {
    const parsed = JSON.parse((reply.match(/\{[\s\S]*\}/) ?? [reply])[0]) as { ratePct?: unknown };
    const value = Number(parsed.ratePct);
    if (!Number.isFinite(value) || value < MIN_RATE || value > MAX_RATE) return null;
    // Deliberately below the pattern's confidence: this is an inference from
    // a model, not a phrase a human can point at in the document.
    return { ratePct: value, confidence: 0.6, evidence: "extracted by model from document text" };
  } catch {
    return null;
  }
}

function docUrl(template: string | null | undefined, docNumber: string): string {
  return (template || DEFAULT_DOC_URL).replace("{doc}", encodeURIComponent(docNumber));
}

export interface RateResult {
  ok: boolean;
  loanId: string;
  ratePct?: number;
  confidence?: number;
  error?: string;
}

/**
 * Read one loan's rate from its recorded instrument and store it. Records
 * an attempt either way, so a document with no stated rate is not retried
 * forever.
 */
export async function enrichLoanRate(env: Env, loanId: string, urlTemplate?: string | null): Promise<RateResult> {
  const loan = await env.DB.prepare(
    "SELECT id, doc_number FROM loans WHERE id = ?1 AND doc_number IS NOT NULL"
  )
    .bind(loanId)
    .first<{ id: string; doc_number: string }>();
  if (!loan) return { ok: false, loanId, error: "loan_not_found_or_no_doc_number" };

  const stamp = (rate: number | null, confidence: number | null, source: string) =>
    env.DB.prepare(
      `UPDATE loans SET rate_pct = COALESCE(?1, rate_pct), rate_confidence = ?2,
         rate_source = ?3, rate_checked_at = datetime('now') WHERE id = ?4`
    ).bind(rate, confidence, source, loanId).run();

  let text: string;
  try {
    text = await renderPageMarkdown(env, docUrl(urlTemplate, loan.doc_number));
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err).slice(0, 200);
    await stamp(null, null, `unreachable: ${message}`);
    return { ok: false, loanId, error: message };
  }

  const hit = rateFromText(text) ?? (await rateFromModel(env, text));
  if (!hit) {
    // The index page states no rate — the expected outcome until the
    // document-image path is confirmed. Stamped so it is not re-fetched.
    await stamp(null, null, "no_rate_stated");
    return { ok: false, loanId, error: "no_rate_stated" };
  }

  await stamp(hit.ratePct, hit.confidence, `instrument:${hit.confidence >= 0.85 ? "pattern" : "model"}`);
  return { ok: true, loanId, ratePct: hit.ratePct, confidence: hit.confidence };
}

/**
 * Bounded enrichment pass: the highest-scoring open maturity leads whose
 * note still has no rate. Deliberately small — each one is a headless
 * browser render plus a model call.
 */
export async function enrichTopRates(env: Env, limit = 5, urlTemplate?: string | null): Promise<number> {
  const targets = await env.DB.prepare(
    `SELECT l.id FROM triggers t
     JOIN loans l ON l.id = t.ref_id
     WHERE t.kind = 'maturity' AND t.status NOT IN ('dismissed','converted')
       AND l.rate_pct IS NULL AND l.doc_number IS NOT NULL
       AND l.rate_checked_at IS NULL
     ORDER BY t.score DESC
     LIMIT ?1`
  )
    .bind(limit)
    .all<{ id: string }>();

  let filled = 0;
  for (const t of targets.results) {
    const res = await enrichLoanRate(env, t.id, urlTemplate);
    if (res.ok) filled++;
  }
  return filled;
}
