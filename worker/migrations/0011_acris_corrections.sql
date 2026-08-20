-- ============================================================
-- 0011 — Apply ACRIS corrections
--
-- The ACRIS OpenData Extract Guide (v1.0, DOF) defines the publishing
-- model this pipeline reads from:
--
--   * "A new extract will be generated and published each month. Each
--      monthly extract will contain all records for documents either
--      recorded OR CORRECTED in the previous month."
--   * Master field 9, Modified Date: "Date Document was Recorded or Index
--      Data was Last Corrected."
--   * "For any document, the records with the latest good through date
--      will be the current records."
--
-- So a document is not write-once: amounts, dates, parties and parcels are
-- re-published when DOF corrects an index. Our upserts were INSERT OR
-- IGNORE keyed on doc_number, which made every correction a no-op — the
-- first version of a document won permanently.
--
-- These columns let an upsert decide whether an incoming row is newer than
-- the stored one, so corrections land and stale re-reads still don't churn
-- the table.
-- ============================================================

ALTER TABLE transactions ADD COLUMN source_modified_at TEXT;
ALTER TABLE loans        ADD COLUMN source_modified_at TEXT;
ALTER TABLE liens        ADD COLUMN source_modified_at TEXT;

-- Partial-interest conveyances: Master field 13, Percentage Transferred —
-- "Reported percentage of interest transferred if the percentage is
-- available; otherwise is null". A deed moving a fractional interest is not
-- a full sale and must not read as one in the flip / cash-purchase signals.
ALTER TABLE transactions ADD COLUMN percent_transferred REAL;

CREATE INDEX IF NOT EXISTS idx_tx_modified    ON transactions(source_modified_at);
CREATE INDEX IF NOT EXISTS idx_loans_modified ON loans(source_modified_at);
CREATE INDEX IF NOT EXISTS idx_liens_modified ON liens(source_modified_at);
