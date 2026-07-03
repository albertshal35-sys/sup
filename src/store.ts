import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  BorrowerResume,
  IngestionRun,
  Kpis,
  Lead,
  LeadActivity,
  PipelineStage,
  TriggerItem,
  TriggerKind,
} from "./types";
import {
  getFeed,
  getIngestionStatus,
  getKpis,
  getResume,
  loginWithCode,
  probeSettings,
  setSessionToken,
  setTriggerStatus,
  syncLeadRemove,
  syncLeadUpsert,
} from "./lib/api";
import type { PublicSettings } from "./types";

export type View =
  | "dashboard"
  | "maturity"
  | "cash_poor"
  | "permit"
  | "lien"
  | "watchlist"
  | "settings";

export type Theme = "dark" | "light";
export type DataMode = "demo" | "live" | "offline";
export type AuthState = "checking" | "locked" | "open";

interface AppState {
  view: View;
  mobileNavOpen: boolean;
  collapsed: boolean; // sidebar icon-rail mode (persisted)
  theme: Theme; // persisted + mirrored to <html data-theme>
  loading: boolean;
  paletteOpen: boolean; // ⌘K command palette
  dataMode: DataMode; // resolved from /api/settings on load
  session: string; // signed session token from access-code login (persisted)
  auth: AuthState; // gate state: checking → locked (login page) | open
  loginError: string | null;
  serverSettings: PublicSettings | null;

  kpis: Kpis | null;
  feeds: Record<TriggerKind, TriggerItem[]>;
  ingestion: IngestionRun[];

  resume: BorrowerResume | null;
  resumeOpen: boolean;

  /** CRM: saved leads keyed by entity id (persisted) */
  pipeline: Record<string, Lead>;
  dismissed: string[]; // trigger ids (persisted)

  setView: (v: View) => void;
  setMobileNav: (open: boolean) => void;
  toggleCollapsed: () => void;
  toggleTheme: () => void;
  setPalette: (open: boolean) => void;
  setDataMode: (m: DataMode) => void;
  login: (code: string) => Promise<void>;
  logout: () => void;
  loadAll: () => Promise<void>;
  openResume: (entityId: string, fromItem?: TriggerItem) => Promise<void>;
  closeResume: () => void;

  toggleWatch: (entityId: string, entityName?: string) => void;
  setLeadStage: (entityId: string, stage: PipelineStage) => void;
  setLeadNote: (entityId: string, note: string) => void;
  setLeadFollowUp: (entityId: string, date: string | null) => void;
  setLeadValue: (entityId: string, value: number | null) => void;
  logLeadActivity: (entityId: string, kind: LeadActivity["kind"], text: string) => void;

  dismissTrigger: (id: string) => void;
  markContacted: (id: string) => void;
}

const emptyFeeds: Record<TriggerKind, TriggerItem[]> = {
  maturity: [],
  cash_poor: [],
  permit: [],
  lien: [],
};

export const STAGES: { id: PipelineStage; label: string }[] = [
  { id: "watching", label: "Watching" },
  { id: "outreach", label: "Outreach" },
  { id: "term_sheet", label: "Term Sheet" },
  { id: "funded", label: "Funded" },
  { id: "lost", label: "Lost" },
];

function newLead(entityId: string, entityName: string): Lead {
  const now = new Date().toISOString();
  return {
    entityId,
    entityName,
    stage: "watching",
    note: "",
    followUp: null,
    dealValue: null,
    addedAt: now,
    activities: [{ ts: now, kind: "added", text: "Saved to pipeline" }],
  };
}

