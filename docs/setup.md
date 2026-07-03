# LienWolf — Setup Guide

Everything you need to take LienWolf from repository to a fully live,
locked-down deployment: Cloudflare resources, environment variables,
secrets, data sources, AI, alerts, and the first data crawl.

The app is a **single Cloudflare Worker** — it serves the built frontend as
static assets and handles every `/api/*` route itself. There is no separate
Pages project. One D1 database holds all data.

---

## 1. Prerequisites

| Thing | Why |
| --- | --- |
| Cloudflare account | Workers, D1, Workers AI, AI Gateway, Browser Rendering |
| Node.js 22+ | wrangler requires ≥ 22 |
| GitHub repository (this one) | merges to `main` auto-deploy via the included Action |

Plan note: everything runs on the **Workers Free tier**. The historical
backfill and daily pulls are deliberately chunked to fit free-tier D1 write
limits; upgrading to Workers Paid ($5/mo) simply makes the backfill finish
faster and raises D1 storage headroom. Nothing needs re-architecting if you
upgrade later.

---

## 2. Cloudflare resources (one-time)

### 2.1 D1 database

The repo is wired to a database named `lienwolf-db`. If you're setting up a
fresh Cloudflare account:

```bash
npx wrangler d1 create lienwolf-db
```

Copy the returned `database_id` into `worker/wrangler.toml` under
`[[d1_databases]]`. Migrations create the entire schema — you never run
`db/schema.sql` by hand against production (it exists for fresh local
installs and reference).

### 2.2 AI Gateway (centralized AI billing/caching/logs)

1. Cloudflare dashboard → **AI** → **AI Gateway** → *Create gateway* (any name).
2. Copy the **gateway ID**.
3. After the app is deployed, paste it in **Settings → AI pipeline** inside
   the app. Every model call (scrape extraction, grounding verification,
   borrower briefs, outreach drafts, signal compilation, field auto-mapping)
   routes through it.

Workers AI itself needs no setup — the `[ai]` binding in `wrangler.toml`
ships with the deploy. Default model: `@cf/moonshotai/kimi-k2.6`
(changeable via the `AI_MODEL` var or the `ai_model` app setting).

### 2.3 Browser Rendering (headless scraping)

Scrape-mode connectors render government portals with Cloudflare's managed
headless Chrome. No separate credentials needed: it reuses the same `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID` GitHub secrets that power deploys — the deploy
workflow injects both into the Worker automatically on every deploy. Just
make sure the token's permissions include **Browser Rendering: Edit**
(section 3). Until then, scrape-mode connectors simply report
`browser_rendering_not_configured` when run — nothing else breaks.

---

## 3. GitHub repository secrets (CI/CD)

The included Action (`.github/workflows/deploy.yml`) runs on every merge to
`main`: type-check → build → **apply D1 migrations** → deploy Worker.
Set two repository secrets (GitHub → Settings → Secrets and variables →
Actions):

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | One token for everything: **Workers Scripts: Edit** + **D1: Edit** + **Browser Rendering: Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | Your account ID (dashboard → Workers & Pages, right sidebar) |

These two are the *only* place you configure Cloudflare credentials — the
deploy workflow passes the account ID into the Worker as a runtime var and
syncs the token in as a Worker secret, so scraping (Browser Rendering)
works with no extra setup.

Manual deploy alternative: `npm run deploy` (builds + `wrangler deploy`),
`npm run db:migrate` (applies pending migrations remotely).

---

## 4. Worker secrets

Set each with:

```bash
npx wrangler secret put <NAME> --config worker/wrangler.toml
```

