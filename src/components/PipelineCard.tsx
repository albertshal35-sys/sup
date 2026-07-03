import { useApp } from "../store";
import { classNames } from "../lib/format";
import { IconPulse } from "./icons";
import { TileHeader } from "./primitives";

const LABELS: Record<string, string> = {
  county_deeds: "County deeds",
  county_loans: "County loans",
  permits: "Permit portals",
  liens: "Lien filings",
  skip_trace: "Skip trace",
  scoring: "Trigger scoring",
};

export function PipelineCard() {
  const runs = useApp((s) => s.ingestion);

  return (
    <section className="card overflow-hidden">
      <TileHeader
        icon={<IconPulse className="h-4 w-4" />}
        title="Data Pipeline"
        hint="daily · weekdays 11:00 UTC"
      />
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
            <span className="flex-1 truncate text-xs text-tx2">
              {LABELS[r.connector] ?? r.connector}
            </span>
            <span className="text-2xs tabular-nums text-tx3">
              {r.rowsIngested.toLocaleString()} rows
            </span>
            <span
              className={classNames(
                "w-12 text-right text-2xs font-medium uppercase",
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
    </section>
  );
}
