import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { BorrowerResume, IngestionRun, Kpis, TriggerItem, TriggerKind } from "./types";
import { getFeed, getIngestionStatus, getKpis, getResume, setTriggerStatus } from "./lib/api";

export type View =
  | "dashboard"
  | "maturity"
  | "cash_poor"
  | "permit"
  | "lien"
  | "watchlist"
  | "settings";

interface AppState {
  view: View;
  mobileNavOpen: boolean;
  loading: boolean;

  kpis: Kpis | null;
  feeds: Record<TriggerKind, TriggerItem[]>;
  ingestion: IngestionRun[];

  resume: BorrowerResume | null;
  resumeOpen: boolean;

  watchlist: string[]; // entity ids (persisted)
  dismissed: string[]; // trigger ids (persisted)

  setView: (v: View) => void;
  setMobileNav: (open: boolean) => void;
  loadAll: () => Promise<void>;
  openResume: (entityId: string, fromItem?: TriggerItem) => Promise<void>;
  closeResume: () => void;
  toggleWatch: (entityId: string) => void;
  dismissTrigger: (id: string) => void;
  markContacted: (id: string) => void;
}

const emptyFeeds: Record<TriggerKind, TriggerItem[]> = {
  maturity: [],
  cash_poor: [],
  permit: [],
  lien: [],
};

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      view: "dashboard",
      mobileNavOpen: false,
      loading: true,

      kpis: null,
      feeds: emptyFeeds,
      ingestion: [],

      resume: null,
      resumeOpen: false,

      watchlist: [],
      dismissed: [],

      setView: (view) => set({ view, mobileNavOpen: false }),
      setMobileNav: (mobileNavOpen) => set({ mobileNavOpen }),

      loadAll: async () => {
        set({ loading: true });
        const [kpis, maturity, cashPoor, permit, lien, ingestion] = await Promise.all([
          getKpis(),
          getFeed("maturity"),
          getFeed("cash_poor"),
          getFeed("permit"),
          getFeed("lien"),
          getIngestionStatus(),
        ]);
        set({
          kpis,
          feeds: { maturity, cash_poor: cashPoor, permit, lien },
          ingestion,
          loading: false,
        });
      },

      openResume: async (entityId, fromItem) => {
        const resume = await getResume(entityId, fromItem);
        if (resume) set({ resume, resumeOpen: true });
      },
      closeResume: () => set({ resumeOpen: false }),

      toggleWatch: (entityId) => {
        const { watchlist } = get();
        set({
          watchlist: watchlist.includes(entityId)
            ? watchlist.filter((id) => id !== entityId)
            : [...watchlist, entityId],
        });
      },

      dismissTrigger: (id) => {
        set({ dismissed: [...get().dismissed, id] });
        void setTriggerStatus(id, "dismissed");
      },

      markContacted: (id) => {
        const feeds = { ...get().feeds };
        (Object.keys(feeds) as TriggerKind[]).forEach((k) => {
          feeds[k] = feeds[k].map((t) => (t.id === id ? { ...t, status: "contacted" } : t));
        });
        set({ feeds });
        void setTriggerStatus(id, "contacted");
      },
    }),
    {
      name: "lienwolf-ui",
      partialize: (s) => ({ watchlist: s.watchlist, dismissed: s.dismissed }),
    }
  )
);

/** Feed rows minus anything the user dismissed. */
export function useVisibleFeed(kind: TriggerKind): TriggerItem[] {
  const feed = useApp((s) => s.feeds[kind]);
  const dismissed = useApp((s) => s.dismissed);
  return feed.filter((t) => !dismissed.includes(t.id));
}
