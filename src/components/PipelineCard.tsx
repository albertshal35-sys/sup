import { useApp } from "../store";
import { classNames } from "../lib/format";
import { IconPulse } from "./icons";
import { TileHeader } from "./primitives";

const LABELS: Record<string, string> = {
  county_deeds: "County deeds",
  county_loans: "County loans",
  permits: "Permit portals",
  liens: "Lien filings",
  lis_pendens: "Lis pendens",
  violations: "Violations",
  tax_liens: "Tax liens",
  auctions: "Auctions",
  satisfactions: "Satisfactions",
  ucc_filings: "UCC filings",
  corp_registry: "Corp registry",
  skip_trace: "Contact enrichment",
  scoring: "Trigger scoring",
  custom_signals: "Your signals",
  resolution: "Entity resolution",
};

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function PipelineCard() {
  const runs = useApp((s) => s.ingestion);
  const setView = useApp((s) => s.setView);

  return (
    <section className="card overflow-hidden">
      <TileHeader
        icon={<IconPulse className="h-4 w-4" />}
        title="Data Pipeline"
        hint="sweeps daily 11:00 & 23:00 UTC"
      />
      {runs.length === 0 ? (
        <div className="px-4 pb-4 sm:px-5">
          <p className="text-xs leading-relaxed text-tx3">
            No pulls have run yet. Enable your data sources and the pipeline
            reports real per-source results here after every scheduled run.
          </p>
          <button
            onClick={() => setView("settings")}
            className="mt-2.5 rounded-lg border border-line bg-raised/60 px-2.5 py-1.5 text-2xs font-medium text-tx2 transition-colors hover:text-tx1"
          >
            Configure sources
          </button>
        </div>
      ) : (
        <div className="flex flex-col px-4 pb-3.5 sm:px-5">
          {runs.map((r) => (
            <div
              key={r.connector}
              className="flex items-center gap-3 border-t border-line py-2 first:border-0"
            >
              <span
                className={classNames(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  r.status === "ok"
                    ? "bg-ok"
                    : r.status === "partial"
                      ? "bg-warn"
                      : r.status === "running"
                        ? "animate-pulse-dot bg-accent"
                        : "bg-danger"
                )}
              />
              <span className="min-w-0 flex-1 truncate text-xs text-tx2">
                {LABELS[r.connector] ?? r.connector}
              </span>
              {r.finishedAt && (
                <span className="hidden text-2xs tabular-nums text-tx3 sm:inline">
                  {ago(r.finishedAt)}
                </span>
              )}
              <span className="text-2xs tabular-nums text-tx3">
                {r.rowsIngested.toLocaleString()} rows
              </span>
              <span
                className={classNames(
                  "w-12 shrink-0 text-right text-2xs font-medium capitalize",
                  r.status === "ok"
                    ? "text-ok/80"
                    : r.status === "partial"
                      ? "text-warn"
                      : "text-danger"
                )}
              >
                {r.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