| Secret | Required? | Purpose |
| --- | --- | --- |
| `ACCESS_CODE` | **Yes — set this first** | The login code that unlocks the app. Until it exists, the app is open (first-run safety), so set it immediately after the first deploy. It is also the encryption key (KEK) for vendor API keys stored in Settings — **changing it invalidates stored vendor keys**, which you'd re-enter in Settings. |
| `RESEND_API_KEY` | For email digests | From [resend.com](https://resend.com) (free tier is fine). Powers the daily digest and Settings → "Send test". |
| `WEBHOOK_SECRET` | Optional | HMAC-SHA256 secret if a vendor pushes records to `POST /api/webhooks/records` between scheduled runs. |
| `COUNTY_API_KEY` / `PERMIT_API_KEY` / `SKIP_TRACE_API_KEY` | Optional | Env fallbacks for vendor keys. Normally you paste keys in Settings instead (encrypted at rest with the `ACCESS_CODE`). |

---

## 5. Worker vars (`worker/wrangler.toml` → `[vars]`)

| Var | Default | Notes |
| --- | --- | --- |
| `ALLOWED_ORIGIN` | `*` | CORS. Single-Worker deploys can leave `*`; tighten to your domain if you like. |
| `AI_MODEL` | `@cf/moonshotai/kimi-k2.6` | Workers AI model for all extraction/generation. |
| `CLOUDFLARE_ACCOUNT_ID` | *(auto)* | Injected by the deploy workflow from the GitHub secret — only set it in `wrangler.toml` for manual `npm run deploy` runs. |
| `ALERT_FROM` | *(unset)* | Optional From address for digests, e.g. `LienWolf <alerts@yourdomain.com>`. The domain must be verified in Resend; otherwise the Resend onboarding sender is used. |

Vars ship with each deploy — after editing, push to `main` (or `npm run deploy`).

---

## 6. First deploy checklist

1. Set the two GitHub secrets (section 3), merge to `main`, and watch the
   **Deploy** Action go green — it applies all migrations and publishes the
   Worker at `https://lienwolf.<your-subdomain>.workers.dev`.
2. Immediately lock it: `npx wrangler secret put ACCESS_CODE --config worker/wrangler.toml`.
   Reload the site — you should see the access-code login page.
3. (Optional demo data) `npm run db:seed` loads the NYC sample dataset.
   The app defaults to **live** mode either way; flip to Demo in
   Settings → Data source to explore, and "Purge demo data" when done.

---

## 7. Data sources (the core of the product)

All twelve connectors are configured in **Settings → Data sources**,
grouped: Core records (deeds, mortgages, permits, liens), Distress signals
(lis pendens, violations, tax liens, auctions), Market intelligence
(satisfactions, UCC, corporation registry), Enrichment (skip trace).
Each connector is **disabled until you configure and enable it** — the
pipeline skips unconfigured sources silently.

Every connector runs in one of two modes:

### 7.1 API mode — NYC Open Data (free, preferred where available)

Point the *Vendor base URL* at a Socrata resource endpoint
(`https://data.cityofnewyork.us/resource/xxxx-xxxx.json`). The app detects
the URL shape and switches to its Socrata adapter automatically. Then:

1. Click **Auto-map with AI** — it fetches sample rows and drafts the
   dataset→record field mapping (a small JSON you can review/edit).
   The mapping is written once; every pull afterward is deterministic.
2. Optional: create a free **Socrata app token** at
   [data.cityofnewyork.us](https://data.cityofnewyork.us/profile/edit/developer_settings)
   and paste it as the connector's API key to avoid throttling.
3. Enable the connector and hit **Run now** to test.

Connectors come **pre-filled with real endpoints** (seeded by migration
0006 — your edits are never overwritten); verify, auto-map, and enable:

| Connector | Seeded endpoint | Dataset |
| --- | --- | --- |
| Permits | `data.cityofnewyork.us/resource/w9ak-ipjd.json` | DOB NOW: Build — Job Application Filings |
| Violations | `data.cityofnewyork.us/resource/6bgk-3dad.json` | DOB ECB Violations (respondent + penalty) |
| Tax liens | `data.cityofnewyork.us/resource/9rz4-mjek.json` | DOF Tax Lien Sale Lists |
| Corp registry | `data.ny.gov/resource/n9v6-gdp6.json` | NYS Active Corporations |
| Deeds / loans / satisfactions | `data.cityofnewyork.us/resource/bnx9-e6tj.json` | ACRIS Real Property Master — see caveat below |

**ACRIS caveat:** the Master dataset carries document type, amount and date,
but party *names* live in ACRIS Parties (`636b-3b5g`) and property
*addresses* in ACRIS Legals (`8h5j-fqxa`), joined by `document_id`. Until
you use a joined feed or scrape the ACRIS search UI, master-only rows lack
names/addresses and will quarantine rather than pollute your data. Filter
document types with the field-map's `where` (e.g. `doc_type = 'MTGE'`).
Scrape-mode connectors (lis pendens, auctions, UCC, borough liens) are
seeded with the relevant portal URLs — swap in the results page for your
borough/search.

ACRIS covers Manhattan/Brooklyn/Queens/Bronx; Staten Island (Richmond
County) records live with the Richmond County Clerk → use scrape mode.

API mode also accepts any normalizing vendor API implementing the simple
contract documented at the top of `worker/src/ingest.ts`.

### 7.2 Scrape mode — Cloudflare headless browser + AI

For portals with no API (borough clerk lien indexes, court auction
calendars, NY DOS UCC search, Richmond County Clerk):

1. Set *Source type* to **Scrape** and paste the portal's search-results URL.
2. Use the **notes** box to tell the AI normalizer what to look for
   (document types, date filters, county quirks) — the notes are injected
   into the extraction prompt.
3. Requires the Browser Rendering permission on your `CLOUDFLARE_API_TOKEN` (section 2.3).

Scraped records pass an extra **AI grounding check**: values that can't be
shown in the rendered page are quarantined, never ingested.

### 7.3 Contact enrichment

`skip_trace` expects an Apollo-compatible API (`POST {base}/trace`). Paste
the vendor base URL + API key. Keys are AES-GCM-encrypted at rest using the
`ACCESS_CODE`.

---

## 8. Schedule, backfill, and data quality

- **Schedule** — the pipeline runs weekdays at **11:00 UTC** (~6/7am NYC),
  set in `wrangler.toml` `[triggers]`. Each run: pull all enabled sources →
  validation gates → scoring → custom signals → entity resolution → digest.
- **Historical backfill** — Settings → Historical backfill. Click *Start
  36-mo crawl* per eligible source (enabled, API mode, mapped). It pulls
  one month-window chunk immediately and continues a couple of chunks after
  every daily cron until done; *Continue now* advances it manually. Scraped
  portals can't be backfilled (a page has no history).
- **Data quality** — Settings → Data quality shows 7-day ingest/quarantine
  counts, records awaiting review (approve = ingest, discard = drop),
  duplicate-borrower merge suggestions, and source anomaly warnings when a
  source's daily volume collapses vs its own baseline.

---

## 9. Alerts, AI features, and in-app settings

Everything below lives in **Settings** inside the app (stored in D1, no
redeploy needed):

| Card | What to set |
| --- | --- |
| Data source | Live vs demo mode; purge demo rows |
| Alerts & daily digest | Toggle + recipient email + *Send test* (needs `RESEND_API_KEY`) |
| Underwriting | Rate spread, points, term, max LTV, min loan, quote validity, lender name on term sheets |
| Outreach identity | Your name, company, email signature — used by the AI outreach composer and the profile menu |
| Custom signals | Plain-English rules → AI compiles once → deterministic evaluation each pull |
| AI pipeline | AI Gateway ID; shows model + scraping-configured status |
| Coverage markets | Defaults to the five borough counties (`Kings / Queens / Bronx / New York / Richmond, NY`); records outside your markets are quarantined |

The question-mark icons on each card open the in-app setup walkthrough.

---

## 10. Quick reference — commands

```bash
npm ci                      # install
npm run dev                 # local UI (offline preview with sample data)
npm run build               # production frontend build
npm run deploy              # build + deploy Worker manually
npm run db:migrate          # apply pending D1 migrations (remote)
npm run db:migrate:local    # same, against the local D1 emulator
npm run db:seed             # load the NYC demo dataset (remote)
npx wrangler secret put ACCESS_CODE --config worker/wrangler.toml
npx wrangler tail --config worker/wrangler.toml   # live Worker logs
```

## 11. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Login page never appears | `ACCESS_CODE` secret not set — app stays open by design until it exists |
| Scrape connector fails `browser_rendering_not_configured` | Token lacks Browser Rendering permission, or no deploy has run since the workflow gained the secret-sync step |
| Socrata connector fails `field_map_missing` | Run *Auto-map with AI* (or paste a mapping) before enabling |
| "Send test" digest fails | `RESEND_API_KEY` not set, or `ALERT_FROM` domain not verified in Resend |
| AI buttons return `ai_not_configured` | Worker deployed without the `[ai]` binding — redeploy from this repo's `wrangler.toml` |
| Deploy Action fails on wrangler | Node < 22 or missing GitHub secrets (section 3) |
| Data Pipeline widget says "no pulls yet" | Expected until at least one connector is enabled and has run |
| Records missing that you expected | Check Settings → Data quality — they may be quarantined (outside markets, failed a sanity gate, or failed grounding) |
