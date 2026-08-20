import { describe, expect, it } from "vitest";
import { RECORD_CONNECTORS } from "../src/ingest";
import { makeFakeDB } from "./fake-d1";

const prov = { sourceId: "county_deeds", sourceUrl: "u", method: "api", confidence: "direct" } as never;
const upsert = (kind: keyof typeof RECORD_CONNECTORS, db: ReturnType<typeof makeFakeDB>, rows: unknown[]) =>
  RECORD_CONNECTORS[kind].upsert({ DB: db.DB } as never, rows as never[], prov);

const deed = (i: number, over: Record<string, unknown> = {}) => ({
  docNumber: `D${i}`, apn: `30009${String(i).padStart(4, "0")}`,
  address: `${i} MAIN STREET`, city: "Brooklyn", county: "Kings", state: "NY",
  price: 100000 + i, isCash: true, buyerName: `BUYER ${i} LLC`, sellerName: "SELLER LLC",
  recordedAt: "2025-06-10", ...over,
});

/** Bind position of each table's mutable columns, for reading the fake back. */
const PRICE = 3, PRINCIPAL = 5, AMOUNT = 5;

describe("bulk write path", () => {
  it("costs round trips per page, not per row", async () => {
    const sizes = [50, 500, 2000];
    const results = [];
    for (const n of sizes) {
      const db = makeFakeDB();
      const r = await upsert("county_deeds", db, Array.from({ length: n }, (_, i) => deed(i)));
      results.push({ n, ingested: r.ingested, props: db.tables.properties.length, trips: db.stats.roundTrips });
    }
    expect(results.map((r) => r.ingested)).toEqual(sizes);
    expect(results.map((r) => r.props)).toEqual(sizes); // one property per parcel
    // A per-row resolve would be ~4n (8,000 trips at n=2000). Batched is an
    // order of magnitude below that; the exact figure is allowed to drift.
    const biggest = results[results.length - 1];
    expect(biggest.trips).toBeLessThan(200);
    expect(biggest.trips / biggest.n).toBeLessThan(0.1);
  });

  it("gives one parcel one property row, however the address was typed", async () => {
    const db = makeFakeDB();
    await upsert("county_deeds", db, [
      deed(1, { docNumber: "A1", apn: "3000900001", address: "123 MAIN STREET" }),
      deed(2, { docNumber: "A2", apn: "3000900001", address: "123 MAIN ST" }),   // same BBL, different spelling
      deed(3, { docNumber: "A3", apn: "3000901002", address: "123 MAIN STREET" }), // condo unit: same address, different BBL
    ]);
    expect(db.tables.properties).toHaveLength(2);
    const byDoc = Object.fromEntries(db.tables.transactions.map((t: any) => [t.docNumber, t.property_id]));
    expect(byDoc.A1).toBe(byDoc.A2);
    expect(byDoc.A1).not.toBe(byDoc.A3);
  });

  it("backfills the APN onto a property first seen without one", async () => {
    const db = makeFakeDB();
    db.tables.properties.push({ id: "prp_seed", apn: null, address: "9 OLD WAY", city: "Brooklyn", county: "Kings", state: "NY", zip: null });
    const r = await upsert("county_deeds", db, [deed(9, { docNumber: "B1", apn: "3000905555", address: "9 OLD WAY" })]);
    expect([r.ingested, db.tables.properties.length]).toEqual([1, 1]); // reused, not duplicated
    expect(db.tables.properties[0].apn).toBe("3000905555");
    expect(db.tables.transactions[0].property_id).toBe("prp_seed");
  });

  it("is idempotent across a re-run and dedupes entities", async () => {
    const db = makeFakeDB();
    const rows = [
      deed(1, { docNumber: "C1", buyerName: "ACME HOLDINGS LLC" }),
      deed(2, { docNumber: "C2", buyerName: "ACME HOLDINGS LLC" }),
    ];
    expect((await upsert("county_deeds", db, rows)).ingested).toBe(2);
    expect(db.tables.entities).toHaveLength(1);

    const second = await upsert("county_deeds", db, rows);
    expect([second.ingested, second.skipped]).toEqual([0, 2]);
    expect(db.tables.transactions).toHaveLength(2);
    expect(db.tables.entities).toHaveLength(1);
  });

  it("skips malformed rows instead of failing the page", async () => {
    const db = makeFakeDB();
    const rows = [
      deed(1, { docNumber: "E1" }),
      { docNumber: "E2", address: "", city: "Brooklyn", county: "Kings", state: "NY", buyerName: "X LLC", price: 1, recordedAt: "2025-06-10" },
      null,
      deed(3, { docNumber: "E3", buyerName: "" }),
    ];
    const r = await upsert("county_deeds", db, rows);
    expect(r.ingested).toBe(1);
    expect(r.ingested + r.skipped).toBe(rows.length); // nothing silently vanishes
  });

  it("takes loans and liens down the same batched path", async () => {
    const db = makeFakeDB();
    const loans = Array.from({ length: 300 }, (_, i) => ({
      docNumber: `M${i}`, apn: `10005${String(i).padStart(4, "0")}`, address: `${i} PARK AVE`,
      city: "Manhattan", county: "New York", state: "NY",
      lenderName: i % 2 ? "CHASE BANK" : "HARD MONEY LLC", lenderType: i % 2 ? "bank" : "private",
      principal: 500000, originatedAt: "2025-06-10", borrowerName: `BORROWER ${i} LLC`,
    }));
    expect((await upsert("county_loans", db, loans)).ingested).toBe(300);
    expect(db.stats.roundTrips).toBeLessThan(40);

    const db2 = makeFakeDB();
    const liens = Array.from({ length: 120 }, (_, i) => ({
      docNumber: `L${i}`, apn: `40007${String(i).padStart(4, "0")}`, address: `${i} QUEENS BLVD`,
      city: "Queens", county: "Queens", state: "NY", claimant: `CONTRACTOR ${i}`,
      amount: 50000, filedAt: "2025-06-10", ownerName: `OWNER ${i} LLC`,
    }));
    expect((await upsert("liens", db2, liens)).ingested).toBe(120);
  });

  it("stores the party mailing address, newest revision winning", async () => {
    const db = makeFakeDB();
    const addr = { address: "500 5TH AVE", city: "NEW YORK", state: "NY", zip: "10110" };
    await upsert("county_deeds", db, [{ ...deed(1), docNumber: "P1", buyerName: "ACME LLC", entityAddress: addr, sourceModifiedAt: "2025-06-30" }]);
    expect(db.tables.entities[0]).toMatchObject({ mailing_address: "500 5TH AVE", mailing_city: "NEW YORK", mailing_zip: "10110" });

    await upsert("county_deeds", db, [{ ...deed(2), docNumber: "P2", buyerName: "ACME LLC", entityAddress: { ...addr, address: "1 NEW PLAZA" }, sourceModifiedAt: "2026-01-31" }]);
    expect(db.tables.entities[0].mailing_address).toBe("1 NEW PLAZA");

    await upsert("county_deeds", db, [{ ...deed(3), docNumber: "P3", buyerName: "ACME LLC", entityAddress: { ...addr, address: "0 ANCIENT RD" }, sourceModifiedAt: "2019-01-01" }]);
    expect(db.tables.entities[0].mailing_address).toBe("1 NEW PLAZA"); // an older filing never clobbers
  });
});

