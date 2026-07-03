import { useMemo } from "react";
import { useApp } from "../store";
import type { TriggerItem } from "../types";
import { CashPoorFeed, LienFeed, MaturityFeed, PermitFeed } from "./Feeds";
import { pct } from "../lib/format";
import { IconBookmark, IconChevronRight } from "./icons";

export function MaturityView() {
  return <MaturityFeed full />;
}
export function CashPoorView() {
  return <CashPoorFeed full />;
}
export function PermitView() {
  return <PermitFeed full />;
}
export function LienView() {
  return <LienFeed full />;
}

/* ----------------------------- watchlist ----------------------------- */

export function WatchlistView() {
  const watchlist = useApp((s) => s.watchlist);
  const feeds = useApp((s) => s.feeds);
  const openResume = useApp((s) => s.openResume);
  const toggleWatch = useApp((s) => s.toggleWatch);

  // Unique watched entities, with their strongest live signal
  const entities = useMemo(() => {
    const map = new Map<string, TriggerItem>();
    Object.values(feeds)
      .flat()
      .forEach((t) => {
        if (!watchlist.includes(t.entity.id)) return;
        const prev = map.get(t.entity.id);
        if (!prev || t.score > prev.score) map.set(t.entity.id, t);
      });
    return [...map.values()].sort((a, b) => b.score - a.score);
  }, [feeds, watchlist]);

  if (entities.length === 0) {
    return (
      <div className="card flex flex-col items-center justify-center gap-2 py-20 text-center">
        <IconBookmark className="h-6 w-6 text-tx3" />
        <p className="text-sm text-tx2">Nothing watched yet.</p>
        <p className="max-w-xs text-xs text-tx3">
          Bookmark a borrower from any feed and they'll surface here with their strongest live
          signal.
        </p>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      {entities.map((item) => (
        <button
          key={item.entity.id}
          onClick={() => openResume(item.entity.id, item)}
          className="group flex w-full items-center gap-4 border-t border-line px-4 py-3.5 text-left transition-colors first:border-0 hover:bg-raised/60 sm:px-5"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-tx1">{item.entity.name}</div>
            <div className="mt-0.5 truncate text-2xs text-tx3">
              {item.entity.flips36mo} flips · {pct(item.entity.avgMarginPct)} margin — {item.headline}
            </div>
          </div>
          <span className="text-sm font-semibold tabular-nums text-tx1">{item.score}</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleWatch(item.entity.id);
            }}
            className="rounded-lg p-1.5 text-violet hover:bg-raised"
            title="Remove from watchlist"
          >
            <IconBookmark className="h-3.5 w-3.5" />
          </button>
          <IconChevronRight className="h-4 w-4 text-tx3 transition-transform group-hover:translate-x-0.5" />
        </button>
      ))}
    </div>
  );
}

/* ------------------------------ settings ------------------------------ */

const MARKETS = ["Maricopa, AZ", "Travis, TX", "Miami-Dade, FL", "Hillsborough, FL"];

export function SettingsView() {
  return (
    <div className="grid max-w-3xl grid-cols-1 gap-3 md:grid-cols-2">
      <section className="card p-5">
        <h3 className="text-[13px] font-semibold text-tx1">Coverage Markets</h3>
        <p className="mt-1 text-2xs text-tx3">
          Counties pulled by the daily pipeline. Additional markets are provisioned per contract.
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {MARKETS.map((m) => (
            <span
              key={m}
              className="rounded-lg border border-accent/20 bg-accent/[0.07] px-2.5 py-1 text-xs text-accent"
            >
              {m}
            </span>
          ))}
          <span className="rounded-lg border border-dashed border-line px-2.5 py-1 text-xs text-tx3">
            + Request market
          </span>
        </div>
      </section>

      <section className="card p-5">
        <h3 className="text-[13px] font-semibold text-tx1">Trigger Thresholds</h3>
        <p className="mt-1 text-2xs text-tx3">Defaults tuned for bridge/fix-and-flip books.</p>
        <dl className="mt-3 space-y-2 text-xs">
          {[
            ["Maturity window", "months 8–10 of term"],
            ["Cash-poor floor", "≥ 2 all-cash buys / 60 days"],
            ["Permit valuation floor", "$250,000"],
            ["Lien freshness", "filed ≤ 21 days ago"],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-4">
              <dt className="text-tx2">{k}</dt>
              <dd className="font-medium tabular-nums text-tx1">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="card p-5 md:col-span-2">
        <h3 className="text-[13px] font-semibold text-tx1">Pipeline Schedule</h3>
        <p className="mt-1 text-2xs text-tx3">
          County records, permits, liens and skip-trace refresh once per day on weekdays at 11:00
          UTC (pre-market US). Every connector run is retried up to 3× and audited — see the Data
          Pipeline tile on the Command view. Vendor webhooks can push urgent records (e.g. new
          liens) between runs.
        </p>
      </section>
    </div>
  );
}
