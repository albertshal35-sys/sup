/**
 * Pipeline board — CRM view over saved leads.
 * Five-stage kanban (Watching → Outreach → Term Sheet → Funded / Lost) with
 * per-lead follow-up chips, deal-size estimates from live signals, and
 * inline stage moves. Columns scroll horizontally with snap on mobile.
 */

import { useMemo } from "react";
import { STAGES, useApp } from "../store";
import type { Lead, PipelineStage, TriggerItem } from "../types";
import { classNames, money, shortDate } from "../lib/format";
import {
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconKanban,
  IconX,
} from "./icons";

const STAGE_TONE: Record<PipelineStage, string> = {
  watching: "bg-accent",
  outreach: "bg-warn",
  term_sheet: "bg-violet",
  funded: "bg-ok",
  lost: "bg-tx3",
};

/** Estimated deal size from the entity's strongest live signal. */
function dealSize(item: TriggerItem | undefined): number | null {
  if (!item) return null;
  const p = item.payload;
  const v = Number(p.principal ?? p.cashDeployed ?? p.valuation ?? p.amount ?? 0);
  return v > 0 ? v : null;
}

function followUpTone(date: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (date < today) return "border-danger/30 bg-danger/10 text-danger";
  if (date === today) return "border-warn/30 bg-warn/10 text-warn";
  return "border-line bg-raised/60 text-tx2";
}

