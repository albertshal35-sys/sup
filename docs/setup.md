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
ships with the deploy.

**Two models, not one.** The AI calls split into two groups with opposite
economics, so they are configured separately in **Settings → AI pipeline**:

| Role | Used by | Default | Setting |
| --- | --- | --- | --- |
| Extraction | scrape parsing, grounding verification, field auto-mapping, rate reading | `@cf/google/gemma-4-26b-a4b-it` | `ai_model_extract` |
| Writing | borrower briefs, outreach drafts | `@cf/moonshotai/kimi-k2.6` | `ai_model_prose` |

Extraction is where essentially all the tokens go, and every one of those
calls wants a rigid JSON object out — which [JSON mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)
enforces directly from the schema rather than by asking the model nicely. A
small model handles that, and the integrity gates quarantine whatever it
gets wrong instead of letting it through. Writing is a handful of calls a
day whose output a customer reads, so it keeps the stronger model.

At the time of writing that is roughly a **10× price difference** —
`kimi-k2.6` is $0.95/M input and $4.00/M output against gemma-4's $0.10 and
$0.30 ([Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)) —
and `kimi-k2.6` additionally requires a paid billing method, so the split
also decides whether the free 10,000-neuron daily allocation covers anything
at all: ~116K input tokens/day on kimi versus ~1.1M on gemma-4.

If extraction quality disappoints, step up rather than back to kimi:
`@cf/nvidia/nemotron-3-120b-a12b` ($0.50/$1.50) is documented with
function-calling and reasoning support and is still far cheaper. Setting
`AI_MODEL` (or the legacy `ai_model` setting) pins **both** roles to one
model and disables the split — useful for a bake-off, wasteful as a
permanent state.

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
| `AI_MODEL` | *(unset)* | Pins **both** model roles to one model, overriding the per-role settings. Leave unset to use the extraction/writing split. |
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
| Tax liens | `data.cityofnewyork.us/resource/bnx9-e6tj.json` | Recorded NYC/Federal tax liens via ACRIS (the DOF lien-*sale* list is frozen while NYC's lien sale is suspended pending the 2029 Land Bank transition) |
| Corp registry | `data.ny.gov/resource/n9v6-gdp6.json` | NYS Active Corporations |
| Deeds / loans / satisfactions | `data.cityofnewyork.us/resource/bnx9-e6tj.json` | ACRIS Real Property Master — see caveat below |
| Mechanic's liens / Lis pendens | `data.cityofnewyork.us/resource/bnx9-e6tj.json` | Also ACRIS — a recorded document type, not a scrape (see "Discover ACRIS doc types" below) |
| Auctions | `ww2.nycourts.gov/courts/2jd/kings/civil/foreclosuresales.shtml` | Kings County Supreme foreclosure calendar (scrape; swap URL per borough — every judicial district uses its own path) |
| UCC filings | `appext20.dos.ny.gov/pls/ucc_public/web_search.main_frame` | NY DOS UCC search (scrape; form-driven, see caveat below) |

**ACRIS is joined natively:** the pipeline automatically joins Master
(amounts/dates) with Legals (`8h5j-fqxa`, addresses + borough/block/lot),
Parties (`636b-3b5g`, names) and — for satisfactions — References
(`pwkr-dpni`, document-to-document cross refs) by `document_id`, producing
complete records from the free city APIs. The record layouts, code tables
and publishing model are specified in DOF's *ACRIS OpenData Extract Guide*
(v1.0), which is the reference for everything in this section.

Note the borough coverage baked into the data: the guide lists borough
codes 1–4 (Manhattan, Bronx, Brooklyn, Queens) only. Staten Island records
with the Richmond County Clerk, which is why it needs scrape mode.

**Parcel facts come from PLUTO.** Because the ACRIS join now produces a BBL,
the city's tax-lot file (`64uk-42ks`) is a join rather than an integration.
It fills lot and building area, unit count, floors, year built, zoning,
building class, owner of record, assessed value and coordinates onto every
parcel, bounded per run and re-synced quarterly (roughly the file's own
cadence). It runs just before scoring, because the maturity feed reads the
derived value.

> **Assessed value is not market value.** NYC assesses Class 1 (1–3 family)
> at **6%** of market and Classes 2–4 at **45%**. Using `assesstot` directly
> would understate a house by roughly 16× and make every LTV meaningless —
> a $500K note against a $3M home would read as 278% LTV. The raw figure is
> stored as `assessed_value`, and `est_market_value` grosses it back up by
> the ratio implied by the building class. That is an **estimate for ranking
> leads, not an appraisal**: assessed values lag the market and carry caps
> and exemptions. Where the building class is unknown the value stays null
> and scoring simply drops the equity term rather than guessing.

**Rate intel is derived, not recorded — and is the least proven part of the
pipeline.** ACRIS publishes an *index*: doc type, amount, dates, parties,
parcel. It does not publish interest rates. So any rate shown is read out of
a recorded instrument and carries `rate_source` and `rate_confidence`
alongside it. Two things to be clear-eyed about:

- The enrichment renders the ACRIS document page for a note and parses the
  text, preferring a rate its own clause qualifies (`11.25% per annum`) over
  one qualified as something else (`24% upon default`, `5% late charge`).
  Picking the wrong percentage is worse than picking none, so a rate whose
  clause carries default/penalty language is discarded rather than ranked.
- **The detail page carries the index; the rate usually lives in the
  document image behind it.** Expect a low hit rate until that image path is
  confirmed, and treat `no_rate_stated` as the normal outcome rather than a
  fault. Point the connector's field-map `docUrlTemplate` (with `{doc}` for
  the document id) at whatever URL does yield instrument text — no code
  change needed.