describe("corrections", () => {
  const base = {
    docNumber: "2019000123456", apn: "3000900001", address: "1 MAIN STREET", city: "Brooklyn",
    county: "Kings", state: "NY", isCash: true, buyerName: "BUYER LLC", sellerName: "SELLER LLC",
    recordedAt: "2019-04-02",
  };

  it("applies a corrected document over the stored one", async () => {
    const db = makeFakeDB();
    await upsert("county_deeds", db, [{ ...base, price: 1000000, sourceModifiedAt: "2019-04-02" }]);
    expect(db.tables.transactions[0].binds[PRICE]).toBe(1000000);

    const r = await upsert("county_deeds", db, [{ ...base, price: 2500000, sellerName: "SELLER LLC CORRECTED", sourceModifiedAt: "2026-07-15" }]);
    expect(r.ingested).toBe(1);
    expect(db.tables.transactions).toHaveLength(1);           // corrected, not duplicated
    expect(db.tables.transactions[0].binds[PRICE]).toBe(2500000);
    expect(db.tables.transactions[0].modifiedAt).toBe("2026-07-15");
  });

  it("never lets a stale re-read clobber a newer revision", async () => {
    const db = makeFakeDB();
    await upsert("county_deeds", db, [{ ...base, price: 2500000, sourceModifiedAt: "2026-07-15" }]);
    const r = await upsert("county_deeds", db, [{ ...base, price: 1000000, sourceModifiedAt: "2019-04-02" }]);
    expect([r.ingested, r.skipped]).toEqual([0, 1]);
    expect(db.tables.transactions[0].binds[PRICE]).toBe(2500000);
  });

  it("stays a no-op on an identical re-read", async () => {
    const db = makeFakeDB();
    const rec = { ...base, price: 1000000, sourceModifiedAt: "2019-04-02" };
    await upsert("county_deeds", db, [rec]);
    const r = await upsert("county_deeds", db, [rec]);
    expect([r.ingested, r.skipped]).toEqual([0, 1]);
    expect(db.tables.transactions).toHaveLength(1);
  });

  it("applies corrections to loans and liens too", async () => {
    const db = makeFakeDB();
    const loan = {
      docNumber: "M1", apn: "1000550001", address: "5 PARK AVE", city: "Manhattan", county: "New York",
      state: "NY", lenderName: "HARD MONEY LLC", principal: 400000, originatedAt: "2024-01-05",
      borrowerName: "BORROWER LLC", sourceModifiedAt: "2024-01-05",
    };
    await upsert("county_loans", db, [loan]);
    await upsert("county_loans", db, [{ ...loan, principal: 950000, sourceModifiedAt: "2026-02-01" }]);
    expect(db.tables.loans[0].binds[PRINCIPAL]).toBe(950000);

    const db2 = makeFakeDB();
    const lien = {
      docNumber: "L1", apn: "4000700001", address: "2 QUEENS BLVD", city: "Queens", county: "Queens",
      state: "NY", claimant: "CONTRACTOR", amount: 50000, filedAt: "2025-03-01", ownerName: "OWNER LLC",
      sourceModifiedAt: "2025-03-01",
    };
    await upsert("liens", db2, [lien]);
    await upsert("liens", db2, [{ ...lien, amount: 82000, sourceModifiedAt: "2025-09-09" }]);
    expect(db2.tables.liens[0].binds[AMOUNT]).toBe(82000);
  });

  it("handles records that carry no revision marker", async () => {
    const db = makeFakeDB();
    const rec = { ...base, price: 1000000, sourceModifiedAt: null };
    expect((await upsert("county_deeds", db, [rec])).ingested).toBe(1);
    expect((await upsert("county_deeds", db, [rec])).ingested).toBe(0); // and does not loop
  });
});
