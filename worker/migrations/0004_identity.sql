-- Neutral operator identity: reset the feature-settings defaults shipped in
-- 0003 (they carried a placeholder company name) and the demo user row.
-- These keys were introduced in the same release, so resetting to the new
-- defaults is safe.

UPDATE app_settings
SET value = '{"rateSpread":0.5,"points":2,"termMonths":12,"maxLtv":70,"minLoan":100000,"lenderName":"LienWolf Lending","validDays":7}'
WHERE key = 'underwriting';

UPDATE app_settings
SET value = '{"senderName":"","company":"","signature":"","defaultChannel":"email"}'
WHERE key = 'outreach';

UPDATE users
SET email = 'demo@lienwolf.app', name = 'Demo Operator', org_name = 'LienWolf'
WHERE id = 'usr_01';
