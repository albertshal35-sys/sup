/** Compact currency: $2.68M, $618K, $86.2K */
export function money(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    const v = n / 1_000_000;
    return `$${v >= 10 ? v.toFixed(1) : v.toFixed(2)}M`;
  }
  if (abs >= 1_000) {
    const v = n / 1_000;
    return `$${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return `$${n}`;
}

/** Full currency with thousands separators: $618,000 */
export function moneyFull(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

export function pct(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(1)}%`;
}

/** Relative time: "2d ago", "5h ago", "just now" */
export function ago(iso: string): string {
  const ms = Date.now() - new Date(iso.includes("T") ? iso : iso + "T00:00:00").getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 45) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function shortDate(iso: string): string {
  return new Date(iso.includes("T") ? iso : iso + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** ISO date offset from today by n days (negative = past). Used by demo data. */
export function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
