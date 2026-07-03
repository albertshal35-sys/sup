-- ============================================================
-- 0005 — Data integrity core + intelligence features
--   1. Provenance on every record (source, method, confidence)
--   2. Liens become the distress table (violations, auctions)
--   3. Loan lifecycle: satisfactions, UCC instruments
--   4. Quarantine, per-source stats, entity merge suggestions
--   5. Custom signals, loan book, backfill state
--   6. Seven new NYC connectors + Socrata field mapping
-- ============================================================

-- ---------- 1. Provenance ----------
ALTER TABLE transactions ADD COLUMN source_id TEXT;
ALTER TABLE transactions ADD COLUMN source_url TEXT;
ALTER TABLE transactions ADD COLUMN source_method TEXT;      -- api | scrape | seed | manual
ALTER TABLE transactions ADD COLUMN confidence TEXT NOT NULL DEFAULT 'direct';  -- corroborated | direct | extracted
ALTER TABLE transactions ADD COLUMN ingested_at TEXT;

-- Loans: rebuild — property becomes optional (UCC filings often carry no
-- property address), plus provenance and lifecycle columns.
CREATE TABLE loans_new (
  id             TEXT PRIMARY KEY,
  property_id    TEXT REFERENCES properties(id),
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
  satisfied_at   TEXT,                                       -- set by satisfactions connector
  instrument     TEXT NOT NULL DEFAULT 'mortgage'            -- mortgage | ucc
);
INSERT INTO loans_new (id, property_id, entity_id, lender_name, lender_type, principal, rate_pct,
                       originated_at, term_months, maturity_date, lien_position, status, doc_number, source, origin)
  SELECT id, property_id, entity_id, lender_name, lender_type, principal, rate_pct,
         originated_at, term_months, maturity_date, lien_position, status, doc_number, source, origin FROM loans;
DROP TABLE loans;
ALTER TABLE loans_new RENAME TO loans;
CREATE UNIQUE INDEX IF NOT EXISTS idx_loans_doc ON loans(doc_number) WHERE doc_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_loans_origination ON loans(status, originated_at);
CREATE INDEX IF NOT EXISTS idx_loans_entity ON loans(entity_id);

ALTER TABLE permits ADD COLUMN source_id TEXT;
ALTER TABLE permits ADD COLUMN source_url TEXT;
ALTER TABLE permits ADD COLUMN source_method TEXT;
ALTER TABLE permits ADD COLUMN confidence TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE permits ADD COLUMN ingested_at TEXT;

-- ---------- 2. Liens → distress events (rebuild for expanded CHECK) ----------
CREATE TABLE liens_new (
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
INSERT INTO liens_new (id, property_id, entity_id, lien_type, claimant, amount, filed_at, status, doc_number, source, origin)
  SELECT id, property_id, entity_id, lien_type, claimant, amount, filed_at, status, doc_number, source, origin FROM liens;
DROP TABLE liens;
ALTER TABLE liens_new RENAME TO liens;
CREATE UNIQUE INDEX IF NOT EXISTS idx_liens_doc ON liens(doc_number) WHERE doc_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_liens_filed ON liens(status, filed_at DESC);

-- ---------- 3. Triggers (rebuild to allow custom signals) ----------
CREATE TABLE triggers_new (
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
INSERT INTO triggers_new SELECT * FROM triggers;
DROP TABLE triggers;
ALTER TABLE triggers_new RENAME TO triggers;
CREATE INDEX IF NOT EXISTS idx_triggers_feed ON triggers(kind, status, score DESC);
CREATE INDEX IF NOT EXISTS idx_triggers_detected ON triggers(detected_at DESC);

-- ---------- 4. Integrity infrastructure ----------
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

-- ---------- 5. Custom signals, loan book, backfill ----------
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

-- ---------- 6. New connectors + Socrata field mapping ----------
ALTER TABLE connector_config ADD COLUMN field_map TEXT;      -- JSON: {"dateField": "...", "map": {ours: theirs}}

INSERT OR IGNORE INTO connector_config (id, label) VALUES
  ('satisfactions', 'Mortgage satisfactions'),
  ('lis_pendens',   'Lis pendens / pre-foreclosure'),
  ('violations',    'DOB & ECB violations'),
  ('tax_liens',     'Tax lien sale list'),
  ('auctions',      'Foreclosure auctions'),
  ('ucc_filings',   'UCC filings'),
  ('corp_registry', 'Corporation registry');
