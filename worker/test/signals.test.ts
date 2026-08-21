import { describe, expect, it } from "vitest";
import { anchorFrom, windowStart, MAX_LAG_DAYS } from "../src/watermark";
import { inMarkets, marketKey } from "../src/integrity";

describe("publication-relative windows", () => {
  const TODAY = "2026-08-21";

  it("behaves exactly as before when the source is current", () => {
    const w = anchorFrom(TODAY, TODAY);
    expect(w).toMatchObject({ anchor: TODAY, lagDays: 0, stale: false });
  });

  it("slides the window back with a lagging source", () => {
    // ACRIS publishes monthly in arrears: the newest record is ~5 weeks old.
    const w = anchorFrom("2026-07-17", TODAY);
    expect(w.lagDays).toBe(35);
    expect(w.anchor).toBe("2026-07-17");
    // A 21-day mechanics window now covers 21 days of *published* data
    // instead of a period the source has not reached yet.
    expect(windowStart(w, 21)).toBe("2026-06-26");
  });

  it("is what makes a short window matchable at all", () => {
    const lagging = anchorFrom("2026-07-17", TODAY);
    const lienFiled = "2026-07-10"; // filed a week before the newest record

    // Against the watermark the lien is 7 days old and inside a 21-day window.
    const fromWatermark = windowStart(lagging, 21);
    expect(lienFiled >= fromWatermark && lienFiled <= lagging.anchor).toBe(true);

    // Against today it is 42 days old and invisible — the original bug.
    const fromToday = windowStart(anchorFrom(TODAY, TODAY), 21);
    expect(lienFiled >= fromToday).toBe(false);
  });

  it("never anchors into the future when a source reports ahead of today", () => {
    const w = anchorFrom("2027-01-01", TODAY);
    expect(w.anchor).toBe(TODAY);
    expect(w.lagDays).toBe(0);
  });

  it("stops sliding once a source is stopped rather than lagging", () => {
    const w = anchorFrom("2020-01-01", TODAY);
    expect(w.stale).toBe(true);
    expect(w.lagDays).toBeGreaterThan(MAX_LAG_DAYS);
    // Clamped, so years-old records are never dressed up as fresh leads.
    expect(w.anchor).toBe("2026-02-22");
  });

  it("falls back to today when a source has no rows", () => {
    expect(anchorFrom(null, TODAY)).toMatchObject({ anchor: TODAY, newest: null, stale: false });
    expect(anchorFrom("not-a-date", TODAY).anchor).toBe(TODAY);
  });
});

describe("market coverage gate", () => {
  it("accepts the borough name for the county that records it", () => {
    // The silent killer: ACRIS emits "Kings", operators type "Brooklyn".
    const brooklynDeed = { county: "Kings", state: "NY" };
    expect(inMarkets(brooklynDeed, ["Brooklyn, NY"])).toBe(true);
    expect(inMarkets(brooklynDeed, ["Kings, NY"])).toBe(true);
  });

  it.each([
    ["Manhattan, NY", { county: "New York", state: "NY" }],
    ["Staten Island, NY", { county: "Richmond", state: "NY" }],
    ["Queens, NY", { county: "Queens", state: "NY" }],
    ["Bronx, NY", { county: "Bronx", state: "NY" }],
  ])("matches %s", (market, rec) => {
    expect(inMarkets(rec, [market])).toBe(true);
  });

  it("is case- and whitespace-insensitive, and tolerates 'County'", () => {
    expect(inMarkets({ county: "kings", state: "ny" }, ["  Brooklyn , NY "])).toBe(true);
    expect(inMarkets({ county: "Kings County", state: "NY" }, ["Kings, NY"])).toBe(true);
  });

  it("still rejects a genuinely different market", () => {
    expect(inMarkets({ county: "Kings", state: "NY" }, ["Miami-Dade, FL"])).toBe(false);
    expect(inMarkets({ county: "Kings", state: "CA" }, ["Kings, NY"])).toBe(false); // same county name, wrong state
  });

  it("stays open when no markets are configured", () => {
    expect(inMarkets({ county: "Kings", state: "NY" }, [])).toBe(true);
  });

  it("rejects records with no geography once markets are set", () => {
    expect(inMarkets({}, ["Kings, NY"])).toBe(false);
  });

  it("ignores a malformed market entry rather than matching everything", () => {
    expect(inMarkets({ county: "Kings", state: "NY" }, ["Brooklyn"])).toBe(false);
  });

  it("reduces both spellings to the same key", () => {
    expect(marketKey("Brooklyn", "NY")).toBe(marketKey("Kings", "NY"));
    expect(marketKey("Manhattan", "ny")).toBe("new york, ny");
  });
});
