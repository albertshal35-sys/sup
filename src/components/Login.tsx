/**
 * Access gate — the whole product sits behind one access code that must
 * match the ACCESS_CODE Worker secret. On-brand with the rest of the app:
 * same tokens, type stack and hairline aesthetic in both themes.
 */

import { useState } from "react";
import { useApp } from "../store";
import { classNames } from "../lib/format";
import { IconRadar } from "./icons";
import { ArrowRight, LockKeyhole } from "lucide-react";

export function LoginPage() {
  const login = useApp((s) => s.login);
  const error = useApp((s) => s.loginError);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code || busy) return;
    setBusy(true);
    await login(code);
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 flex touch-none items-center justify-center overflow-hidden px-4">
      {/* quiet brand backdrop: hairline grid, no glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(rgb(var(--line) / 0.5) 1px, transparent 1px), linear-gradient(90deg, rgb(var(--line) / 0.5) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage: "radial-gradient(ellipse 70% 60% at 50% 40%, black 30%, transparent 75%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 70% 60% at 50% 40%, black 30%, transparent 75%)",
        }}
      />

      <div className="relative w-full max-w-sm animate-fade-up">
        {/* Brand */}
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-accent/25 bg-accent/10 text-accent">
            <IconRadar className="h-7 w-7" />
          </span>
          <h1 className="mt-4 font-display text-2xl font-bold tracking-tight text-tx1">LienWolf</h1>
          <p className="mt-1 text-xs text-tx3">Lender intelligence, one command center.</p>
        </div>

        <form onSubmit={submit} className="card p-6">
          <label className="flex items-center gap-1.5 text-2xs font-medium text-tx3">
            <LockKeyhole strokeWidth={1.75} className="h-3 w-3" />
            Access code
          </label>
          <input
            autoFocus
            type="password"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Enter your code"
            autoComplete="current-password"
            className={classNames(
              "mt-2 w-full rounded-xl border bg-surface px-3.5 py-2.5 text-center font-mono text-base tracking-[0.2em] text-tx1 placeholder:font-sans placeholder:text-sm placeholder:tracking-normal placeholder:text-tx3 focus:outline-none",
              error ? "border-danger/50" : "border-line focus:border-accent/50"
            )}
          />
          {error && <p className="mt-2 text-center text-2xs text-danger">{error}</p>}
          <button
            type="submit"
            disabled={!code || busy}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-accent/90 py-2.5 text-sm font-semibold text-bg transition-all hover:bg-accent disabled:opacity-40"
          >
            {busy ? "Verifying…" : "Enter"}
            {!busy && <ArrowRight strokeWidth={2} className="h-4 w-4" />}
          </button>
        </form>

        <p className="mt-6 text-center text-2xs text-tx3">
          Access is issued by your workspace administrator.
        </p>
      </div>
    </div>
  );
}
