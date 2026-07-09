-- ============================================================
-- 0009 — Source research pass: fix a stale scrape URL, move two
-- form-page-only scrape connectors onto the ACRIS join (which can
-- now target any recorded document type once the operator confirms
-- the code via "Discover ACRIS doc types" in Test source), and
-- correct/clarify notes based on July 2026 research. As with 0006,
-- every UPDATE is guarded to only touch rows still at their prior
-- seeded value — anything the operator has since edited is untouched.
-- ============================================================

-- Kings County foreclosure auction calendar moved: the old
-- .../courts/2jd/kings/civil/foreclosures.shtml URL is stale. The live
-- page is on the ww2 subdomain with a different filename.
UPDATE connector_config SET
  scrape_url = 'https://ww2.nycourts.gov/courts/2jd/kings/civil/foreclosuresales.shtml',
  notes = 'Kings County Supreme foreclosure auction calendar (swap per borough: Queens ww2.nycourts.gov/courts/11jd/supctqns/foreclosure-auctions.shtml, Bronx 12jd, Staten Island 13jd, Manhattan ww2.nycourts.gov/courts/1jd/supctmanh/foreclosure-auctions.shtml — every judicial district uses its own URL pattern, there is no unified API). Auction buyers are all-cash by definition — delayed-financing targets.'
WHERE id = 'auctions' AND scrape_url = 'https://www.nycourts.gov/courts/2jd/kings/civil/foreclosures.shtml';

-- Mechanic's liens: the a836-acris.nyc.gov doc-type picker is a form page,
-- not a results page, so this connector has never been able to return real
-- rows. ACRIS's Real Property Master does carry Mechanic's Lien as a
-- recorded document type (joined the same way as deeds/mortgages) — move
-- it onto that pipeline. The doc_type filter is intentionally left blank:
-- run "Discover ACRIS doc types" in Test source once to read the real code
-- off production data, then paste `doc_type = 'XXX'` into the field-map
-- "where" box below. (We deliberately don't guess it — ACRIS doc_type
-- codes aren't documented anywhere reliable, and a wrong guess would
-- silently return 0 rows forever, the exact bug this migration fixes.)
UPDATE connector_config SET
  mode = 'api',
  base_url = 'https://data.cityofnewyork.us/resource/bnx9-e6tj.json',
  scrape_url = NULL,
  notes = 'ACRIS Real Property Master, joined with Legals + Parties. Run "Discover ACRIS doc types" in Test source to find the exact code for Mechanic''s Lien, then set the field-map "where" to doc_type = ''<that code>''. Staten Island liens are not on ACRIS — use rcc.richmondcountyclerk.com instead.'
WHERE id = 'liens' AND scrape_url = 'https://a836-acris.nyc.gov/DS/DocumentSearch/DocumentType' AND base_url IS NULL;

-- Lis pendens: same problem — iapps.courts.state.ny.us/webcivil/ecourtsMain
-- is a search form with no documented direct-GET results URL (confirmed by
-- research; NYS eCourts requires form/session state). Notice of Pendency is
-- also a recorded ACRIS document type, so move this connector onto the same
-- join instead of a scrape that can never work.
UPDATE connector_config SET
  mode = 'api',
  base_url = 'https://data.cityofnewyork.us/resource/bnx9-e6tj.json',
  scrape_url = NULL,
  notes = 'ACRIS Real Property Master, joined with Legals + Parties. Run "Discover ACRIS doc types" in Test source to find the exact code for Notice of Pendency (Lis Pendens), then set the field-map "where" to doc_type = ''<that code>''. This is the single best rescue-capital lead once configured.'
WHERE id = 'lis_pendens' AND scrape_url = 'https://iapps.courts.state.ny.us/webcivil/ecourtsMain' AND base_url IS NULL;

-- Tax lien sale: NYC's 2026 lien sale is suspended (Mayor Mamdani, March
-- 2026) pending a transition to a public NYC Land Bank targeted for 2029 —
-- this dataset will look stale/quiet regardless of connector config until
-- the sale resumes. Recorded per-property NYC/federal tax liens are a
-- separate, still-live ACRIS document type if you want a current signal
-- in the meantime.
UPDATE connector_config SET
  notes = 'NYC''s 2026 tax lien sale is currently SUSPENDED pending a transition to a NYC Land Bank (targeted 2029) — this annual sale-list dataset will likely stay empty or stale until sales resume; that is expected, not a broken connector. For a live signal now, point this connector''s base_url at the ACRIS Master (https://data.cityofnewyork.us/resource/bnx9-e6tj.json) instead, run "Discover ACRIS doc types" in Test source, and filter on the NYC/Federal Tax Lien code — recorded tax liens are still ongoing even with the sale paused.'
WHERE id = 'tax_liens' AND base_url = 'https://data.cityofnewyork.us/resource/9rz4-mjek.json';

-- UCC filings: ACRIS only records UCC financing statements for co-op share
-- loans — general business UCC1/UCC3 (the actually useful "which lender
-- has a claim on this LLC's assets" signal) lives solely with NY DOS, which
-- has no public bulk API. Clarify what "paste a results URL" concretely
-- means so this isn't a dead end.
UPDATE connector_config SET
  notes = 'NY DOS UCC search (appext20.dos.ny.gov) is form/session-driven with no public API or bulk export — there is no URL fix for that. To use it: run a search on the site for a secured party or debtor name, then paste the RESULTS page URL (after you search, not the landing page) here so it can be scraped. ACRIS separately records UCC1/UCC3 filings, but only for co-op share loans, not general business assets — not a substitute for most competitor-lender lookups.'
WHERE id = 'ucc_filings' AND scrape_url = 'https://appext20.dos.ny.gov/pls/ucc_public/web_search.main_frame';

-- Permits: note the companion "issued" dataset so ground-up construction
-- starts (not just filings) can be tracked if the operator wants it.
UPDATE connector_config SET
  notes = 'DOB NOW Build job filings (New Building + full Demolition only — other job types are on the legacy DOB Job Application Filings dataset, ic3t-wcy2). Ground-up = New Building (NB); structural = Alteration CO (ALT-CO/ALT1). For actual permit ISSUANCE events (construction start, not application), the companion dataset is DOB Permit Issuance (data.cityofnewyork.us/resource/ipu4-2q9a.json) — same field-map workflow, configure as a second connector-style pull via a custom signal if you want both. Free Socrata app token recommended for volume.'
WHERE id = 'permits' AND base_url = 'https://data.cityofnewyork.us/resource/w9ak-ipjd.json';