Enrichment is bounded to the top few open maturity leads per sweep, like
contact enrichment: each one is a headless browser render plus a model call,
and a rate only matters for a note you are about to quote against.

**What is and isn't consumed.** ACRIS publishes ten record datasets plus
five code tables. These connectors read the Real Property side:

| Dataset | Id | Used |
| --- | --- | --- |
| Real Property Master | `bnx9-e6tj` | yes — type, amounts, dates, revision markers, percent transferred |
| Real Property Legals | `8h5j-fqxa` | yes — BBL, address, easement/air-rights flags, property type |
| Real Property Parties | `636b-3b5g` | yes — names **and** mailing addresses |
| Real Property References | `pwkr-dpni` | yes, for satisfactions (which mortgage a payoff discharges) |
| Real Property Remarks | `9p4w-7npp` | **no** — free-text remarks per document, currently unread |
| PLUTO (tax lot facts) | `64uk-42ks` | yes — joined on BBL for parcel facts and assessed value |
| Personal Property (5 datasets) | `sv7x-dduq` et al. | **no** — the UCC / Federal Liens class; in ACRIS this is essentially co-op share loans (see the UCC note below) |
| Document Control Codes | `7isb-wh4c` | yes — doc-type labels and per-type party roles |
| Property Type / State / Country / UCC Collateral codes | `94g4-w6xz` et al. | **no** — label lookups for codes we currently store raw or not at all |

Master fields deliberately skipped: the pre-ACRIS reel year/number/page
(microfilm references for pre-1966 records) and `recorded_borough`, which is
redundant with the borough on the Legals row we already join.

**On API versions:** these connectors use the SODA 2.1 `/resource/{id}.json`
endpoints, which need no credentials (an app token only raises the throttle)
and accept an unbounded `$limit`. There is also a SODA 3 endpoint
(`/api/v3/views/{id}/query.json`) which **requires authentication** — it is a
different query interface, not a larger one, so it buys nothing here. No field map is needed for
deeds/loans/satisfactions, whose document types default to `DEED` /
`MTGE`+`AGMT` / `SAT`. Lenders are auto-classified bank vs private by name,
and all-cash purchases are detected by reconciling deeds against mortgage
recordings on the same parcel.

Three details worth knowing, because they decide how much the feeds can
actually see:

- **Parcels are keyed by BBL.** Every joined record carries the borough-
  block-lot key from Legals as its APN, so a deed, a mortgage, a lien and a
  permit on one parcel converge on a single property row instead of
  fragmenting on address spelling ("123 MAIN STREET" vs "123 Main St"). This
  is what makes cash-purchase detection, borrower resumes, and the maturity
  feed line up. A document covering several parcels (blanket mortgage,
  assemblage) is bound to its primary parcel — easement and air-rights rows
  are never chosen over a real taxable lot.
