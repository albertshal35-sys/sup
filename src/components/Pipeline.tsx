/**
 * Pipeline board — CRM view over saved leads.
 * Five-stage kanban (Watching → Outreach → Term Sheet → Funded / Lost).
 * Cards drag between columns; a kebab menu covers touch devices and
 * quick actions. Deal size is editable inline and overrides the
 * signal-derived estimate.
 */

import { useMemo, useState } from "react";
import { STAGES, useApp } from "../store";
import type { Lead, PipelineStage, TriggerItem } from "../types";
import { classNames, money, shortDate } from "../lib/format";
import { Menu } from "./ui";
import { IconBookmark, IconCalendar, IconKanban, IconX } from "./icons";

const STAGE_TONE: Record<PipelineStage, string> = {
  watching: "bg-accent",
  outreach: "bg-warn",
  term_sheet: "bg-violet",
  funded: "bg-ok",
  lost: "bg-tx3",
};

/** Deal size: manual override first, then the strongest live signal. */
function dealSize(lead: Lead, item: TriggerItem | undefined): number | null {
  if (lead.dealValue != null) return lead.dealValue;
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

/** Parse "$1.2m", "850k", "425,000" into whole dollars. */
function parseMoney(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/[$,\s]/g, "");
  if (!s) return null;
  const mult = s.endsWith("m") ? 1_000_000 : s.endsWith("k") ? 1_000 : 1;
  const n = parseFloat(s.replace(/[mk]$/, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * mult) : null;
}

function EditableValue({ lead, signal }: { lead: Lead; signal?: TriggerItem }) {
  const setLeadValue = useApp((s) => s.setLeadValue);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const size = dealSize(lead, signal);

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setLeadValue(lead.entityId, parseMoney(draft));
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setEditing(false);
        }}
        placeholder="$850k"
        className="w-20 rounded-md border border-accent/40 bg-surface px-1.5 py-0.5 text-sm font-bold tabular-nums text-tx1 focus:outline-none"
      />
    );
  }

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        setDraft(size != null ? String(size) : "");
        setEditing(true);
      }}
      title="Edit deal size"
      className="rounded-md px-1 py-0.5 font-display text-sm font-bold tabular-nums text-tx1 transition-colors hover:bg-raised"
    >
      {size != null ? money(size) : <span className="text-tx3">＋ value</span>}
    </button>
  );
}

function LeadCard({
  lead,
  signal,
  onDragStart,
  onDragEnd,
  dragging,
}: {
  lead: Lead;
  signal?: TriggerItem;
  onDragStart: () => void;
  onDragEnd: () => void;
  dragging: boolean;
}) {
  const openResume = useApp((s) => s.openResume);
  const setLeadStage = useApp((s) => s.setLeadStage);
  const toggleWatch = useApp((s) => s.toggleWatch);
  const name = signal?.entity.name ?? lead.entityName;

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/lienwolf-lead", lead.entityId);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={() => void openResume(lead.entityId, signal)}
      onKeyDown={(e) => e.key === "Enter" && void openResume(lead.entityId, signal)}
      className={classNames(
        "card group cursor-grab rounded-xl p-3 transition-all hover:border-tx3/40 active:cursor-grabbing",
        dragging && "opacity-40"
      )}
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
        <Menu
          items={[
            { label: "Open resume", onSelect: () => void openResume(lead.entityId, signal) },
            ...STAGES.filter((s) => s.id !== lead.stage).map((s) => ({
              label: `Move to ${s.label}`,
              onSelect: () => setLeadStage(lead.entityId, s.id),
            })),
            {
              label: "Remove from pipeline",
              danger: true,
              divider: true,
              icon: <IconX className="h-3.5 w-3.5" />,
              onSelect: () => toggleWatch(lead.entityId),
            },
          ]}
        />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <EditableValue lead={lead} signal={signal} />
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
    </div>
  );
}

