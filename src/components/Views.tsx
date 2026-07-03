/**
 * Individual signal pages — deeper than the Command Center tiles.
 * Each page adds: signal-specific analytics strip, filter bar (market,
 * urgency, sort — all custom components), and the full unabridged feed.
 */

import { useMemo, useState } from "react";
import { useVisibleFeed } from "../store";
import type { TriggerItem, TriggerKind, Urgency } from "../types";
import { CashPoorFeed, LienFeed, MaturityFeed, PermitFeed } from "./Feeds";
import { classNames, money } from "../lib/format";
import { Select, TextField, type SelectOption } from "./ui";

/* ----------------------------- shared page kit ----------------------------- */

type SortKey = "score" | "value" | "recent";

interface Filters {
  market: string;
  urgency: "all" | Urgency;
  sort: SortKey;
  query: string;
}

const URGENCY_OPTIONS: SelectOption<Filters["urgency"]>[] = [
  { value: "all", label: "All urgencies" },
  { value: "critical", label: "Critical" },
  { value: "hot", label: "Hot" },
  { value: "warm", label: "Warm" },
];

const SORT_OPTIONS: SelectOption<SortKey>[] = [
  { value: "score", label: "Sort: Intent score" },
  { value: "value", label: "Sort: Deal size" },
  { value: "recent", label: "Sort: Most recent" },
];

function itemValue(t: TriggerItem): number {
  const p = t.payload;
  return Number(p.principal ?? p.cashDeployed ?? p.valuation ?? p.amount ?? 0);
}

function useFilteredFeed(kind: TriggerKind) {
  const items = useVisibleFeed(kind);
  const [filters, setFilters] = useState<Filters>({
    market: "all",
    urgency: "all",
    sort: "score",
    query: "",
  });

  const markets = useMemo(() => {
    const set = new Set<string>();
    items.forEach((t) => t.property && set.add(`${t.property.county}, ${t.property.state}`));
    return [
      { value: "all", label: "All markets" },
      ...[...set].sort().map((m) => ({ value: m, label: m })),
    ];
  }, [items]);

  const filtered = useMemo(() => {
    const q = filters.query.trim().toLowerCase();
    const out = items.filter((t) => {
      if (
        filters.market !== "all" &&
        `${t.property?.county}, ${t.property?.state}` !== filters.market
      )
        return false;
      if (filters.urgency !== "all" && t.urgency !== filters.urgency) return false;
      if (q) {
        const hay = [t.entity.name, t.entity.principalName ?? "", t.property?.address ?? "", t.headline]
          .join(" ")
          .toLowerCase();
        if (!q.split(/\s+/).every((part) => hay.includes(part))) return false;
      }
      return true;
    });
    out.sort((a, b) =>
      filters.sort === "value"
        ? itemValue(b) - itemValue(a)
        : filters.sort === "recent"
          ? b.detectedAt.localeCompare(a.detectedAt)
          : b.score - a.score
    );
    return out;
  }, [items, filters]);

  return { items, filtered, filters, setFilters, markets };
}

function StatCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="card px-4 py-3">
      <div className="truncate text-2xs font-medium text-tx3">{label}</div>
      <div
        className={classNames(
          "mt-0.5 font-display text-xl font-bold tabular-nums tracking-tight",
          tone ?? "text-tx1"
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-2xs text-tx3">{sub}</div>}
    </div>
  );
}

function FilterBar({
  filters,
  setFilters,
  markets,
  count,
}: {
  filters: Filters;
  setFilters: (f: Filters) => void;
  markets: SelectOption[];
  count: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <TextField
        value={filters.query}
        onChange={(query) => setFilters({ ...filters, query })}
        placeholder="Filter by name, principal, address…"
        className="max-w-xs"
      />
      <Select
        size="sm"
        className="w-44"
        value={filters.market}
        options={markets}
        onChange={(market) => setFilters({ ...filters, market })}
      />
      <Select
        size="sm"
        className="w-36"
        value={filters.urgency}
        options={URGENCY_OPTIONS}
        onChange={(urgency) => setFilters({ ...filters, urgency })}
      />
      <Select
        size="sm"
        className="w-44"
        value={filters.sort}
        options={SORT_OPTIONS}
        onChange={(sort) => setFilters({ ...filters, sort })}
      />
      <span className="ml-auto text-2xs tabular-nums text-tx3">
        {count} result{count === 1 ? "" : "s"}
      </span>
    </div>
  );
}

/* ------------------------------- Maturities ------------------------------- */

