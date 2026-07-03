import type { TriggerItem } from "../types";
import { useApp, useVisibleFeed } from "../store";
import { ago, classNames, money, pct } from "../lib/format";
import { ConfidenceChip, Countdown, EmptyState, ScoreGauge, TileHeader, UrgencyPill } from "./primitives";
import { IconAlert, IconBookmark, IconCash, IconClock, IconHammer, IconMail, IconPhone, IconX } from "./icons";

/* ------------------------- shared row actions ------------------------- */

function RowActions({ item }: { item: TriggerItem }) {
  const toggleWatch = useApp((s) => s.toggleWatch);
  const dismissTrigger = useApp((s) => s.dismissTrigger);
  const markContacted = useApp((s) => s.markContacted);
  const logLeadActivity = useApp((s) => s.logLeadActivity);
  const watched = useApp((s) => Boolean(s.pipeline[item.entity.id]));

  // outbound touches update trigger status + the lead's activity trail
  const logTouch = (kind: "call" | "email", detail: string) => {
    markContacted(item.id);
    logLeadActivity(item.entity.id, kind, detail);
  };

  return (
    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-100">
      {item.contact?.phone && (
        <a
          href={`tel:${item.contact.phone}`}
          onClick={(e) => {
            e.stopPropagation();
            logTouch("call", `Called ${item.contact!.phone}`);
          }}
          title={`Call ${item.contact.phone}`}
          className="rounded-lg p-1.5 text-tx3 hover:bg-raised hover:text-ok"
        >
          <IconPhone className="h-3.5 w-3.5" />
        </a>
      )}
      {item.contact?.email && (
        <a
          href={`mailto:${item.contact.email}`}
          onClick={(e) => {
            e.stopPropagation();
            logTouch("email", `Emailed ${item.contact!.email}`);
          }}
          title={`Email ${item.contact.email}`}
          className="rounded-lg p-1.5 text-tx3 hover:bg-raised hover:text-accent"
        >
          <IconMail className="h-3.5 w-3.5" />
        </a>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          toggleWatch(item.entity.id, item.entity.name);
        }}
        title={watched ? "Remove from pipeline" : "Save lead to pipeline"}
        className={classNames(
          "rounded-lg p-1.5 hover:bg-raised",
          watched ? "text-violet" : "text-tx3 hover:text-violet"
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
        className="rounded-lg p-1.5 text-tx3 hover:bg-raised hover:text-danger"
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
        <span className="truncate text-[13px] font-medium text-tx1">{item.entity.name}</span>
        {item.status === "new" && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="New" />
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-2xs text-tx3">
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
    <section className="card flex flex-col overflow-hidden">
      <TileHeader
        icon={<IconClock className="h-4 w-4" />}
        title="Upcoming Maturity Sniffer"
        hint="notes originated 8–10 months ago"
        action={
          <span className="rounded-full bg-raised px-2 py-0.5 text-2xs tabular-nums text-tx2">
            {items.length} in window
          </span>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse">
          <thead>
            <tr className="border-y border-line text-2xs text-tx3">
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
                className="group cursor-pointer border-b border-line transition-colors last:border-0 hover:bg-raised/60"
              >
                <td className="px-4 py-2.5 sm:px-5">
                  <EntityCell item={item} />
                </td>
                <td className="px-3 py-2.5">
                  <div className="max-w-[180px] truncate text-xs text-tx2">
                    {item.property?.address}
                  </div>
                  <div className="text-2xs text-tx3">
                    {item.property?.city}, {item.property?.state}
                  </div>
                </td>
                <td className="num px-3 py-2.5 text-[13px] font-medium text-tx1">
                  {money(Number(item.payload.principal))}
                </td>
                <td className="num px-3 py-2.5 text-xs text-tx2">
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
    <section className="card overflow-hidden">
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
            className="group border-t border-line px-4 py-3 text-left transition-colors hover:bg-raised/60 sm:px-5"
          >
            <div className="flex items-center justify-between gap-3">
              <EntityCell item={item} />
              <UrgencyPill urgency={item.urgency} />
            </div>
            <div className="mt-2 flex items-baseline gap-4">
              <div>
                <div className="font-display text-lg font-bold tabular-nums tracking-tight text-tx1">
                  {money(Number(item.payload.cashDeployed))}
                </div>
                <div className="text-2xs text-tx3">cash deployed</div>
              </div>
              <div>
                <div className="font-display text-lg font-bold tabular-nums tracking-tight text-tx1">
                  {item.payload.buys}
                </div>
                <div className="text-2xs text-tx3">all-cash buys</div>
              </div>
              <div>
                <div className="font-display text-lg font-bold tabular-nums tracking-tight text-tx1">
                  {item.payload.windowDays}d
                </div>
                <div className="text-2xs text-tx3">window</div>
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
    <section className="card overflow-hidden">
      <TileHeader
        icon={<IconHammer className="h-4 w-4" />}
        title="Permit Intelligence"
        hint="ground-up & structural, LLC-matched + skip-traced"
      />
      <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2">
        {rows.map((item) => (
          <button
            key={item.id}
            onClick={() => openResume(item.entity.id, item)}
            className="group bg-surface px-4 py-3.5 text-left transition-colors hover:bg-raised/60 sm:px-5"
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className={classNames(
                  "rounded-md border px-1.5 py-0.5 text-2xs font-medium",
                  item.payload.permitType === "ground_up"
                    ? "border-violet/30 bg-violet/10 text-violet"
                    : "border-accent/30 bg-accent/10 text-accent"
                )}
              >
                {item.payload.permitType === "ground_up" ? "Ground-up" : "Structural"}
              </span>
              <span className="text-2xs tabular-nums text-tx3">{ago(item.detectedAt)}</span>
            </div>
            <div className="mt-2 font-display text-xl font-bold tabular-nums tracking-tight text-tx1">
              {money(Number(item.payload.valuation))}
            </div>
            <div className="mt-0.5 truncate text-xs text-tx2">
              {item.property?.address} · {item.property?.city}, {item.property?.state}
            </div>
            <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-line pt-2.5">
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-tx1">{item.entity.name}</div>
                <div className="flex items-center gap-2 text-2xs text-tx3">
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
    <section className="card overflow-hidden">
      <TileHeader
        icon={<IconAlert className="h-4 w-4" />}
        title="Lien Monitoring"
        hint="rescue-capital signals"
        action={
          rows.some((r) => r.urgency === "critical") ? (
            <span className="flex items-center gap-1.5 text-2xs font-medium text-danger">
              <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-danger" />
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
              "group relative border-t border-line px-4 py-3 text-left transition-colors hover:bg-raised/60 sm:px-5",
              item.urgency === "critical" && "bg-danger/[0.03]"
            )}
          >
            <span
              className={classNames(
                "absolute inset-y-2 left-0 w-0.5 rounded-full",
                item.urgency === "critical"
                  ? "bg-danger"
                  : item.urgency === "hot"
                    ? "bg-warn"
                    : "bg-accent/60"
              )}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="font-display text-[15px] font-bold tabular-nums tracking-tight text-tx1">
                {money(Number(item.payload.amount))}
              </span>
              <span className="text-2xs tabular-nums text-tx3">{ago(item.detectedAt)}</span>
            </div>
            <div className="mt-0.5 truncate text-xs text-tx2">
              {item.payload.claimant} · mechanics lien
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <div className="min-w-0 truncate text-2xs text-tx3">
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