- **Satisfactions match their mortgage by reference, not by name.** The
  References dataset resolves which document a `SAT` discharges (by document
  id, or by CRFN), so a payoff closes the right loan. Only when ACRIS
  publishes no reference does it fall back to the lender+borrower name
  match.
- **Windows are read under a document budget, in as few requests as
  possible.** SoDA 2.1 `/resource/` endpoints set **no `$limit` ceiling**
  (the 50,000 cap belongs to SoDA 2.0), so a pull asks for its whole budget
  in a single Master request — the default 5,000 documents costs one
  request, not ten. Each request asks for one row *more* than it keeps: if
  that probe row comes back, the window provably holds more than the budget,
  so "truncated" is a fact rather than a guess. When a window does overflow,
  the historical backfill resumes from the oldest record the pull reached
  instead of stepping over the remainder — a bounded budget slows the crawl
  down, it does not punch holes in it. Raise a source's `docBudget` in its
  field map to read more per pull.

  At realistic NYC volume the budget rarely binds: two weeks of one document
  class runs well under 5,000, so a 36-month backfill completes in ~79
  chunks without truncating at all.

- **ACRIS republishes corrections, and the pipeline applies them.** Per the
  DOF *ACRIS OpenData Extract Guide* (v1.0), each monthly extract contains
  every document "either recorded **or corrected** in the previous month",
  Master carries a **Modified Date** meaning "recorded or index data last
  corrected", and "the records with the latest good through date are the
  current records". So a document is not write-once: amounts, dates,
  parties and parcels can change after the fact.

  Two consequences are wired in. Routine catch-up pulls filter on
  `modified_date`, not `recorded_datetime` — a 2019 deed corrected last
  month still carries its 2019 recording date, so a recorded-date filter
  would never surface it. And record upserts compare `source_modified_at`
  and apply the newer revision, instead of ignoring anything whose document
  number is already on file. The historical backfill still walks
  `recorded_datetime`, because there it is deliberately reading recording
  history.

- **Signal windows follow publication, not the wall clock.** This matters
  more than it sounds. The feeds ask questions like "liens filed in the last
  21 days" — measured against *today*, that window can never match a source
  publishing a month in arrears, and the pipeline looks healthy the whole
  time because nothing is failing. Every window is therefore counted back
  from each source's newest delivered record. A current source behaves
  exactly as before; a lagging one keeps covering the same amount of real
  data. Past 180 days a source is treated as stopped rather than lagging:
  the window stops sliding and the staleness is reported instead of stale
  records being dressed up as fresh leads.

- **Expect monthly, not daily, movement.** The extract is regenerated once a
  month. Daily pulls are cheap no-ops between publications and then take a
  batch when one lands — a run of quiet days is the source behaving
  normally, not a broken connector.

- **Partial-interest deeds are flagged, not counted as sales.** Master's
  *Percentage Transferred* rides along on deed records, so a conveyance of a
  fractional interest can be told apart from a whole-property sale.

- **Lien party roles come from the code table.** Document Control Codes
  publishes a Party1/Party2 role name per document type, so the mechanic's
  lien / lis pendens / tax lien shaper reads which side is the owner and
  which is the claimant rather than assuming.

- **A corrected document appears more than once.** Per the Real Property
  Master data dictionary: documents are "uniquely identified by both the
  document id and CRFN fields; however to find the most current version of
  the index data for the document, one must find the record with the most
  recent good through date... some documents may have more than one." When
  DOF corrects a document, *all* of its index data is re-published under a
  new good-through date — in Master and in every companion dataset. The
  adapter collapses each document to its current revision before shaping
  records, so a correction does not become a duplicate deed, an inflated
  parcel count, or party names merged across revisions.

- **Party mailing addresses are collected.** The Parties dataset carries
  Address Line 1/2, City, State and Zip for every party. That address is
  what the borrowing entity itself put on a recorded instrument, and for an
  LLC with no other public footprint it is often the only contact detail
  that exists. It lands on `entities.mailing_*` and costs no extra requests.

- **Get a Socrata app token.** Paste it into the connector's API-key field.
  Socrata throttles token-less callers through a shared per-IP pool; with a
  token you get roughly 1,000 requests per rolling hour, which is what makes
  sustained crawling at this volume workable. It is free to register.

