-- ============================================================
-- 0012 — Party mailing addresses from ACRIS
--
-- The Real Property Parties dataset (636b-3b5g) publishes, for every party
-- on every recorded document: Address Line 1, Address Line 2, City, State,
-- Zip and Country (extract guide, Parties fields 5-10). The adapter was
-- reading only party_type and name and discarding the rest.
--
-- That address is the one the borrowing entity itself put on a recorded
-- instrument — for an LLC with no public footprint it is often the only
-- contact detail that exists anywhere, and it costs nothing extra to
-- collect: the Parties rows are already fetched for the names.
--
-- `entities.mailing_address` already exists; these add the rest of the
-- address plus a marker for which document revision supplied it, so a
-- later correction can replace an older address instead of being ignored.
-- ============================================================

ALTER TABLE entities ADD COLUMN mailing_city    TEXT;
ALTER TABLE entities ADD COLUMN mailing_state   TEXT;
ALTER TABLE entities ADD COLUMN mailing_zip     TEXT;
ALTER TABLE entities ADD COLUMN mailing_seen_at TEXT;
