import { useEffect, useState } from "react";
import type { BorrowerResume as BorrowerResumeType } from "../types";
import { STAGES, useApp } from "../store";
import { ago, classNames, money, moneyFull, pct, shortDate } from "../lib/format";
import {
  IconBookmark,
  IconBuilding,
  IconExternal,
  IconMail,
  IconPhone,
  IconPlus,
  IconX,
} from "./icons";
import { UrgencyPill } from "./primitives";
import { DatePicker, TextField } from "./ui";
import { IconChevronRight, IconPulse } from "./icons";
import { fetchAiBrief } from "../lib/api";
import { Sparkles } from "lucide-react";

/* --------------------------- AI brief --------------------------- */
/* One click: kimi-k2.6 (via AI Gateway) synthesizes every signal, the
   36-month history and cost of capital into an outreach brief. */

function AiBrief({ entityId }: { entityId: string }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [brief, setBrief] = useState("");

  useEffect(() => {
    setState("idle");
    setBrief("");
  }, [entityId]);

  const generate = async () => {
    setState("loading");
    const res = await fetchAiBrief(entityId);
    if ("brief" in res) {
      setBrief(res.brief);
      setState("done");
    } else {
      setBrief(
        res.error === "ai_not_configured" || res.error === "offline"
          ? "AI briefs activate once the Worker is deployed with the Workers AI binding."
          : "Brief generation failed — try again in a moment."
      );
      setState("error");
    }
  };

  return (
    <section className="mt-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-2xs font-medium text-tx3">AI Outreach Brief</h3>
        <button
          onClick={() => void generate()}
          disabled={state === "loading"}
          className="flex items-center gap-1.5 rounded-lg border border-violet/30 bg-violet/10 px-2.5 py-1 text-2xs font-medium text-violet transition-colors hover:bg-violet/20 disabled:opacity-50"
        >
          <Sparkles strokeWidth={1.75} className="h-3 w-3" />
          {state === "loading" ? "Analyzing…" : state === "done" ? "Regenerate" : "Generate"}
        </button>
      </div>
      {state !== "idle" && (
        <p
          className={classNames(
            "mt-2 whitespace-pre-wrap rounded-xl border px-3.5 py-3 text-xs leading-relaxed",
            state === "error"
              ? "border-line bg-raised/60 text-tx3"
              : "border-violet/20 bg-violet/[0.05] text-tx2"
          )}
        >
          {state === "loading" ? "Reading signals, history and cost of capital…" : brief}
        </p>
      )}
    </section>
  );
}

/* ------------------------- CRM panel ------------------------- */

