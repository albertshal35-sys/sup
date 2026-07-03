-- ============================================================
-- LienWolf D1 Schema (Cloudflare D1 / SQLite)
-- Borrower-intent intelligence for private & hard money lenders
-- ============================================================

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- Platform users (lender-side accounts)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,               -- ulid
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  org_name      TEXT,
  role          TEXT NOT NULL DEFAULT 'analyst' CHECK (role IN ('owner','admin','analyst')),
  -- per-user customization: saved filters, column layouts, alert prefs
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- Borrowing entities (LLCs and individuals). The "prospect".
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entities (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL DEFAULT 'llc' CHECK (kind IN ('llc','individual','trust','corp')),
  name             TEXT NOT NULL,               -- "SUNBELT EQUITY GROUP LLC"
  state            TEXT,                        -- registration state
  formation_date   TEXT,
  registered_agent TEXT,
  mailing_address  TEXT,
  principal_name   TEXT,                        -- skip-traced managing member
  -- rolling 36-month performance snapshot (denormalized by nightly job)
  flips_36mo       INTEGER NOT NULL DEFAULT 0,
  avg_margin_pct   REAL,
  avg_hold_days    REAL,
  volume_36mo      INTEGER NOT NULL DEFAULT 0,  -- gross $ bought+sold
  velocity_score   REAL NOT NULL DEFAULT 0,     -- 0-100 composite
  origin           TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','demo')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
CREATE INDEX IF NOT EXISTS idx_entities_velocity ON entities(velocity_score DESC);

-- ------------------------------------------------------------
-- Skip-traced contact channels for an entity's principals
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  title       TEXT,                              -- "Managing Member"
  phone       TEXT,
  email       TEXT,
  linkedin    TEXT,
  instagram   TEXT,
  source      TEXT NOT NULL DEFAULT 'skip_trace',-- skip_trace | sos_filing | permit | manual
  confidence  REAL NOT NULL DEFAULT 0.5,         -- 0..1 match confidence
  verified_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contacts_entity ON contacts(entity_id);

-- ------------------------------------------------------------
-- Physical parcels
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS properties (
  id            TEXT PRIMARY KEY,
  apn           TEXT,                            -- assessor parcel number
  address       TEXT NOT NULL,
  city          TEXT NOT NULL,
  county        TEXT NOT NULL,
  state         TEXT NOT NULL,
  zip           TEXT,
  property_type TEXT NOT NULL DEFAULT 'sfr' CHECK (property_type IN ('sfr','multi','condo','land','commercial','mixed')),
  beds          INTEGER,
  baths         REAL,
  sqft          INTEGER,
  year_built    INTEGER,
  est_value     INTEGER,                         -- AVM estimate, whole dollars
  lat           REAL,
  lng           REAL,
  origin        TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','demo')),
  UNIQUE (apn, county, state)
);
CREATE INDEX IF NOT EXISTS idx_properties_county ON properties(county, state);

-- ------------------------------------------------------------
-- Recorded transfers (deeds). Fuel for Cash-Poor + Resume.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id),
  entity_id    TEXT REFERENCES entities(id),     -- buying/selling entity if matched
  side         TEXT NOT NULL CHECK (side IN ('purchase','sale')),
  price        INTEGER NOT NULL,
  is_cash      INTEGER NOT NULL DEFAULT 0,       -- 1 = no concurrent deed of trust
  deed_type    TEXT,                             -- warranty | special_warranty | quitclaim | trustee
  buyer_name   TEXT,
  seller_name  TEXT,
  recorded_at  TEXT NOT NULL,                    -- county recording date
  doc_number   TEXT,
  source       TEXT NOT NULL DEFAULT 'county_recorder',
  origin       TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','demo'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_doc ON transactions(doc_number) WHERE doc_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tx_entity_date ON transactions(entity_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_cash_recent ON transactions(is_cash, recorded_at DESC);

-- ------------------------------------------------------------
-- Recorded loans (deeds of trust / mortgages). Fuel for Maturity Sniffer.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loans (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id),
  entity_id      TEXT REFERENCES entities(id),
  lender_name    TEXT NOT NULL,
  lender_type    TEXT NOT NULL DEFAULT 'private' CHECK (lender_type IN ('private','hard_money','bank','credit_union','seller')),
  principal      INTEGER NOT NULL,
  rate_pct       REAL,
  originated_at  TEXT NOT NULL,
  term_months    INTEGER,                        -- typical private note: 12
  maturity_date  TEXT,                           -- explicit if recorded, else originated + term
  lien_position  INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paid_off','defaulted','refinanced')),
  doc_number     TEXT,
  source         TEXT NOT NULL DEFAULT 'county_recorder',
  origin         TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','demo'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_loans_doc ON loans(doc_number) WHERE doc_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_loans_origination ON loans(status, originated_at);
CREATE INDEX IF NOT EXISTS idx_loans_entity ON loans(entity_id);

-- ------------------------------------------------------------
-- Building permits. Fuel for Permit-to-Social Matching.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS permits (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id),
  entity_id    TEXT REFERENCES entities(id),
  permit_no    TEXT NOT NULL,
  permit_type  TEXT NOT NULL CHECK (permit_type IN ('ground_up','structural','addition','demo','remodel','pool','solar','other')),
  description  TEXT,
  valuation    INTEGER,                          -- declared job value
  filed_at     TEXT NOT NULL,
  issued_at    TEXT,
  status       TEXT NOT NULL DEFAULT 'filed' CHECK (status IN ('filed','issued','in_review','expired','finaled')),
  contractor   TEXT,
  source       TEXT NOT NULL DEFAULT 'municipal_portal',
  origin       TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','demo'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_permits_no ON permits(permit_no, property_id);
