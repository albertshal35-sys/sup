-- ============================================================
-- 0013 — PLUTO parcel facts + derived market value
--
-- PLUTO (64uk-42ks) is keyed by BBL, which the ACRIS join now produces for
-- every recorded document. That makes the city's tax-lot file a free join
-- rather than a new integration: it turns "a note matures in 40 days" into
-- "a note matures in 40 days on a 12-unit 1928 walk-up with $X equity".
--
-- On assessed value: NYC does NOT assess at market. Class 1 (1-3 family)
-- is assessed at 6% of market value and Classes 2-4 at 45%, so using
-- `assesstot` as a value would understate a Class 1 property by ~16x and
-- make every LTV meaningless. `est_market_value` is assessed value grossed
-- back up by the ratio implied by the building class — an estimate, and
-- labelled as one. `assessed_value` keeps the raw figure so the derivation
-- is always auditable.
-- ============================================================

ALTER TABLE properties ADD COLUMN lot_area           INTEGER;  -- square feet
ALTER TABLE properties ADD COLUMN bldg_area          INTEGER;  -- gross square feet
ALTER TABLE properties ADD COLUMN units_total        INTEGER;
ALTER TABLE properties ADD COLUMN num_floors         REAL;
ALTER TABLE properties ADD COLUMN bldg_class         TEXT;     -- NYC building class, e.g. C4
ALTER TABLE properties ADD COLUMN zoning             TEXT;
ALTER TABLE properties ADD COLUMN owner_name         TEXT;     -- owner of record per DOF
ALTER TABLE properties ADD COLUMN assessed_value     INTEGER;  -- raw assesstot, NOT market
ALTER TABLE properties ADD COLUMN est_market_value   INTEGER;  -- assessed / assessment ratio
ALTER TABLE properties ADD COLUMN tax_class          TEXT;     -- 1 | 2 | 4, derived from bldg_class
ALTER TABLE properties ADD COLUMN pluto_synced_at    TEXT;

CREATE INDEX IF NOT EXISTS idx_properties_pluto ON properties(pluto_synced_at);
