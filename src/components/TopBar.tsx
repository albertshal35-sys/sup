import { useApp, type View } from "../store";
import { Menu } from "./ui";
import { IconGear, IconMenu, IconMoon, IconRadar, IconSearch, IconSun } from "./icons";
import { classNames } from "../lib/format";

const TITLES: Record<View, { title: string; sub: string }> = {
  dashboard: { title: "Command Center", sub: "All high-intent borrowing signals, ranked" },
  maturity: { title: "Upcoming Maturities", sub: "Private notes entering months 8–10 — refi window" },
  cash_poor: { title: "Cash-Poor Buyers", sub: "Multiple all-cash buys < 60 days — delayed financing" },
  permit: { title: "Permit Intelligence", sub: "Ground-up & structural filings, matched to principals" },
  lien: { title: "Distress Monitoring", sub: "Liens, lis pendens, violations, tax liens & auctions — rescue capital" },
  map: { title: "Borough Map", sub: "Every live signal across the five boroughs" },
  lenders: { title: "Lender Intelligence", sub: "Who's lending in your markets — and whose book is maturing" },
  loanbook: { title: "Loan Book", sub: "Your funded deals — balances, rates, payoff dates" },
  watchlist: { title: "Pipeline", sub: "Saved leads — watching through funded" },
  settings: { title: "Settings", sub: "Data sources, integrations & administration" },
};

const MODE_BADGE = {
  demo: { label: "Demo data", tone: "border-warn/30 bg-warn/10 text-warn" },
  live: { label: "Live", tone: "border-ok/30 bg-ok/10 text-ok" },
  offline: { label: "Demo data", tone: "border-warn/30 bg-warn/10 text-warn" },
} as const;

export function TopBar() {
  const view = useApp((s) => s.view);
  const setMobileNav = useApp((s) => s.setMobileNav);
  const setPalette = useApp((s) => s.setPalette);
  const setView = useApp((s) => s.setView);
  const theme = useApp((s) => s.theme);
  const toggleTheme = useApp((s) => s.toggleTheme);
  const dataMode = useApp((s) => s.dataMode);
  const outreach = useApp((s) => s.serverSettings?.outreach);
  const t = TITLES[view];
  const mode = MODE_BADGE[dataMode];
  const operatorName = outreach?.senderName?.trim() || "Operator";
  const operatorOrg = outreach?.company?.trim() || "LienWolf";

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur-xl">
      <div className="flex h-14 items-center gap-2 px-3 sm:gap-3 sm:px-5 lg:px-6">
        <button
          onClick={() => setMobileNav(true)}
          className="-ml-1 rounded-lg p-1.5 text-tx2 hover:bg-raised md:hidden"
          aria-label="Open menu"
        >
          <IconMenu className="h-5 w-5" />
        </button>

        {/* Brand mark — the sidebar is hidden on mobile, so carry it here */}
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-accent/25 bg-accent/10 text-accent md:hidden">
          <IconRadar className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate font-display text-[15px] font-bold tracking-tight text-tx1">
              {t.title}
            </h1>
            <span
              className={classNames(
                "hidden rounded-md border px-1.5 py-0.5 text-2xs font-medium sm:inline",
                mode.tone
              )}
              title={
                dataMode === "live"
                  ? "Showing live records from connected data sources"
                  : "Showing sample data — switch to live in Settings"
              }
            >
              {mode.label}
            </span>
          </div>
          <p className="hidden truncate text-2xs text-tx3 sm:block">{t.sub}</p>
        </div>

        {/* Search — opens the ⌘K palette */}
        <button
          onClick={() => setPalette(true)}
          className="hidden items-center gap-2 rounded-xl border border-line bg-raised/60 px-3 py-1.5 text-tx3 transition-colors hover:border-tx3/40 md:flex"
        >
          <IconSearch className="h-3.5 w-3.5" />
          <span className="w-40 text-left text-xs xl:w-56">Search entities, addresses…</span>
          <span className="kbd">⌘K</span>
        </button>
        <button
          onClick={() => setPalette(true)}
          className="rounded-lg p-2 text-tx2 hover:bg-raised md:hidden"
          aria-label="Search"
        >
          <IconSearch className="h-4 w-4" />
        </button>

        {/* Profile */}
        <Menu
          align="right"
          button={
            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-line bg-raised text-xs font-semibold text-tx1 transition-colors hover:border-tx3/40">
              {operatorName.slice(0, 1).toUpperCase()}
            </span>
          }
          header={
            <div>
              <div className="text-xs font-semibold text-tx1">{operatorName}</div>
              <div className="text-2xs text-tx3">{operatorOrg}</div>
            </div>
          }
          items={[
            {
              label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
              icon: theme === "dark" ? <IconSun className="h-3.5 w-3.5" /> : <IconMoon className="h-3.5 w-3.5" />,
              onSelect: toggleTheme,
            },
            {
              label: "Settings",
              icon: <IconGear className="h-3.5 w-3.5" />,
              onSelect: () => setView("settings"),
            },
            {
              label: "Sign out",
              divider: true,
              danger: true,
              onSelect: () => {
                useApp.getState().logout();
              },
            },
          ]}
        />
      </div>
    </header>
  );
}
