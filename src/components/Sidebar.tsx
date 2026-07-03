import { useApp, useVisibleFeed, type View } from "../store";
import { classNames } from "../lib/format";
import {
  IconAlert,
  IconBookmark,
  IconCash,
  IconClock,
  IconCollapse,
  IconExpand,
  IconGear,
  IconGrid,
  IconHammer,
  IconRadar,
  IconX,
  type IconType,
} from "./icons";

interface NavItem {
  view: View;
  label: string;
  icon: IconType;
}

const NAV: NavItem[] = [
  { view: "dashboard", label: "Command", icon: IconGrid },
  { view: "maturity", label: "Maturities", icon: IconClock },
  { view: "cash_poor", label: "Cash-Poor", icon: IconCash },
  { view: "permit", label: "Permits", icon: IconHammer },
  { view: "lien", label: "Lien Alerts", icon: IconAlert },
  { view: "watchlist", label: "Watchlist", icon: IconBookmark },
];

function NavButton({ item, expanded }: { item: NavItem; expanded: boolean }) {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const watchCount = useApp((s) => s.watchlist.length);
  const lienCount = useVisibleFeed("lien").filter((t) => t.urgency === "critical").length;
  const active = view === item.view;
  const Icon = item.icon;

  const badge =
    item.view === "lien" && lienCount > 0
      ? lienCount
      : item.view === "watchlist" && watchCount > 0
        ? watchCount
        : null;

  return (
    <button
      onClick={() => setView(item.view)}
      title={item.label}
      className={classNames(
        "group relative flex w-full items-center gap-3 rounded-xl py-2.5 text-left transition-colors duration-150",
        expanded ? "px-3" : "justify-center px-0",
        active ? "bg-raised text-tx1" : "text-tx2 hover:bg-raised/60 hover:text-tx1"
      )}
    >
      {active && (
        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
      )}
      <Icon className={classNames("h-[18px] w-[18px] shrink-0", active ? "text-accent" : "")} />
      {expanded && <span className="flex-1 truncate text-[13px] font-medium">{item.label}</span>}
      {expanded && badge != null && (
        <span
          className={classNames(
            "rounded-full px-1.5 py-0.5 text-2xs font-semibold tabular-nums",
            item.view === "lien" ? "bg-danger/15 text-danger" : "bg-raised text-tx2"
          )}
        >
          {badge}
        </span>
      )}
      {!expanded && badge != null && (
        <span
          className={classNames(
            "absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full",
            item.view === "lien" ? "bg-danger" : "bg-accent"
          )}
        />
      )}
    </button>
  );
}

function SidebarBody({ expanded, showCollapse }: { expanded: boolean; showCollapse?: boolean }) {
  const setView = useApp((s) => s.setView);
  const view = useApp((s) => s.view);
  const toggleCollapsed = useApp((s) => s.toggleCollapsed);

  return (
    <div className="flex h-full flex-col">
      {/* Brand */}
      <div
        className={classNames(
          "flex items-center gap-2.5 pb-6 pt-5",
          expanded ? "px-3" : "justify-center px-0"
        )}
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-accent/25 bg-accent/10 text-accent">
          <IconRadar className="h-[18px] w-[18px]" />
        </span>
        {expanded && (
          <div className="leading-tight">
            <div className="font-display text-sm font-bold tracking-tight text-tx1">LienWolf</div>
            <div className="text-2xs text-tx3">Lender Intelligence</div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex flex-1 flex-col gap-1 px-2">
        {expanded && (
          <div className="px-3 pb-1.5 text-2xs font-medium uppercase tracking-widest text-tx3">
            Signal Feeds
          </div>
        )}
        {NAV.map((item) => (
          <NavButton key={item.view} item={item} expanded={expanded} />
        ))}
      </nav>

      {/* Footer */}
      <div className="flex flex-col gap-1 px-2 pb-4">
        <button
          onClick={() => setView("settings")}
          title="Settings"
          className={classNames(
            "flex w-full items-center gap-3 rounded-xl py-2.5 transition-colors",
            expanded ? "px-3" : "justify-center px-0",
            view === "settings" ? "bg-raised text-tx1" : "text-tx2 hover:bg-raised/60 hover:text-tx1"
          )}
        >
          <IconGear className="h-[18px] w-[18px] shrink-0" />
          {expanded && <span className="text-[13px] font-medium">Settings</span>}
        </button>

        {showCollapse && (
          <button
            onClick={toggleCollapsed}
            title={expanded ? "Collapse sidebar" : "Expand sidebar"}
            className={classNames(
              "hidden w-full items-center gap-3 rounded-xl py-2.5 text-tx2 transition-colors hover:bg-raised/60 hover:text-tx1 lg:flex",
              expanded ? "px-3" : "justify-center px-0"
            )}
          >
            {expanded ? (
              <IconCollapse className="h-[18px] w-[18px] shrink-0" />
            ) : (
              <IconExpand className="h-[18px] w-[18px] shrink-0" />
            )}
            {expanded && <span className="text-[13px] font-medium">Collapse</span>}
          </button>
        )}

        {expanded && (
          <div className="mt-2 rounded-xl border border-line bg-raised/60 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-2xs text-tx2">
              <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-ok" />
              Pipeline healthy
            </div>
            <div className="mt-0.5 text-2xs text-tx3">Next pull · weekdays 11:00 UTC</div>
          </div>
        )}
      </div>
    </div>
  );
}

export function Sidebar() {
  const mobileNavOpen = useApp((s) => s.mobileNavOpen);
  const setMobileNav = useApp((s) => s.setMobileNav);
  const collapsed = useApp((s) => s.collapsed);

  return (
    <>
      {/* ≥md: fixed rail. Icon-only below lg or when user-collapsed; full otherwise. */}
      <aside
        className={classNames(
          "fixed inset-y-0 left-0 z-30 hidden w-[72px] border-r border-line bg-surface/85 backdrop-blur-xl transition-[width] duration-200 md:block",
          !collapsed && "lg:w-60"
        )}
      >
        {collapsed ? (
          <SidebarBody expanded={false} showCollapse />
        ) : (
          <>
            <div className="hidden h-full lg:block">
              <SidebarBody expanded showCollapse />
            </div>
            <div className="h-full lg:hidden">
              <SidebarBody expanded={false} />
            </div>
          </>
        )}
      </aside>

      {/* Mobile: slide-over */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setMobileNav(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-64 animate-scale-in border-r border-line bg-surface">
            <button
              onClick={() => setMobileNav(false)}
              className="absolute right-3 top-4 rounded-lg p-1.5 text-tx2 hover:bg-raised"
              aria-label="Close menu"
            >
              <IconX className="h-4 w-4" />
            </button>
            <SidebarBody expanded />
          </aside>
        </div>
      )}
    </>
  );
}
