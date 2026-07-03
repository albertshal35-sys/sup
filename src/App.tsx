import { useEffect } from "react";
import { useApp } from "./store";
import { classNames } from "./lib/format";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { Dashboard } from "./components/Dashboard";
import { BorrowerResumeModal } from "./components/BorrowerResume";
import {
  CashPoorView,
  LienView,
  MaturityView,
  PermitView,
  SettingsView,
  WatchlistView,
} from "./components/Views";

export default function App() {
  const view = useApp((s) => s.view);
  const collapsed = useApp((s) => s.collapsed);
  const loadAll = useApp((s) => s.loadAll);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  return (
    <div className="relative min-h-screen">
      <Sidebar />

      <div className={classNames("relative md:pl-[72px]", !collapsed && "lg:pl-60")}>
        <TopBar />
        <main className="mx-auto max-w-[1600px] px-3 py-4 sm:px-5 sm:pb-8 lg:px-6">
          {view === "dashboard" && <Dashboard />}
          {view === "maturity" && <MaturityView />}
          {view === "cash_poor" && <CashPoorView />}
          {view === "permit" && <PermitView />}
          {view === "lien" && <LienView />}
          {view === "watchlist" && <WatchlistView />}
          {view === "settings" && <SettingsView />}
        </main>
      </div>

      <BorrowerResumeModal />
    </div>
  );
}
