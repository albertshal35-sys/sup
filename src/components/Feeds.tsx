import type { TriggerItem } from "../types";
import { useApp, useVisibleFeed } from "../store";
import { ago, classNames, money, pct } from "../lib/format";
import { ConfidenceChip, Countdown, EmptyState, ScoreGauge, TileHeader, UrgencyPill } from "./primitives";
import { IconAlert, IconBookmark, IconCash, IconClock, IconHammer, IconMail, IconPhone, IconX } from "./icons";

/* ------------------------- shared row actions ------------------------- */

function RowActions({ item }: { item: TriggerItem }) {
  const toggleWatch = useApp((s) => s.toggleWatch);
  const dismissTrigger = useApp((s) => s.dismissTrigger);
  const watchlist = useApp((s) => s.watchlist);
  const watched = watchlist.includes(item.entity.id);

  return (
    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-100">
      {item.contact?.phone && (
        <a
          href={`tel:${item.contact.phone}`}
          onClick={(e) => e.stopPropagation()}
          title={`Call ${item.contact.phone}`}
          className="rounded-lg p-1.5 text-mist-500 hover:bg-white/[0.07] hover:text-glow-green"
        >
          <IconPhone className="h-3.5 w-3.5" />
        </a>
      )}
      {item.contact?.email && (
        <a
          href={`mailto:${item.contact.email}`}
          onClick={(e) => e.stopPropagation()}
          title={`Email ${item.contact.email}`}
          className="rounded-lg p-1.5 text-mist-500 hover:bg-white/[0.07] hover:text-glow-cyan"
        >
          <IconMail className="h-3.5 w-3.5" />
        </a>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          toggleWatch(item.entity.id);
        }}
        title={watched ? "Remove from watchlist" : "Add to watchlist"}
        className={classNames(
          "rounded-lg p-1.5 hover:bg-white/[0.07]",
          watched ? "text-glow-violet" : "text-mist-500 hover:text-glow-violet"
        )}
      >
        <IconBookmark className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          dismissTrigger(item.id);
        }}
        title="Dismiss"
        className="rounded-lg p-1.5 text-mist-500 hover:bg-white/[0.07] hover:text-glow-red"
      >
        <IconX className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function EntityCell({ item }: { item: TriggerItem }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <span className="truncate text-[13px] font-medium text-mist-100">{item.entity.name}</span>
        {item.status === "new" && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-glow-cyan" title="New" />
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-2xs text-mist-500">
        <span className="truncate">
          {item.entity.flips36mo} flips · {pct(item.entity.avgMarginPct)} margin
        </span>
        {item.contact && <ConfidenceChip value={item.contact.confidence} />}
      </div>
    </div>
  );
}

/* ---------------------- 1 — Upcoming Maturity feed ---------------------- */

export function MaturityFeed({ full = false }: { full?: boolean }) {
  const items = useVisibleFeed("maturity");
  const openResume = useApp((s) => s.openResume);
  const rows = full ? items : items.slice(0, 6);

  return (
    <section className="glass flex flex-col overflow-hidden">
      <TileHeader
        icon={<IconClock className="h-4 w-4" />}
        title="Upcoming Maturity Sniffer"
        hint="notes originated 8–10 months ago"
        action={
          <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-2xs tabular-nums text-mist-400">
            {items.length} in window
          </span>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse">
          <thead>
            <tr className="border-y border-white/[0.05] text-2xs uppercase tracking-wider text-mist-500">
              <th className="px-4 py-2 text-left font-medium sm:px-5">Borrower</th>
              <th className="px-3 py-2 text-left font-medium">Property</th>
              <th className="px-3 py-2 text-right font-medium">Principal</th>
              <th className="px-3 py-2 text-right font-medium">Rate</th>
              <th className="px-3 py-2 text-right font-medium">Maturity</th>
              <th className="px-3 py-2 text-right font-medium">Intent</th>
              <th className="w-32 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <tr
                key={item.id}
                onClick={() => openResume(item.entity.id, item)}
                className="group cursor-pointer border-b border-white/[0.04] transition-colors last:border-0 hover:bg-white/[0.03]"
              >
                <td className="px-4 py-2.5 sm:px-5">
                  <EntityCell item={item} />
                </td>
                <td className="px-3 py-2.5">
                  <div className="max-w-[180px] truncate text-xs text-mist-300">
                    {item.property?.address}
                  </div>
                  <div className="text-2xs text-mist-500">
                    {item.property?.city}, {item.property?.state}
                  </div>
                </td>
                <td className="num px-3 py-2.5 text-[13px] font-medium text-mist-100">
                  {money(Number(item.payload.principal))}
                </td>
                <td className="num px-3 py-2.5 text-xs text-mist-300">
                  {Number(item.payload.rate).toFixed(2)}%
                </td>
                <td className="px-3 py-2.5 text-right">
                  <Countdown days={Number(item.payload.daysToMaturity)} />
                </td>
                <td className="px-3 py-2.5">
                  <ScoreGauge score={item.score} />
                </td>
                <td className="px-3 py-2.5">
                  <RowActions item={item} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <EmptyState label="No notes in the 8–10 month window." />}
      </div>
    </section>
  );
}

/* ------------------------- 2 — Cash-Poor feed ------------------------- */

