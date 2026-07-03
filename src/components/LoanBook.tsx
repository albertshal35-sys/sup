/**
 * Loan book — the lender's own funded deals. Tracks balance, rate, status
 * and payoff date; maturities here feed the daily digest (D-60 crossings)
 * so renewals never surprise you. Pipeline leads marked "Funded" are one
 * click away from a book entry.
 */

import { useEffect, useMemo, useState } from "react";
import { useApp } from "../store";
import type { LoanBookEntry, LoanBookStatus } from "../types";
import { deleteLoanBookEntry, getLoanBook, saveLoanBookEntry } from "../lib/api";
import { downloadCsv } from "../lib/csv";
import { classNames, money, shortDate } from "../lib/format";
import { EmptyState } from "./primitives";
import { Menu, Modal, Select, TextArea, TextField, type SelectOption } from "./ui";
import { BookOpen, Download, MoreHorizontal, Plus } from "lucide-react";

const STATUS_OPTIONS: SelectOption<LoanBookStatus>[] = [
  { value: "current", label: "Current" },
  { value: "late", label: "Late" },
  { value: "extended", label: "Extended" },
  { value: "paid_off", label: "Paid off" },
  { value: "defaulted", label: "Defaulted" },
];

const STATUS_TONE: Record<LoanBookStatus, string> = {
  current: "border-ok/30 bg-ok/10 text-ok",
  late: "border-danger/30 bg-danger/10 text-danger",
  extended: "border-warn/30 bg-warn/10 text-warn",
  paid_off: "border-line bg-raised/60 text-tx3",
  defaulted: "border-danger/40 bg-danger/15 text-danger",
};

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

const EMPTY_FORM = {
  id: "", borrowerName: "", propertyAddress: "", principal: "", ratePct: "", points: "",
  originatedAt: "", termMonths: "12", maturityDate: "", status: "current" as LoanBookStatus, notes: "",
};

function EntryModal({
  open, initial, onClose, onSaved,
}: {
  open: boolean;
  initial: typeof EMPTY_FORM;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setF(initial), [initial]);

  const set = (k: keyof typeof EMPTY_FORM) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const save = async () => {
    const principal = Number(f.principal.replace(/[$,\s]/g, ""));
    if (!f.borrowerName.trim() || !principal || !f.originatedAt) {
      setErr("Borrower, principal and origination date are required.");
      return;
    }
    const res = await saveLoanBookEntry({
      id: f.id || undefined,
      borrowerName: f.borrowerName.trim(),
      propertyAddress: f.propertyAddress.trim() || null,
      principal,
      ratePct: Number(f.ratePct) || 0,
      points: f.points ? Number(f.points) : null,
      originatedAt: f.originatedAt,
      termMonths: Number(f.termMonths) || 12,
      maturityDate: f.maturityDate || null,
      status: f.status,
      notes: f.notes.trim() || null,
    });
    if (!res.ok) {
      setErr("Could not save — the Worker API is unreachable in offline preview.");
      return;
    }
    onSaved();
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={f.id ? "Edit loan" : "Add loan"} maxWidth="max-w-lg">
      <div className="grid grid-cols-2 gap-2.5">
        <label className="col-span-2 flex flex-col gap-1 sm:col-span-1">
          <span className="text-2xs font-medium text-tx3">Borrower</span>
          <TextField value={f.borrowerName} onChange={set("borrowerName")} placeholder="Entity or person" />
        </label>
        <label className="col-span-2 flex flex-col gap-1 sm:col-span-1">
          <span className="text-2xs font-medium text-tx3">Property</span>
          <TextField value={f.propertyAddress} onChange={set("propertyAddress")} placeholder="Address (optional)" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-tx3">Principal ($)</span>
          <TextField value={f.principal} onChange={set("principal")} className="tabular-nums" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-tx3">Rate (% I/O)</span>
          <TextField value={f.ratePct} onChange={set("ratePct")} className="tabular-nums" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-tx3">Points (%)</span>
          <TextField value={f.points} onChange={set("points")} className="tabular-nums" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-tx3">Term (months)</span>
          <TextField value={f.termMonths} onChange={set("termMonths")} className="tabular-nums" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-tx3">Originated (YYYY-MM-DD)</span>
          <TextField value={f.originatedAt} onChange={set("originatedAt")} placeholder="2026-01-15" className="tabular-nums" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-tx3">Maturity (blank = origin + term)</span>
          <TextField value={f.maturityDate} onChange={set("maturityDate")} placeholder="auto" className="tabular-nums" />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-tx3">Status</span>
          <Select value={f.status} options={STATUS_OPTIONS} onChange={(v) => setF((p) => ({ ...p, status: v }))} />
        </div>
        <label className="col-span-2 flex flex-col gap-1">
          <span className="text-2xs font-medium text-tx3">Notes</span>
          <TextArea value={f.notes} onChange={set("notes")} rows={2} placeholder="Draw schedule, payoff conversations…" />
        </label>
      </div>
      {err && <p className="mt-2 text-2xs text-danger">{err}</p>}
      <div className="mt-4 flex justify-end gap-2 border-t border-line pt-3">
        <button onClick={onClose} className="rounded-xl border border-line px-3.5 py-2 text-xs font-medium text-tx2 hover:text-tx1">
          Cancel
        </button>
        <button onClick={() => void save()} className="rounded-xl bg-accent/90 px-4 py-2 text-xs font-semibold text-bg transition-colors hover:bg-accent">
          Save loan
        </button>
      </div>
    </Modal>
  );
}