function withActivity(lead: Lead, kind: LeadActivity["kind"], text: string): Lead {
  return {
    ...lead,
    activities: [{ ts: new Date().toISOString(), kind, text }, ...lead.activities].slice(0, 50),
  };
}

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      view: "dashboard",
      mobileNavOpen: false,
      collapsed: false,
      theme: "dark",
      loading: true,
      paletteOpen: false,
      dataMode: "offline",
      session: "",
      auth: "checking",
      loginError: null,
      serverSettings: null,

      kpis: null,
      feeds: emptyFeeds,
      ingestion: [],

      resume: null,
      resumeOpen: false,

      pipeline: {},
      dismissed: [],

      setView: (view) => set({ view, mobileNavOpen: false }),
      setMobileNav: (mobileNavOpen) => set({ mobileNavOpen }),
      toggleCollapsed: () => set({ collapsed: !get().collapsed }),
      toggleTheme: () => {
        const theme: Theme = get().theme === "dark" ? "light" : "dark";
        applyTheme(theme);
        set({ theme });
      },
      setPalette: (paletteOpen) => set({ paletteOpen }),
      setDataMode: (dataMode) => set({ dataMode }),

      login: async (code) => {
        set({ loginError: null });
        const res = await loginWithCode(code);
        if (!res.ok) {
          set({
            loginError:
              res.error === "invalid_code"
                ? "That code isn't right — check with your administrator."
                : "Can't reach the server. Try again in a moment.",
          });
          return;
        }
        setSessionToken(res.token);
        set({ session: res.token, auth: "open" });
        void get().loadAll();
      },

      logout: () => {
        setSessionToken("");
        set({ session: "", auth: "locked", kpis: null, feeds: emptyFeeds });
      },

      loadAll: async () => {
        set({ loading: true });
        setSessionToken(get().session);
        // Probe the API: offline → bundled demo, 401 → login page, ok → data.
        const probe = await probeSettings();
        if (probe.status === "unauthorized") {
          set({ auth: "locked", loading: false });
          return;
        }
        const settings = probe.status === "ok" ? probe.settings : null;
        const mode: DataMode = settings?.dataMode ?? "offline";
        set({ auth: "open", serverSettings: settings });
        const [kpis, maturity, cashPoor, permit, lien, ingestion] = await Promise.all([
          getKpis(mode),
          getFeed("maturity", mode),
          getFeed("cash_poor", mode),
          getFeed("permit", mode),
          getFeed("lien", mode),
          getIngestionStatus(mode),
        ]);
        set({
          dataMode: mode,
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

      toggleWatch: (entityId, entityName) => {
        const { pipeline } = get();
        if (pipeline[entityId]) {
          const next = { ...pipeline };
          delete next[entityId];
          set({ pipeline: next });
          void syncLeadRemove(entityId);
        } else {
          const lead = newLead(entityId, entityName ?? entityId);
          set({ pipeline: { ...pipeline, [entityId]: lead } });
          void syncLeadUpsert(lead);
        }
      },

      setLeadStage: (entityId, stage) => {
        const lead = get().pipeline[entityId];
        if (!lead || lead.stage === stage) return;
        const label = STAGES.find((s) => s.id === stage)?.label ?? stage;
        const next = withActivity({ ...lead, stage }, "stage", `Moved to ${label}`);
        set({ pipeline: { ...get().pipeline, [entityId]: next } });
        void syncLeadUpsert(next);
      },

      setLeadNote: (entityId, note) => {
        const lead = get().pipeline[entityId];
        if (!lead || lead.note === note) return;
        const next = withActivity({ ...lead, note }, "note", "Note updated");
        set({ pipeline: { ...get().pipeline, [entityId]: next } });
        void syncLeadUpsert(next);
      },

      setLeadFollowUp: (entityId, date) => {
        const lead = get().pipeline[entityId];
        if (!lead || lead.followUp === date) return;
        const next = withActivity(
          { ...lead, followUp: date },
          "follow_up",
          date ? `Follow-up set for ${date}` : "Follow-up cleared"
        );
        set({ pipeline: { ...get().pipeline, [entityId]: next } });
        void syncLeadUpsert(next);
      },

      setLeadValue: (entityId, value) => {
        const lead = get().pipeline[entityId];
        if (!lead || lead.dealValue === value) return;
        const next = withActivity(
          { ...lead, dealValue: value },
          "note",
          value != null ? `Deal size set to $${value.toLocaleString("en-US")}` : "Deal size cleared"
        );
        set({ pipeline: { ...get().pipeline, [entityId]: next } });
        void syncLeadUpsert(next);
      },

      logLeadActivity: (entityId, kind, text) => {
        const lead = get().pipeline[entityId];
        if (!lead) return;
        set({ pipeline: { ...get().pipeline, [entityId]: withActivity(lead, kind, text) } });
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
      version: 2,
      partialize: (s) => ({
        pipeline: s.pipeline,
        dismissed: s.dismissed,
        collapsed: s.collapsed,
        theme: s.theme,
        session: s.session,
      }),
      migrate: (persisted, version) => {
        const state = persisted as Record<string, unknown>;
        // v0 stored `watchlist: string[]` — promote to full pipeline leads.
        if (version === 0 && Array.isArray(state.watchlist)) {
          state.pipeline = Object.fromEntries(
            (state.watchlist as string[]).map((id) => [id, newLead(id, id)])
          );
          delete state.watchlist;
        }
        // v1 stored a separate adminToken — superseded by the login session.
        if (version <= 1) delete state.adminToken;
        return state as never;
      },
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme);
      },
    }
  )
);

/** Stamp the theme on <html>; index.html pre-paint script reads the same store key. */
function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

/** Feed rows minus anything the user dismissed. */
export function useVisibleFeed(kind: TriggerKind): TriggerItem[] {
  const feed = useApp((s) => s.feeds[kind]);
  const dismissed = useApp((s) => s.dismissed);
  return feed.filter((t) => !dismissed.includes(t.id));
}

/** The strongest live trigger per saved entity — used to enrich board cards. */
export function useBestSignal(entityId: string): TriggerItem | null {
  const feeds = useApp((s) => s.feeds);
  let best: TriggerItem | null = null;
  Object.values(feeds)
    .flat()
    .forEach((t) => {
      if (t.entity.id === entityId && (!best || t.score > best.score)) best = t;
    });
  return best;
}
