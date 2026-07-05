# LienWolf — Lender Intelligence Platform

B2B SaaS for private & hard money real estate lenders. Aggregates county records,
permits, liens and skip-trace data to flag **high-intent borrowing triggers** so
lenders can reach active fix-and-flippers and developers at the exact moment they
need capital.

## Core signal feeds

| Feed | Trigger logic |
| --- | --- |
| **Upcoming Maturity Sniffer** | Active private/hard-money notes originated **8–10 months ago** → refi window opening |
| **Cash-Poor Trigger** | ≥2 **all-cash purchases in 60 days** → delayed-financing candidates rebuilding liquidity |
| **Automated Borrower Resume** | 36-month deed + financing timeline, flips, margins, hold time, **cost-of-capital rate intel** (last/avg/highest rate paid — quote below it to win), skip-traced contacts |
| **Permit-to-Social Matching** | Ground-up/structural permits ≥$250K, matched to registered LLC + principal contact info |
| **Contractor Lien Monitoring** | Fresh mechanics liens (≤21 days) → frozen draws, rescue-capital opportunities |
| **Pipeline CRM** | Five-stage lead board (Watching → Outreach → Term Sheet → Funded/Lost) with notes, follow-up dates, activity trail, and deal-size rollups |

## Stack

- **Single Worker deploy** — one Cloudflare Worker serves the built React frontend as static assets **and** the `/api/*` edge API. One URL, one `npm run deploy`.
- **Frontend** — React 18 + TypeScript + Tailwind (dual-theme design system, bento grid, custom component kit, Zustand state, ⌘K palette, drag-and-drop pipeline).
- **Database** — **Cloudflare D1**; schema managed by migrations in `worker/migrations/` (applied automatically on merge by `.github/workflows/deploy.yml`). Materialized `triggers` table for O(1) feed reads; `principals`/`entity_principals` model the cross-LLC borrower graph.
- **Ingestion** — Worker **cron `0 11 * * 1-5`** (daily, weekdays): county deeds/loans → permits → liens → skip-trace → scoring. Connectors are configured from the in-app admin settings (enable, vendor URL, AES-GCM-encrypted API key), retried 3× with backoff, audited in `ingestion_runs`, and idempotent on re-run.
- **Data modes** — `demo` (seeded sample data, default) vs `live` (only ingested records). Toggle in Settings; purge sample rows once live.

## Develop

```bash
npm install
npm run dev            # UI on :5173 (falls back to bundled demo data)
npm run worker:dev     # API on :8787 (optional; UI proxies /api → :8787)
```

## Provision & deploy

```bash
npx wrangler login
npx wrangler d1 create lienwolf-db          # put the id in worker/wrangler.toml
npm run db:migrate                          # apply migrations to remote D1
npm run db:seed                             # optional: sample data for demo mode
npx wrangler secret put ADMIN_TOKEN --config worker/wrangler.toml
npx wrangler secret put WEBHOOK_SECRET --config worker/wrangler.toml
npm run deploy                              # build UI + deploy Worker (assets + API)
```

**Continuous deploy:** merges to `main` run `.github/workflows/deploy.yml` — type-check,
build, `d1 migrations apply`, `wrangler deploy`. Add `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` repository secrets to enable it.

**Access:** the whole app sits behind an access code — set `wrangler secret put ACCESS_CODE`
and share the code with your team. It doubles as the encryption key for stored vendor keys.

**Going live:** live data is the default. Open **Settings** → configure each data source —
**Scrape** mode points a Cloudflare headless browser (Browser Rendering; reuses the CI `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` — the deploy workflow injects both into the Worker) at recorder/permit portals and Workers AI
(`@cf/moonshotai/kimi-k2.6`, routed through your AI Gateway for centralized billing) extracts
clean records; **API** mode takes a vendor base URL + key (contract documented at the top of
`worker/src/ingest.ts`). Contact enrichment is Apollo-compatible. Suggested portals for each
source are listed inline in Settings.

## API surface

```
GET    /api/health                     pipeline liveness + last runs
GET    /api/kpis                       metric strip
GET    /api/triggers/maturities        maturity feed
GET    /api/triggers/cash-poor         cash-poor feed
GET    /api/triggers/permits           permit feed
GET    /api/triggers/liens             lien feed
GET    /api/borrowers/:id/resume       36-month borrower resume
POST   /api/triggers/:id/status        viewed | contacted | dismissed | converted
POST   /api/watchlist                  add entity to pipeline
DELETE /api/watchlist/:entityId        remove
POST   /api/webhooks/records           HMAC-verified vendor push (urgent records)
POST   /api/admin/run-ingestion        manual pipeline kick (bearer secret)
```

## Master prompt

The complete build prompt for this platform (all features, stack and design
constraints) lives in [`docs/PROMPT.md`](docs/PROMPT.md) — reusable for future
Claude Code sessions extending the product.