export function MaturityView() {
  const { filtered, filters, setFilters, markets } = useFilteredFeed("maturity");

  const totalPrincipal = filtered.reduce((s, t) => s + Number(t.payload.principal ?? 0), 0);
  const avgRate =
    filtered.length > 0
      ? filtered.reduce((s, t) => s + Number(t.payload.rate ?? 0), 0) / filtered.length
      : 0;
  const critical = filtered.filter((t) => t.urgency === "critical").length;
  const nearest = filtered.length
    ? Math.min(...filtered.map((t) => Number(t.payload.daysToMaturity ?? 999)))
    : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        <StatCard label="Refi principal in window" value={money(totalPrincipal)} sub="sum of maturing notes" />
        <StatCard label="Avg rate being paid" value={`${avgRate.toFixed(2)}%`} sub="your pricing target sits below this" />
        <StatCard label="Critical (≤60 days)" value={String(critical)} tone={critical > 0 ? "text-danger" : undefined} sub="call these first" />
        <StatCard label="Nearest maturity" value={nearest != null ? `D-${nearest}` : "—"} sub="days until first balloon" />
      </div>
      <FilterBar filters={filters} setFilters={setFilters} markets={markets} count={filtered.length} />
      <MaturityFeed full items={filtered} />
    </div>
  );
}

/* -------------------------------- Cash-Poor -------------------------------- */

export function CashPoorView() {
  const { filtered, filters, setFilters, markets } = useFilteredFeed("cash_poor");

  const totalCash = filtered.reduce((s, t) => s + Number(t.payload.cashDeployed ?? 0), 0);
  const totalBuys = filtered.reduce((s, t) => s + Number(t.payload.buys ?? 0), 0);
  const avgWindow =
    filtered.length > 0
      ? Math.round(filtered.reduce((s, t) => s + Number(t.payload.windowDays ?? 0), 0) / filtered.length)
      : 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        <StatCard label="Cash deployed · 60d" value={money(totalCash)} sub="capital they want back out" />
        <StatCard label="All-cash purchases" value={String(totalBuys)} sub="delayed-financing eligible deeds" />
        <StatCard label="Buyers in window" value={String(filtered.length)} sub="entities with ≥2 cash buys" />
        <StatCard label="Avg buying window" value={`${avgWindow}d`} sub="velocity of deployment" />
      </div>
      <FilterBar filters={filters} setFilters={setFilters} markets={markets} count={filtered.length} />
      <CashPoorFeed full items={filtered} />
    </div>
  );
}

/* --------------------------------- Permits --------------------------------- */

export function PermitView() {
  const { filtered, filters, setFilters, markets } = useFilteredFeed("permit");

  const totalValuation = filtered.reduce((s, t) => s + Number(t.payload.valuation ?? 0), 0);
  const groundUp = filtered.filter((t) => t.payload.permitType === "ground_up").length;
  const avgValuation = filtered.length ? totalValuation / filtered.length : 0;
  const matched = filtered.filter((t) => t.contact != null).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        <StatCard label="Declared job value · 30d" value={money(totalValuation)} sub="construction capital demand" />
        <StatCard label="Ground-up starts" value={String(groundUp)} sub="vs structural remodels" />
        <StatCard label="Avg permit value" value={money(avgValuation)} sub="per filing" />
        <StatCard label="Skip-traced" value={`${matched}/${filtered.length}`} sub="principals with direct contact" />
      </div>
      <FilterBar filters={filters} setFilters={setFilters} markets={markets} count={filtered.length} />
      <PermitFeed full items={filtered} />
    </div>
  );
}

/* ---------------------------------- Liens ---------------------------------- */

export function LienView() {
  const { filtered, filters, setFilters, markets } = useFilteredFeed("lien");

  const totalClaimed = filtered.reduce((s, t) => s + Number(t.payload.amount ?? 0), 0);
  const critical = filtered.filter((t) => t.urgency === "critical").length;
  const avgAmount = filtered.length ? totalClaimed / filtered.length : 0;
  const freshest = filtered.length
    ? Math.min(...filtered.map((t) => Number(t.payload.filedDaysAgo ?? 99)))
    : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        <StatCard label="Claims outstanding" value={money(totalClaimed)} sub="liens, judgments & penalties" />
        <StatCard label="Critical situations" value={String(critical)} tone={critical > 0 ? "text-danger" : undefined} sub="pre-foreclosure & frozen draws" />
        <StatCard label="Avg claim" value={money(avgAmount)} sub="per event" />
        <StatCard label="Freshest filing" value={freshest != null ? `${freshest}d ago` : "—"} sub="newest distress signal" />
      </div>
      <FilterBar filters={filters} setFilters={setFilters} markets={markets} count={filtered.length} />
      <LienFeed full items={filtered} />
    </div>
  );
}

export { SettingsView } from "./AdminSettings";
