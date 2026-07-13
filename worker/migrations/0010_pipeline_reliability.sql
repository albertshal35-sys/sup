-- ============================================================
-- 0010 — Pipeline reliability: queue-based ingestion + live tax liens
--
-- Workers cap upstream fetches per invocation (50 on the Free plan) and a
-- single ACRIS-join pull costs up to ~9, so running every connector in one
-- cron invocation fails silently partway through once enough sources are
-- enabled. The twice-daily crons now only seed this queue; the 10-minute
-- tick drains a bounded slice per invocation.
-- ============================================================

CREATE TABLE IF NOT EXISTS pull_queue (
  connector   TEXT PRIMARY KEY,
  enqueued_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tax liens: the DOF lien-sale list is frozen while NYC's lien sale is
-- suspended (Land Bank transition targeted 2029), so the default source
-- moves to recorded NYC/Federal tax liens on ACRIS — a live document
-- stream. Doc-type codes resolve automatically from the city's Document
-- Control Codes dataset on first pull. Guarded: only applies if the
-- connector is still at its seeded DOF default; field_map is cleared
-- because any saved mapping targeted the DOF dataset's columns.
UPDATE connector_config SET
  base_url = 'https://data.cityofnewyork.us/resource/bnx9-e6tj.json',
  field_map = NULL,
  notes = 'Recorded NYC/Federal tax liens via the ACRIS join (Master + Legals + Parties). The doc_type filter resolves automatically from the city''s code table on first pull and appears in the field map, where you can adjust it. (The DOF lien-sale list 9rz4-mjek is frozen while NYC''s lien sale is suspended pending the Land Bank transition — recorded tax liens keep flowing regardless.)'
WHERE id = 'tax_liens' AND base_url = 'https://data.cityofnewyork.us/resource/9rz4-mjek.json';
