-- ============================================================
-- 0005 — Data integrity core + intelligence features
--   1. Provenance on every record (source, method, confidence)
--   2. Liens become the distress table (violations, auctions)
--   3. Loan lifecycle: satisfactions, UCC instruments
--   4. Quarantine, per-source stats, entity merge suggestions
--   5. Custom signals, loan book, backfill state
--   6. Seven new NYC connectors + Socrata field mapping
--
-- Implementation note: this rebuilds the data tables outright
-- (DROP + CREATE in canonical shape) instead of ALTER/copy. The
-- production database predates the migration system, so early
-- tables drifted from 0001's definitions (e.g. no `origin`
-- column) and a copy-based rebuild is not deterministic against
-- them. All ingested/demo record data is recreated by the
-- pipeline or `npm run db:seed`; operator state (users,
-- app_settings, connector_config, ingestion_runs) is untouched.
-- ============================================================

-- Clean up any partial artifacts from an earlier failed apply.
DROP TABLE IF EXISTS liens_new;
DROP TABLE IF EXISTS loans_new;
DROP TABLE IF EXISTS triggers_new;

DROP TABLE IF EXISTS lead_events;
DROP TABLE IF EXISTS watchlist;
DROP TABLE IF EXISTS triggers;
DROP TABLE IF EXISTS liens;
DROP TABLE IF EXISTS permits;
DROP TABLE IF EXISTS loans;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS entity_principals;
DROP TABLE IF EXISTS principals;
DROP TABLE IF EXISTS contacts;
DROP TABLE IF EXISTS properties;
DROP TABLE IF EXISTS entities;

-- ---------- canonical data tables ----------

CREATE TABLE entities (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL DEFAULT 'llc' CHECK (kind IN ('llc','individual','trust','corp')),
  name             TEXT NOT NULL,
  state            TEXT,
  formation_date   TEXT,
  registered_agent TEXT,
  mailing_address  TEXT,
  principal_name   TEXT,
  flips_36mo       INTEGER NOT NULL DEFAULT 0,
  avg_margin_pct   REAL,
  avg_hold_days    REAL,
  volume_36mo      INTEGER NOT NULL DEFAULT 0,
  velocity_score   REAL NOT NULL DEFAULT 0,
  origin           TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','demo')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_entities_name ON entities(name);
CREATE INDEX idx_entities_velocity ON entities(velocity_score DESC);

CREATE TABLE contacts (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  title       TEXT,
  phone       TEXT,
  email       TEXT,
  linkedin    TEXT,
  instagram   TEXT,
  source      TEXT NOT NULL DEFAULT 'skip_trace',
  confidence  REAL NOT NULL DEFAULT 0.5,
  verified_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_contacts_entity ON contacts(entity_id);

CREATE TABLE properties (
  id            TEXT PRIMARY KEY,
  apn           TEXT,
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
  est_value     INTEGER,
  lat           REAL,
  lng           REAL,
  origin        TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','demo')),
  UNIQUE (apn, county, state)
);
CREATE INDEX idx_properties_county ON properties(county, state);

CREATE TABLE transactions (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id),
  entity_id     TEXT REFERENCES entities(id),
  side          TEXT NOT NULL CHECK (side IN ('purchase','sale')),
  price         INTEGER NOT NULL,
  is_cash       INTEGER NOT NULL DEFAULT 0,
  deed_type     TEXT,
  buyer_name    TEXT,
  seller_name   TEXT,
  recorded_at   TEXT NOT NULL,
  doc_number    TEXT,
  source        TEXT NOT NULL DEFAULT 'county_recorder',
  origin        TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','demo')),
  source_id     TEXT,
  source_url    TEXT,
  source_method TEXT,
  confidence    TEXT NOT NULL DEFAULT 'direct',
  ingested_at   TEXT
);
CREATE UNIQUE INDEX idx_tx_doc ON transactions(doc_number) WHERE doc_number IS NOT NULL;
CREATE INDEX idx_tx_entity_date ON transactions(entity_id, recorded_at DESC);
CREATE INDEX idx_tx_cash_recent ON transactions(is_cash, recorded_at DESC);

CREATE TABLE loans (
  id             TEXT PRIMARY KEY,
  property_id    TEXT REFERENCES properties(id),   -- nullable: UCC filings may carry no property
  entity_id      TEXT REFERENCES entities(id),
  lender_name    TEXT NOT NULL,
  lender_type    TEXT NOT NULL DEFAULT 'private' CHECK (lender_type IN ('private','hard_money','bank','credit_union','seller')),
  principal      INTEGER NOT NULL,
  rate_pct       REAL,
  originated_at  TEXT NOT NULL,
  term_months    INTEGER,
  maturity_date  TEXT,
  lien_position  INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paid_off','defaulted','refinanced')),
  doc_number     TEXT,
  source         TEXT NOT NULL DEFAULT 'county_recorder',
  origin         TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','demo')),
  source_id      TEXT,
  source_url     TEXT,
  source_method  TEXT,
  confidence     TEXT NOT NULL DEFAULT 'direct',
  ingested_at    TEXT,
  satisfied_at   TEXT,
  instrument     TEXT NOT NULL DEFAULT 'mortgage'
);
CREATE UNIQUE INDEX idx_loans_doc ON loans(doc_number) WHERE doc_number IS NOT NULL;
CREATE INDEX idx_loans_origination ON loans(status, originated_at);
CREATE INDEX idx_loans_entity ON loans(entity_id);

CREATE TABLE permits (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id),
  entity_id     TEXT REFERENCES entities(id),
  permit_no     TEXT NOT NULL,
  permit_type   TEXT NOT NULL CHECK (permit_type IN ('ground_up','structural','addition','demo','remodel','pool','solar','other')),
  description   TEXT,
  valuation     INTEGER,
  filed_at      TEXT NOT NULL,
  issued_at     TEXT,
  status        TEXT NOT NULL DEFAULT 'filed' CHECK (status IN ('filed','issued','in_review','expired','finaled')),
  contractor    TEXT,
  source        TEXT NOT NULL DEFAULT 'municipal_portal',
  origin        TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','demo')),
  source_id     TEXT,
  source_url    TEXT,
  source_method TEXT,
  confidence    TEXT NOT NULL DEFAULT 'direct',
  ingested_at   TEXT
);
CREATE UNIQUE INDEX idx_permits_no ON permits(permit_no, property_id);
CREATE INDEX idx_permits_filed ON permits(filed_at DESC);
CREATE INDEX idx_permits_value ON permits(valuation DESC);

