/**
 * Settings — data source mode, per-connector ingestion setup (vendor API
 * or headless-browser scraping), AI pipeline, coverage markets.
 * Authentication is the app-wide access code; no separate admin token.
 */

import { useCallback, useEffect, useState } from "react";
import { useApp } from "../store";
import { admin, probeSettings } from "../lib/api";
import type { ConnectorInfo } from "../types";
import { ago, classNames } from "../lib/format";
import { Toggle, TextField, TextArea, Select } from "./ui";
import { IconAlert, IconPulse, IconX } from "./icons";
import { Sparkles } from "lucide-react";

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="card p-5">
      <h3 className="text-[13px] font-semibold text-tx1">{title}</h3>
      {sub && <p className="mt-1 max-w-xl text-2xs text-tx3">{sub}</p>}
      <div className="mt-3.5">{children}</div>
    </section>
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
  skip_trace: [
    "Apollo.io (api.apollo.io) — people/organization match",
    "Alternatives: BatchSkipTracing, Clearbit, PeopleDataLabs",
  ],
};

const MODE_OPTIONS = [
  { value: "scrape" as const, label: "Scrape (headless browser + AI)", hint: "for gov portals" },
  { value: "api" as const, label: "Vendor API", hint: "normalized JSON feed" },
];

function ConnectorCard({ connector, onChanged }: { connector: ConnectorInfo; onChanged: () => void }) {
  const [baseUrl, setBaseUrl] = useState(connector.baseUrl ?? "");
  const [scrapeUrl, setScrapeUrl] = useState(connector.scrapeUrl ?? "");
  const [notes, setNotes] = useState(connector.notes ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
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
        <div className="min-w-0">
          <div className="text-xs font-semibold text-tx1">{connector.label}</div>
          <div className="mt-0.5 flex items-center gap-2 text-2xs text-tx3">
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
        </div>
        <Toggle
          checked={connector.enabled}
          disabled={busy}
          label={`Enable ${connector.label}`}
          onChange={(enabled) => void save({ enabled })}
        />
      </div>

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

      <div className="mt-3 flex items-center justify-between border-t border-line pt-2.5">
        <span className="text-2xs text-tx3">Runs weekdays 11:00 UTC · 3 retries · audited</span>
        <button
          disabled={busy || !connector.enabled}
          onClick={() => void run()}
          className="rounded-lg border border-line bg-surface px-2.5 py-1 text-2xs font-medium text-tx2 transition-colors hover:text-tx1 disabled:opacity-40"
        >
          Run now
        </button>
      </div>
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

  const refresh = useCallback(async () => {
    const probe = await probeSettings();
    setApiUp(probe.status === "ok");
    if (probe.status !== "ok") return;
    setMarkets(probe.settings.markets);
    setGatewayId(probe.settings.aiGatewayId);
    const res = await admin.getConnectors();
    setConnectors(res.ok ? res.data.connectors : null);
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
        sub="One connector per source. Government recorder and permit portals rarely offer APIs — set those to Scrape: a Cloudflare headless browser renders the page on schedule and the AI pipeline extracts clean records from it. Vendor keys are encrypted at rest (AES-GCM)."
      >
        {connectors ? (
          <div className="flex flex-col gap-2.5">
            {connectors.map((c) => (
              <ConnectorCard key={c.id} connector={c} onChanged={() => void refresh()} />
            ))}
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

      {/* AI pipeline */}
      <Section
        title="AI pipeline"
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
                <> Scraping needs CF_ACCOUNT_ID + CF_API_TOKEN (Browser Rendering) on the Worker.</>
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
