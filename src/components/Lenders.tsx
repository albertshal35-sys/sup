/**
 * Competitor intelligence — a league table of the private/hard-money lenders
 * active in your markets, built from the same recorded mortgages and UCC
 * filings that power the feeds. The play: a competitor's maturing book is
 * your outreach list.
 */

import { Fragment, useEffect, useState } from "react";
import { useApp } from "../store";
import type { LenderLoan, LenderRow } from "../types";
import { getLenderLoans, getLenders } from "../lib/api";
import { downloadCsv } from "../lib/csv";
import { classNames, money, shortDate } from "../lib/format";
import { EmptyState, ProvenanceBadge } from "./primitives";
import { Download, Landmark } from "lucide-react";

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

function LenderLoans({ name }: { name: string }) {
  const dataMode = useApp((s) => s.dataMode);
  const openResume = useApp((s) => s.openResume);
  const [loans, setLoans] = useState<LenderLoan[] | null>(null);

  useEffect(() => {
    setLoans(null);
    void getLenderLoans(name, dataMode).then(setLoans);
  }, [name, dataMode]);

  if (!loans) return <div className="px-4 py-3 text-2xs text-tx3">Loading book…</div>;
  if (loans.length === 0) return <div className="px-4 py-3 text-2xs text-tx3">No recorded loans.</div>;

  return (
    <div className="border-t border-line bg-raised/30">
      {loans.map((l) => {
        const d = l.status === "active" ? daysUntil(l.maturity) : null;
        return (
          <button
            key={l.id}
            disabled={!l.entityId}
            onClick={() => l.entityId && void openResume(l.entityId)}
            className="flex w-full items-center gap-3 border-t border-line/60 px-4 py-2 text-left first:border-0 hover:bg-raised/60 disabled:cursor-default sm:px-5"
          >
            <div className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-tx1">
                {l.entityName ?? "Unmatched borrower"}
                {l.instrument === "ucc" && (
                  <span className="ml-1.5 rounded border border-line bg-raised px-1 py-px font-mono text-[10px] text-tx3">UCC</span>
                )}
              </span>
              <span className="block truncate text-2xs text-tx3">
                {l.address ? `${l.address} · ${l.city}` : "—"} · originated {shortDate(l.originatedAt)}
              </span>
            </div>
            <ProvenanceBadge confidence={l.confidence} sourceUrl={l.sourceUrl} />
            <span className="num w-20 text-xs font-semibold text-tx1">{l.principal ? money(l.principal) : "—"}</span>
            <span className="num hidden w-14 text-2xs text-tx2 sm:block">
              {l.ratePct != null ? `${l.ratePct.toFixed(2)}%` : "—"}
            </span>
            <span
              className={classNames(
                "w-16 text-right font-mono text-2xs font-semibold tabular-nums",
                l.status !== "active" ? "text-tx3" : d != null && d <= 60 ? "text-danger" : d != null && d <= 90 ? "text-warn" : "text-tx2"
              )}
            >
              {l.status === "active" && d != null ? `D-${d}` : l.status.replace("_", " ")}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function LendersView() {
  const dataMode = useApp((s) => s.dataMode);
  const [lenders, setLenders] = useState<LenderRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    void getLenders(dataMode).then(setLenders);
  }, [dataMode]);

  const exportCsv = () => {
    if (!lenders) return;
    downloadCsv(
      "lienwolf-lenders",
      ["Lender", "Loans", "UCC filings", "Volume", "Avg rate %", "Maturing 90d", "Maturing volume", "Payoffs 90d"],
      lenders.map((l) => [l.lenderName, l.loans, l.uccFilings, l.volume, l.avgRate?.toFixed(2) ?? "", l.maturing90d, l.maturingVolume, l.payoffs90d])
    );
  };

  const totals = lenders?.reduce(
    (acc, l) => ({ volume: acc.volume + l.volume, maturing: acc.maturing + l.maturingVolume }),
    { volume: 0, maturing: 0 }
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-2xs text-tx3">
          Built from recorded mortgages, satisfactions and UCC filings in your markets.{" "}
          <span className="text-tx2">A competitor's maturing book is your outreach list.</span>
        </p>
        <button
          onClick={exportCsv}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-2xs font-medium text-tx2 transition-colors hover:text-tx1"
        >
          <Download strokeWidth={1.75} className="h-3.5 w-3.5" />
          CSV
        </button>
      </div>

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-2.5 sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <Landmark strokeWidth={1.75} className="h-4 w-4 text-tx2" />
            <h2 className="text-[13px] font-semibold tracking-tight text-tx1">Active private lenders</h2>
          </div>
          {totals && (
            <span className="text-2xs tabular-nums text-tx3">
              <span className="font-semibold text-tx1">{money(totals.volume)}</span> tracked ·{" "}
              <span className="font-semibold text-warn">{money(totals.maturing)}</span> maturing ≤90d
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse">
            <thead>
              <tr className="border-b border-line text-2xs font-medium text-tx3">
                <th className="px-4 py-2 text-left sm:px-5">Lender</th>
                <th className="px-2 py-2 text-right">Loans</th>
                <th className="px-2 py-2 text-right">Volume</th>
                <th className="px-2 py-2 text-right">Avg rate</th>
                <th className="px-2 py-2 text-right">Maturing ≤90d</th>
                <th className="px-2 py-2 text-right">Payoffs 90d</th>
                <th className="px-4 py-2 text-right sm:px-5">Book</th>
              </tr>
            </thead>
            <tbody>
              {lenders === null && (
                <tr><td colSpan={7}><EmptyState label="Loading lender intelligence…" /></td></tr>
              )}
              {lenders?.length === 0 && (
                <tr><td colSpan={7}><EmptyState label="No recorded private loans yet — enable the county loans source in Settings." /></td></tr>
              )}
              {lenders?.map((l) => (
                <Fragment key={l.lenderName}>
                  <tr
                    onClick={() => setOpen(open === l.lenderName ? null : l.lenderName)}
                    className="cursor-pointer border-t border-line transition-colors hover:bg-raised/60"
                  >
                    <td className="px-4 py-2.5 sm:px-5">
                      <span className="text-[13px] font-medium text-tx1">{l.lenderName}</span>
                      {l.uccFilings > 0 && (
                        <span className="ml-1.5 rounded border border-line bg-raised px-1 py-px font-mono text-[10px] text-tx3">
                          +{l.uccFilings} UCC
                        </span>
                      )}
                    </td>
                    <td className="num px-2 py-2.5 text-xs text-tx2">{l.loans}</td>
                    <td className="num px-2 py-2.5 text-xs font-semibold text-tx1">{money(l.volume)}</td>
                    <td className="num px-2 py-2.5 text-xs text-tx2">{l.avgRate != null ? `${l.avgRate.toFixed(2)}%` : "—"}</td>
                    <td className="num px-2 py-2.5 text-xs">
                      {l.maturing90d > 0 ? (
                        <span className="font-semibold text-warn">{l.maturing90d} · {money(l.maturingVolume)}</span>
                      ) : (
                        <span className="text-tx3">—</span>
                      )}
                    </td>
                    <td className="num px-2 py-2.5 text-xs text-tx2">{l.payoffs90d || "—"}</td>
                    <td className="px-4 py-2.5 text-right text-2xs text-accent sm:px-5">
                      {open === l.lenderName ? "Hide" : "View"}
                    </td>
                  </tr>
                  {open === l.lenderName && (
                    <tr>
                      <td colSpan={7} className="p-0">
                        <LenderLoans name={l.lenderName} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <p className="text-2xs text-tx3">
        Click a lender to open their recorded book; click a borrower to open the resume and quote against their current note.
      </p>
    </div>
  );
}
