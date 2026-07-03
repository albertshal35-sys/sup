import { useApp } from "../store";
import { money } from "../lib/format";
import { Sparkline } from "./Sparkline";

interface KpiDef {
  id: string;
  label: string;
  value: (k: NonNullable<ReturnType<typeof selectKpis>>) => string;
  sub: (k: NonNullable<ReturnType<typeof selectKpis>>) => string;
  spark: (k: NonNullable<ReturnType<typeof selectKpis>>) => number[];
  colorClass: string;
}

const selectKpis = (s: ReturnType<typeof useApp.getState>) => s.kpis;

const KPIS: KpiDef[] = [
  {
    id: "leads",
    label: "New Leads",
    value: (k) => String(k.newLeads),
    sub: () => "last 24h across all feeds",
    spark: (k) => k.sparks.newLeads,
    colorClass: "text-accent",
  },
  {
    id: "expiring",
    label: "Expiring Loans",
    value: (k) => String(k.expiringLoans.count),
    sub: (k) => `${money(k.expiringLoans.principal)} principal in window`,
    spark: (k) => k.sparks.expiringLoans,
    colorClass: "text-warn",
  },
  {
    id: "cashpoor",
    label: "Cash-Poor Buyers",
    value: (k) => String(k.cashPoorEntities),
    sub: () => "≥2 cash buys · 60 days",
    spark: (k) => k.sparks.cashPoor,
    colorClass: "text-violet",
  },
  {
    id: "liens",
    label: "Active Liens",
    value: (k) => String(k.activeLiens.count),
    sub: (k) => `${money(k.activeLiens.amount)} claimed`,
    spark: (k) => k.sparks.liens,
    colorClass: "text-danger",
  },
  {
    id: "flippers",
    label: "High-Velocity Flippers",
    value: (k) => String(k.highVelocityFlippers),
    sub: () => "velocity score ≥ 85",
    spark: (k) => k.sparks.flippers,
    colorClass: "text-ok",
  },
];

export function KpiStrip() {
  const kpis = useApp((s) => s.kpis);

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 xl:grid-cols-5">
      {KPIS.map((def, i) => (
        <div
          key={def.id}
          className="card animate-fade-up px-4 py-3.5 last:col-span-2 sm:last:col-span-1"
          style={{ animationDelay: `${i * 40}ms` }}
        >
          {kpis ? (
            <>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-2xs font-medium text-tx3">
                    {def.label}
                  </div>
                  <div className="mt-1 font-display text-2xl font-bold tabular-nums tracking-tight text-tx1">
                    {def.value(kpis)}
                  </div>
                </div>
                <div className={"hidden shrink-0 pt-1 sm:block " + def.colorClass}>
                  <Sparkline data={def.spark(kpis)} id={def.id} />
                </div>
              </div>
              <div className="mt-1 truncate text-2xs text-tx3">{def.sub(kpis)}</div>
            </>
          ) : (
            <div className="h-[68px] animate-pulse rounded-lg bg-raised/60" />
          )}
        </div>
      ))}
    </div>
  );
}
