import type { ReactNode } from "react";
import type { RecordConfidence, Urgency } from "../types";
import { classNames } from "../lib/format";

/** Urgency pill — critical / hot / warm */
export function UrgencyPill({ urgency }: { urgency: Urgency }) {
  const styles: Record<Urgency, string> = {
    critical: "bg-danger/10 text-danger border-danger/25",
    hot: "bg-warn/10 text-warn border-warn/25",
    warm: "bg-accent/10 text-accent border-accent/25",
  };
  return (
    <span
      className={classNames(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium capitalize",
        styles[urgency]
      )}
    >
      {urgency === "critical" && (
        <span className="h-1 w-1 animate-pulse-dot rounded-full bg-danger" />
      )}
      {urgency}
    </span>
  );
}

/** 0–100 intent score with a thin gauge bar */
export function ScoreGauge({ score }: { score: number }) {
  const tone = score >= 90 ? "bg-danger" : score >= 78 ? "bg-warn" : "bg-accent";
  return (
    <div
      className="flex items-center justify-end gap-2"
      title={`Intent score ${score}/100 — composite of urgency, borrower velocity and deal size`}
    >
      <div className="h-1 w-10 overflow-hidden rounded-full bg-line">
        <div className={classNames("h-full rounded-full", tone)} style={{ width: `${score}%` }} />
      </div>
      <span className="num w-6 text-xs font-semibold text-tx1">{score}</span>
    </div>
  );
}

/** Section card header used across bento tiles */
export function TileHeader({
  icon,
  title,
  hint,
  action,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-2.5 sm:px-5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="text-tx2">{icon}</span>
        <h2 className="truncate text-[13px] font-semibold tracking-tight text-tx1">{title}</h2>
        {hint && <span className="hidden truncate text-2xs text-tx3 md:inline">{hint}</span>}
      </div>
      {action}
    </div>
  );
}

/** Skip-trace confidence chip */
export function ConfidenceChip({ value }: { value: number }) {
  const pctVal = Math.round(value * 100);
  const tone =
    pctVal >= 90 ? "text-ok" : pctVal >= 75 ? "text-accent" : "text-warn";
  return (
    <span className={classNames("text-2xs font-medium tabular-nums", tone)} title="Skip-trace match confidence">
      {pctVal}% match
    </span>
  );
}

/** Days-to-maturity countdown pill (D-52 style) */
export function Countdown({ days }: { days: number }) {
  const tone =
    days <= 60
      ? "border-danger/30 bg-danger/10 text-danger"
      : days <= 90
        ? "border-warn/30 bg-warn/10 text-warn"
        : "border-line bg-raised/60 text-tx2";
  const maturesOn = new Date(Date.now() + days * 86_400_000).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  return (
    <span
      title={`Note matures ~${maturesOn} (${days} days)`}
      className={classNames(
        "inline-flex whitespace-nowrap rounded-md border px-1.5 py-0.5 font-mono text-2xs font-semibold tabular-nums",
        tone
      )}
    >
      {`D-${days}`}
    </span>
  );
}

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-32 items-center justify-center text-xs text-tx3">{label}</div>
  );
}

/**
 * Record trust badge. Corroborated = two independent sources agree;
 * direct = structured API; extracted = AI-parsed from a scraped page.
 * Links to the source document when one is on file.
 */
export function ProvenanceBadge({
  confidence,
  sourceUrl,
  sourceId,
}: {
  confidence: RecordConfidence;
  sourceUrl?: string | null;
  sourceId?: string | null;
}) {
  const tone: Record<RecordConfidence, string> = {
    corroborated: "border-ok/30 bg-ok/10 text-ok",
    direct: "border-line bg-raised/60 text-tx2",
    extracted: "border-warn/30 bg-warn/10 text-warn",
  };
  const label: Record<RecordConfidence, string> = {
    corroborated: "2×",
    direct: "src",
    extracted: "ai",
  };
  const title: Record<RecordConfidence, string> = {
    corroborated: "Corroborated — two independent sources agree on this record",
    direct: "Direct — from a structured data source",
    extracted: "Extracted — AI-parsed from a scraped page (grounding-verified)",
  };
  const chip = (
    <span
      title={`${title[confidence]}${sourceId ? ` · ${sourceId}` : ""}${sourceUrl ? " · click to open source" : ""}`}
      className={classNames(
        "inline-flex items-center rounded border px-1 py-px font-mono text-[10px] font-semibold leading-none",
        tone[confidence]
      )}
    >
      {label[confidence]}
    </span>
  );
  return sourceUrl ? (
    <a href={sourceUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
      {chip}
    </a>
  ) : (
    chip
  );
}
