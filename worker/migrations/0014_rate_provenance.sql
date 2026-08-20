-- ============================================================
-- 0014 — Rate provenance
--
-- ACRIS publishes an index, not the instrument, so it states no interest
-- rate. Any rate the product shows is therefore *derived* — read out of a
-- recorded document — and needs to carry where it came from and how sure we
-- are, so a quoted number is never mistaken for a recorded fact.
--
-- rate_checked_at also stops the enrichment retrying documents that simply
-- do not state a rate.
-- ============================================================

ALTER TABLE loans ADD COLUMN rate_source     TEXT;  -- instrument:pattern | instrument:model | no_rate_stated | unreachable: ...
ALTER TABLE loans ADD COLUMN rate_confidence REAL;  -- 0-1
ALTER TABLE loans ADD COLUMN rate_checked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_loans_rate_checked ON loans(rate_checked_at);
