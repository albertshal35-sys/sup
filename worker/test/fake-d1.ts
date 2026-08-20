/**
 * Minimal in-memory stand-in for D1.
 *
 * This is deliberately NOT a SQL engine: it pattern-matches the handful of
 * statement shapes the ingest path emits and models just the constraints
 * that matter — the UNIQUE(apn, county, state) on properties, the unique
 * doc_number per record table, and the ON CONFLICT revision guard. That is
 * enough to pin the behaviour we actually care about (parcel identity,
 * idempotency, corrections, round-trip counts) without pulling in a real
 * database.
 */
export function makeFakeDB() {
  const t: Record<string, any[]> = { properties: [], entities: [], transactions: [], loans: [], liens: [], permits: [] };
  const stats = { roundTrips: 0, statements: 0, selects: 0, batches: 0 };

  const exec = (sql: string, binds: any[]): any => {
    stats.statements++;
    const s = sql.replace(/\s+/g, " ").trim();

    let m;
    if ((m = s.match(/^SELECT id, apn, county, state FROM properties WHERE apn IN/))) {
      stats.selects++;
      const set = new Set(binds as string[]);
      return { results: t.properties.filter((p: any) => p.apn && set.has(p.apn)).map((p: any) => ({ id: p.id, apn: p.apn, county: p.county, state: p.state })) };
    }
    if ((m = s.match(/^SELECT id, apn, address, city, state FROM properties WHERE address IN/))) {
      stats.selects++;
      const set = new Set(binds as string[]);
      return { results: t.properties.filter((p: any) => set.has(p.address)).map((p: any) => ({ id: p.id, apn: p.apn, address: p.address, city: p.city, state: p.state })) };
    }
    if ((m = s.match(/^SELECT id, name FROM entities WHERE name IN/))) {
      stats.selects++;
      const set = new Set(binds as string[]);
      return { results: t.entities.filter((e: any) => set.has(e.name)).map((e: any) => ({ id: e.id, name: e.name })) };
    }
    if (s.startsWith("INSERT OR IGNORE INTO properties")) {
      const [id, apn, address, city, county, state, zip] = binds;
      // UNIQUE (apn, county, state) when apn is non-null
      if (apn && t.properties.some((p: any) => p.apn === apn && p.county === county && p.state === state)) return { meta: { changes: 0 } };
      t.properties.push({ id, apn, address, city, county, state, zip });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE OR IGNORE properties SET apn")) {
      const [apn, id] = binds;
      const p = t.properties.find((x: any) => x.id === id && x.apn == null);
      if (!p) return { meta: { changes: 0 } };
      if (t.properties.some((x: any) => x.apn === apn && x.county === p.county && x.state === p.state)) return { meta: { changes: 0 } };
      p.apn = apn;
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE entities SET mailing_address")) {
      const [address, city, state, zip, seenAt, id] = binds;
      const e = t.entities.find((x: any) => x.id === id);
      if (!e) return { meta: { changes: 0 } };
      if (e.mailing_seen_at != null && !(String(seenAt ?? "") > String(e.mailing_seen_at))) return { meta: { changes: 0 } };
      Object.assign(e, { mailing_address: address, mailing_city: city, mailing_state: state, mailing_zip: zip, mailing_seen_at: seenAt });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT INTO entities")) {
      const [id, kind, name] = binds;
      t.entities.push({ id, kind, name });
      return { meta: { changes: 1 } };
    }
    if ((m = s.match(/^INSERT (?:OR IGNORE )?INTO (transactions|loans|liens|permits)/))) {
      const table = m[1];
      const [id, property_id, entity_id] = binds;
      // doc_number sits at a different bind position per table
      const DOC_AT: Record<string, number> = { transactions: 9, loans: 10, liens: 7, permits: 3 };
      const MOD_AT: Record<string, number> = { transactions: 10, loans: 11, liens: 8 };
      const docNumber = binds[DOC_AT[table]];
      const modifiedAt = MOD_AT[table] != null ? binds[MOD_AT[table]] : null;
      const key = table === "permits" ? `${docNumber}|${property_id}` : docNumber;
      const existing = t[table].find((r: any) => r.key === key);
      if (existing) {
        // ON CONFLICT ... DO UPDATE ... WHERE excluded.source_modified_at > COALESCE(stored, '')
        const upsert = /ON CONFLICT/.test(s);
        if (!upsert) return { meta: { changes: 0 } };
        if (!((modifiedAt ?? "") > (existing.modifiedAt ?? ""))) return { meta: { changes: 0 } };
        Object.assign(existing, { property_id, entity_id, modifiedAt, binds });
        return { meta: { changes: 1 } };
      }
      t[table].push({ id, property_id, entity_id, key, docNumber, modifiedAt, binds, confidence: binds.at(-1) });
      return { meta: { changes: 1 } };
    }
    if ((m = s.match(/^UPDATE (transactions|loans|liens) SET confidence/))) {
      return { meta: { changes: 0 } };
    }
    throw new Error("fake-d1: unhandled SQL -> " + s.slice(0, 120));
  };

  const prepare = (sql: string): any => ({
    bind: (...binds) => ({
      first: async () => { stats.roundTrips++; return exec(sql, binds).results?.[0] ?? null; },
      all: async () => { stats.roundTrips++; return exec(sql, binds); },
      run: async () => { stats.roundTrips++; return exec(sql, binds); },
      __exec: () => exec(sql, binds),
    }),
    first: async () => { stats.roundTrips++; return exec(sql, []).results?.[0] ?? null; },
    all: async () => { stats.roundTrips++; return exec(sql, []); },
    run: async () => { stats.roundTrips++; return exec(sql, []); },
    __exec: () => exec(sql, []),
  });

  return {
    tables: t,
    stats,
    DB: {
      prepare,
      batch: async (stmts: any[]) => { stats.roundTrips++; stats.batches++; return stmts.map((st: any) => st.__exec()); },
    },
  };
}
