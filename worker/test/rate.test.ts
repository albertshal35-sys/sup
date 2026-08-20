import { describe, expect, it } from "vitest";
import { rateFromText, DEFAULT_DOC_URL } from "../src/rate";

describe("reading a note rate out of instrument text", () => {
  it("finds a rate stated per annum", () => {
    const hit = rateFromText("...shall bear interest at the rate of 11.25% per annum from the date hereof...");
    expect(hit?.ratePct).toBe(11.25);
    expect(hit?.confidence).toBe(0.85);
    expect(hit?.evidence).toContain("per annum");
  });

  it.each([
    ["the annual rate of 9%", 9],
    ["interest rate of 7.5 percent", 7.5],
    ["bears interest at 12.875% per annum", 12.875],
    ["initial rate: 6.25%", 6.25],
  ])("parses %s", (text, want) => {
    expect(rateFromText(text)?.ratePct).toBe(want);
  });

  // The important case: a mortgage states several percentages, and a
  // confident wrong one is worse than none — it is what gets quoted against.
  it("ignores the default rate and takes the note rate", () => {
    const doc = `
      The principal sum shall bear interest at the rate of 11.25% per annum.
      Upon an Event of Default the entire balance shall bear interest at 24% per annum.
      A late charge equal to 5% of any overdue installment shall be payable.
    `;
    const hit = rateFromText(doc);
    expect(hit?.ratePct).toBe(11.25);
  });

  it("returns nothing when every percentage is a penalty", () => {
    expect(rateFromText("A late charge of 5% applies. Default rate 24%.")).toBeNull();
  });

  it("marks a bare percentage as lower confidence than a cued one", () => {
    const bare = rateFromText("Schedule A: 8.5%");
    const cued = rateFromText("interest rate of 8.5% per annum");
    expect(bare!.confidence).toBeLessThan(cued!.confidence);
  });

  it("rejects values outside the plausibility band", () => {
    expect(rateFromText("transfer tax of 0.4%")).toBeNull();   // too low for a note
    expect(rateFromText("penalty of 95%")).toBeNull();          // and too high
  });

  it("handles empty and absent input", () => {
    expect(rateFromText("")).toBeNull();
    expect(rateFromText(null)).toBeNull();
    expect(rateFromText("no numbers here at all")).toBeNull();
  });

  it("survives the whitespace mangling of rendered markdown", () => {
    const messy = "interest\n\n   at   the    rate\tof\n9.75\n%\nper\nannum";
    expect(rateFromText(messy)?.ratePct).toBe(9.75);
  });
});

describe("document URL template", () => {
  it("substitutes the document id", () => {
    expect(DEFAULT_DOC_URL.replace("{doc}", "2019000123456"))
      .toBe("https://a836-acris.nyc.gov/DS/DocumentSearch/DocumentDetail?doc_id=2019000123456");
  });
});
