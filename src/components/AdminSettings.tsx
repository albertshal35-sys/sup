/**
 * Settings — data source mode, per-connector ingestion setup (vendor API
 * or headless-browser scraping), AI pipeline, coverage markets.
 * Authentication is the app-wide access code; no separate admin token.
 */

import { useCallback, useEffect, useState } from "react";
import { useApp } from "../store";
import { admin, offlineAdminData, probeSettings } from "../lib/api";
import type {
  BackfillRow,
  ConnectorInfo,
  CustomSignal,
  DataQuality,
  OutreachDefaults,
  UnderwritingDefaults,
} from "../types";
import { UNDERWRITING_FALLBACK } from "./QuoteModal";
import { ago, classNames, money } from "../lib/format";
import { Toggle, TextField, TextArea, Select, Modal } from "./ui";
import { IconAlert, IconChevronRight, IconHelp, IconPulse, IconX } from "./icons";
import { Sparkles } from "lucide-react";

function Section({
  title,
  sub,
  children,
  onHelp,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
  onHelp?: () => void;
}) {
  return (
    <section className="card p-5">
      <div className="flex items-center gap-1.5">
        <h3 className="text-[13px] font-semibold text-tx1">{title}</h3>
        {onHelp && (
          <button
            onClick={onHelp}
            aria-label={`How to set up ${title}`}
            title="Setup guide"
            className="rounded-full p-0.5 text-tx3 transition-colors hover:bg-raised hover:text-accent"
          >
            <IconHelp className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {sub && <p className="mt-1 max-w-xl text-2xs text-tx3">{sub}</p>}
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

/* --------------------------- setup guide --------------------------- */

function GuideStep({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-2xs font-bold tabular-nums text-accent">
        {n}
      </span>
      <div className="min-w-0">
        <div className="text-xs font-semibold text-tx1">{title}</div>
        <div className="mt-0.5 text-2xs leading-relaxed text-tx2">{children}</div>
      </div>
    </li>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-raised px-1 py-0.5 font-mono text-[10px] text-tx1">{children}</code>
  );
}

function SetupGuideModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Setting up live data" maxWidth="max-w-xl">
      <ol className="flex flex-col gap-4">
        <GuideStep n={1} title="Deploy & lock the app">
          Merges to main auto-deploy (needs <Code>CLOUDFLARE_API_TOKEN</Code> +{" "}
          <Code>CLOUDFLARE_ACCOUNT_ID</Code> GitHub secrets). Set your login code once:{" "}
          <Code>npx wrangler secret put ACCESS_CODE --config worker/wrangler.toml</Code>. Everyone
          with the code gets in; it also encrypts stored vendor keys.
        </GuideStep>
        <GuideStep n={2} title="Enable the headless browser (scraping)">
          Scrape mode uses Cloudflare Browser Rendering — a managed headless Chrome fleet. It
          reuses the same <Code>CLOUDFLARE_API_TOKEN</Code> + <Code>CLOUDFLARE_ACCOUNT_ID</Code>{" "}
          GitHub secrets that power deploys (the workflow injects both into the Worker
          automatically) — just make sure the token also has the{" "}
          <em>Browser Rendering: Edit</em> permission, then redeploy. The status line in the AI
          pipeline card below confirms when it's active.
        </GuideStep>
        <GuideStep n={3} title="Route AI through your Gateway">
          Workers AI ships with the deploy (model <Code>@cf/moonshotai/kimi-k2.6</Code>). In the
          Cloudflare dashboard: AI → AI Gateway → Create gateway, then paste its ID in the AI
          pipeline card — every extraction and brief routes through it for centralized billing,
          caching and logs.
        </GuideStep>
        <GuideStep n={4} title="Point each source at NYC">
          For ACRIS deeds/mortgages and DOB permits, prefer <em>Vendor API</em> mode with the free
          NYC Open Data endpoints (see suggested sources on each card). For portals without APIs —
          Richmond County Clerk, borough clerk lien indexes — pick <em>Scrape</em>, paste the
          search-results URL, and use the notes box to tell the AI what to look for (document
          types, date filters, county quirks). Enable each connector when configured.
        </GuideStep>
        <GuideStep n={5} title="Test with Run now">
          Each card's <em>Run now</em> triggers that connector immediately; status, row counts and
          retries appear on the card and in the Data Pipeline tile on Command. Failures are audited
          with the error message.
        </GuideStep>
        <GuideStep n={6} title="Go fully live">
          The pipeline runs automatically every weekday at 11:00 UTC (~6/7am NYC). Once real
          records flow, purge the demo rows above — the Live badge in the top bar confirms
          everything on screen is real.
        </GuideStep>
      </ol>
    </Modal>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "ok"
      ? "text-ok"
      : status === "partial"
        ? "text-warn"
        : status === "running"
          ? "text-accent"
          : "text-danger";
  return <span className={classNames("text-2xs font-medium capitalize", tone)}>{status}</span>;
}

/** NYC-first sources per connector. ACRIS + DOB publish free Socrata APIs
    on NYC Open Data — prefer API mode there; scrape covers the rest. */
const SUGGESTED_SOURCES: Record<string, string[]> = {
  county_deeds: [
    "★ NYC Open Data (free API) — ACRIS Real Property Master + Legals + Parties, data.cityofnewyork.us — covers Manhattan, Brooklyn, Queens, Bronx",
    "ACRIS document search (scrape) — a836-acris.nyc.gov",
    "Staten Island: Richmond County Clerk (scrape) — richmondcountyclerk.com",
  ],
  county_loans: [
    "★ Same ACRIS Open Data datasets filtered to doc type MTGE / AGMT (mortgages & agreements)",
    "ACRIS document search (scrape) for recorded mortgage docs incl. lender + amount",
  ],
  permits: [
    "★ NYC Open Data (free API) — DOB NOW: Build Job Application Filings + DOB Permit Issuance",
    "DOB NOW / BIS portals (scrape) — a810-dobnow.nyc.gov",
    "Alteration Type 1/2 + New Building (NB) filings = your ground-up & structural signals",
  ],
  liens: [
    "Mechanics liens are filed with each borough's County Clerk — scrape the clerk minutes/indexes",
    "ACRIS captures many NYC lien documents — filter doc class LIEN / UCC",
  ],
  lis_pendens: [
    "★ The single best rescue-capital lead: lis pendens = pre-foreclosure",
    "Filed with each borough's County Clerk / Supreme Court — NYSCEF & eCourts (scrape)",
    "PropertyShark and ACRIS surface many LP filings for the outer boroughs",
  ],
  violations: [
    "★ NYC Open Data (free API) — DOB Violations + ECB Violations datasets",
    "HPD Violations & Vacate Orders (also on NYC Open Data) — deeper distress",
  ],
  tax_liens: [
    "★ NYC Open Data (free API) — DOF Tax Lien Sale lists (published annually, updated ahead of the sale)",
  ],
  auctions: [
    "Borough Supreme Court foreclosure auction calendars (scrape) — auction buyers are all-cash by definition",
    "ny.courtlistener / court websites publish weekly auction schedules",
  ],
  satisfactions: [
    "★ ACRIS Open Data filtered to doc type SAT (satisfaction of mortgage) — free API",
    "A payoff means they're refinancing or sitting unencumbered — and a competitor's book is running off",
  ],
  ucc_filings: [
    "NY DOS UCC search (scrape) — appstext.dos.ny.gov; secured party = the competitor lender",
    "ACRIS UCC classes cover fixture filings on NYC real property",
  ],
  corp_registry: [
    "★ data.ny.gov (free API) — Active Corporations dataset: formation dates + registered agents",
    "Feeds entity resolution: catches borrowers operating under LLC name variants",
  ],
  skip_trace: [
    "Apollo.io (api.apollo.io) — people/organization match",
    "Alternatives: BatchSkipTracing, Clearbit, PeopleDataLabs",
  ],
};

/** Keep 12 connectors approachable: grouped, with only enabled/relevant cards expanded. */
const CONNECTOR_GROUPS: Array<{ title: string; sub: string; ids: string[] }> = [
  {
    title: "Core records",
    sub: "Deeds, mortgages, permits and liens — the four feeds.",
    ids: ["county_deeds", "county_loans", "permits", "liens"],
  },
  {
    title: "Distress signals",
    sub: "Pre-foreclosure and stalled-project events; all flow into the Distress feed.",
    ids: ["lis_pendens", "violations", "tax_liens", "auctions"],
  },
  {
    title: "Market intelligence",
    sub: "Loan lifecycle and competitor activity; powers the Lenders view and entity resolution.",
    ids: ["satisfactions", "ucc_filings", "corp_registry"],
  },
  {
    title: "Enrichment",
    sub: "Contact data for matched borrowers.",
    ids: ["skip_trace"],
  },
];

const MODE_OPTIONS = [
  { value: "scrape" as const, label: "Scrape (headless browser + AI)", hint: "for gov portals" },
  { value: "api" as const, label: "Vendor API", hint: "normalized JSON feed" },
];

function ConnectorCard({ connector, onChanged }: { connector: ConnectorInfo; onChanged: () => void }) {
  const [open, setOpen] = useState(connector.enabled);
  const [baseUrl, setBaseUrl] = useState(connector.baseUrl ?? "");
  const [scrapeUrl, setScrapeUrl] = useState(connector.scrapeUrl ?? "");
  const [notes, setNotes] = useState(connector.notes ?? "");
  const [fieldMap, setFieldMap] = useState(connector.fieldMap ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [diag, setDiag] = useState<Array<{ label: string; ok: boolean; detail: string }> | null>(null);
  const scrape = connector.mode === "scrape";

  const save = async (patch: Parameters<typeof admin.saveConnector>[1]) => {
    setBusy(true);
    const res = await admin.saveConnector(connector.id, patch);
    setNote(res.ok ? "Saved" : `Error: ${res.error}`);
    setBusy(false);
    if (res.ok) {
      setApiKey("");
      onChanged();
    }
    setTimeout(() => setNote(null), 2500);
  };

  const run = async () => {
    setBusy(true);
    const res = await admin.runConnector(connector.id);
    setNote(res.ok ? "Run started" : `Error: ${res.error}`);
    setBusy(false);
    setTimeout(() => {
      setNote(null);
      onChanged();
    }, 2500);
  };

  return (
    <div className="rounded-xl border border-line bg-raised/40 p-3.5">
      <div className="flex items-center justify-between gap-3">
        <button onClick={() => setOpen(!open)} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-tx1">
            <IconChevronRight
              className={classNames("h-3 w-3 shrink-0 text-tx3 transition-transform", open && "rotate-90")}
            />
            <span className="truncate">{connector.label}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 pl-[18px] text-2xs text-tx3">
            {connector.lastRun ? (
              <>
                <StatusPill status={connector.lastRun.status} />
                <span>
                  {connector.lastRun.rowsIngested.toLocaleString()} rows
                  {connector.lastRun.finishedAt && ` · ${ago(connector.lastRun.finishedAt)}`}
                </span>
              </>
            ) : (
              <span>never run</span>
            )}
            {note && <span className="text-accent">{note}</span>}
          </div>
          {connector.lastRun?.status === "failed" && connector.lastRun.error && (
            <div className="mt-1 pl-[18px] text-2xs text-danger">
              Last run failed: {connector.lastRun.error}
            </div>
          )}
          {connector.lastRun?.status === "ok" && connector.lastRun.rowsIngested === 0 && (connector.lastRun.rowsSkipped ?? 0) > 0 && (
            <div className="mt-1 pl-[18px] text-2xs text-warn">
              0 ingested, {connector.lastRun.rowsSkipped} skipped/quarantined — run Test source below, and check Data quality.
            </div>
          )}
        </button>
        <Toggle
          checked={connector.enabled}
          disabled={busy}
          label={`Enable ${connector.label}`}
          onChange={(enabled) => void save({ enabled })}
        />
      </div>

      {open && (
      <>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[240px_1fr]">
        <div className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-tx3">Source type</span>
          <Select
            size="sm"
            value={connector.mode}
            options={connector.id === "skip_trace" ? MODE_OPTIONS.slice(1) : MODE_OPTIONS}
            onChange={(mode) => void save({ mode })}
          />
        </div>
        {scrape ? (
          <div className="flex flex-col gap-1">
            <span className="text-2xs font-medium text-tx3">Portal URL to scrape</span>
            <TextField
              value={scrapeUrl}
              onChange={setScrapeUrl}
              onBlur={() => {
                if (scrapeUrl !== (connector.scrapeUrl ?? "")) void save({ scrapeUrl });
              }}
              placeholder="https://a836-acris.nyc.gov/DS/DocumentSearch/…"
            />
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <span className="text-2xs font-medium text-tx3">Vendor base URL</span>
            <TextField
              value={baseUrl}
              onChange={setBaseUrl}
              onBlur={() => {
                if (baseUrl !== (connector.baseUrl ?? "")) void save({ baseUrl });
              }}
              placeholder="https://api.vendor.com/v2"
            />
          </div>
        )}
      </div>

      {!scrape && connector.isSocrata && (
        <div className="mt-2 flex flex-col gap-1">
          <span className="flex items-center justify-between text-2xs font-medium text-tx3">
            <span>
              Field mapping <span className="text-tx3">(open-data source detected — target field → dataset field)</span>
            </span>
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const res = await admin.automapConnector(connector.id);
                if (res.ok) {
                  setFieldMap(JSON.stringify(res.data.fieldMap));
                  setNote("Fields mapped by AI — review below");
                  onChanged();
                } else setNote(`Auto-map failed: ${res.error}`);
                setBusy(false);
                setTimeout(() => setNote(null), 3500);
              }}
              className="flex items-center gap-1 rounded border border-violet/30 bg-violet/10 px-1.5 py-0.5 font-medium text-violet transition-colors hover:bg-violet/20 disabled:opacity-40"
            >
              <Sparkles strokeWidth={1.75} className="h-3 w-3" />
              Auto-map with AI
            </button>
          </span>
          <TextArea
            value={fieldMap}
            onChange={setFieldMap}
            onBlur={() => {
              if (fieldMap !== (connector.fieldMap ?? "")) void save({ fieldMap });
            }}
            rows={2}
            placeholder='{"dateField":"recorded_datetime","map":{"docNumber":"document_id","price":"doc_amount","state":"=NY",…}}'
            className="font-mono text-[11px]"
          />
        </div>
      )}

      {!scrape && (
        <div className="mt-2 flex flex-col gap-1">
          <span className="text-2xs font-medium text-tx3">
            API key{" "}
            {connector.apiKeyLast4 && (
              <span className="tabular-nums text-tx3">(configured ····{connector.apiKeyLast4})</span>
            )}
          </span>
          <div className="flex gap-2">
            <TextField
              type="password"
              value={apiKey}
              onChange={setApiKey}
              placeholder={connector.apiKeyLast4 ? "Replace key…" : "Paste vendor key…"}
            />
            <button
              disabled={!apiKey || busy}
              onClick={() => void save({ apiKey })}
              className="shrink-0 rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </div>
      )}

      <div className="mt-2 flex flex-col gap-1">
        <span className="text-2xs font-medium text-tx3">
          Notes for the pipeline{scrape && " (fed to the AI normalizer)"}
        </span>
        <TextArea
          value={notes}
          onChange={setNotes}
          onBlur={() => {
            if (notes !== (connector.notes ?? "")) void save({ notes });
          }}
          placeholder="Anything this source needs: search filters to apply, county quirks, document types, login hints…"
        />
      </div>

      {SUGGESTED_SOURCES[connector.id] && (
        <div className="mt-2 rounded-lg border border-dashed border-line px-3 py-2">
          <div className="text-2xs font-medium text-tx3">Suggested sources</div>
          <ul className="mt-1 flex flex-col gap-0.5">
            {SUGGESTED_SOURCES[connector.id].map((s) => (
              <li key={s} className="text-2xs text-tx3">
                · {s}
              </li>
            ))}
          </ul>
        </div>
      )}

      {diag && (
        <div className="mt-3 rounded-lg border border-line bg-surface px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-2xs font-semibold text-tx2">Diagnostics</span>
            <button onClick={() => setDiag(null)} className="text-2xs text-tx3 hover:text-tx1">dismiss</button>
          </div>
          <ol className="mt-1.5 flex flex-col gap-1">
            {diag.map((d, i) => (
              <li key={i} className="flex items-start gap-2 text-2xs">
                <span className={d.ok ? "text-ok" : "text-danger"}>{d.ok ? "✓" : "✕"}</span>
                <span className="min-w-0">
                  <span className="font-medium text-tx1">{d.label}:</span>{" "}
                  <span className="break-words text-tx2">{d.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-2.5">
        <span className="text-2xs text-tx3">Runs weekdays 11:00 UTC · 3 retries · gated & audited</span>
        <div className="flex items-center gap-1.5">
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setDiag([{ label: "Testing", ok: true, detail: "dry run — nothing is written…" }]);
              const res = await admin.testConnector(connector.id);
              setDiag(res.ok ? res.data.steps : [{ label: "Test", ok: false, detail: res.error }]);
              setBusy(false);
            }}
            className="rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-1 text-2xs font-medium text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
          >
            Test source
          </button>
          <button
            disabled={busy || !connector.enabled}
            onClick={() => void run()}
            className="rounded-lg border border-line bg-surface px-2.5 py-1 text-2xs font-medium text-tx2 transition-colors hover:text-tx1 disabled:opacity-40"
          >
            Run now
          </button>
        </div>
      </div>
      </>
      )}
    </div>
  );
}

export function SettingsView() {
  const dataMode = useApp((s) => s.dataMode);
  const setDataMode = useApp((s) => s.setDataMode);
  const serverSettings = useApp((s) => s.serverSettings);
  const loadAll = useApp((s) => s.loadAll);

  const [connectors, setConnectors] = useState<ConnectorInfo[] | null>(null);
  const [markets, setMarkets] = useState<string[]>(serverSettings?.markets ?? []);
  const [newMarket, setNewMarket] = useState("");
  const [gatewayId, setGatewayId] = useState(serverSettings?.aiGatewayId ?? "");
  const [apiUp, setApiUp] = useState<boolean | null>(serverSettings ? true : null);
  const [purgeArmed, setPurgeArmed] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [alertsEnabled, setAlertsEnabled] = useState(serverSettings?.alertsEnabled ?? false);
  const [alertEmail, setAlertEmail] = useState(serverSettings?.alertEmail ?? "");
  const [uw, setUw] = useState<UnderwritingDefaults>(serverSettings?.underwriting ?? UNDERWRITING_FALLBACK);
  const [outreachCfg, setOutreachCfg] = useState<OutreachDefaults>(
    serverSettings?.outreach ?? {
      senderName: "",
      company: "",
      signature: "",
      defaultChannel: "email",
    }
  );

  const [dq, setDq] = useState<DataQuality | null>(null);
  const [signals, setSignals] = useState<CustomSignal[] | null>(null);
  const [backfill, setBackfill] = useState<{ backfills: BackfillRow[]; eligible: string[] } | null>(null);

  const refresh = useCallback(async () => {
    const probe = await probeSettings();
    setApiUp(probe.status === "ok");
    if (probe.status !== "ok") {
      // Offline preview: show the surfaces with sample content so the
      // product is explorable without a deployed Worker.
      setDq(offlineAdminData.dataQuality);
      setSignals(offlineAdminData.signals);
      setBackfill(null);
      return;
    }
    setMarkets(probe.settings.markets);
    setGatewayId(probe.settings.aiGatewayId);
    setAlertsEnabled(probe.settings.alertsEnabled);
    setAlertEmail(probe.settings.alertEmail);
    if (probe.settings.underwriting) setUw(probe.settings.underwriting);
    if (probe.settings.outreach) setOutreachCfg(probe.settings.outreach);
    const [res, dqRes, sigRes, bfRes] = await Promise.all([
      admin.getConnectors(),
      admin.getDataQuality(),
      admin.getSignals(),
      admin.getBackfill(),
    ]);
    setConnectors(res.ok ? res.data.connectors : null);
    setDq(dqRes);
    setSignals(sigRes);
    setBackfill(bfRes);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const flash = (msg: string) => {
    setBanner(msg);
    setTimeout(() => setBanner(null), 3000);
  };

  const switchMode = async (live: boolean) => {
    const target = live ? "live" : "demo";
    const res = await admin.saveSettings({ dataMode: target });
    if (res.ok) {
      setDataMode(target);
      flash(target === "live" ? "Live mode on — feeds now show only real records." : "Demo mode on.");
      void loadAll();
    } else {
      flash(`Could not switch mode: ${res.error}`);
    }
  };

  const purge = async () => {
    if (!purgeArmed) {
      setPurgeArmed(true);
      setTimeout(() => setPurgeArmed(false), 4000);
      return;
    }
    const res = await admin.purgeDemo();
    setPurgeArmed(false);
    flash(res.ok ? `Purged ${res.data.deleted} sample rows.` : `Purge failed: ${res.error}`);
    void loadAll();
  };

  const addMarket = async () => {
    const m = newMarket.trim();
    if (!m || markets.includes(m)) return;
    const next = [...markets, m];
    const res = await admin.saveSettings({ markets: next });
    if (res.ok) {
      setMarkets(next);
      setNewMarket("");
    } else flash(`Could not save market: ${res.error}`);
  };

  const removeMarket = async (m: string) => {
    const next = markets.filter((x) => x !== m);
    const res = await admin.saveSettings({ markets: next });
    if (res.ok) setMarkets(next);
  };

  const offline = apiUp === false;

  return (
    <div className="flex max-w-3xl flex-col gap-3">
      {banner && (
        <div className="animate-fade-up rounded-xl border border-accent/25 bg-accent/10 px-4 py-2.5 text-xs text-accent">
          {banner}
        </div>
      )}

      {offline && (
        <div className="flex items-start gap-2.5 rounded-xl border border-warn/25 bg-warn/10 px-4 py-3 text-xs text-warn">
          <IconAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            The Worker API is not reachable, so the app is running on bundled sample data. Deploy
            it (<code className="font-mono">npm run deploy</code>) to manage live data sources here.
          </span>
        </div>
      )}

      {/* Data source */}
      <Section
        title="Data source"
        sub="Live mode (default) shows only real records ingested from your configured sources. Demo mode overlays the bundled sample dataset for exploring the product."
      >
        <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-raised/40 px-4 py-3">
          <div>
            <div className="text-xs font-semibold text-tx1">
              {dataMode === "live" ? "Live data" : "Sample data"}
            </div>
            <div className="text-2xs text-tx3">
              {dataMode === "live"
                ? "Feeds reflect records pulled by the scheduled pipeline."
                : "Feeds include seeded demo borrowers and signals."}
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <span className={classNames("text-2xs font-medium", dataMode !== "live" ? "text-warn" : "text-tx3")}>
              Demo
            </span>
            <Toggle
              checked={dataMode === "live"}
              disabled={offline}
              label="Live data"
              onChange={(v) => void switchMode(v)}
            />
            <span className={classNames("text-2xs font-medium", dataMode === "live" ? "text-ok" : "text-tx3")}>
              Live
            </span>
          </div>
        </div>
        <div className="mt-2.5 flex items-center justify-between gap-3">
          <p className="text-2xs text-tx3">
            Permanently delete the seeded sample rows (entities, signals, deeds, loans, permits,
            liens). Your saved pipeline is not affected.
          </p>
          <button
            onClick={() => void purge()}
            disabled={offline}
            className={classNames(
              "shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40",
              purgeArmed
                ? "border-danger bg-danger/15 text-danger"
                : "border-danger/30 bg-danger/10 text-danger hover:bg-danger/20"
            )}
          >
            {purgeArmed ? "Click again to confirm" : "Purge demo data"}
          </button>
        </div>
      </Section>

      {/* Data sources / connectors */}
      <Section
        title="Data sources"
        onHelp={() => setGuideOpen(true)}
        sub="One connector per source. Government recorder and permit portals rarely offer APIs — set those to Scrape: a Cloudflare headless browser renders the page on schedule and the AI pipeline extracts clean records from it. Vendor keys are encrypted at rest (AES-GCM)."
      >
        {connectors ? (
          <div className="flex flex-col gap-4">
            {CONNECTOR_GROUPS.map((group) => {
              const cards = connectors.filter((c) => group.ids.includes(c.id));
              if (cards.length === 0) return null;
              return (
                <div key={group.title}>
                  <div className="flex items-baseline gap-2">
                    <h4 className="text-xs font-semibold text-tx1">{group.title}</h4>
                    <span className="truncate text-2xs text-tx3">{group.sub}</span>
                  </div>
                  <div className="mt-2 flex flex-col gap-2">
                    {cards.map((c) => (
                      <ConnectorCard key={c.id} connector={c} onChanged={() => void refresh()} />
                    ))}
                  </div>
                </div>
              );
            })}
            <button
              onClick={async () => {
                const res = await admin.runAll();
                flash(res.ok ? "Full pipeline run started." : `Error: ${res.error}`);
              }}
              className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-line py-2.5 text-xs font-medium text-tx2 transition-colors hover:border-accent/40 hover:text-accent"
            >
              <IconPulse className="h-3.5 w-3.5" /> Run full pipeline now
            </button>
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-tx3">
            {offline ? "Connector management requires the deployed Worker." : "Loading connectors…"}
          </p>
        )}
      </Section>

      {/* Data quality */}
      <Section
        title="Data quality"
        onHelp={() => setGuideOpen(true)}
        sub="Every record passes validation gates before it can touch your database; failures wait here for review. Scraped records additionally pass an AI grounding check against the source page. Freshness monitoring flags sources whose volume collapses versus their own baseline."
      >
        {dq ? (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-3 gap-2.5">
              {[
                { label: "Ingested · 7d", value: dq.ingested7d.toLocaleString(), tone: "text-tx1" },
                { label: "Quarantined · 7d", value: dq.quarantined7d.toLocaleString(), tone: "text-tx1" },
                { label: "Awaiting review", value: String(dq.pendingQuarantine), tone: dq.pendingQuarantine > 0 ? "text-warn" : "text-tx1" },
              ].map((s) => (
                <div key={s.label} className="rounded-xl border border-line bg-raised/40 px-3.5 py-2.5">
                  <div className="text-2xs font-medium text-tx3">{s.label}</div>
                  <div className={classNames("mt-0.5 font-display text-lg font-bold tabular-nums", s.tone)}>{s.value}</div>
                </div>
              ))}
            </div>

            {dq.anomalies.length > 0 && (
              <div className="rounded-xl border border-danger/25 bg-danger/[0.06] px-3.5 py-2.5">
                <div className="text-2xs font-semibold text-danger">Source anomalies</div>
                {dq.anomalies.map((a) => (
                  <p key={a.connector} className="mt-1 text-2xs text-tx2">
                    <span className="font-mono">{a.connector}</span> returned {a.today} rows today vs a ~{a.baseline}/day baseline — the source may be broken.
                  </p>
                ))}
              </div>
            )}

            {dq.quarantine.length > 0 && (
              <div>
                <div className="text-2xs font-semibold text-tx2">Quarantined records</div>
                <div className="mt-1.5 flex flex-col gap-1.5">
                  {dq.quarantine.map((q) => (
                    <div key={q.id} className="rounded-xl border border-line bg-raised/40 px-3.5 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-xs font-medium text-tx1">
                          {String(q.payload.buyerName ?? q.payload.borrowerName ?? q.payload.ownerName ?? q.payload.entityName ?? "Unnamed record")}
                          <span className="ml-1.5 font-mono text-[10px] text-tx3">{q.connector} · {q.recordKind}</span>
                        </span>
                        <div className="flex shrink-0 gap-1.5">
                          <button
                            disabled={offline}
                            onClick={async () => {
                              const res = await admin.quarantineAction(q.id, "approve");
                              flash(res.ok ? "Record approved and ingested." : `Error: ${res.error}`);
                              void refresh();
                            }}
                            className="rounded border border-ok/30 bg-ok/10 px-2 py-0.5 text-2xs font-medium text-ok transition-colors hover:bg-ok/20 disabled:opacity-40"
                          >
                            Approve
                          </button>
                          <button
                            disabled={offline}
                            onClick={async () => {
                              const res = await admin.quarantineAction(q.id, "discard");
                              flash(res.ok ? "Record discarded." : `Error: ${res.error}`);
                              void refresh();
                            }}
                            className="rounded border border-line px-2 py-0.5 text-2xs font-medium text-tx3 transition-colors hover:text-danger disabled:opacity-40"
                          >
                            Discard
                          </button>
                        </div>
                      </div>
                      <ul className="mt-1 flex flex-col gap-0.5">
                        {q.reasons.map((r) => (
                          <li key={r} className="text-2xs text-warn">· {r}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {dq.merges.length > 0 && (
              <div>
                <div className="text-2xs font-semibold text-tx2">Possible duplicate borrowers</div>
                <div className="mt-1.5 flex flex-col gap-1.5">
                  {dq.merges.map((m) => (
                    <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-raised/40 px-3.5 py-2.5">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-tx1">
                          {m.nameA} <span className="text-tx3">↔</span> {m.nameB}
                        </div>
                        <div className="truncate text-2xs text-tx3">{m.reason}</div>
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        <button
                          disabled={offline}
                          onClick={async () => {
                            const res = await admin.mergeAction(m.id, "merge");
                            flash(res.ok ? "Entities merged." : `Error: ${res.error}`);
                            void refresh();
                            void loadAll();
                          }}
                          className="rounded border border-accent/30 bg-accent/10 px-2 py-0.5 text-2xs font-medium text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
                        >
                          Merge
                        </button>
                        <button
                          disabled={offline}
                          onClick={async () => {
                            await admin.mergeAction(m.id, "dismiss");
                            void refresh();
                          }}
                          className="rounded border border-line px-2 py-0.5 text-2xs font-medium text-tx3 transition-colors hover:text-tx1 disabled:opacity-40"
                        >
                          Not the same
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {dq.pendingQuarantine === 0 && dq.merges.length === 0 && dq.anomalies.length === 0 && (
              <p className="rounded-xl border border-dashed border-line px-4 py-4 text-center text-2xs text-tx3">
                All clear — nothing quarantined, no duplicate suspects, all sources at baseline volume.
              </p>
            )}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-tx3">
            Loading data-quality state…
          </p>
        )}
      </Section>

      {/* Custom signals */}
      <Section
        title="Custom signals"
        onHelp={() => setGuideOpen(true)}
        sub="Describe a trigger in plain English — the AI compiles it once into a deterministic rule you confirm. Every pull after that evaluates the rule with plain SQL (no AI involved), and hits appear on Command under “Your Signals”."
      >
        <SignalBuilder
          offline={offline}
          signals={signals ?? []}
          onChanged={() => {
            void refresh();
            void loadAll();
          }}
          flash={flash}
        />
      </Section>

      {/* Historical backfill */}
      <Section
        title="Historical backfill"
        onHelp={() => setGuideOpen(true)}
        sub="Walk each API source back 36 months so borrower resumes and rate history are complete, not just complete-from-today. Free-tier friendly: one month-window chunk at a time, continuing automatically after each daily pull."
      >
        {offline ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-tx3">
            Backfill requires the deployed Worker.
          </p>
        ) : backfill && (backfill.eligible.length > 0 || backfill.backfills.length > 0) ? (
          <div className="flex flex-col gap-1.5">
            {backfill.eligible.map((id) => {
              const state = backfill.backfills.find((b) => b.connector === id);
              return (
                <div key={id} className="flex items-center gap-3 rounded-xl border border-line bg-raised/40 px-3.5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs font-medium text-tx1">
                      <span className="font-mono">{id}</span>
                      {state && (
                        <span className={classNames(
                          "text-2xs capitalize",
                          state.status === "done" ? "text-ok" : state.status === "error" ? "text-danger" : "text-tx3"
                        )}>
                          {state.status}{state.status === "error" && state.error ? ` — ${state.error}` : ""}
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-line">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${state?.pctComplete ?? 0}%` }} />
                    </div>
                    {state && (
                      <div className="mt-1 text-2xs tabular-nums text-tx3">
                        {state.pctComplete}% · {state.rowsTotal.toLocaleString()} rows
                        {state.cursorDate && state.status === "running" && ` · crawled back to ${state.cursorDate}`}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={async () => {
                      const res = state?.status === "running"
                        ? await admin.chunkBackfill(id)
                        : await admin.startBackfill(id);
                      flash(res.ok ? "Backfill chunk pulled." : `Error: ${res.error}`);
                      void refresh();
                    }}
                    className="shrink-0 rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-1 text-2xs font-medium text-accent transition-colors hover:bg-accent/20"
                  >
                    {state?.status === "running" ? "Continue now" : state?.status === "done" ? "Re-run" : "Start 36-mo crawl"}
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-line px-4 py-4 text-center text-2xs text-tx3">
            No sources eligible yet — backfill needs an enabled API-mode connector (open-data sources also need a field mapping). Scraped portals can't be crawled historically.
          </p>
        )}
      </Section>

      {/* Alerts & digest */}
      <Section
        title="Alerts & daily digest"
        onHelp={() => setGuideOpen(true)}
        sub="After every pipeline run, email the critical picture: new high-urgency signals and notes crossing D-60. Quiet days send nothing. Requires a RESEND_API_KEY secret on the Worker."
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-2.5 rounded-xl border border-line bg-raised/40 px-4 py-2.5">
            <span className="text-xs font-medium text-tx1">Digest</span>
            <Toggle
              checked={alertsEnabled}
              disabled={offline}
              label="Alerts enabled"
              onChange={async (v) => {
                setAlertsEnabled(v);
                const res = await admin.saveSettings({ alertsEnabled: v });
                if (!res.ok) flash(`Could not save: ${res.error}`);
              }}
            />
          </div>
          <div className="min-w-[220px] flex-1">
            <span className="text-2xs font-medium text-tx3">Send to</span>
            <TextField
              value={alertEmail}
              onChange={setAlertEmail}
              onBlur={async () => {
                const res = await admin.saveSettings({ alertEmail });
                if (!res.ok) flash(`Could not save: ${res.error}`);
              }}
              placeholder="you@yourfund.com"
              disabled={offline}
              className="mt-1"
            />
          </div>
          <button
            disabled={offline || !alertEmail}
            onClick={async () => {
              const res = await admin.testAlerts();
              flash(res.ok ? "Test digest sent — check your inbox." : `Send failed: ${res.error}`);
            }}
            className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
          >
            Send test
          </button>
        </div>
        {serverSettings && !serverSettings.alertsConfigured && !offline && (
          <p className="mt-2 text-2xs text-warn">
            Set the email provider first: <code className="font-mono">npx wrangler secret put RESEND_API_KEY</code>
          </p>
        )}
      </Section>

      {/* Underwriting */}
      <Section
        title="Underwriting"
        onHelp={() => setGuideOpen(true)}
        sub="Defaults for the Quote & term-sheet engine on every borrower resume. The quoted rate starts at the borrower's last rate minus your spread."
      >
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {(
            [
              ["Rate spread", "pts under their last rate", "rateSpread"],
              ["Points", "% origination", "points"],
              ["Term", "months", "termMonths"],
              ["Max LTV", "% ceiling", "maxLtv"],
              ["Min loan", "$", "minLoan"],
              ["Quote valid", "days", "validDays"],
            ] as Array<[string, string, keyof UnderwritingDefaults]>
          ).map(([label, hint, key]) => (
            <div key={key}>
              <span className="text-2xs font-medium text-tx3">
                {label} <span className="text-tx3">({hint})</span>
              </span>
              <TextField
                value={String(uw[key])}
                onChange={(v) => setUw({ ...uw, [key]: Number(v.replace(/[^0-9.]/g, "")) || 0 })}
                onBlur={async () => {
                  const res = await admin.saveSettings({ underwriting: uw as unknown as Record<string, unknown> });
                  if (!res.ok) flash(`Could not save: ${res.error}`);
                }}
                className="mt-1 tabular-nums"
              />
            </div>
          ))}
          <div className="col-span-2">
            <span className="text-2xs font-medium text-tx3">Lender name on term sheets</span>
            <TextField
              value={uw.lenderName}
              onChange={(v) => setUw({ ...uw, lenderName: v })}
              onBlur={async () => {
                const res = await admin.saveSettings({ underwriting: uw as unknown as Record<string, unknown> });
                if (!res.ok) flash(`Could not save: ${res.error}`);
              }}
              className="mt-1"
            />
          </div>
        </div>
      </Section>

      {/* Outreach identity */}
      <Section
        title="Outreach identity"
        onHelp={() => setGuideOpen(true)}
        sub="Used by the AI outreach composer — who the drafts are from and the signature appended to emails."
      >
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <div>
            <span className="text-2xs font-medium text-tx3">Sender name</span>
            <TextField
              value={outreachCfg.senderName}
              placeholder="Your name"
              onChange={(v) => setOutreachCfg({ ...outreachCfg, senderName: v })}
              onBlur={async () => {
                const res = await admin.saveSettings({ outreach: outreachCfg as unknown as Record<string, unknown> });
                if (!res.ok) flash(`Could not save: ${res.error}`);
              }}
              className="mt-1"
            />
          </div>
          <div>
            <span className="text-2xs font-medium text-tx3">Company</span>
            <TextField
              value={outreachCfg.company}
              placeholder="Your fund"
              onChange={(v) => setOutreachCfg({ ...outreachCfg, company: v })}
              onBlur={async () => {
                const res = await admin.saveSettings({ outreach: outreachCfg as unknown as Record<string, unknown> });
                if (!res.ok) flash(`Could not save: ${res.error}`);
              }}
              className="mt-1"
            />
          </div>
          <div>
            <span className="text-2xs font-medium text-tx3">Email signature</span>
            <TextArea
              value={outreachCfg.signature}
              placeholder={"Name\nFund · phone"}
              onChange={(v) => setOutreachCfg({ ...outreachCfg, signature: v })}
              onBlur={async () => {
                const res = await admin.saveSettings({ outreach: outreachCfg as unknown as Record<string, unknown> });
                if (!res.ok) flash(`Could not save: ${res.error}`);
              }}
              rows={2}
              className="mt-1"
            />
          </div>
        </div>
      </Section>

      {/* AI pipeline */}
      <Section
        title="AI pipeline"
        onHelp={() => setGuideOpen(true)}
        sub="Workers AI analyzes scraped pages into structured records, enriches entities, and writes borrower briefs. Requests route through your Cloudflare AI Gateway for centralized billing, caching and logs."
      >
        <div className="flex items-center gap-2 rounded-xl border border-line bg-raised/40 px-4 py-3">
          <Sparkles strokeWidth={1.75} className="h-4 w-4 shrink-0 text-violet" />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-tx1">
              Model: <span className="font-mono text-2xs">@cf/moonshotai/kimi-k2.6</span>
            </div>
            <div className="text-2xs text-tx3">
              {serverSettings?.aiEnabled
                ? "Workers AI binding active."
                : "Deploy the Worker to activate the AI binding."}
              {serverSettings && !serverSettings.scrapingConfigured && (
                <> Scraping needs the CLOUDFLARE_API_TOKEN with Browser Rendering permission — see the setup guide.</>
              )}
            </div>
          </div>
        </div>
        <div className="mt-2.5 flex max-w-md items-end gap-2">
          <div className="flex-1">
            <span className="text-2xs font-medium text-tx3">AI Gateway ID</span>
            <TextField
              value={gatewayId}
              onChange={setGatewayId}
              placeholder="my-gateway"
              disabled={offline}
              className="mt-1"
            />
          </div>
          <button
            disabled={offline}
            onClick={async () => {
              const res = await admin.saveSettings({ aiGatewayId: gatewayId });
              flash(res.ok ? "AI Gateway saved." : `Error: ${res.error}`);
            }}
            className="shrink-0 rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </Section>

      <SetupGuideModal open={guideOpen} onClose={() => setGuideOpen(false)} />

      {/* Markets */}
      <Section
        title="Coverage markets"
        sub="Counties requested from every source on each run. Add markets as your coverage expands."
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {markets.map((m) => (
            <span
              key={m}
              className="group flex items-center gap-1 rounded-lg border border-accent/20 bg-accent/[0.07] px-2.5 py-1 text-xs text-accent"
            >
              {m}
              <button
                onClick={() => void removeMarket(m)}
                disabled={offline}
                aria-label={`Remove ${m}`}
                className="rounded p-0.5 opacity-50 hover:opacity-100 disabled:hidden"
              >
                <IconX className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          <div className="flex items-center gap-1.5">
            <TextField
              value={newMarket}
              onChange={setNewMarket}
              placeholder="County, ST"
              disabled={offline}
              className="w-32"
            />
            <button
              onClick={() => void addMarket()}
              disabled={offline || !newMarket.trim()}
              className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-tx2 transition-colors hover:text-tx1 disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </div>
      </Section>
    </div>
  );
}

/* ------------------------- custom signal builder ------------------------- */

function describeRule(rule: Record<string, unknown>): string {
  const f = (rule.filters ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  const rec = String(rule.record ?? "deed");
  parts.push({ deed: "Deeds", loan: "Loans", permit: "Permits", lien: "Distress events" }[rec] ?? rec);
  if (f.isCash === true) parts.push("all-cash");
  if (f.minAmount) parts.push(`≥ ${money(Number(f.minAmount))}`);
  if (f.maxAmount) parts.push(`≤ ${money(Number(f.maxAmount))}`);
  if (Array.isArray(f.counties) && f.counties.length) parts.push(`in ${f.counties.join(", ")}`);
  if (Array.isArray(f.cities) && f.cities.length) parts.push(`(${f.cities.join(", ")})`);
  if (f.minFlips) parts.push(`entity ≥ ${f.minFlips} flips`);
  if (f.minVelocity) parts.push(`velocity ≥ ${f.minVelocity}`);
  if (f.minRate) parts.push(`rate ≥ ${f.minRate}%`);
  if (Array.isArray(f.lenderTypes) && f.lenderTypes.length) parts.push(String(f.lenderTypes.join("/")));
  if (Array.isArray(f.permitTypes) && f.permitTypes.length) parts.push(String(f.permitTypes.join("/")));
  if (Array.isArray(f.lienTypes) && f.lienTypes.length) parts.push(String(f.lienTypes.join("/")));
  parts.push(`last ${Number(f.windowDays) || 30} days`);
  return parts.join(" · ");
}

function SignalBuilder({
  offline,
  signals,
  onChanged,
  flash,
}: {
  offline: boolean;
  signals: CustomSignal[];
  onChanged: () => void;
  flash: (msg: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [compiled, setCompiled] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const compile = async () => {
    setBusy(true);
    setErr(null);
    setCompiled(null);
    const res = await admin.compileSignal(prompt.trim());
    setBusy(false);
    if (!res.ok) {
      setErr(res.error === "ai_not_configured" ? "AI isn't available on the Worker yet." : `Couldn't compile: ${res.error}`);
      return;
    }
    const data = res.data as { rule?: Record<string, unknown> };
    if (!data.rule) {
      setErr("Couldn't express that as a rule — try naming a record type, amount, and borough.");
      return;
    }
    setCompiled(data.rule);
    if (!name.trim()) setName(String(data.rule.label ?? "").slice(0, 60));
  };

  const save = async () => {
    if (!compiled || !name.trim()) return;
    setBusy(true);
    const res = await admin.createSignal(name.trim(), prompt.trim(), compiled);
    setBusy(false);
    if (!res.ok) {
      setErr(`Couldn't save: ${res.error}`);
      return;
    }
    flash(`Signal saved — ${res.data.hits} existing record${res.data.hits === 1 ? "" : "s"} already match.`);
    setPrompt("");
    setName("");
    setCompiled(null);
    onChanged();
  };

  return (
    <div className="flex flex-col gap-3">
      {signals.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {signals.map((s) => (
            <div key={s.id} className="flex items-center gap-3 rounded-xl border border-line bg-raised/40 px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-tx1">{s.name}</div>
                <div className="truncate text-2xs text-tx3">
                  {describeRule(s.rule)} · <span className="tabular-nums">{s.totalHits}</span> hits
                </div>
              </div>
              <Toggle
                checked={s.enabled}
                disabled={offline}
                label={`Enable ${s.name}`}
                onChange={async (v) => {
                  await admin.toggleSignal(s.id, v);
                  onChanged();
                }}
              />
              <button
                disabled={offline}
                onClick={async () => {
                  await admin.deleteSignal(s.id);
                  flash("Signal deleted.");
                  onChanged();
                }}
                aria-label={`Delete ${s.name}`}
                className="rounded-lg p-1.5 text-tx3 transition-colors hover:bg-raised hover:text-danger disabled:opacity-40"
              >
                <IconX className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-xl border border-dashed border-line p-3.5">
        <span className="text-2xs font-medium text-tx3">Describe a new signal</span>
        <TextArea
          value={prompt}
          onChange={setPrompt}
          rows={2}
          disabled={offline}
          placeholder='e.g. "Cash purchases over $2M in Queens or Brooklyn by entities with 8+ flips" or "New private loans above 12% in the Bronx"'
          className="mt-1"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-2xs text-tx3">Compiled once by AI → runs deterministically after every pull.</span>
          <button
            disabled={offline || busy || prompt.trim().length < 8}
            onClick={() => void compile()}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-violet/30 bg-violet/10 px-3 py-1.5 text-xs font-medium text-violet transition-colors hover:bg-violet/20 disabled:opacity-40"
          >
            <Sparkles strokeWidth={1.75} className="h-3.5 w-3.5" />
            {busy ? "Compiling…" : "Compile rule"}
          </button>
        </div>
        {err && <p className="mt-2 text-2xs text-danger">{err}</p>}

        {compiled && (
          <div className="mt-3 rounded-lg border border-line bg-raised/40 px-3.5 py-3">
            <div className="text-2xs font-medium text-tx3">Compiled rule — confirm before saving</div>
            <p className="mt-1 text-xs text-tx1">{describeRule(compiled)}</p>
            <div className="mt-2.5 flex flex-wrap items-end gap-2">
              <div className="min-w-[200px] flex-1">
                <span className="text-2xs font-medium text-tx3">Signal name</span>
                <TextField value={name} onChange={setName} placeholder="Big Brooklyn cash buys" className="mt-1" />
              </div>
              <button
                disabled={busy || !name.trim()}
                onClick={() => void save()}
                className="rounded-lg bg-accent/90 px-3.5 py-2 text-xs font-semibold text-bg transition-colors hover:bg-accent disabled:opacity-40"
              >
                Save & run
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
