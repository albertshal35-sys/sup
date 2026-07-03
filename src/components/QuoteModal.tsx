/**
 * Quote & term sheet — underwrite a deal in seconds and print a branded
 * term sheet. Defaults come from Settings → Underwriting (rate spread vs
 * the borrower's last rate, points, term, LTV ceiling).
 */

import { useMemo, useState } from "react";
import { useApp } from "../store";
import type { UnderwritingDefaults } from "../types";
import { classNames, money, moneyFull } from "../lib/format";
import { Modal, TextField } from "./ui";
import { Printer } from "lucide-react";

export const UNDERWRITING_FALLBACK: UnderwritingDefaults = {
  rateSpread: 0.5,
  points: 2,
  termMonths: 12,
  maxLtv: 70,
  minLoan: 100_000,
  lenderName: "LienWolf Lending",
  validDays: 7,
};

function Field({ label, suffix, value, onChange }: { label: string; suffix?: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs font-medium text-tx3">
        {label}
        {suffix && <span className="text-tx3"> ({suffix})</span>}
      </span>
      <TextField value={value} onChange={onChange} className="tabular-nums" />
    </label>
  );
}

export function QuoteModal({
  open,
  onClose,
  entityId,
  entityName,
  address,
  defaultAmount,
  lastRate,
  estValue,
}: {
  open: boolean;
  onClose: () => void;
  entityId: string;
  entityName: string;
  address: string | null;
  defaultAmount: number | null;
  lastRate: number | null;
  estValue: number | null;
}) {
  const uw = useApp((s) => s.serverSettings?.underwriting) ?? UNDERWRITING_FALLBACK;
  const logLeadActivity = useApp((s) => s.logLeadActivity);

  const [amount, setAmount] = useState(String(defaultAmount ?? uw.minLoan));
  const [rate, setRate] = useState(
    (lastRate != null ? Math.max(6, lastRate - uw.rateSpread) : 10.5).toFixed(2)
  );
  const [points, setPoints] = useState(String(uw.points));
  const [term, setTerm] = useState(String(uw.termMonths));
  const [arv, setArv] = useState(String(estValue ?? ""));

  const calc = useMemo(() => {
    const a = Number(amount.replace(/[$,\s]/g, "")) || 0;
    const r = Number(rate) || 0;
    const p = Number(points) || 0;
    const t = Number(term) || 12;
    const v = Number(arv.replace(/[$,\s]/g, "")) || 0;
    return {
      amount: a,
      rate: r,
      points: p,
      term: t,
      arv: v,
      ltv: v > 0 ? (a / v) * 100 : null,
      origination: Math.round((a * p) / 100),
      monthlyIO: Math.round((a * r) / 1200),
      totalInterest: Math.round(((a * r) / 1200) * t),
    };
  }, [amount, rate, points, term, arv]);

  const ltvOver = calc.ltv != null && calc.ltv > uw.maxLtv;

  const printSheet = () => {
    const validUntil = new Date(Date.now() + uw.validDays * 86_400_000).toLocaleDateString("en-US", {
      month: "long", day: "numeric", year: "numeric",
    });
    const row = (k: string, v: string) =>
      `<tr><td style="padding:7px 0;color:#5a616a;font-size:12px">${k}</td><td style="padding:7px 0;text-align:right;font-weight:600;font-variant-numeric:tabular-nums">${v}</td></tr>`;
    const html = `<!doctype html><html><head><title>Term Sheet — ${entityName}</title></head>
<body style="font-family:-apple-system,'Segoe UI',sans-serif;color:#17191d;max-width:620px;margin:40px auto;padding:0 24px">
  <div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #17191d;padding-bottom:12px">
    <div><div style="font-size:20px;font-weight:800">${uw.lenderName}</div>
    <div style="font-size:11px;color:#5a616a">Indicative Term Sheet — Private Bridge Financing</div></div>
    <div style="font-size:11px;color:#5a616a;text-align:right">${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</div>
  </div>
  <table style="width:100%;margin-top:18px;border-collapse:collapse;font-size:13px">
    ${row("Borrower", entityName)}
    ${address ? row("Subject property", address) : ""}
    ${row("Loan amount", moneyFull(calc.amount))}
    ${row("Interest rate", `${calc.rate.toFixed(2)}% (interest-only)`)}
    ${row("Origination", `${calc.points}% (${moneyFull(calc.origination)})`)}
    ${row("Term", `${calc.term} months`)}
    ${calc.ltv != null ? row("LTV", `${calc.ltv.toFixed(1)}%${calc.arv ? ` of ${moneyFull(calc.arv)}` : ""}`) : ""}
    ${row("Monthly payment (I/O)", moneyFull(calc.monthlyIO))}
  </table>
  <p style="font-size:11px;color:#5a616a;margin-top:22px;line-height:1.6">
    This indicative term sheet is for discussion purposes only and does not constitute a commitment to lend.
    Terms subject to underwriting, appraisal, title and full documentation. Valid through ${validUntil}.
  </p>
</body></html>`;
    const w = window.open("", "_blank", "width=720,height=900");
    if (w) {
      w.document.write(html);
      w.document.close();
      w.focus();
      setTimeout(() => w.print(), 250);
    }
    logLeadActivity(
      entityId,
      "note",
      `Term sheet generated — ${money(calc.amount)} @ ${calc.rate.toFixed(2)}%, ${calc.points} pts, ${calc.term} mo`
    );
  };

  return (
    <Modal open={open} onClose={onClose} title={`Quote — ${entityName}`} maxWidth="max-w-xl">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <Field label="Loan amount" suffix="$" value={amount} onChange={setAmount} />
        <Field label="Rate" suffix="% I/O" value={rate} onChange={setRate} />
        <Field label="Points" suffix="%" value={points} onChange={setPoints} />
        <Field label="Term" suffix="months" value={term} onChange={setTerm} />
        <Field label="Value / ARV" suffix="$" value={arv} onChange={setArv} />
      </div>

      {lastRate != null && (
        <p className="mt-3 rounded-xl border border-accent/20 bg-accent/[0.06] px-3.5 py-2 text-2xs text-tx2">
          They last borrowed at{" "}
          <strong className="tabular-nums text-tx1">{lastRate.toFixed(2)}%</strong> — this quote
          undercuts by{" "}
          <strong className="tabular-nums text-tx1">
            {(lastRate - (Number(rate) || 0)).toFixed(2)} pts
          </strong>
          .
        </p>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {[
          { label: "LTV", value: calc.ltv != null ? `${calc.ltv.toFixed(1)}%` : "—", warn: ltvOver },
          { label: "Origination", value: money(calc.origination) },
          { label: "Monthly I/O", value: money(calc.monthlyIO) },
          { label: `Interest / ${calc.term}mo`, value: money(calc.totalInterest) },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-line bg-raised/60 px-3 py-2.5">
            <div className="text-2xs font-medium text-tx3">{s.label}</div>
            <div
              className={classNames(
                "mt-0.5 font-display text-lg font-bold tabular-nums",
                s.warn ? "text-danger" : "text-tx1"
              )}
            >
              {s.value}
            </div>
          </div>
        ))}
      </div>
      {ltvOver && (
        <p className="mt-2 text-2xs text-danger">
          Above your {uw.maxLtv}% LTV ceiling (Settings → Underwriting).
        </p>
      )}

      <div className="mt-4 flex items-center justify-between border-t border-line pt-3">
        <span className="text-2xs text-tx3">
          Defaults from Settings · valid {uw.validDays} days · {uw.lenderName}
        </span>
        <button
          onClick={printSheet}
          className="flex items-center gap-2 rounded-xl bg-accent/90 px-4 py-2 text-xs font-semibold text-bg transition-colors hover:bg-accent"
        >
          <Printer strokeWidth={1.75} className="h-3.5 w-3.5" />
          Print term sheet
        </button>
      </div>
    </Modal>
  );
}