CREATE INDEX IF NOT EXISTS idx_permits_filed ON permits(filed_at DESC);
CREATE INDEX IF NOT EXISTS idx_permits_value ON permits(valuation DESC);

-- ------------------------------------------------------------
-- Mechanics liens & other involuntary encumbrances. Rescue-capital signal.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS liens (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id),
  entity_id    TEXT REFERENCES entities(id),
  lien_type    TEXT NOT NULL DEFAULT 'mechanics' CHECK (lien_type IN ('mechanics','tax','hoa','judgment','lis_pendens')),
  claimant     TEXT NOT NULL,                    -- the contractor/sub filing
  amount       INTEGER NOT NULL,
  filed_at     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','disputed','foreclosing')),
  doc_number   TEXT,
  source       TEXT NOT NULL DEFAULT 'county_recorder',
  origin       TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','demo'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_liens_doc ON liens(doc_number) WHERE doc_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_liens_filed ON liens(status, filed_at DESC);

-- ------------------------------------------------------------
-- Materialized high-intent triggers ("leads"). One row per signal.
-- Recomputed by the nightly ingestion job; UI reads from here.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS triggers (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('maturity','cash_poor','permit','lien')),
  entity_id    TEXT NOT NULL REFERENCES entities(id),
  property_id  TEXT REFERENCES properties(id),
  ref_id       TEXT,                             -- id of the loan/permit/lien row that fired
  score        REAL NOT NULL DEFAULT 0,          -- 0-100 urgency composite
  urgency      TEXT NOT NULL DEFAULT 'warm' CHECK (urgency IN ('critical','hot','warm')),
  headline     TEXT NOT NULL,                    -- one-line human summary
  payload_json TEXT NOT NULL DEFAULT '{}',       -- kind-specific detail blob
  detected_at  TEXT NOT NULL DEFAULT (datetime('now')),
  status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','viewed','contacted','dismissed','converted')),
  origin       TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','demo')),
  UNIQUE (kind, entity_id, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_triggers_feed ON triggers(kind, status, score DESC);
CREATE INDEX IF NOT EXISTS idx_triggers_detected ON triggers(detected_at DESC);

-- ------------------------------------------------------------
-- Per-user watchlist / pipeline
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS watchlist (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_id      TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  note           TEXT,
  stage          TEXT NOT NULL DEFAULT 'watching' CHECK (stage IN ('watching','outreach','term_sheet','funded','lost')),
  follow_up_date TEXT,                             -- next scheduled touch
  deal_value     INTEGER,                          -- manual deal-size override
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, entity_id)
);

-- ------------------------------------------------------------
-- CRM activity trail per lead (calls, emails, stage moves, notes)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('added','stage','note','call','email','follow_up')),
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lead_events ON lead_events(user_id, entity_id, created_at DESC);

-- ------------------------------------------------------------
-- Principals (people) and their links to entities. One developer
-- typically operates several LLCs — this is the relationship graph
-- that lets a lender court the customer, not just the entity.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS principals (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  phone    TEXT,
  email    TEXT,
  linkedin TEXT,
  origin   TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','demo'))
);
CREATE INDEX IF NOT EXISTS idx_principals_name ON principals(name);

CREATE TABLE IF NOT EXISTS entity_principals (
  id           TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  entity_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role         TEXT DEFAULT 'managing_member',
  source       TEXT NOT NULL DEFAULT 'sos_filing',
  confidence   REAL NOT NULL DEFAULT 0.8,
  UNIQUE (principal_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_ep_entity ON entity_principals(entity_id);
CREATE INDEX IF NOT EXISTS idx_ep_principal ON entity_principals(principal_id);

-- ------------------------------------------------------------
-- App-wide settings (data mode, coverage markets, …)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('data_mode', 'demo');
INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('markets', '["Kings, NY","Queens, NY","Bronx, NY","New York, NY","Richmond, NY"]');

-- ------------------------------------------------------------
-- Vendor connector configuration. API keys are AES-GCM encrypted
-- with a key derived from the ADMIN_TOKEN secret; only the Worker
-- can decrypt them at run time.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connector_config (
  id            TEXT PRIMARY KEY,      -- county_deeds | county_loans | permits | liens | skip_trace
  label         TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 0,
  base_url      TEXT,
  api_key_ct    TEXT,                  -- base64 ciphertext
  api_key_iv    TEXT,                  -- base64 IV
  api_key_last4 TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO connector_config (id, label) VALUES
  ('county_deeds', 'County recorder — deeds'),
  ('county_loans', 'County recorder — deeds of trust'),
  ('permits', 'Municipal permits'),
  ('liens', 'Mechanics liens'),
  ('skip_trace', 'Skip trace / contact enrichment');

-- ------------------------------------------------------------
-- Hardened ingestion audit log: one row per connector per run.
-- Reliability surface for the daily weekday pipeline.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id            TEXT PRIMARY KEY,
  connector     TEXT NOT NULL,                   -- county_deeds | county_loans | permits | liens | skip_trace | scoring
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','partial','failed')),
  rows_ingested INTEGER NOT NULL DEFAULT 0,
  rows_skipped  INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 1,
  checksum      TEXT,                            -- payload hash to detect silent source drift
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_ingestion_recent ON ingestion_runs(started_at DESC);
