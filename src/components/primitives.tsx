import type { ReactNode } from "react";
import type { Urgency } from "../types";
import { classNames } from "../lib/format";

/** Urgency pill — critical / hot / warm */
export function UrgencyPill({ urgency }: { urgency: Urgency }) {
  const styles: Record<Urgency, string> = {
    critical: "bg-glow-red/10 text-glow-red border-glow-red/25",
    hot: "bg-glow-amber/10 text-glow-amber border-glow-amber/25",
    warm: "bg-glow-cyan/10 text-glow-cyan border-glow-cyan/25",
  };
  return (
    <span
      className={classNames(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium uppercase tracking-wide",
        styles[urgency]
      )}
    >
      {urgency === "critical" && (
        <span className="h-1 w-1 animate-pulse-dot rounded-full bg-glow-red" />
      )}
      {urgency}
    </span>
  );
}

/** 0–100 intent score with a thin gauge bar */
export function ScoreGauge({ score }: { score: number }) {
  const tone = score >= 90 ? "bg-glow-red" : score >= 78 ? "bg-glow-amber" : "bg-glow-cyan";
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1 w-10 overflow-hidden rounded-full bg-white/[0.08]">
        <div className={classNames("h-full rounded-full", tone)} style={{ width: `${score}%` }} />
      </div>
      <span className="num w-6 text-xs font-semibold text-mist-100">{score}</span>
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
        <span className="text-mist-400">{icon}</span>
        <h2 className="truncate text-[13px] font-semibold tracking-tight text-mist-100">{title}</h2>
        {hint && <span className="hidden truncate text-2xs text-mist-500 md:inline">{hint}</span>}
      </div>
      {action}
    </div>
  );
}

/** Skip-trace confidence chip */
export function ConfidenceChip({ value }: { value: number }) {
  const pctVal = Math.round(value * 100);
  const tone =
    pctVal >= 90 ? "text-glow-green" : pctVal >= 75 ? "text-glow-cyan" : "text-glow-amber";
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
      ? "border-glow-red/30 bg-glow-red/10 text-glow-red"
      : days <= 90
        ? "border-glow-amber/30 bg-glow-amber/10 text-glow-amber"
        : "border-white/10 bg-white/[0.04] text-mist-300";
  return (
    <span
      className={classNames(
        "inline-flex rounded-md border px-1.5 py-0.5 font-mono text-2xs font-semibold tabular-nums",
        tone
      )}
    >
      D-{days}
    </span>
  );
}

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-32 items-center justify-center text-xs text-mist-500">{label}</div>
  );
}