export function PipelineView() {
  const pipeline = useApp((s) => s.pipeline);
  const feeds = useApp((s) => s.feeds);
  const setLeadStage = useApp((s) => s.setLeadStage);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<PipelineStage | null>(null);

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
      .sort(
        (a, b) =>
          (signals.get(b.entityId)?.score ?? 0) - (signals.get(a.entityId)?.score ?? 0)
      );

  const active = leads.filter((l) => l.stage !== "funded" && l.stage !== "lost");
  const activeValue = active.reduce(
    (sum, l) => sum + (dealSize(l, signals.get(l.entityId)) ?? 0),
    0
  );
  const fundedValue = leads
    .filter((l) => l.stage === "funded")
    .reduce((sum, l) => sum + (dealSize(l, signals.get(l.entityId)) ?? 0), 0);
  const dueToday = active.filter(
    (l) => l.followUp && l.followUp <= new Date().toISOString().slice(0, 10)
  ).length;

  const drop = (stage: PipelineStage, e: React.DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/lienwolf-lead") || draggingId;
    if (id) setLeadStage(id, stage);
    setDraggingId(null);
    setOverStage(null);
  };

  if (leads.length === 0) {
    return (
      <div className="card flex flex-col items-center justify-center gap-2 py-20 text-center">
        <IconKanban className="h-6 w-6 text-tx3" />
        <p className="text-sm text-tx2">Your pipeline is empty.</p>
        <p className="max-w-xs text-xs text-tx3">
          Save a borrower from any feed <IconBookmark className="inline h-3 w-3" /> and manage them
          here through outreach, term sheet and funding.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Summary strip */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3 md:max-w-2xl">
        {[
          { label: "Active leads", value: String(active.length) },
          {
            label: "Est. active value",
            value: activeValue > 0 ? money(activeValue) : "—",
            hint: "click a card's value to edit",
          },
          { label: "Funded volume", value: fundedValue > 0 ? money(fundedValue) : "—" },
          {
            label: "Follow-ups due",
            value: String(dueToday),
            tone: dueToday > 0 ? "text-danger" : undefined,
          },
        ].map((s) => (
          <div key={s.label} className="card px-4 py-3" title={s.hint}>
            <div className="truncate text-2xs font-medium text-tx3">{s.label}</div>
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
            const isOver = overStage === stage.id && draggingId != null;
            return (
              <div
                key={stage.id}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setOverStage(stage.id);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverStage(null);
                }}
                onDrop={(e) => drop(stage.id, e)}
                className={classNames(
                  "w-[272px] shrink-0 snap-start rounded-2xl border transition-colors xl:w-auto xl:flex-1",
                  isOver ? "border-accent/50 bg-accent/[0.05]" : "border-line bg-raised/40"
                )}
              >
                <div className="flex items-center gap-2 px-3.5 pb-2 pt-3">
                  <span className={classNames("h-1.5 w-1.5 rounded-full", STAGE_TONE[stage.id])} />
                  <span className="text-xs font-semibold text-tx1">{stage.label}</span>
                  <span className="ml-auto rounded-full bg-raised px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-tx2">
                    {items.length}
                  </span>
                </div>
                <div className="flex min-h-[96px] flex-col gap-2 px-2.5 pb-2.5">
                  {items.map((lead) => (
                    <LeadCard
                      key={lead.entityId}
                      lead={lead}
                      signal={signals.get(lead.entityId)}
                      dragging={draggingId === lead.entityId}
                      onDragStart={() => setDraggingId(lead.entityId)}
                      onDragEnd={() => {
                        setDraggingId(null);
                        setOverStage(null);
                      }}
                    />
                  ))}
                  {items.length === 0 && (
                    <div
                      className={classNames(
                        "flex h-16 items-center justify-center rounded-xl border border-dashed text-2xs",
                        isOver ? "border-accent/50 text-accent" : "border-line text-tx3"
                      )}
                    >
                      {isOver ? "Drop to move" : "Empty"}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <p className="text-2xs text-tx3">
        Drag cards between stages, or use a card's ⋯ menu. Click a value to set your own deal size.
      </p>
    </div>
  );
}
