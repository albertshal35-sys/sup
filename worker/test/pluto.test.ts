import { describe, expect, it } from "vitest";
import { taxClassOf, estimateMarketValue, plutoFacts } from "../src/pluto";
import { positionOf, equityScore } from "../src/scoring";

describe("tax class from building class", () => {
  it.each([
    ["A1", "1"], // one-family
    ["B3", "1"], // two-family
    ["C0", "1"], // three-family assesses as Class 1
    ["C4", "2"], // walk-up apartments
    ["D9", "2"], // elevator apartments
    ["O5", "4"], // office
    ["K2", "4"], // retail
    ["V0", "4"], // vacant land
  ])("maps %s to class %s", (bldg, want) => {
    expect(taxClassOf(bldg)).toBe(want);
  });

  it("returns null when the class is unknown", () => {
    expect(taxClassOf("")).toBeNull();
    expect(taxClassOf(null)).toBeNull();
  });
});

describe("assessed value is not market value", () => {
  // This is the whole point of the derivation: NYC assesses Class 1 at 6%
  // of market. Treating assesstot as a value would understate a house by
  // ~16x and make every LTV nonsense.
  it("grosses a Class 1 home up by the 6% ratio", () => {
    expect(estimateMarketValue(180_000, "1")).toBe(3_000_000);
  });

  it("grosses Classes 2 and 4 up by the 45% ratio", () => {
    expect(estimateMarketValue(1_350_000, "2")).toBe(3_000_000);
    expect(estimateMarketValue(450_000, "4")).toBe(1_000_000);
  });

  it("refuses to guess when the class is unknown", () => {
    // A wrong ratio ranks leads confidently and wrongly — worse than none.
    expect(estimateMarketValue(180_000, null)).toBeNull();
    expect(estimateMarketValue(0, "1")).toBeNull();
    expect(estimateMarketValue(null, "1")).toBeNull();
  });

  it("would have produced an absurd LTV without the ratio", () => {
    const assessed = 180_000;          // a $3M Class 1 house
    const note = 500_000;
    const naive = positionOf(note, assessed);
    const derived = positionOf(note, estimateMarketValue(assessed, "1"));
    expect(naive.ltvPct).toBe(278);    // the bug this avoids
    expect(derived.ltvPct).toBe(17);
  });
});

describe("plutoFacts", () => {
  it("shapes a row and derives value in one pass", () => {
    expect(plutoFacts({
      bbl: "3009990007", lotarea: "2500", bldgarea: "7200", unitstotal: "12",
      numfloors: "4", yearbuilt: "1928", bldgclass: "C4", zonedist1: "R6",
      ownername: "BEDFORD HOLDINGS LLC", assesstot: "1350000",
      latitude: "40.6782", longitude: "-73.9442",
    })).toEqual({
      lotArea: 2500, bldgArea: 7200, unitsTotal: 12, numFloors: 4, yearBuilt: 1928,
      bldgClass: "C4", zoning: "R6", ownerName: "BEDFORD HOLDINGS LLC",
      assessedValue: 1350000, taxClass: "2", estMarketValue: 3000000,
      lat: 40.6782, lng: -73.9442,
    });
  });

  it("treats absent and zero fields as unknown, not as zero", () => {
    const f = plutoFacts({ bbl: "1000010001", lotarea: "0", unitstotal: "", bldgclass: "  " });
    expect(f.lotArea).toBeNull();
    expect(f.unitsTotal).toBeNull();
    expect(f.bldgClass).toBeNull();
    expect(f.estMarketValue).toBeNull();
  });
});

describe("debt position", () => {
  it("computes LTV and equity against estimated market value", () => {
    expect(positionOf(750_000, 3_000_000)).toEqual({ ltvPct: 25, equity: 2_250_000 });
  });

  it("returns nulls rather than a fabricated position", () => {
    expect(positionOf(750_000, null)).toEqual({ ltvPct: null, equity: null });
    expect(positionOf(750_000, 0)).toEqual({ ltvPct: null, equity: null });
  });

  it("reports negative equity honestly when the stack exceeds value", () => {
    const p = positionOf(3_500_000, 3_000_000);
    expect(p.ltvPct).toBe(117);
    expect(p.equity).toBe(-500_000);
  });

  it("scores low leverage high and bottoms out past unfundable", () => {
    expect(equityScore(0)).toBe(100);
    expect(equityScore(85)).toBe(0);
    expect(equityScore(117)).toBe(0); // clamped, never negative
    expect(equityScore(40)).toBeGreaterThan(equityScore(70));
  });
});
