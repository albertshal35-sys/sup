import { describe, expect, it } from "vitest";
import { acrisFetch, acrisDocBudget, discoverDocTypes, toIsoDate } from "../src/acris";
import { serveAcris, connector, env, WINDOW as W } from "./fake-acris";

describe("ACRIS join", () => {
  it("keys parcels by BBL and prefers a real lot over easement rows", async () => {
    serveAcris({
      masterRows: [{ document_id: "D1", doc_type: "DEED", document_amt: "1750000", document_date: "2025-06-12", recorded_datetime: "2025-06-14T10:00:00.000" }],
      legals: [
        // easement row listed first — must not win over the taxable lot
        { document_id: "D1", borough: "3", block: "1234", lot: "56", easement: "Y", street_number: "10", street_name: "EASEMENT WAY" },
        { document_id: "D1", borough: "3", block: "999", lot: "7", easement: "N", air_rights: "N", property_type: "R1", street_number: "123", street_name: "MAIN STREET", unit: "4B" },
      ],
      parties: [
        { document_id: "D1", party_type: "1", name: "SELLER LLC" },
        { document_id: "D1", party_type: "2", name: "BUYER ONE LLC" },
        { document_id: "D1", party_type: "2", name: "BUYER TWO LLC" },
      ],
    });
    const { rows, truncated } = await acrisFetch(env, connector("county_deeds"), W);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      apn: "3009990007",                      // borough + 5-digit block + 4-digit lot
      address: "123 MAIN STREET 4B",
      city: "Brooklyn", county: "Kings", state: "NY",
      buyerName: "BUYER ONE LLC & BUYER TWO LLC", // co-buyers both kept
      sellerName: "SELLER LLC",
      price: 1750000,
      parcelCount: 2,
    });
    expect(truncated).toBe(false);
  });

  it("classifies lenders and lands both loans on one parcel", async () => {
    serveAcris({
      masterRows: [
        { document_id: "M1", doc_type: "MTGE", document_amt: "900000", recorded_datetime: "2025-06-10T09:00:00.000" },
        { document_id: "M2", doc_type: "MTGE", document_amt: "500000", recorded_datetime: "2025-06-11T09:00:00.000" },
      ],
      legals: [
        { document_id: "M1", borough: "1", block: "55", lot: "1002", street_number: "5", street_name: "PARK AVE" },
        { document_id: "M2", borough: "1", block: "55", lot: "1002", street_number: "5", street_name: "PARK AVE" },
      ],
      parties: [
        { document_id: "M1", party_type: "1", name: "BORROWER LLC" },
        { document_id: "M1", party_type: "2", name: "JPMORGAN CHASE BANK, N.A." },
        { document_id: "M2", party_type: "1", name: "BORROWER LLC" },
        { document_id: "M2", party_type: "2", name: "HARD MONEY PARTNERS LLC" },
      ],
    });
    const { rows } = await acrisFetch(env, connector("county_loans"), W);
    expect(rows.map((r) => r.lenderType)).toEqual(["bank", "private"]);
    expect(rows.map((r) => r.apn)).toEqual(["1000551002", "1000551002"]);
    expect(rows[0].originatedAt).toBe("2025-06-10"); // falls back to recorded date
  });

  it("matches a satisfaction to its mortgage by reference, not by name", async () => {
    const fake = serveAcris({
      masterRows: [
        { document_id: "S1", crfn: "2025000111", doc_type: "SAT", recorded_datetime: "2025-06-20T09:00:00.000" },
        { document_id: "S2", crfn: "2025000222", doc_type: "SAT", recorded_datetime: "2025-06-21T09:00:00.000" },
        { document_id: "M9", crfn: "2019000999", doc_type: "SAT", recorded_datetime: "2025-06-22T09:00:00.000" },
      ],
      parties: [
        { document_id: "S1", party_type: "1", name: "BORROWER LLC" },
        { document_id: "S1", party_type: "2", name: "PRIVATE LENDER LLC" },
      ],
      refs: [
        { document_id: "S1", reference_by_doc_id: "MTG-ORIGINAL-1" },
        { document_id: "S2", reference_by_crfn_: "2019000999" }, // CRFN-only reference
      ],
    });
    const { rows } = await acrisFetch(env, connector("satisfactions"), W);
    expect(rows.map((r) => r.originalDocNumber)).toEqual(["MTG-ORIGINAL-1", "M9", null]);
    // Satisfactions carry no address, so the Legals fetch is skipped entirely.
    expect(fake.legalCalls()).toBe(0);
  });

  it("orients lien parties from the published role names, not an assumption", async () => {
    serveAcris({
      masterRows: [{ document_id: "N1", doc_type: "MECHANIC", document_amt: "75000", recorded_datetime: "2025-06-05T00:00:00.000" }],
      legals: [{ document_id: "N1", borough: "4", block: "9", lot: "9", street_number: "7", street_name: "QUEENS BLVD" }],
      parties: [
        { document_id: "N1", party_type: "1", name: "ACME CONTRACTING" },
        { document_id: "N1", party_type: "2", name: "PROPCO LLC" },
      ],
      codes: [{ doc__type: "MECHANIC", doc__type_description: "MECHANICS LIEN", party1_type: "LIENOR", party2_type: "OWNER" }],
    });
    const { rows } = await acrisFetch(env, connector("liens", { where: "doc_type = 'MECHANIC'" }), W);
    expect(rows[0]).toMatchObject({ claimant: "ACME CONTRACTING", ownerName: "PROPCO LLC" });
  });

  it("falls back to party1 = owner when the code table says nothing useful", async () => {
    serveAcris({
      masterRows: [{ document_id: "N2", doc_type: "ZZZZ", document_amt: "1000", recorded_datetime: "2025-06-05T00:00:00.000" }],
      legals: [{ document_id: "N2", borough: "4", block: "9", lot: "9", street_number: "8", street_name: "QUEENS BLVD" }],
      parties: [
        { document_id: "N2", party_type: "1", name: "OWNER CO" },
        { document_id: "N2", party_type: "2", name: "CLAIM CO" },
      ],
      codes: [],
    });
    const { rows } = await acrisFetch(env, connector("liens", { where: "doc_type = 'ZZZZ'" }), W);
    expect(rows[0]).toMatchObject({ ownerName: "OWNER CO", claimant: "CLAIM CO" });
  });

  it("collects the party mailing address that comes free with the names", async () => {
    serveAcris({
      masterRows: [{ document_id: "A9", doc_type: "DEED", document_amt: "500000", recorded_datetime: "2025-06-02T00:00:00.000", good_through_date: "2025-06-30T00:00:00.000" }],
      legals: [{ document_id: "A9", borough: "3", block: "5", lot: "5", street_number: "12", street_name: "BEDFORD AVE" }],
      parties: [
        { document_id: "A9", party_type: "1", name: "SELLER LLC", address_1: "1 SELLER WAY", city: "JERSEY CITY", state: "NJ", zip: "07302" },
        { document_id: "A9", party_type: "2", name: "BUYER LLC", address_1: "C/O SOME MGR", address_2: "500 5TH AVE STE 200", city: "NEW YORK", state: "NY", zip: "10110" },
      ],
    });
    const { rows } = await acrisFetch(env, connector("county_deeds"), W);
    expect(rows[0].entityAddress).toEqual({
      address: "C/O SOME MGR 500 5TH AVE STE 200", city: "NEW YORK", state: "NY", zip: "10110",
    });
  });

  it("does not invent an address for a party that has none", async () => {
    serveAcris({
      masterRows: [{ document_id: "A8", doc_type: "DEED", document_amt: "1", recorded_datetime: "2025-06-02T00:00:00.000" }],
      legals: [{ document_id: "A8", borough: "3", block: "5", lot: "6", street_number: "13", street_name: "BEDFORD AVE" }],
      parties: [{ document_id: "A8", party_type: "2", name: "BUYER LLC" }],
    });
    const { rows } = await acrisFetch(env, connector("county_deeds"), W);
    expect(rows[0].entityAddress).toBeNull();
  });
});