function LeadCard({ lead, signal }: { lead: Lead; signal?: TriggerItem }) {
  const openResume = useApp((s) => s.openResume);
  const setLeadStage = useApp((s) => s.setLeadStage);
  const toggleWatch = useApp((s) => s.toggleWatch);

  const idx = STAGES.findIndex((s) => s.id === lead.stage);
  const size = dealSize(signal);
  const name = signal?.entity.name ?? lead.entityName;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => void openResume(lead.entityId, signal)}
      onKeyDown={(e) => e.key === "Enter" && void openResume(lead.entityId, signal)}
      className="card group cursor-pointer rounded-xl p-3 transition-colors hover:border-tx3/40"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-tx1">{name}</div>
          {signal ? (
            <div className="mt-0.5 line-clamp-2 text-2xs text-tx3">{signal.headline}</div>
          ) : (
            <div className="mt-0.5 text-2xs text-tx3">No live signal</div>
          )}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            toggleWatch(lead.entityId);
          }}
          title="Remove from pipeline"
          className="rounded-md p-1 text-tx3 opacity-0 transition-opacity hover:bg-raised hover:text-danger group-hover:opacity-100 max-md:opacity-100"
        >
          <IconX className="h-3 w-3" />
        </button>
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {size != null && (
            <span className="font-display text-sm font-bold tabular-nums text-tx1">
              {money(size)}
            </span>
          )}
          {signal && (
            <span className="rounded bg-raised px-1 py-0.5 text-2xs font-semibold tabular-nums text-tx2">
              {signal.score}
            </span>
          )}
        </div>
        {lead.followUp && (
          <span
            title={`Follow up ${shortDate(lead.followUp)}`}
            className={classNames(
              "inline-flex items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-2xs font-medium tabular-nums",
              followUpTone(lead.followUp)
            )}
          >
            <IconCalendar className="h-3 w-3 shrink-0" />
            {shortDate(lead.followUp).replace(/, \d{4}$/, "")}
          </span>
        )}
      </div>

      {/* Stage movers */}
      <div className="mt-2.5 flex items-center justify-between border-t border-line pt-2">
        <button
          disabled={idx === 0}
          onClick={(e) => {
            e.stopPropagation();
            setLeadStage(lead.entityId, STAGES[idx - 1].id);
          }}
          title={idx > 0 ? `Move to ${STAGES[idx - 1].label}` : undefined}
          className="rounded-md p-1 text-tx3 transition-colors hover:bg-raised hover:text-tx1 disabled:opacity-30"
        >
          <IconChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="text-2xs text-tx3">{STAGES[idx].label}</span>
        <button
          disabled={idx === STAGES.length - 1}
          onClick={(e) => {
            e.stopPropagation();
            setLeadStage(lead.entityId, STAGES[idx + 1].id);
          }}
          title={idx < STAGES.length - 1 ? `Move to ${STAGES[idx + 1].label}` : undefined}
          className="rounded-md p-1 text-tx3 transition-colors hover:bg-raised hover:text-tx1 disabled:opacity-30"
        >
          <IconChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function PipelineView() {
  const pipeline = useApp((s) => s.pipeline);
  const feeds = useApp((s) => s.feeds);

  // strongest live signal per saved entity
  const signals = useMemo(() => {
    const map = new Map<string, TriggerItem>();
    Object.values(feeds)
      .flat()
      .forEach((t) => {
        if (!pipeline[t.entity.id]) return;
        const prev = map.get(t.entity.id);
        if (!prev || t.score > prev.score) map.set(t.entity.id, t);
      });
    return map;
  }, [feeds, pipeline]);

  const leads = Object.values(pipeline);
  const byStage = (stage: PipelineStage) =>
    leads
      .filter((l) => l.stage === stage)
      .sort((a, b) => (signals.get(b.entityId)?.score ?? 0) - (signals.get(a.entityId)?.score ?? 0));

  const active = leads.filter((l) => l.stage !== "funded" && l.stage !== "lost");
  const activeValue = active.reduce((sum, l) => sum + (dealSize(signals.get(l.entityId)) ?? 0), 0);
  const fundedCount = leads.filter((l) => l.stage === "funded").length;
  const dueToday = active.filter(
    (l) => l.followUp && l.followUp <= new Date().toISOString().slice(0, 10)
  ).length;

  if (leads.length === 0) {
    return (
      <div className="card flex flex-col items-center justify-center gap-2 py-20 text-center">
        <IconKanban className="h-6 w-6 text-tx3" />
        <p className="text-sm text-tx2">Your pipeline is empty.</p>
        <p className="max-w-xs text-xs text-tx3">
          Save a borrower from any feed (bookmark icon) and manage them here through outreach,
          term sheet and funding.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-2.5 sm:gap-3 md:max-w-xl">
        {[
          { label: "Active leads", value: String(active.length) },
          { label: "Est. active value", value: activeValue > 0 ? money(activeValue) : "—" },
          {
            label: "Follow-ups due",
            value: String(dueToday),
            tone: dueToday > 0 ? "text-danger" : undefined,
          },
        ].map((s) => (
          <div key={s.label} className="card px-4 py-3">
            <div className="truncate text-2xs font-medium uppercase tracking-wider text-tx3">
              {s.label}
            </div>
            <div
              className={classNames(
                "mt-0.5 font-display text-xl font-bold tabular-nums tracking-tight",
                s.tone ?? "text-tx1"
              )}
            >
              {s.value}
            </div>
          </div>
        ))}
      </div>

      {/* Board */}
      <div className="snap-x snap-mandatory overflow-x-auto pb-2">
        <div className="flex min-w-max gap-3 xl:min-w-0">
          {STAGES.map((stage) => {
            const items = byStage(stage.id);
            return (
              <div
                key={stage.id}
                className="w-[272px] shrink-0 snap-start rounded-2xl border border-line bg-raised/40 xl:w-auto xl:flex-1"
              >
                <div className="flex items-center gap-2 px-3.5 pb-2 pt-3">
                  <span className={classNames("h-1.5 w-1.5 rounded-full", STAGE_TONE[stage.id])} />
                  <span className="text-xs font-semibold text-tx1">{stage.label}</span>
                  <span className="ml-auto rounded-full bg-raised px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-tx2">
                    {items.length}
                  </span>
                </div>
                <div className="flex min-h-[80px] flex-col gap-2 px-2.5 pb-2.5">
                  {items.map((lead) => (
                    <LeadCard key={lead.entityId} lead={lead} signal={signals.get(lead.entityId)} />
                  ))}
                  {items.length === 0 && (
                    <div className="flex h-16 items-center justify-center rounded-xl border border-dashed border-line text-2xs text-tx3">
                      Empty
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {fundedCount > 0 && (
        <p className="text-2xs text-tx3">
          {fundedCount} funded deal{fundedCount === 1 ? "" : "s"} to date · funded and lost leads
          stay on the board for record-keeping.
        </p>
      )}
    </div>
  );
}
