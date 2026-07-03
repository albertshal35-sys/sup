import { useApp, type View } from "../store";
import { IconMenu, IconMoon, IconSearch, IconSun } from "./icons";

const TITLES: Record<View, { title: string; sub: string }> = {
  dashboard: { title: "Command Center", sub: "All high-intent borrowing signals, ranked" },
  maturity: { title: "Upcoming Maturities", sub: "Private notes entering months 8–10 — refi window" },
  cash_poor: { title: "Cash-Poor Buyers", sub: "Multiple all-cash buys < 60 days — delayed financing" },
  permit: { title: "Permit Intelligence", sub: "Ground-up & structural filings, matched to principals" },
  lien: { title: "Lien Monitoring", sub: "Fresh mechanics liens — frozen draws, rescue capital" },
  watchlist: { title: "Pipeline", sub: "Saved leads — watching through funded" },
  settings: { title: "Settings", sub: "Markets, thresholds & pipeline" },
};

export function TopBar() {
  const view = useApp((s) => s.view);
  const setMobileNav = useApp((s) => s.setMobileNav);
  const theme = useApp((s) => s.theme);
  const toggleTheme = useApp((s) => s.toggleTheme);
  const t = TITLES[view];

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur-xl">
      <div className="flex h-14 items-center gap-2.5 px-3 sm:gap-3 sm:px-5 lg:px-6">
        <button
          onClick={() => setMobileNav(true)}
          className="rounded-lg p-1.5 text-tx2 hover:bg-raised md:hidden"
          aria-label="Open menu"
        >
          <IconMenu className="h-5 w-5" />
        </button>

        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-[15px] font-bold tracking-tight text-tx1">
            {t.title}
          </h1>
          <p className="hidden truncate text-2xs text-tx3 sm:block">{t.sub}</p>
        </div>

        {/* Search (visual affordance; wire to /api/search later) */}
        <div className="hidden items-center gap-2 rounded-xl border border-line bg-raised/60 px-3 py-1.5 text-tx3 transition-colors focus-within:border-accent/40 md:flex">
          <IconSearch className="h-3.5 w-3.5" />
          <input
            placeholder="Search entities, addresses…"
            className="w-40 bg-transparent text-xs text-tx1 placeholder:text-tx3 focus:outline-none xl:w-56"
          />
          <span className="kbd">⌘K</span>
        </div>

        <button
          onClick={toggleTheme}
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          className="rounded-lg p-2 text-tx2 transition-colors hover:bg-raised hover:text-tx1"
        >
          {theme === "dark" ? <IconSun className="h-4 w-4" /> : <IconMoon className="h-4 w-4" />}
        </button>

        {/* Sync status + avatar */}
        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-1.5 text-2xs text-tx3 lg:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-ok" />
            Synced 8h ago
          </div>
          <span
            className="flex h-8 w-8 items-center justify-center rounded-full border border-line bg-raised text-xs font-semibold text-tx1"
            title="Max · Allura Capital"
          >
            M
          </span>
        </div>
      </div>
    </header>
  );
}
