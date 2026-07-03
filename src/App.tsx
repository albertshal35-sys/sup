import { useEffect } from "react";
import { useApp } from "./store";
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
  const loadAll = useApp((s) => s.loadAll);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  return (
    <div className="relative min-h-screen">
      {/* Ambient depth: two faint radial glows behind everything */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/4 h-[480px] w-[640px] rounded-full bg-glow-cyan/[0.045] blur-[120px]" />
        <div className="absolute -bottom-56 right-0 h-[420px] w-[560px] rounded-full bg-glow-violet/[0.05] blur-[130px]" />
      </div>

      <Sidebar />

      <div className="relative md:pl-[72px] lg:pl-60">
        <TopBar />
        <main className="mx-auto max-w-[1600px] px-3 py-4 sm:px-6 sm:pb-8">
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
