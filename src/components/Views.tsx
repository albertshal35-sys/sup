import { CashPoorFeed, LienFeed, MaturityFeed, PermitFeed } from "./Feeds";

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
