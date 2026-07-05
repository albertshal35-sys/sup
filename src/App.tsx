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
} from "./components/Views";
import { PipelineView } from "./components/Pipeline";
import { CommandPalette } from "./components/CommandPalette";
import { LoginPage } from "./components/Login";
import { MapView } from "./components/MapView";
import { LendersView } from "./components/Lenders";
import { LoanBookView } from "./components/LoanBook";
import { Toaster } from "./components/Toaster";

export default function App() {
  const view = useApp((s) => s.view);
  const collapsed = useApp((s) => s.collapsed);
  const auth = useApp((s) => s.auth);
  const loadAll = useApp((s) => s.loadAll);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  if (auth === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="h-2 w-2 animate-pulse-dot rounded-full bg-accent" />
      </div>
    );
  }
  if (auth === "locked") return <LoginPage />;

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
          {view === "map" && <MapView />}
          {view === "lenders" && <LendersView />}
          {view === "loanbook" && <LoanBookView />}
          {view === "watchlist" && <PipelineView />}
          {view === "settings" && <SettingsView />}
        </main>
      </div>

      <BorrowerResumeModal />
      <CommandPalette />
      <Toaster />
    </div>
  );
}
