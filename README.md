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

- **Frontend** — React 18 + TypeScript + Tailwind (obsidian glassmorphic design system, bento grid, Zustand state). Deploys to **Cloudflare Pages**.
- **API** — **Cloudflare Worker** (`worker/`), zero-dependency edge router + HMAC-verified record webhooks.
- **Database** — **Cloudflare D1** (`db/schema.sql`), materialized `triggers` table for O(1) feed reads.
- **Ingestion** — Worker **cron `0 11 * * 1-5`** (daily, weekdays): county deeds/loans → permits → liens → skip-trace → scoring. Each connector is retried 3× with backoff and audited in `ingestion_runs`; re-runs are idempotent.

## Develop

```bash
npm install
npm run dev            # UI on :5173 (falls back to bundled demo data)
npm run worker:dev     # API on :8787 (optional; UI proxies /api → :8787)
```

## Provision & deploy

```bash
npx wrangler d1 create lienwolf-db          # put the id in worker/wrangler.toml
npm run db:schema && npm run db:seed
npx wrangler secret put WEBHOOK_SECRET --config worker/wrangler.toml
# COUNTY_API_KEY / PERMIT_API_KEY / SKIP_TRACE_API_KEY once vendors are contracted
npm run deploy:worker
npm run deploy:pages
```

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
