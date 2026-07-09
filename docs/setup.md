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

Connectors come **pre-filled with real endpoints** (seeded by migrations
0006 + 0009 — your edits are never overwritten); verify, auto-map, and enable:

| Connector | Seeded endpoint | Dataset |
| --- | --- | --- |
| Permits | `data.cityofnewyork.us/resource/w9ak-ipjd.json` | DOB NOW: Build — Job Application Filings (NB/DM only; other job types are on the legacy `ic3t-wcy2` dataset) |
| Violations | `data.cityofnewyork.us/resource/6bgk-3dad.json` | DOB ECB Violations (respondent + penalty) |
| Tax liens | `data.cityofnewyork.us/resource/9rz4-mjek.json` | DOF Tax Lien Sale Lists — **NYC's 2026 sale is suspended** pending a Land Bank transition (targeted 2029); expect this one to look quiet until it resumes |
| Corp registry | `data.ny.gov/resource/n9v6-gdp6.json` | NYS Active Corporations |
| Deeds / loans / satisfactions | `data.cityofnewyork.us/resource/bnx9-e6tj.json` | ACRIS Real Property Master — see caveat below |
| Mechanic's liens / Lis pendens | `data.cityofnewyork.us/resource/bnx9-e6tj.json` | Also ACRIS — a recorded document type, not a scrape (see "Discover ACRIS doc types" below) |
| Auctions | `ww2.nycourts.gov/courts/2jd/kings/civil/foreclosuresales.shtml` | Kings County Supreme foreclosure calendar (scrape; swap URL per borough — every judicial district uses its own path) |
| UCC filings | `appext20.dos.ny.gov/pls/ucc_public/web_search.main_frame` | NY DOS UCC search (scrape; form-driven, see caveat below) |

**ACRIS is joined natively:** the pipeline automatically joins Master
(amounts/dates) with Legals (`8h5j-fqxa`, addresses) and Parties
(`636b-3b5g`, names) by `document_id`, producing complete records from the
free city APIs — no field map needed for deeds/loans/satisfactions, whose
document types default to `DEED` / `MTGE`+`AGMT` / `SAT`. Lenders are
auto-classified bank vs private by name, and all-cash purchases are
detected by reconciling deeds against mortgage recordings on the same
parcel.

**Mechanic's liens and lis pendens are recorded ACRIS document types too**
— not scrapes — but we deliberately don't ship a guessed `doc_type` code
for them, because ACRIS's codes aren't documented anywhere reliable and a
wrong guess would silently return 0 rows forever (the exact bug this
covers). Instead: click **Test source** on either connector — the
diagnostic runs a **"Discover ACRIS doc types"** step that samples the
Master dataset for the last 45 days with no filter, groups by `doc_type`,
and lists each code with its real count and (when available) description.
Read off the right one and paste `doc_type = '<code>'` into that
connector's field-map **where** box. The same trick works for any other
ACRIS document class you want to add later (judgments, easements, etc.) —
just point a connector's base URL at the Master dataset and run Discover.

ACRIS covers Manhattan/Brooklyn/Queens/Bronx; Staten Island (Richmond
County) records live with the Richmond County Clerk → use scrape mode.

**UCC filings are a structural dead end for automation**: NY DOS UCC
search has no public API or bulk export — it's session/form-driven, so
there's no URL that returns results directly. To use it, search the site
yourself, then paste the **results page URL** (after searching, not the
landing page) into the connector. ACRIS does record UCC1/UCC3, but only
for co-op share loans, not general business assets, so it isn't a
substitute for competitor-lender lookups.

**Foreclosure auction calendars have no unified source** — each judicial
district publishes its own page with its own URL pattern (`ww2.nycourts.gov`
subdomain, filename varies). Swap the seeded Kings County URL for your
borough and re-verify with Test source; these pages change layout
occasionally, so re-check if a previously-working scrape goes to 0.

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
  36-mo crawl* per eligible source (enabled, API mode, mapped). Click *Start* once:
  it pulls a few chunks immediately, then the Worker continues the crawl
  automatically in the background every 10 minutes until complete. Scraped
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
| Nothing populates at all, connectors look configured | Connectors are **disabled by default** — a seeded/correct endpoint does nothing until you flip the toggle on in Settings and either wait for the weekday cron or click *Run now* |
| ACRIS-backed connector (liens/lis pendens) always returns 0 rows | It ships with no `doc_type` filter on purpose — click *Test source*, read the **"ACRIS doc types in window"** line for the real code, then paste `doc_type = '<code>'` into that connector's field-map *where* box |
| Tax lien connector is empty | NYC's 2026 tax lien sale is suspended citywide — not a config problem; see the connector's notes for a live ACRIS-based alternative |
