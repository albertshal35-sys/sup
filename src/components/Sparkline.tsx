import { useState } from "react";

/**
 * Area sparkline for KPI cards — pure SVG, no chart lib.
 * Inherits color from CSS (`currentColor`) so it adapts to theme.
 * Pointer-tracked tooltip shows the value for the hovered period
 * (works with mouse and touch via pointer events).
 */

const W = 96;
const H = 28;

export function Sparkline({
  data,
  id,
  periodLabel = "w",
}: {
  data: number[];
  id: string;
  /** unit suffix for "N<unit> ago" tooltip labels, e.g. "w" for weeks */
  periodLabel?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = W / (data.length - 1);

  const points = data.map((v, i) => ({
    x: i * step,
    y: H - 3 - ((v - min) / range) * (H - 7),
  }));
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;

  const active = hover != null ? points[hover] : points[points.length - 1];
  const agoN = hover != null ? data.length - 1 - hover : 0;

  return (
    <div
      className="relative touch-none"
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * W;
        setHover(Math.max(0, Math.min(data.length - 1, Math.round(x / step))));
      }}
      onPointerLeave={() => setHover(null)}
    >
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="overflow-visible" aria-hidden>
        <defs>
          <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#spark-${id})`} />
        <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        {hover != null && (
          <line
            x1={active.x}
            y1={2}
            x2={active.x}
            y2={H}
            stroke="currentColor"
            strokeOpacity="0.35"
            strokeWidth="1"
            strokeDasharray="2 2"
          />
        )}
        <circle cx={active.x} cy={active.y} r="2" fill="currentColor" />
      </svg>

      {hover != null && (
        <div
          className="pointer-events-none absolute -top-7 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-surface px-1.5 py-0.5 text-2xs font-medium tabular-nums text-tx1 shadow-pop"
          style={{ left: `${(active.x / W) * 100}%` }}
        >
          {data[hover]}
          <span className="ml-1 text-tx3">{agoN === 0 ? "now" : `${agoN}${periodLabel} ago`}</span>
        </div>
      )}
    </div>
  );
}