function CrmPanel({ entityId, entityName }: { entityId: string; entityName: string }) {
  const lead = useApp((s) => s.pipeline[entityId]);
  const toggleWatch = useApp((s) => s.toggleWatch);
  const setLeadStage = useApp((s) => s.setLeadStage);
  const setLeadNote = useApp((s) => s.setLeadNote);
  const setLeadFollowUp = useApp((s) => s.setLeadFollowUp);
  const setLeadValue = useApp((s) => s.setLeadValue);
  const [draftNote, setDraftNote] = useState(lead?.note ?? "");
  const [draftValue, setDraftValue] = useState(lead?.dealValue != null ? String(lead.dealValue) : "");

  useEffect(() => setDraftNote(lead?.note ?? ""), [lead?.note, entityId]);
  useEffect(
    () => setDraftValue(lead?.dealValue != null ? String(lead.dealValue) : ""),
    [lead?.dealValue, entityId]
  );

  if (!lead) {
    return (
      <section className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-dashed border-line px-3.5 py-3">
        <p className="text-xs text-tx3">
          Not in your pipeline yet — save to track outreach, notes and follow-ups.
        </p>
        <button
          onClick={() => toggleWatch(entityId, entityName)}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20"
        >
          <IconPlus className="h-3.5 w-3.5" /> Save lead
        </button>
      </section>
    );
  }

  return (
    <section className="mt-5 rounded-xl border border-line bg-raised/60 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-2xs font-medium text-tx3">Pipeline</h3>
        <span className="text-2xs text-tx3">saved {ago(lead.addedAt)}</span>
      </div>

      {/* Stage selector */}
      <div className="mt-2.5 flex flex-wrap gap-1">
        {STAGES.map((s) => (
          <button
            key={s.id}
            onClick={() => setLeadStage(entityId, s.id)}
            className={classNames(
              "rounded-lg border px-2.5 py-1 text-2xs font-medium transition-colors",
              lead.stage === s.id
                ? "border-accent/40 bg-accent/15 text-accent"
                : "border-line bg-surface text-tx2 hover:text-tx1"
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Follow-up + deal size + note */}
      <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-[170px_140px_1fr]">
        <div className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-tx3">Next follow-up</span>
          <DatePicker
            value={lead.followUp}
            onChange={(date) => setLeadFollowUp(entityId, date)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-tx3">Deal size</span>
          <TextField
            value={draftValue}
            onChange={setDraftValue}
            onBlur={() => {
              const n = Math.round(Number(draftValue.replace(/[$,\s]/g, "")));
              setLeadValue(entityId, Number.isFinite(n) && n > 0 ? n : null);
            }}
            placeholder="850000"
            className="tabular-nums"
          />
        </div>
        <label className="col-span-2 flex flex-col gap-1 sm:col-span-1">
          <span className="text-2xs font-medium text-tx3">Notes</span>
          <textarea
            rows={2}
            value={draftNote}
            onChange={(e) => setDraftNote(e.target.value)}
            onBlur={() => setLeadNote(entityId, draftNote)}
            placeholder="Terms discussed, docs requested, objections…"
            className="resize-none rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-tx1 placeholder:text-tx3 focus:border-accent/40 focus:outline-none"
          />
        </label>
      </div>

      {/* Activity trail */}
      {lead.activities.length > 0 && (
        <ol className="mt-3 flex flex-col gap-1 border-t border-line pt-2.5">
          {lead.activities.slice(0, 4).map((a, i) => (
            <li key={i} className="flex items-baseline gap-2 text-2xs">
              <span className="w-14 shrink-0 tabular-nums text-tx3">{ago(a.ts)}</span>
              <span className="text-tx2">{a.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/* --------------------- borrower network --------------------- */
/* The same principal usually operates several LLCs. Surfacing the whole
   book is how a lender learns the customer and wins repeat business
   across every entity they control. */

function NetworkSection({ network }: { network: BorrowerResumeType["network"] }) {
  const openResume = useApp((s) => s.openResume);
  if (!network || network.entities.length === 0) return null;

  const combinedFlips = network.entities.reduce((s, e) => s + e.flips36mo, 0);
  const combinedVolume = network.entities.reduce((s, e) => s + e.volume36mo, 0);

  return (
    <section className="mt-5">
      <h3 className="mb-2 text-2xs font-medium text-tx3">Borrower Network</h3>
      <div className="rounded-xl border border-violet/20 bg-violet/[0.05] p-3.5">
        <div className="flex items-start gap-2">
          <IconPulse className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet" />
          <p className="text-xs text-tx2">
            <strong className="font-semibold text-tx1">{network.principalName}</strong> also operates{" "}
            {network.entities.length === 1 ? "another entity" : `${network.entities.length} other entities`} —{" "}
            <span className="tabular-nums">
              +{combinedFlips} flips · {money(combinedVolume)} additional volume
            </span>{" "}
            across the relationship. Win one deal, underwrite the whole book.
          </p>
        </div>
        <div className="mt-2.5 flex flex-col gap-1.5">
          {network.entities.map((e) => (
            <button
              key={e.id}
              onClick={() => void openResume(e.id)}
              className="group flex w-full items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2 text-left transition-colors hover:border-violet/40"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-tx1">{e.name}</span>
                <span className="block text-2xs text-tx3">
                  {e.role ?? "Principal"} · {e.flips36mo} flips · {money(e.volume36mo)} volume
                </span>
              </span>
              <span className="rounded bg-raised px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-tx2">
                {e.velocityScore}
              </span>
              <IconChevronRight className="h-3.5 w-3.5 text-tx3 transition-transform group-hover:translate-x-0.5" />
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/* --------------------- rate intelligence --------------------- */
/* What has this borrower historically paid for money? The lender's
   pricing edge: quote under their demonstrated cost of capital. */

function RateIntel({ loans }: { loans: BorrowerResumeType["loans"] }) {
  const rated = loans.filter((l) => l.ratePct != null);
  if (rated.length === 0) return null;

  const sorted = [...rated].sort((a, b) => b.originatedAt.localeCompare(a.originatedAt));
  const last = sorted[0];
  const avg = rated.reduce((s, l) => s + (l.ratePct ?? 0), 0) / rated.length;
  const high = Math.max(...rated.map((l) => l.ratePct ?? 0));
  const activeDebt = loans
    .filter((l) => l.status === "active")
    .reduce((s, l) => s + l.principal, 0);

  return (
    <section className="mt-5">
      <h3 className="mb-2 text-2xs font-medium text-tx3">
        Cost of Capital
      </h3>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat
          label="Last rate paid"
          value={`${last.ratePct!.toFixed(2)}%`}
          sub={`${last.lenderName} · ${shortDate(last.originatedAt)}`}
        />
        <Stat label="Avg rate" value={`${avg.toFixed(2)}%`} sub={`across ${rated.length} notes`} />
        <Stat label="Highest paid" value={`${high.toFixed(2)}%`} sub="rate ceiling" />
        <Stat
          label="Active debt"
          value={activeDebt > 0 ? money(activeDebt) : "—"}
          sub="open principal"
        />
      </div>
      <p className="mt-2 flex items-start gap-1.5 rounded-xl border border-accent/20 bg-accent/[0.06] px-3.5 py-2.5 text-xs text-tx2">
        <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
        <span>
          Pricing edge: they last borrowed at{" "}
          <strong className="font-semibold tabular-nums text-tx1">{last.ratePct!.toFixed(2)}%</strong> — any
          quote below that undercuts their demonstrated cost of capital
          {avg > (last.ratePct ?? 0) &&
            ` (and they've paid up to ${high.toFixed(2)}% before)`}
          .
        </span>
      </p>
    </section>
  );
}

interface TimelineRow {
  key: string;
  date: string;
  kind: "purchase" | "sale" | "loan";
  detail: string;
  amount: number;
  ratePct: number | null;
  isCash: boolean;
}

/** Merge deeds and loan originations into one descending timeline (36mo). */
function buildTimeline(resume: BorrowerResumeType): TimelineRow[] {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 36);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const deeds: TimelineRow[] = resume.transactions.map((t) => ({
    key: `tx-${t.id}`,
    date: t.recordedAt,
    kind: t.side,
    detail: `${t.address}, ${t.city}`,
    amount: t.price,
    ratePct: null,
    isCash: t.isCash,
  }));

  const notes: TimelineRow[] = resume.loans
    .filter((l) => l.originatedAt >= cutoffIso)
    .map((l) => ({
      key: `loan-${l.id}`,
      date: l.originatedAt,
      kind: "loan" as const,
      detail: `${l.lenderName} — ${l.address}`,
      amount: l.principal,
      ratePct: l.ratePct,
      isCash: false,
    }));

  return [...deeds, ...notes].sort((a, b) => b.date.localeCompare(a.date));
}

function VelocityRing({ score }: { score: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const tone = score >= 85 ? "text-ok" : score >= 70 ? "text-accent" : "text-warn";
  return (
    <div className="relative h-16 w-16 shrink-0">
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" className="stroke-line" strokeWidth="4" />
        <circle
          cx="32" cy="32" r={r} fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - score / 100)} className={tone}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="font-display text-xl font-bold tabular-nums text-tx1">{score}</span>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-line bg-raised/60 px-3.5 py-3">
      <div className="text-2xs font-medium text-tx3">{label}</div>
      <div className="mt-1 font-display text-lg font-bold tabular-nums tracking-tight text-tx1">{value}</div>
      {sub && <div className="mt-0.5 text-2xs text-tx3">{sub}</div>}
    </div>
  );
}

export function BorrowerResumeModal() {
  const resume = useApp((s) => s.resume);
  const open = useApp((s) => s.resumeOpen);
  const close = useApp((s) => s.closeResume);
  const toggleWatch = useApp((s) => s.toggleWatch);
  const pipeline = useApp((s) => s.pipeline);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  if (!open || !resume) return null;
  const e = resume.entity;
  const watched = Boolean(pipeline[e.id]);
  const primary = resume.contacts[0];

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-6">
      <div className="absolute inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm" onClick={close} />

      <div className="card relative flex max-h-[92vh] w-full max-w-3xl animate-scale-in flex-col overflow-hidden rounded-t-3xl !bg-surface shadow-pop sm:rounded-3xl">
        {/* Header */}
        <div className="flex items-start gap-4 border-b border-line px-5 py-4 sm:px-7 sm:py-5">
          <VelocityRing score={e.velocityScore} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-lg font-bold tracking-tight text-tx1">{e.name}</h2>
              <span className="rounded-md border border-line bg-raised/60 px-1.5 py-0.5 text-2xs capitalize text-tx2">
                {e.kind === "llc" ? "LLC" : e.kind}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-tx2">
              {e.principalName && <span>{e.principalName}</span>}
              {e.state && <span>· {e.state}</span>}
              {e.formationDate && <span>· est. {new Date(e.formationDate).getFullYear()}</span>}
              {e.registeredAgent && (
                <span className="hidden sm:inline">· RA: {e.registeredAgent}</span>
              )}
            </div>
            {primary && (
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                {primary.phone && (
                  <a
                    href={`tel:${primary.phone}`}
                    className="flex items-center gap-1.5 rounded-lg border border-ok/25 bg-ok/10 px-2.5 py-1 text-xs font-medium text-ok transition-colors hover:bg-ok/20"
                  >
                    <IconPhone className="h-3 w-3" /> {primary.phone}
                  </a>
                )}
                {primary.email && (
                  <a
                    href={`mailto:${primary.email}`}
                    className="flex items-center gap-1.5 rounded-lg border border-accent/25 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/20"
                  >
                    <IconMail className="h-3 w-3" /> {primary.email}
                  </a>
                )}
                {primary.linkedin && (
                  <a
                    href={`https://${primary.linkedin}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 rounded-lg border border-line bg-raised/60 px-2.5 py-1 text-xs text-tx2 transition-colors hover:bg-line"
                  >
                    <IconExternal className="h-3 w-3" /> LinkedIn
                  </a>
                )}
                <span className="text-2xs text-tx3">
                  skip-traced · {Math.round(primary.confidence * 100)}% match
                  {primary.verifiedAt && ` · verified ${ago(primary.verifiedAt)}`}
                </span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => toggleWatch(e.id, e.name)}
              title={watched ? "Remove from pipeline" : "Save lead to pipeline"}
              className={classNames(
                "rounded-xl p-2 transition-colors hover:bg-raised",
                watched ? "text-violet" : "text-tx2"
              )}
            >
              <IconBookmark className="h-[18px] w-[18px]" />
            </button>
            <button
              onClick={close}
              className="rounded-xl p-2 text-tx2 transition-colors hover:bg-raised"
              aria-label="Close"
            >
              <IconX className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 sm:px-7 sm:py-5">
          {/* 36-month performance */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Stat label="Flips · 36mo" value={String(e.flips36mo)} sub="completed exits" />
            <Stat label="Avg Margin" value={pct(e.avgMarginPct)} sub="gross, per exit" />
            <Stat
              label="Avg Hold"
              value={e.avgHoldDays ? `${Math.round(e.avgHoldDays)}d` : "—"}
              sub="purchase → resale"
            />
            <Stat label="Volume · 36mo" value={money(e.volume36mo)} sub="bought + sold" />
          </div>

          <CrmPanel entityId={e.id} entityName={e.name} />

          <AiBrief entityId={e.id} />

          <NetworkSection network={resume.network} />

          {/* Active signals */}
          {resume.activeSignals.length > 0 && (
            <section className="mt-5">
              <h3 className="mb-2 text-2xs font-medium text-tx3">
                Active Signals
              </h3>
              <div className="flex flex-col gap-1.5">
                {resume.activeSignals.map((s, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-3 rounded-xl border border-line bg-raised/60 px-3.5 py-2.5"
                  >
                    <span className="min-w-0 truncate text-xs text-tx1">{s.headline}</span>
                    <UrgencyPill urgency={s.score >= 90 ? "critical" : s.score >= 78 ? "hot" : "warm"} />
                  </div>
                ))}
              </div>
            </section>
          )}

          <RateIntel loans={resume.loans} />

          {/* Transaction + financing timeline */}
          <section className="mt-5">
            <h3 className="mb-2 text-2xs font-medium text-tx3">
              Transaction &amp; Financing History · 36 months
            </h3>
            {(() => {
              const rows = buildTimeline(resume);
              if (rows.length === 0) {
                return (
                  <p className="rounded-xl border border-line bg-raised/60 px-3.5 py-3 text-xs text-tx3">
                    Full county history loads once the record pipeline links this entity's deeds.
                  </p>
                );
              }
              return (
                <div className="overflow-x-auto rounded-xl border border-line">
                  <table className="w-full min-w-[540px]">
                    <thead>
                      <tr className="border-b border-line bg-raised/60 text-2xs text-tx3">
                        <th className="px-3.5 py-2 text-left font-medium">Date</th>
                        <th className="px-3 py-2 text-left font-medium">Event</th>
                        <th className="px-3 py-2 text-left font-medium">Detail</th>
                        <th className="px-3 py-2 text-right font-medium">Rate</th>
                        <th className="px-3.5 py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.key} className="border-b border-line last:border-0">
                          <td className="whitespace-nowrap px-3.5 py-2 text-xs tabular-nums text-tx2">
                            {shortDate(r.date)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            <span
                              className={classNames(
                                "rounded-md px-1.5 py-0.5 text-2xs font-medium capitalize",
                                r.kind === "purchase" && "bg-violet/10 text-violet",
                                r.kind === "sale" && "bg-ok/10 text-ok",
                                r.kind === "loan" && "bg-warn/10 text-warn"
                              )}
                            >
                              {r.kind === "purchase" ? "Buy" : r.kind === "sale" ? "Sell" : "Loan"}
                            </span>
                            {r.isCash && (
                              <span className="ml-1.5 text-2xs text-warn" title="All-cash">
                                cash
                              </span>
                            )}
                          </td>
                          <td className="max-w-[240px] truncate px-3 py-2 text-xs text-tx2">
                            {r.detail}
                          </td>
                          <td className="num px-3 py-2 font-mono text-xs text-tx1">
                            {r.ratePct != null ? `${r.ratePct.toFixed(2)}%` : "—"}
                          </td>
                          <td className="num px-3.5 py-2 text-xs font-medium text-tx1">
                            {moneyFull(r.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </section>

          {/* Loan history */}
          {resume.loans.length > 0 && (
            <section className="mt-5">
              <h3 className="mb-2 text-2xs font-medium text-tx3">
                Debt Stack
              </h3>
              <div className="flex flex-col gap-1.5">
                {resume.loans.map((l) => (
                  <div
                    key={l.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-line bg-raised/60 px-3.5 py-2.5"
                  >
                    <IconBuilding className="h-3.5 w-3.5 shrink-0 text-tx3" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-tx1">
                        {l.lenderName}
                        <span className="ml-2 text-2xs font-normal text-tx3">{l.address}</span>
                      </div>
                      <div className="text-2xs tabular-nums text-tx3">
                        {shortDate(l.originatedAt)}
                        {l.maturityDate && ` → ${shortDate(l.maturityDate)}`}
                        {l.ratePct != null && ` · ${l.ratePct}%`}
                      </div>
                    </div>
                    <span className="text-sm font-semibold tabular-nums text-tx1">
                      {money(l.principal)}
                    </span>
                    <span
                      className={classNames(
                        "rounded-md px-1.5 py-0.5 text-2xs font-medium capitalize",
                        l.status === "active"
                          ? "bg-warn/10 text-warn"
                          : "bg-raised text-tx2"
                      )}
                    >
                      {l.status.replace("_", " ")}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
