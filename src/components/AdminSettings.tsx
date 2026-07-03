/**
 * Admin settings — data-source mode (sample vs live), vendor API
 * integrations for every connector, coverage markets and pipeline ops.
 * All mutating calls hit /api/admin/* with a bearer token.
 */

import { useCallback, useEffect, useState } from "react";
import { useApp } from "../store";
import { admin, getPublicSettings } from "../lib/api";
import type { ConnectorInfo } from "../types";
import { ago, classNames } from "../lib/format";
import { Toggle, TextField } from "./ui";
import { IconAlert, IconCheck, IconPulse, IconX } from "./icons";

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

function ConnectorCard({
  connector,
  token,
  onChanged,
}: {
  connector: ConnectorInfo;
  token: string;
  onChanged: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(connector.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const save = async (patch: { enabled?: boolean; baseUrl?: string; apiKey?: string }) => {
    setBusy(true);
    const res = await admin.saveConnector(token, connector.id, patch);
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
    const res = await admin.runConnector(token, connector.id);
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

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
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
        <div className="flex flex-col gap-1">
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
      </div>

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
  const adminToken = useApp((s) => s.adminToken);
  const setAdminToken = useApp((s) => s.setAdminToken);
  const dataMode = useApp((s) => s.dataMode);
  const setDataMode = useApp((s) => s.setDataMode);
  const loadAll = useApp((s) => s.loadAll);

  const [tokenDraft, setTokenDraft] = useState(adminToken);
  const [connectors, setConnectors] = useState<ConnectorInfo[] | null>(null);
  const [markets, setMarkets] = useState<string[]>([]);
  const [newMarket, setNewMarket] = useState("");
  const [apiUp, setApiUp] = useState<boolean | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [purgeArmed, setPurgeArmed] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const pub = await getPublicSettings();
    setApiUp(pub != null);
    if (pub) setMarkets(pub.markets);
    if (pub && adminToken) {
      const res = await admin.getConnectors(adminToken);
      if (res.ok) {
        setConnectors(res.data.connectors);
        setAuthError(null);
      } else {
        setConnectors(null);
        setAuthError(res.error === "unauthorized" ? "Token rejected" : res.error);
      }
    }
  }, [adminToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const flash = (msg: string) => {
    setBanner(msg);
    setTimeout(() => setBanner(null), 3000);
  };

  const switchMode = async (live: boolean) => {
    const target = live ? "live" : "demo";
    const res = await admin.saveSettings(adminToken, { dataMode: target });
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
    const res = await admin.purgeDemo(adminToken);
    setPurgeArmed(false);
    flash(res.ok ? `Purged ${res.data.deleted} sample rows.` : `Purge failed: ${res.error}`);
    void loadAll();
  };

  const addMarket = async () => {
    const m = newMarket.trim();
    if (!m || markets.includes(m)) return;
    const next = [...markets, m];
    const res = await admin.saveSettings(adminToken, { markets: next });
    if (res.ok) {
      setMarkets(next);
      setNewMarket("");
    } else flash(`Could not save market: ${res.error}`);
  };

  const removeMarket = async (m: string) => {
    const next = markets.filter((x) => x !== m);
    const res = await admin.saveSettings(adminToken, { markets: next });
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
            the Worker (<code className="font-mono">npm run deploy</code>) to manage live
            integrations from here.
          </span>
        </div>
      )}

      {/* Admin access */}
      <Section
        title="Administrator access"
        sub="Admin actions authenticate with the ADMIN_TOKEN secret set on the Worker (wrangler secret put ADMIN_TOKEN). The token is stored only in this browser."
      >
        <div className="flex max-w-md gap-2">
          <TextField
            type="password"
            value={tokenDraft}
            onChange={setTokenDraft}
            placeholder="Paste admin token…"
            disabled={offline}
          />
          <button
            onClick={() => {
              setAdminToken(tokenDraft);
              flash("Admin token saved.");
            }}
            disabled={offline || tokenDraft === adminToken}
            className="shrink-0 rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
          >
            Save
          </button>
        </div>
        {authError && <p className="mt-2 text-2xs text-danger">{authError}</p>}
        {!offline && adminToken && !authError && connectors && (
          <p className="mt-2 flex items-center gap-1.5 text-2xs text-ok">
            <IconCheck className="h-3 w-3" /> Authenticated
          </p>
        )}
      </Section>

      {/* Data source */}
      <Section
        title="Data source"
        sub="Demo mode shows the bundled sample dataset so the product is always explorable. Live mode shows only real records ingested from your connected APIs — sample rows disappear from every feed and KPI."
      >
        <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-raised/40 px-4 py-3">
          <div>
            <div className="text-xs font-semibold text-tx1">
              {dataMode === "live" ? "Live data" : "Sample data"}
            </div>
            <div className="text-2xs text-tx3">
              {dataMode === "live"
                ? "Feeds reflect records pulled by the daily pipeline."
                : "Feeds include seeded demo borrowers and signals."}
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <span className={classNames("text-2xs font-medium", dataMode !== "live" ? "text-warn" : "text-tx3")}>
              Demo
            </span>
            <Toggle
              checked={dataMode === "live"}
              disabled={offline || !adminToken}
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
            Permanently delete the seeded sample rows from the database (entities, signals, deeds,
            loans, permits, liens). Your saved pipeline is not affected.
          </p>
          <button
            onClick={() => void purge()}
            disabled={offline || !adminToken}
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

      {/* Integrations */}
      <Section
        title="API integrations"
        sub="One connector per source. Keys are encrypted at rest in D1 (AES-GCM) and only decrypted inside the Worker at run time. The pipeline pulls every weekday at 11:00 UTC; each connector retries 3× and writes an audit row."
      >
        {connectors ? (
          <div className="flex flex-col gap-2.5">
            {connectors.map((c) => (
              <ConnectorCard key={c.id} connector={c} token={adminToken} onChanged={() => void refresh()} />
            ))}
            <button
              onClick={async () => {
                const res = await admin.runAll(adminToken);
                flash(res.ok ? "Full pipeline run started." : `Error: ${res.error}`);
              }}
              className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-line py-2.5 text-xs font-medium text-tx2 transition-colors hover:border-accent/40 hover:text-accent"
            >
              <IconPulse className="h-3.5 w-3.5" /> Run full pipeline now
            </button>
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-tx3">
            {offline
              ? "Connector management requires the deployed Worker."
              : adminToken
                ? "Loading connectors…"
                : "Save an admin token above to manage integrations."}
          </p>
        )}
      </Section>

      {/* Markets */}
      <Section
        title="Coverage markets"
        sub="Counties requested from every connector on each run. Add markets as your vendor contracts expand."
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
                disabled={offline || !adminToken}
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
              disabled={offline || !adminToken}
              className="w-32"
            />
            <button
              onClick={() => void addMarket()}
              disabled={offline || !adminToken || !newMarket.trim()}
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