export function LoanBookView() {
  const dataMode = useApp((s) => s.dataMode);
  const openResume = useApp((s) => s.openResume);
  const [loans, setLoans] = useState<LoanBookEntry[] | null>(null);
  const [editing, setEditing] = useState<typeof EMPTY_FORM | null>(null);

  const refresh = () => void getLoanBook(dataMode).then(setLoans);
  useEffect(refresh, [dataMode]);

  const stats = useMemo(() => {
    const active = (loans ?? []).filter((l) => l.status === "current" || l.status === "late" || l.status === "extended");
    const outstanding = active.reduce((s, l) => s + l.principal, 0);
    const annualInterest = active.reduce((s, l) => s + (l.principal * l.ratePct) / 100, 0);
    const next = active
      .filter((l) => l.maturityDate)
      .sort((a, b) => (a.maturityDate! < b.maturityDate! ? -1 : 1))[0];
    return { count: active.length, outstanding, annualInterest, next };
  }, [loans]);

  const exportCsv = () => {
    if (!loans) return;
    downloadCsv(
      "lienwolf-loan-book",
      ["Borrower", "Property", "Principal", "Rate %", "Points", "Originated", "Term", "Maturity", "Status", "Notes"],
      loans.map((l) => [l.borrowerName, l.propertyAddress, l.principal, l.ratePct, l.points, l.originatedAt, l.termMonths, l.maturityDate, l.status, l.notes])
    );
  };

  const edit = (l: LoanBookEntry) =>
    setEditing({
      id: l.id, borrowerName: l.borrowerName, propertyAddress: l.propertyAddress ?? "",
      principal: String(l.principal), ratePct: String(l.ratePct), points: l.points != null ? String(l.points) : "",
      originatedAt: l.originatedAt, termMonths: String(l.termMonths), maturityDate: l.maturityDate ?? "",
      status: l.status, notes: l.notes ?? "",
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3">
        {[
          { label: "Active loans", value: String(stats.count) },
          { label: "Outstanding", value: money(stats.outstanding) },
          { label: "Annualized interest", value: money(stats.annualInterest) },
          {
            label: "Next maturity",
            value: stats.next?.maturityDate
              ? `D-${daysUntil(stats.next.maturityDate)} · ${stats.next.borrowerName.split(" ")[0]}`
              : "—",
          },
        ].map((s) => (
          <div key={s.label} className="card px-4 py-3.5">
            <div className="truncate text-2xs font-medium text-tx3">{s.label}</div>
            <div className="mt-1 truncate font-display text-xl font-bold tabular-nums tracking-tight text-tx1">{s.value}</div>
          </div>
        ))}
      </div>

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-2.5 sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <BookOpen strokeWidth={1.75} className="h-4 w-4 text-tx2" />
            <h2 className="text-[13px] font-semibold tracking-tight text-tx1">Funded deals</h2>
            <span className="hidden text-2xs text-tx3 md:inline">D-60 crossings appear in your daily digest</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={exportCsv}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-2xs font-medium text-tx2 transition-colors hover:text-tx1"
            >
              <Download strokeWidth={1.75} className="h-3.5 w-3.5" />
              CSV
            </button>
            <button
              onClick={() => setEditing({ ...EMPTY_FORM })}
              className="flex items-center gap-1.5 rounded-lg bg-accent/90 px-2.5 py-1.5 text-2xs font-semibold text-bg transition-colors hover:bg-accent"
            >
              <Plus strokeWidth={2} className="h-3.5 w-3.5" />
              Add loan
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] border-collapse">
            <thead>
              <tr className="border-b border-line text-2xs font-medium text-tx3">
                <th className="px-4 py-2 text-left sm:px-5">Borrower</th>
                <th className="px-2 py-2 text-right">Principal</th>
                <th className="px-2 py-2 text-right">Rate</th>
                <th className="px-2 py-2 text-right">Originated</th>
                <th className="px-2 py-2 text-right">Maturity</th>
                <th className="px-2 py-2 text-right">Status</th>
                <th className="px-4 py-2 sm:px-5" />
              </tr>
            </thead>
            <tbody>
              {loans === null && <tr><td colSpan={7}><EmptyState label="Loading your book…" /></td></tr>}
              {loans?.length === 0 && (
                <tr><td colSpan={7}><EmptyState label="No funded deals yet — add your first loan, or fund a pipeline lead." /></td></tr>
              )}
              {loans?.map((l) => {
                const d = daysUntil(l.maturityDate);
                const active = l.status === "current" || l.status === "late" || l.status === "extended";
                return (
                  <tr key={l.id} className="border-t border-line transition-colors hover:bg-raised/60">
                    <td className="px-4 py-2.5 sm:px-5">
                      <button
                        disabled={!l.entityId}
                        onClick={() => l.entityId && void openResume(l.entityId)}
                        className="block max-w-full truncate text-left text-[13px] font-medium text-tx1 hover:text-accent disabled:hover:text-tx1"
                      >
                        {l.borrowerName}
                      </button>
                      <span className="block truncate text-2xs text-tx3">{l.propertyAddress ?? "—"}{l.notes ? ` · ${l.notes}` : ""}</span>
                    </td>
                    <td className="num px-2 py-2.5 text-xs font-semibold text-tx1">{money(l.principal)}</td>
                    <td className="num px-2 py-2.5 text-xs text-tx2">{l.ratePct.toFixed(2)}%</td>
                    <td className="num px-2 py-2.5 text-2xs text-tx3">{shortDate(l.originatedAt)}</td>
                    <td className="px-2 py-2.5 text-right">
                      {l.maturityDate && active && d != null ? (
                        <span
                          className={classNames(
                            "font-mono text-2xs font-semibold tabular-nums",
                            d <= 60 ? "text-danger" : d <= 90 ? "text-warn" : "text-tx2"
                          )}
                        >
                          D-{d}
                        </span>
                      ) : (
                        <span className="text-2xs text-tx3">{l.maturityDate ? shortDate(l.maturityDate) : "—"}</span>
                      )}
                    </td>
                    <td className="px-2 py-2.5 text-right">
                      <span className={classNames("inline-flex rounded-full border px-2 py-0.5 text-2xs font-medium capitalize", STATUS_TONE[l.status])}>
                        {l.status.replace("_", " ")}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right sm:px-5">
                      <Menu
                        align="right"
                        button={
                          <span className="inline-flex rounded-lg p-1.5 text-tx3 transition-colors hover:bg-raised hover:text-tx1">
                            <MoreHorizontal strokeWidth={1.75} className="h-4 w-4" />
                          </span>
                        }
                        items={[
                          { label: "Edit", onSelect: () => edit(l) },
                          {
                            label: "Mark paid off",
                            onSelect: () => {
                              void saveLoanBookEntry({ ...l, status: "paid_off" }).then(refresh);
                            },
                          },
                          {
                            label: "Delete",
                            danger: true,
                            divider: true,
                            onSelect: () => {
                              void deleteLoanBookEntry(l.id).then(refresh);
                            },
                          },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {editing && (
        <EntryModal open initial={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      )}
    </div>
  );
}
