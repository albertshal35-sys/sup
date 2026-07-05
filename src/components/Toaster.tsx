/**
 * Global toast stack — quiet confirmations for saves and actions.
 */

import { useApp } from "../store";
import { classNames } from "../lib/format";

const TONE = {
  ok: "border-ok/30 bg-ok/10 text-ok",
  error: "border-danger/30 bg-danger/10 text-danger",
  info: "border-line bg-raised text-tx2",
};

export function Toaster() {
  const toasts = useApp((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={classNames(
            "animate-fade-up rounded-xl border px-3.5 py-2 text-xs font-medium shadow-pop backdrop-blur",
            TONE[t.tone]
          )}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
