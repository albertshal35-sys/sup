import { useEffect } from "react";
import { useApp } from "../store";
import { ago, classNames, money, moneyFull, pct, shortDate } from "../lib/format";
import { IconBookmark, IconBuilding, IconExternal, IconMail, IconPhone, IconX } from "./icons";
import { UrgencyPill } from "./primitives";

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
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-base font-bold tabular-nums text-tx1">{score}</span>
        <span className="text-[9px] uppercase tracking-wider text-tx3">velocity</span>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-line bg-raised/60 px-3.5 py-3">
      <div className="text-2xs font-medium uppercase tracking-wider text-tx3">{label}</div>
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
  const watchlist = useApp((s) => s.watchlist);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  if (!open || !resume) return null;
  const e = resume.entity;
  const watched = watchlist.includes(e.id);
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
              <span className="rounded-md border border-line bg-raised/60 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-tx2">
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
              onClick={() => toggleWatch(e.id)}
              title={watched ? "Remove from watchlist" : "Add to watchlist"}
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

          {/* Active signals */}
          {resume.activeSignals.length > 0 && (
            <section className="mt-5">
              <h3 className="mb-2 text-2xs font-medium uppercase tracking-widest text-tx3">
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

          {/* Transaction timeline */}
          <section className="mt-5">
            <h3 className="mb-2 text-2xs font-medium uppercase tracking-widest text-tx3">
              Transaction History · 36 months
            </h3>
            {resume.transactions.length === 0 ? (
              <p className="rounded-xl border border-line bg-raised/60 px-3.5 py-3 text-xs text-tx3">
                Full county history loads once the record pipeline links this entity's deeds.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full min-w-[480px]">
                  <thead>
                    <tr className="border-b border-line bg-raised/60 text-2xs uppercase tracking-wider text-tx3">
                      <th className="px-3.5 py-2 text-left font-medium">Date</th>
                      <th className="px-3 py-2 text-left font-medium">Side</th>
                      <th className="px-3 py-2 text-left font-medium">Property</th>
                      <th className="px-3.5 py-2 text-right font-medium">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resume.transactions.map((t) => (
                      <tr key={t.id} className="border-b border-line last:border-0">
                        <td className="whitespace-nowrap px-3.5 py-2 text-xs tabular-nums text-tx2">
                          {shortDate(t.recordedAt)}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={classNames(
                              "rounded-md px-1.5 py-0.5 text-2xs font-medium uppercase",
                              t.side === "purchase"
                                ? "bg-violet/10 text-violet"
                                : "bg-ok/10 text-ok"
                            )}
                          >
                            {t.side === "purchase" ? "Buy" : "Sell"}
                          </span>
                          {t.isCash && (
                            <span className="ml-1.5 text-2xs text-warn" title="All-cash">
                              cash
                            </span>
                          )}
                        </td>
                        <td className="max-w-[220px] truncate px-3 py-2 text-xs text-tx2">
                          {t.address}, {t.city}
                        </td>
                        <td className="num px-3.5 py-2 text-xs font-medium text-tx1">
                          {moneyFull(t.price)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Loan history */}
          {resume.loans.length > 0 && (
            <section className="mt-5">
              <h3 className="mb-2 text-2xs font-medium uppercase tracking-widest text-tx3">
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
                        "rounded-md px-1.5 py-0.5 text-2xs font-medium uppercase",
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
