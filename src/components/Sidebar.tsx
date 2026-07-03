import { useApp, type View } from "../store";
import { classNames } from "../lib/format";
import {
  IconAlert,
  IconBookmark,
  IconCash,
  IconClock,
  IconGear,
  IconGrid,
  IconHammer,
  IconRadar,
  IconX,
} from "./icons";
import { useVisibleFeed } from "../store";

interface NavItem {
  view: View;
  label: string;
  icon: (p: { className?: string }) => JSX.Element;
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
        "group relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors duration-150",
        active
          ? "bg-white/[0.07] text-mist-100 shadow-glow-cyan"
          : "text-mist-400 hover:bg-white/[0.04] hover:text-mist-200"
      )}
    >
      {active && (
        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-glow-cyan" />
      )}
      <Icon className={classNames("h-[18px] w-[18px] shrink-0", active ? "text-glow-cyan" : "")} />
      {expanded && <span className="flex-1 truncate text-[13px] font-medium">{item.label}</span>}
      {expanded && badge != null && (
        <span
          className={classNames(
            "rounded-full px-1.5 py-0.5 text-2xs font-semibold tabular-nums",
            item.view === "lien" ? "bg-glow-red/15 text-glow-red" : "bg-white/[0.07] text-mist-300"
          )}
        >
          {badge}
        </span>
      )}
      {!expanded && badge != null && (
        <span
          className={classNames(
            "absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full",
            item.view === "lien" ? "bg-glow-red" : "bg-glow-cyan"
          )}
        />
      )}
    </button>
  );
}

function SidebarBody({ expanded }: { expanded: boolean }) {
  const setView = useApp((s) => s.setView);
  const view = useApp((s) => s.view);

  return (
    <div className="flex h-full flex-col">
      {/* Brand */}
      <div className={classNames("flex items-center gap-2.5 px-3 pb-6 pt-5", !expanded && "justify-center px-0")}>
        <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-glow-cyan/25 bg-glow-cyan/10 text-glow-cyan">
          <IconRadar className="h-[18px] w-[18px]" />
        </span>
        {expanded && (
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight text-mist-100">LienWolf</div>
            <div className="text-2xs text-mist-500">Lender Intelligence</div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className={classNames("flex flex-1 flex-col gap-1", expanded ? "px-2" : "items-center px-2")}>
        {expanded && (
          <div className="px-3 pb-1.5 text-2xs font-medium uppercase tracking-widest text-mist-600">
            Signal Feeds
          </div>
        )}
        {NAV.map((item) => (
          <NavButton key={item.view} item={item} expanded={expanded} />
        ))}
      </nav>

      {/* Footer */}
      <div className={classNames("flex flex-col gap-1 pb-4", expanded ? "px-2" : "items-center px-2")}>
        <button
          onClick={() => setView("settings")}
          title="Settings"
          className={classNames(
            "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 transition-colors",
            view === "settings"
              ? "bg-white/[0.07] text-mist-100"
              : "text-mist-400 hover:bg-white/[0.04] hover:text-mist-200"
          )}
        >
          <IconGear className="h-[18px] w-[18px] shrink-0" />
          {expanded && <span className="text-[13px] font-medium">Settings</span>}
        </button>
        {expanded && (
          <div className="mt-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-2xs text-mist-400">
              <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-glow-green" />
              Pipeline healthy
            </div>
            <div className="mt-0.5 text-2xs text-mist-600">Next pull · weekdays 11:00 UTC</div>
          </div>
        )}
      </div>
    </div>
  );
}

export function Sidebar() {
  const mobileNavOpen = useApp((s) => s.mobileNavOpen);
  const setMobileNav = useApp((s) => s.setMobileNav);

  return (
    <>
      {/* Desktop: full rail ≥lg, icon rail md–lg */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[72px] border-r border-white/[0.06] bg-ink-900/70 backdrop-blur-xl md:block lg:w-60">
        <div className="hidden h-full lg:block">
          <SidebarBody expanded />
        </div>
        <div className="h-full lg:hidden">
          <SidebarBody expanded={false} />
        </div>
      </aside>

      {/* Mobile: slide-over */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setMobileNav(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-64 animate-scale-in border-r border-white/[0.08] bg-ink-900/95 backdrop-blur-2xl">
            <button
              onClick={() => setMobileNav(false)}
              className="absolute right-3 top-4 rounded-lg p-1.5 text-mist-400 hover:bg-white/[0.06]"
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