export function CashPoorFeed({ full = false }: { full?: boolean }) {
  const items = useVisibleFeed("cash_poor");
  const openResume = useApp((s) => s.openResume);
  const rows = full ? items : items.slice(0, 3);

  return (
    <section className="glass overflow-hidden">
      <TileHeader
        icon={<IconCash className="h-4 w-4" />}
        title="Cash-Poor Buyers"
        hint="delayed-financing candidates"
      />
      <div className="flex flex-col">
        {rows.map((item) => (
          <button
            key={item.id}
            onClick={() => openResume(item.entity.id, item)}
            className="group border-t border-white/[0.04] px-4 py-3 text-left transition-colors hover:bg-white/[0.03] sm:px-5"
          >
            <div className="flex items-center justify-between gap-3">
              <EntityCell item={item} />
              <UrgencyPill urgency={item.urgency} />
            </div>
            <div className="mt-2 flex items-baseline gap-4">
              <div>
                <div className="text-lg font-semibold tabular-nums tracking-tight text-mist-100">
                  {money(Number(item.payload.cashDeployed))}
                </div>
                <div className="text-2xs text-mist-500">cash deployed</div>
              </div>
              <div>
                <div className="text-lg font-semibold tabular-nums tracking-tight text-mist-100">
                  {item.payload.buys}
                </div>
                <div className="text-2xs text-mist-500">all-cash buys</div>
              </div>
              <div>
                <div className="text-lg font-semibold tabular-nums tracking-tight text-mist-100">
                  {item.payload.windowDays}d
                </div>
                <div className="text-2xs text-mist-500">window</div>
              </div>
              <div className="ml-auto self-center">
                <RowActions item={item} />
              </div>
            </div>
          </button>
        ))}
        {rows.length === 0 && <EmptyState label="No multi-cash buyers in the last 60 days." />}
      </div>
    </section>
  );
}

/* ------------------- 3 — Permit-to-Social feed ------------------- */

export function PermitFeed({ full = false }: { full?: boolean }) {
  const items = useVisibleFeed("permit");
  const openResume = useApp((s) => s.openResume);
  const rows = full ? items : items.slice(0, 4);

  return (
    <section className="glass overflow-hidden">
      <TileHeader
        icon={<IconHammer className="h-4 w-4" />}
        title="Permit Intelligence"
        hint="ground-up & structural, LLC-matched + skip-traced"
      />
      <div className="grid grid-cols-1 gap-px bg-white/[0.04] sm:grid-cols-2">
        {rows.map((item) => (
          <button
            key={item.id}
            onClick={() => openResume(item.entity.id, item)}
            className="group bg-ink-900/60 px-4 py-3.5 text-left transition-colors hover:bg-white/[0.03] sm:px-5"
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className={classNames(
                  "rounded-md border px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide",
                  item.payload.permitType === "ground_up"
                    ? "border-glow-violet/30 bg-glow-violet/10 text-glow-violet"
                    : "border-glow-cyan/30 bg-glow-cyan/10 text-glow-cyan"
                )}
              >
                {item.payload.permitType === "ground_up" ? "Ground-up" : "Structural"}
              </span>
              <span className="text-2xs tabular-nums text-mist-500">{ago(item.detectedAt)}</span>
            </div>
            <div className="mt-2 text-xl font-semibold tabular-nums tracking-tight text-mist-100">
              {money(Number(item.payload.valuation))}
            </div>
            <div className="mt-0.5 truncate text-xs text-mist-300">
              {item.property?.address} · {item.property?.city}, {item.property?.state}
            </div>
            <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-white/[0.05] pt-2.5">
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-mist-200">{item.entity.name}</div>
                <div className="flex items-center gap-2 text-2xs text-mist-500">
                  <span className="truncate">{item.entity.principalName}</span>
                  {item.contact && <ConfidenceChip value={item.contact.confidence} />}
                </div>
              </div>
              <RowActions item={item} />
            </div>
          </button>
        ))}
      </div>
      {rows.length === 0 && <EmptyState label="No qualifying permits in the last 30 days." />}
    </section>
  );
}

/* -------------------- 4 — Contractor lien alerts -------------------- */

export function LienFeed({ full = false }: { full?: boolean }) {
  const items = useVisibleFeed("lien");
  const openResume = useApp((s) => s.openResume);
  const rows = full ? items : items.slice(0, 4);

  return (
    <section className="glass overflow-hidden">
      <TileHeader
        icon={<IconAlert className="h-4 w-4" />}
        title="Lien Monitoring"
        hint="rescue-capital signals"
        action={
          rows.some((r) => r.urgency === "critical") ? (
            <span className="flex items-center gap-1.5 text-2xs font-medium text-glow-red">
              <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-glow-red" />
              live
            </span>
          ) : undefined
        }
      />
      <div className="flex flex-col">
        {rows.map((item) => (
          <button
            key={item.id}
            onClick={() => openResume(item.entity.id, item)}
            className={classNames(
              "group relative border-t border-white/[0.04] px-4 py-3 text-left transition-colors hover:bg-white/[0.03] sm:px-5",
              item.urgency === "critical" && "bg-glow-red/[0.03]"
            )}
          >
            <span
              className={classNames(
                "absolute inset-y-2 left-0 w-0.5 rounded-full",
                item.urgency === "critical"
                  ? "bg-glow-red"
                  : item.urgency === "hot"
                    ? "bg-glow-amber"
                    : "bg-glow-cyan/60"
              )}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[15px] font-semibold tabular-nums tracking-tight text-mist-100">
                {money(Number(item.payload.amount))}
              </span>
              <span className="text-2xs tabular-nums text-mist-500">{ago(item.detectedAt)}</span>
            </div>
            <div className="mt-0.5 truncate text-xs text-mist-300">
              {item.payload.claimant} · mechanics lien
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <div className="min-w-0 truncate text-2xs text-mist-500">
                {item.entity.name} — {item.property?.address}
              </div>
              <RowActions item={item} />
            </div>
          </button>
        ))}
        {rows.length === 0 && <EmptyState label="No fresh liens. Quiet is good — for them." />}
      </div>
    </section>
  );
}