CREATE TABLE liens (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id),
  entity_id     TEXT REFERENCES entities(id),
  lien_type     TEXT NOT NULL DEFAULT 'mechanics'
                CHECK (lien_type IN ('mechanics','tax','hoa','judgment','lis_pendens','violation','auction')),
  claimant      TEXT NOT NULL,
  amount        INTEGER NOT NULL,
  filed_at      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','disputed','foreclosing')),
  doc_number    TEXT,
  source        TEXT NOT NULL DEFAULT 'county_recorder',
  origin        TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','demo')),
  source_id     TEXT,
  source_url    TEXT,
  source_method TEXT,
  confidence    TEXT NOT NULL DEFAULT 'direct',
  ingested_at   TEXT
);
CREATE UNIQUE INDEX idx_liens_doc ON liens(doc_number) WHERE doc_number IS NOT NULL;
CREATE INDEX idx_liens_filed ON liens(status, filed_at DESC);

CREATE TABLE triggers (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('maturity','cash_poor','permit','lien','custom')),
  entity_id    TEXT NOT NULL REFERENCES entities(id),
  property_id  TEXT REFERENCES properties(id),
  ref_id       TEXT,
  score        REAL NOT NULL DEFAULT 0,
  urgency      TEXT NOT NULL DEFAULT 'warm' CHECK (urgency IN ('critical','hot','warm')),
  headline     TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  detected_at  TEXT NOT NULL DEFAULT (datetime('now')),
  status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','viewed','contacted','dismissed','converted')),
  origin       TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','demo')),
  UNIQUE (kind, entity_id, ref_id)
);
CREATE INDEX idx_triggers_feed ON triggers(kind, status, score DESC);
CREATE INDEX idx_triggers_detected ON triggers(detected_at DESC);

