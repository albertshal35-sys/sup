import { useApp, type View } from "../store";
import { IconMenu, IconSearch } from "./icons";

const TITLES: Record<View, { title: string; sub: string }> = {
  dashboard: { title: "Command Center", sub: "All high-intent borrowing signals, ranked" },
  maturity: { title: "Upcoming Maturities", sub: "Private notes entering months 8–10 — refi window" },
  cash_poor: { title: "Cash-Poor Buyers", sub: "Multiple all-cash buys < 60 days — delayed financing" },
  permit: { title: "Permit Intelligence", sub: "Ground-up & structural filings, matched to principals" },
  lien: { title: "Lien Monitoring", sub: "Fresh mechanics liens — frozen draws, rescue capital" },
  watchlist: { title: "Watchlist", sub: "Entities you're tracking" },
  settings: { title: "Settings", sub: "Markets, thresholds & pipeline" },
};

export function TopBar() {
  const view = useApp((s) => s.view);
  const setMobileNav = useApp((s) => s.setMobileNav);
  const t = TITLES[view];

  return (
    <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-ink-950/75 backdrop-blur-xl">
      <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
        <button
          onClick={() => setMobileNav(true)}
          className="rounded-lg p-1.5 text-mist-400 hover:bg-white/[0.06] md:hidden"
          aria-label="Open menu"
        >
          <IconMenu className="h-5 w-5" />
        </button>

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold tracking-tight text-mist-100">
            {t.title}
          </h1>
          <p className="hidden truncate text-2xs text-mist-500 sm:block">{t.sub}</p>
        </div>

        {/* Search (visual affordance; wire to /api/search later) */}
        <div className="hidden items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-1.5 text-mist-500 transition-colors focus-within:border-glow-cyan/40 sm:flex">
          <IconSearch className="h-3.5 w-3.5" />
          <input
            placeholder="Search entities, addresses…"
            className="w-44 bg-transparent text-xs text-mist-200 placeholder:text-mist-600 focus:outline-none lg:w-56"
          />
          <span className="kbd">⌘K</span>
        </div>

        {/* Sync status + avatar */}
        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-1.5 text-2xs text-mist-500 md:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-glow-green" />
            Synced 8h ago
          </div>
          <span
            className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-gradient-to-br from-glow-violet/30 to-glow-cyan/20 text-xs font-semibold text-mist-100"
            title="Max · Allura Capital"
          >
            M
          </span>
        </div>
      </div>
    </header>
  );
}