describe("document revisions", () => {
  // Per the Master data dictionary a corrected document is re-published in
  // full under a new good-through date, in every dataset at once.
  const twoRevisions = () =>
    serveAcris({
      masterRows: [
        { document_id: "V1", doc_type: "DEED", document_amt: "1000000", document_date: "2019-04-01", recorded_datetime: "2019-04-02T00:00:00.000", good_through_date: "2019-04-30T00:00:00.000" },
        { document_id: "V1", doc_type: "DEED", document_amt: "2500000", document_date: "2019-04-01", recorded_datetime: "2019-04-02T00:00:00.000", good_through_date: "2026-07-31T00:00:00.000" },
      ],
      legals: [
        { document_id: "V1", good_through_date: "2019-04-30T00:00:00.000", borough: "3", block: "1", lot: "1", street_number: "1", street_name: "OLD ST" },
        { document_id: "V1", good_through_date: "2026-07-31T00:00:00.000", borough: "3", block: "1", lot: "2", street_number: "9", street_name: "NEW ST" },
      ],
      parties: [
        { document_id: "V1", good_through_date: "2019-04-30T00:00:00.000", party_type: "2", name: "WRONG BUYER LLC" },
        { document_id: "V1", good_through_date: "2026-07-31T00:00:00.000", party_type: "2", name: "RIGHT BUYER LLC" },
        { document_id: "V1", good_through_date: "2026-07-31T00:00:00.000", party_type: "1", name: "SELLER LLC" },
      ],
    });

  it("collapses every dataset to the current revision", async () => {
    twoRevisions();
    const { rows } = await acrisFetch(env, connector("county_deeds"), W);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      price: 2500000,                 // corrected amount, not the original
      buyerName: "RIGHT BUYER LLC",   // superseded party name gone
      apn: "3000010002",              // current parcel
      parcelCount: 1,                 // not inflated by the old Legals row
      sourceModifiedAt: "2026-07-31", // drives the upsert's revision guard
    });
  });
});