CREATE TABLE watchlist (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_id      TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  note           TEXT,
  stage          TEXT NOT NULL DEFAULT 'watching' CHECK (stage IN ('watching','outreach','term_sheet','funded','lost')),
  follow_up_date TEXT,
  deal_value     INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, entity_id)
);

CREATE TABLE lead_events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('added','stage','note','call','email','follow_up')),
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_lead_events ON lead_events(user_id, entity_id, created_at DESC);

CREATE TABLE principals (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  phone    TEXT,
  email    TEXT,
  linkedin TEXT,
  origin   TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','demo'))
);

CREATE TABLE entity_principals (
  id           TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  entity_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role         TEXT DEFAULT 'managing_member',
  source       TEXT NOT NULL DEFAULT 'sos_filing',
  confidence   REAL NOT NULL DEFAULT 0.8,
  UNIQUE (principal_id, entity_id)
);
CREATE INDEX idx_ep_entity ON entity_principals(entity_id);
CREATE INDEX idx_ep_principal ON entity_principals(principal_id);

-- ---------- integrity infrastructure ----------

CREATE TABLE IF NOT EXISTS quarantine (
  id           TEXT PRIMARY KEY,
  connector    TEXT NOT NULL,
  record_kind  TEXT NOT NULL,                    -- deed | loan | permit | lien | satisfaction | ucc | corp
  payload_json TEXT NOT NULL,                    -- the rejected record, verbatim
  reasons_json TEXT NOT NULL,                    -- JSON array of failed checks
  source_url   TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','discarded')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_quarantine_status ON quarantine(status, created_at DESC);

CREATE TABLE IF NOT EXISTS source_stats (
  connector        TEXT NOT NULL,
  day              TEXT NOT NULL,               -- YYYY-MM-DD
  rows_ingested    INTEGER NOT NULL DEFAULT 0,
  rows_quarantined INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (connector, day)
);

CREATE TABLE IF NOT EXISTS merge_suggestions (
  id         TEXT PRIMARY KEY,
  entity_a   TEXT NOT NULL REFERENCES entities(id),
  entity_b   TEXT NOT NULL REFERENCES entities(id),
  reason     TEXT NOT NULL,
  score      REAL NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','merged','dismissed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_a, entity_b)
);

-- ---------- custom signals, loan book, backfill ----------

CREATE TABLE IF NOT EXISTS custom_signals (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  prompt      TEXT NOT NULL,                     -- operator's plain-English rule
  rule_json   TEXT NOT NULL,                     -- compiled deterministic rule
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  total_hits  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loan_book (
  id               TEXT PRIMARY KEY,
  entity_id        TEXT REFERENCES entities(id),
  borrower_name    TEXT NOT NULL,
  property_address TEXT,
  principal        INTEGER NOT NULL,
  rate_pct         REAL NOT NULL,
  points           REAL,
  originated_at    TEXT NOT NULL,
  term_months      INTEGER NOT NULL DEFAULT 12,
  maturity_date    TEXT,
  status           TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current','late','extended','paid_off','defaulted')),
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_loan_book_maturity ON loan_book(status, maturity_date);

CREATE TABLE IF NOT EXISTS backfill_state (
  connector   TEXT PRIMARY KEY,
  cursor_date TEXT,                              -- walks backwards month by month
  target_date TEXT,                              -- stop boundary (36 months back)
  status      TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','running','done','error')),
  rows_total  INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- new connectors + Socrata field mapping ----------

ALTER TABLE connector_config ADD COLUMN field_map TEXT;      -- JSON: {"dateField": "...", "map": {ours: theirs}}

INSERT OR IGNORE INTO connector_config (id, label) VALUES
  ('satisfactions', 'Mortgage satisfactions'),
  ('lis_pendens',   'Lis pendens / pre-foreclosure'),
  ('violations',    'DOB & ECB violations'),
  ('tax_liens',     'Tax lien sale list'),
  ('auctions',      'Foreclosure auctions'),
  ('ucc_filings',   'UCC filings'),
  ('corp_registry', 'Corporation registry');
