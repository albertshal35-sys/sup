# LienWolf — Master Build Prompt

> Reusable prompt for Claude Code sessions building or extending this platform.

---

Build **LienWolf**, a high-performance B2B SaaS platform for private and hard money
real estate lenders. It aggregates county records, building permits, mechanics liens
and skip-trace/social data to flag **high-intent borrowing triggers**, so lenders can
find active fix-and-flippers and developers at the moment they urgently need capital.
It is an all-in-one sales command center: one screen, every signal, full borrower
context, direct contact actions.

## Tech stack (fixed)

- **Frontend:** React 18 + TypeScript + Tailwind CSS, deployed on Cloudflare Pages.
- **Backend:** Cloudflare Workers (edge routing, webhook ingestion, cron pipeline).
- **Database:** Cloudflare D1 (serverless SQLite) with a materialized `triggers` table so feed reads are single indexed queries.
- **State:** Zustand (lightweight; persist only watchlist/dismissals to localStorage).

## Core features (all required)

1. **Upcoming Maturity Sniffer** — feed of borrowers whose private/hard-money notes were originated **8–10 months ago** (12-month terms ⇒ maturity approaching ⇒ refinance urgency). Show principal, rate, lender, D-{days} countdown, intent score.
2. **Cash-Poor Trigger** — entities with **≥2 all-cash purchases recorded in the last 60 days**: prime delayed-financing candidates needing to replenish liquidity. Show total cash deployed, buy count, window length.
3. **Automated Borrower Resume** — per-prospect modal stitching **36 months of transactions**: total flips, estimated gross margins, average hold/days-on-market, volume, full debt stack, active signals, and skip-traced contact channels with match confidence.
4. **Permit-to-Social Matching** — feed of large **ground-up / structural permits** (≥$250K valuation) filed in the last 30 days, linked to the registered LLC and the principal's skip-traced phone/email/LinkedIn.
5. **Contractor Lien Monitoring** — alert feed for **fresh mechanics liens** (≤21 days): a frozen construction draw signals need for rescue capital. Critical urgency when the same entity also carries a maturing note.

## Data pipeline (hardened, reliable)

- Worker **cron, weekdays once daily** (`0 11 * * 1-5`): county deeds → county loans → permits → liens → skip-trace → trigger scoring.
- Every connector: 3 retry attempts with exponential backoff, per-run audit row (`ingestion_runs`: status/rows/attempts/checksum), idempotent upserts keyed on document numbers. One failing source never blocks the rest.
- HMAC-verified webhook endpoint for vendors that push urgent records (new liens) between runs.
- Pipeline health surfaced in the UI as a first-class dashboard tile.

## UI/UX constraints (strict)

- **Theme:** "Obsidian" minimalist dark mode — deep blacks (#0a0a0e family), rich dark grays, desaturated glacier-cyan + dusk-violet accents for active states only. WCAG-safe text contrast throughout.
- **Aesthetic:** Glassmorphism 2.0 / liquid glass — subtle `backdrop-blur` translucent layers, 1px semi-transparent hairline borders, diffused shadows, faint ambient radial glows. Depth without noise; never overdo the blur.
- **Layout:** Bento/CSS-grid dashboard with **high information density** — power users want data, not whitespace. KPI metric strip (4–5 cards with SVG sparklines) on top: New Leads, Expiring Loans, Cash-Poor Buyers, Active Liens, High-Velocity Flippers.
- **Navigation:** sleek sidebar — full labels on large screens, icon rail on tablet, slide-over on mobile — maximizing viewport for the data grid.
- **Typography:** Inter (geometric sans). Left-align text, **right-align numbers, tabular numerals for all financial figures**.
- Must feel like a premium native macOS/iOS app translated to web; flawless on desktop **and mobile**. Intentional micro-interactions (fade-up card entrances, hover reveals, pulsing live dots). Nothing generic — no Bootstrap/MUI look.

## Product behaviors

- Every feed row: click → Borrower Resume; hover actions → call, email, watch, dismiss.
- Intent score 0–100 per trigger with urgency tiers (critical ≥90 pulses red, hot ≥78 amber, warm cyan).
- Watchlist persisted per user; dismissed triggers stay hidden.
- Customizable: coverage markets, trigger thresholds, alert preferences (settings surface).
- Frontend degrades gracefully to bundled demo data when the API is unreachable, so the UI is always demoable.