describe("date normalization", () => {
  it.each([
    ["07/15/2026", "2026-07-15"],
    ["4/2/2019", "2019-04-02"],
    ["2026-07-15T00:00:00.000", "2026-07-15"],
    ["", null],
    ["n/a", null],
  ])("normalizes %s", (input, want) => {
    expect(toIsoDate(input)).toBe(want);
  });

  it("orders revisions correctly once normalized", () => {
    // Compared raw, "04/30/2019" sorts above "07/15/2026" — the exact bug
    // this normalization exists to prevent.
    expect(["07/15/2026", "04/30/2019"].map(toIsoDate).sort()).toEqual(["2019-04-30", "2026-07-15"]);
  });

  it("stores US-format dates as ISO end to end", async () => {
    serveAcris({
      masterRows: [{ document_id: "D9", doc_type: "DEED", document_amt: "5", document_date: "04/02/2019", recorded_datetime: "04/02/2019", good_through_date: "07/15/2026" }],
      legals: [{ document_id: "D9", borough: "3", block: "1", lot: "1", street_number: "1", street_name: "A ST" }],
      parties: [{ document_id: "D9", party_type: "2", name: "B LLC" }],
    });
    const { rows } = await acrisFetch(env, connector("county_deeds"), W);
    expect(rows[0]).toMatchObject({ recordedAt: "2019-04-02", sourceModifiedAt: "2026-07-15" });
  });
});

describe("windowed reads", () => {
  const manyDocs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      document_id: `X${i}`,
      doc_type: "DEED",
      document_amt: "100000",
      // newest first, one per hour walking backwards
      recorded_datetime: new Date(Date.parse("2025-06-30T23:00:00Z") - i * 3600_000).toISOString().slice(0, 23),
    }));

  it("reads a whole budget in a single Master request", async () => {
    const fake = serveAcris({ masterRows: manyDocs(8000) });
    const { rows, truncated } = await acrisFetch(env, connector("county_deeds"), W);
    expect(acrisDocBudget(connector("county_deeds"))).toBe(5000);
    expect(rows).toHaveLength(5000);
    expect(fake.masterCalls()).toBe(1);
    expect(fake.lastMasterLimit).toBe(5001); // budget + the truncation probe
    expect(truncated).toBe(true);
  });

  it("reports the oldest date it reached, so a backfill can resume there", async () => {
    serveAcris({ masterRows: manyDocs(8000) });
    const { oldestRecorded } = await acrisFetch(env, connector("county_deeds"), W);
    const expected = new Date(Date.parse("2025-06-30T23:00:00Z") - 4999 * 3600_000).toISOString().slice(0, 10);
    expect(oldestRecorded).toBe(expected);
  });

  it("proves completeness when the probe row does not come back", async () => {
    serveAcris({ masterRows: manyDocs(700) });
    const short = await acrisFetch(env, connector("county_deeds"), W);
    expect([short.rows.length, short.truncated]).toEqual([700, false]);

    // Exactly-budget is still provably complete — the probe row is absent.
    serveAcris({ masterRows: manyDocs(5000) });
    const exact = await acrisFetch(env, connector("county_deeds"), W);
    expect([exact.rows.length, exact.truncated]).toEqual([5000, false]);
  });

  it("honours a raised docBudget", async () => {
    serveAcris({ masterRows: manyDocs(8000) });
    const { rows } = await acrisFetch(env, connector("county_deeds", { docBudget: 8000 }), W);
    expect(rows).toHaveLength(8000);
  });

  it("keeps the external request cost inside the Workers Free-plan cap", async () => {
    // Workers meter external fetches separately from D1: 50 per invocation.
    const fake = serveAcris({ masterRows: manyDocs(8000) });
    await acrisFetch(env, connector("county_deeds"), W);
    expect(fake.calls.length).toBe(1 + 2 * Math.ceil(5000 / 250));
    expect(fake.calls.length).toBeLessThanOrEqual(50);
  });
});

describe("doc-type discovery", () => {
  it("reads labels from the double-underscore code columns", async () => {
    // The lookup table spells them doc__type / doc__type_description, unlike
    // every other ACRIS dataset.
    serveAcris({
      masterRows: [],
      codes: [
        { doc__type: "DEED", doc__type_description: "DEED", class_code_description: "DEEDS AND OTHER CONVEYANCES" },
        { doc__type: "MTGE", doc__type_description: "MORTGAGE", class_code_description: "MORTGAGES" },
      ],
    });
    const types = await discoverDocTypes(connector("county_deeds"), W);
    expect(types.map((t) => `${t.docType}:${t.description}`)).toEqual(["DEED:DEED", "MTGE:MORTGAGE"]);
  });
});
