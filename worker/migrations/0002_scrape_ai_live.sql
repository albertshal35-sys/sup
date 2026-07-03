-- Scrape-capable connectors, AI settings, live-by-default data mode.

-- Connectors can now be API-based or scraped via headless browser.
ALTER TABLE connector_config ADD COLUMN mode TEXT NOT NULL DEFAULT 'api';
ALTER TABLE connector_config ADD COLUMN scrape_url TEXT;
ALTER TABLE connector_config ADD COLUMN notes TEXT;

-- Live data is the default posture; demo mode is opt-in from Settings.
UPDATE app_settings SET value = 'live', updated_at = datetime('now') WHERE key = 'data_mode';

-- AI pipeline settings (Workers AI via AI Gateway)
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('ai_model', '@cf/moonshotai/kimi-k2.6');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('ai_gateway_id', '');

-- Relabel skip-trace as contact enrichment (Apollo-compatible)
UPDATE connector_config SET label = 'Contact enrichment (Apollo-compatible)' WHERE id = 'skip_trace';

-- Home markets: the five NYC boroughs (county names as recorded on deeds)
UPDATE app_settings SET value = '["Kings, NY","Queens, NY","Bronx, NY","New York, NY","Richmond, NY"]', updated_at = datetime('now') WHERE key = 'markets';
