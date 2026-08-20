/**
 * Fixture ACRIS: serves Master plus the companion datasets from in-memory
 * rows, honouring the parts of SoQL the adapter actually relies on —
 * `$limit`/`$offset` slicing on Master and `document_id in(...)` batching on
 * the companions. Records every request so tests can assert on request
 * *cost*, not just on the joined output.
 */

export interface FakeRows {
  masterRows?: Record<string, unknown>[];
  legals?: Record<string, unknown>[];
  parties?: Record<string, unknown>[];
  refs?: Record<string, unknown>[];
  codes?: Record<string, unknown>[];
}

export interface FakeAcris {
  /** Every request path, in order (with ?offset= when one was sent). */
  calls: string[];
  /** The `$limit` most recently asked of Master. */
  lastMasterLimit: number;
  masterCalls(): number;
  legalCalls(): number;
}

export const BASE = "https://data.cityofnewyork.us/resource/bnx9-e6tj.json";

/** Installs a stub `fetch` and returns a handle for asserting on traffic. */
export function serveAcris(rows: FakeRows): FakeAcris {
  const {
    masterRows = [], legals = [], parties = [], refs = [], codes = [],
  } = rows;
  const handle: FakeAcris = {
    calls: [],
    lastMasterLimit: 0,
    masterCalls: () => handle.calls.filter((c) => c.includes("bnx9-e6tj")).length,
    legalCalls: () => handle.calls.filter((c) => c.includes("8h5j-fqxa")).length,
  };

  globalThis.fetch = (async (url: string) => {
    const u = new URL(String(url));
    const isMaster = u.pathname.includes("bnx9-e6tj");
    const grouped = Boolean(u.searchParams.get("$group"));
    if (isMaster && !grouped) handle.lastMasterLimit = Number(u.searchParams.get("$limit"));
    handle.calls.push(u.pathname + (u.searchParams.get("$offset") ? `?offset=${u.searchParams.get("$offset")}` : ""));

    const body = (payload: unknown[]) => ({ ok: true, text: async () => JSON.stringify(payload) });

    if (isMaster) {
      // Doc-type discovery uses $group; everything else is a windowed read.
      if (grouped) return body([{ doc_type: "DEED", n: "42" }, { doc_type: "MTGE", n: "31" }]);
      const off = Number(u.searchParams.get("$offset") ?? 0);
      const lim = Number(u.searchParams.get("$limit") ?? 1000);
      return body(masterRows.slice(off, off + lim));
    }
    if (u.pathname.includes("7isb-wh4c")) return body(codes);

    const ids = [...(u.searchParams.get("$where") ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const forIds = (rs: Record<string, unknown>[]) => rs.filter((r) => ids.includes(String(r.document_id)));
    if (u.pathname.includes("8h5j-fqxa")) return body(forIds(legals));
    if (u.pathname.includes("636b-3b5g")) return body(forIds(parties));
    if (u.pathname.includes("pwkr-dpni")) return body(forIds(refs));
    throw new Error(`fixture: unexpected dataset ${u.pathname}`);
  }) as unknown as typeof fetch;

  return handle;
}

/** A connector config pointing at the fixture. */
export const connector = (id: string, fieldMap: Record<string, unknown> | null = null) =>
  ({ id, enabled: true, mode: "api", baseUrl: BASE, scrapeUrl: null, notes: null, apiKey: null, fieldMap }) as never;

/** Env stub whose DB accepts the field-map write `resolveAcrisDocTypes` makes. */
export const env = { DB: { prepare: () => ({ bind: () => ({ run: async () => {} }) }) } } as never;

export const WINDOW = { from: "2025-06-01", to: "2025-07-01" };
