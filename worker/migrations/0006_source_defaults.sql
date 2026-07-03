-- ============================================================
-- 0006 — Seed real NYC source URLs into unconfigured connectors
-- so setup starts from working endpoints instead of blank fields.
-- Only rows the operator hasn't touched (no base_url AND no
-- scrape_url) are updated; connectors stay disabled until enabled
-- in Settings. Dataset ids verified against NYC Open Data /
-- data.ny.gov, July 2026.
-- ============================================================

-- Permits — DOB NOW: Build, Job Application Filings (standalone: address,
-- job type, initial cost, owner). w9ak-ipjd.
UPDATE connector_config SET
  mode = 'api',
  base_url = 'https://data.cityofnewyork.us/resource/w9ak-ipjd.json',
  notes = 'DOB NOW Build job filings. Ground-up = New Building (NB); structural = Alteration CO (ALT-CO/ALT1). Use Auto-map, then set "where" to filter job types if volume is high. Free Socrata app token recommended.'
WHERE id = 'permits' AND base_url IS NULL AND scrape_url IS NULL;

-- Violations — DOB ECB Violations (respondent name + penalty + address). 6bgk-3dad.
UPDATE connector_config SET
  mode = 'api',
  base_url = 'https://data.cityofnewyork.us/resource/6bgk-3dad.json',
  notes = 'DOB ECB violations: respondent, penalty imposed, violation address. Companion datasets: DOB Violations 3h2n-5cm9, HPD Violations wvxf-dwi5.'
WHERE id = 'violations' AND base_url IS NULL AND scrape_url IS NULL;

-- Tax liens — DOF Tax Lien Sale Lists. 9rz4-mjek.
UPDATE connector_config SET
  mode = 'api',
  base_url = 'https://data.cityofnewyork.us/resource/9rz4-mjek.json',
  notes = 'Annual DOF tax lien sale list (updated ahead of each sale). Dataset has address/BBL but no owner name — map ownerName from a joined source or expect quarantine until enriched.'
WHERE id = 'tax_liens' AND base_url IS NULL AND scrape_url IS NULL;

-- Corporation registry — NY DOS Active Corporations (data.ny.gov). n9v6-gdp6.
UPDATE connector_config SET
  mode = 'api',
  base_url = 'https://data.ny.gov/resource/n9v6-gdp6.json',
  notes = 'NYS Active Corporations: entity name, initial DOS filing date, registered agent. Enrichment only — never creates entities. Filter with "where" to county IN (KINGS, QUEENS, BRONX, NEW YORK, RICHMOND).'
WHERE id = 'corp_registry' AND base_url IS NULL AND scrape_url IS NULL;

-- ACRIS family — the master dataset carries doc type/amount/date, but party
-- names live in Parties (636b-3b5g) and addresses in Legals (8h5j-fqxa),
-- joined by document_id. Until a joined feed is configured, records lacking
-- names/addresses will quarantine — the notes say so honestly.
UPDATE connector_config SET
  mode = 'api',
  base_url = 'https://data.cityofnewyork.us/resource/bnx9-e6tj.json',
  notes = 'ACRIS Real Property Master (deeds: set where doc_type = ''DEED''). NOTE: master alone lacks address (Legals 8h5j-fqxa) and party names (Parties 636b-3b5g), joined by document_id — use a joined feed/vendor, or scrape a836-acris.nyc.gov search results. Covers Manhattan/Brooklyn/Queens/Bronx; Staten Island = Richmond County Clerk (scrape).'
WHERE id = 'county_deeds' AND base_url IS NULL AND scrape_url IS NULL;

UPDATE connector_config SET
  mode = 'api',
  base_url = 'https://data.cityofnewyork.us/resource/bnx9-e6tj.json',
  notes = 'ACRIS Real Property Master (mortgages: set where doc_type IN (''MTGE'',''AGMT'')). Same join caveat as deeds: names in Parties 636b-3b5g, addresses in Legals 8h5j-fqxa. Recorded NYC mortgages carry amounts but rarely interest rates.'
WHERE id = 'county_loans' AND base_url IS NULL AND scrape_url IS NULL;

UPDATE connector_config SET
  mode = 'api',
  base_url = 'https://data.cityofnewyork.us/resource/bnx9-e6tj.json',
  notes = 'ACRIS Real Property Master (satisfactions: set where doc_type = ''SAT''). Lender name via Parties 636b-3b5g join.'
WHERE id = 'satisfactions' AND base_url IS NULL AND scrape_url IS NULL;

-- Scrape-first sources (no public API): seed the portal URLs + guidance.
UPDATE connector_config SET
  mode = 'scrape',
  scrape_url = 'https://iapps.courts.state.ny.us/webcivil/ecourtsMain',
  notes = 'Lis pendens are filed with each borough County Clerk / Supreme Court. NYSCEF & eCourts publish case indexes; paste a search-results URL for the borough + case type. PropertyShark also surfaces LP filings. The single best rescue-capital lead.'
WHERE id = 'lis_pendens' AND base_url IS NULL AND scrape_url IS NULL;

UPDATE connector_config SET
  mode = 'scrape',
  scrape_url = 'https://www.nycourts.gov/courts/2jd/kings/civil/foreclosures.shtml',
  notes = 'Kings County Supreme foreclosure auction calendar (swap per borough: Queens 11jd, Bronx 12jd, Richmond 13jd). Auction buyers are all-cash by definition — delayed-financing targets.'
WHERE id = 'auctions' AND base_url IS NULL AND scrape_url IS NULL;

UPDATE connector_config SET
  mode = 'scrape',
  scrape_url = 'https://appext20.dos.ny.gov/pls/ucc_public/web_search.main_frame',
  notes = 'NY DOS UCC search is form-driven — paste a results URL after searching a secured party, or use ACRIS UCC doc classes via the API instead. Secured party = the competitor lender.'
WHERE id = 'ucc_filings' AND base_url IS NULL AND scrape_url IS NULL;

UPDATE connector_config SET
  mode = 'scrape',
  scrape_url = 'https://a836-acris.nyc.gov/DS/DocumentSearch/DocumentType',
  notes = 'Borough County Clerk mechanics-lien indexes; ACRIS captures many NYC lien documents (doc class LIEN). Staten Island: rcc.richmondcountyclerk.com.'
WHERE id = 'liens' AND base_url IS NULL AND scrape_url IS NULL;

UPDATE connector_config SET
  mode = 'api',
  base_url = 'https://api.apollo.io/v1',
  notes = 'Apollo.io-compatible enrichment (POST /trace). Paste your Apollo API key; alternatives: PeopleDataLabs, BatchSkipTracing.'
WHERE id = 'skip_trace' AND base_url IS NULL AND scrape_url IS NULL;