**Mechanic's liens, lis pendens, and tax liens are recorded ACRIS document
types too** — not scrapes. Their `doc_type` filters are never guessed:
on first pull each connector queries the city's own **Document Control
Codes** dataset, matches its document class by description, and saves the
resolved filter into the field map (visible and editable in Settings). If
you ever want to verify or extend a filter, **Test source** narrates the
resolution and its **"ACRIS doc types in window"** step lists every code
actually recorded in the last 45 days with real counts — works for any
other ACRIS document class you want to add later (judgments, easements,
etc.).

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

- **One-click activation** — Settings → Data sources → **Activate all free
  sources** enables every free NYC connector, resolves ACRIS document
  filters from the city's code table, drafts Socrata field maps with AI,
  starts 36-month backfills, and queues first pulls. Data starts flowing
  within ~10 minutes of one click.
- **Schedule** — sweeps run **every day at 11:00 and 23:00 UTC**. Only one
  cron trigger is registered (`*/10 * * * *` in `wrangler.toml` — Cloudflare
  caps schedules per account on the Free plan); the tick computes the sweep
  boundaries in code. A sweep only *seeds* a pull queue; the
  10-minute background tick drains a couple of connectors per invocation.
  (Workers meter two budgets per invocation: **external** fetches — 50 on
  the Free plan — and calls to Cloudflare services like D1, capped at 1,000
  on Free. One ACRIS join costs `1 + 2 × ceil(docs / 250)` external
  requests, so the default 5,000-document budget costs 41, just inside the
  external cap; running every connector in one invocation would blow it,
  which is why pulls are spread across ticks. Raising `docBudget` raises
  that cost linearly — 6,000 documents is about the Free-plan ceiling for a
  single connector. The D1 side is batched (see `BulkResolver` in
  `ingest.ts`), so ingesting those 5,000 records costs a few hundred
  service calls rather than the ~20,000 a per-row path would. Spreading pulls across ticks keeps every connector
  inside the budget no matter how many are enabled.) Scoring, custom
  signals, entity resolution, and the digest run when the queue drains.
- **Historical backfill** — Settings → Historical backfill, or automatic:
  any enabled, eligible source that has never crawled is auto-started at
  the next sweep. Crawls advance in the background every 10 minutes until
  they reach −36 months. Scraped portals can't be backfilled (a page has
  no history).
- **Pipeline doctor** — Settings → Data sources → **Diagnose** explains,
  per feed tab, exactly why it is or isn't populating (e.g. "the loans
  table is empty — County loans has never ingested"), plus a per-connector
  verdict (disabled / failed with error / pulling but quarantining / healthy).
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
| Nothing populates at all, connectors look configured | Connectors are **disabled by default** — use **Activate all free sources** (Settings → Data sources), which enables, maps, backfills, and queues everything in one click |
| A tab (Maturities/Cash-Poor/Permits/Distress) is empty | Click **Diagnose** in Settings → Data sources — it states the exact reason per feed (missing table data, no records in the signal window, connector failed) |
| Backfill shows a "coverage gap" warning | One day held more documents than a single pull could read, so its earliest part was skipped. Raise that source's field-map `docBudget` and re-run the backfill to recover the day |
| ACRIS backfill is crawling slowly | Expected on high-volume document types: a saturated window resumes where it stopped rather than skipping ahead, so coverage stays complete. Raise `docBudget` to trade subrequests for speed |
| Feeds are empty but every connector says healthy | Open **Settings → Pipeline health → Diagnose** and read the **Data coverage** panel. It reports what exists, how far behind each source is, how many rows each signal window actually reaches, and the top rejection reasons — the doctor above it only says whether connectors *ran* |
| A market you configured matches nothing | The coverage panel names it. Boroughs and counties both work (`Brooklyn, NY` and `Kings, NY` are the same market), but a market that matches no stored records means every record outside the matched set is being quarantined on geography |
| ACRIS connector returns 0 rows for days at a time | Expected. The extract is regenerated monthly, so daily pulls are no-ops between publications and take a batch when one lands |
| ACRIS lien-family connector returns 0 rows | Doc-type filters resolve automatically from the city's code table on first pull; if resolution failed, *Test source* narrates why and lists the real codes to paste into the field-map *where* |
| Tax lien connector looks quiet | It now reads **recorded** NYC/Federal tax liens from ACRIS (live). The DOF lien-*sale* list is frozen while NYC's lien sale is suspended — that dataset stays stale citywide |
