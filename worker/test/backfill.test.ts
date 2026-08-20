import { describe, expect, it } from "vitest";
import { advanceCursor } from "../src/backfill";

const day = (iso: string, n: number) =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

describe("advanceCursor", () => {
  const target = "2023-08-20";

  it("takes the full step when the window was read to the end", () => {
    expect(advanceCursor({ to: "2026-08-20", from: "2026-08-06", target, truncated: false, resumeCursor: null }))
      .toEqual({ next: "2026-08-06", stalled: false, done: false });
  });

  it("resumes at the oldest record reached instead of stepping over the rest", () => {
    // Budget ran out at 2026-08-14; the 6th-to-13th were never read, so the
    // cursor must not jump past them to the window's `from`.
    const { next, stalled } = advanceCursor({
      to: "2026-08-20", from: "2026-08-06", target, truncated: true, resumeCursor: "2026-08-14",
    });
    expect(next).toBe("2026-08-15"); // +1 day: that day was only read in part
    expect(stalled).toBe(false);
    expect(next > "2026-08-06").toBe(true);
  });

  it("flags the one case that loses records: a day bigger than one pull", () => {
    const { next, stalled } = advanceCursor({
      to: "2026-08-20", from: "2026-08-06", target, truncated: true, resumeCursor: "2026-08-20",
    });
    expect(stalled).toBe(true);       // said out loud, not swallowed
    expect(next).toBe("2026-08-19");  // still moves, so the crawl cannot spin
  });

  it("flags truncation with no usable date rather than advancing blindly", () => {
    const { next, stalled } = advanceCursor({
      to: "2026-08-20", from: "2026-08-06", target, truncated: true, resumeCursor: null,
    });
    expect(stalled).toBe(true);
    expect(next).toBe("2026-08-19");
  });

  it("reports done only once the target is reached", () => {
    expect(advanceCursor({ to: "2023-09-01", from: target, target, truncated: false, resumeCursor: null }).done).toBe(true);
    expect(advanceCursor({ to: "2023-09-15", from: "2023-09-01", target, truncated: false, resumeCursor: null }).done).toBe(false);
  });
});

describe("crawl invariants", () => {
  const CHUNK = 14;
  const start = "2026-08-20", target = "2023-08-20";

  /** Drive advanceCursor to the target, modelling a source of given density. */
  const crawl = (docsPerDay: number, budget: number) => {
    const windows: { from: string; to: string; stalled: boolean }[] = [];
    let cursor = start;
    for (let guard = 0; cursor > target && guard < 5000; guard++) {
      const step = day(cursor, -CHUNK);
      const from = step < target ? target : step;
      const days = Math.round((Date.parse(cursor) - Date.parse(from)) / 86400000);
      const truncated = days * docsPerDay > budget;
      const daysRead = Math.max(1, Math.floor(budget / docsPerDay));
      const { next, stalled } = advanceCursor({
        to: cursor, from, target,
        truncated, resumeCursor: truncated ? day(cursor, -daysRead) : null,
      });
      expect(next < cursor).toBe(true); // always makes progress
      windows.push({ from: next, to: cursor, stalled });
      cursor = next;
    }
    return { windows, ended: cursor };
  };

  it.each([
    ["NYC deed volume, budget never binds", 300, 5000],
    ["heavy volume, budget binds every chunk", 900, 5000],
    ["pathological: one day exceeds the budget", 6000, 5000],
  ])("tiles gap-free and terminates — %s", (_name, docsPerDay, budget) => {
    const { windows, ended } = crawl(docsPerDay, budget);
    expect(windows.length).toBeGreaterThan(0);
    expect(ended).toBe(target); // reaches the 36-month target exactly

    // Consecutive windows must abut: no date is ever skipped.
    let prev = start;
    for (const w of windows) {
      expect(w.to).toBe(prev);
      prev = w.from;
    }
    expect(prev).toBe(target);
  });

  it("does not truncate at all at realistic NYC deed volume", () => {
    const { windows } = crawl(300, 5000);
    expect(windows.some((w) => w.stalled)).toBe(false);
    expect(windows.length).toBeLessThan(100); // ~79 chunks for 36 months
  });

  it("still covers the range when every single day overflows, and says so", () => {
    const { windows } = crawl(6000, 5000);
    expect(windows.every((w) => w.stalled)).toBe(true);
  });
});
