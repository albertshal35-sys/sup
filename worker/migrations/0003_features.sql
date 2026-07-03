-- Feature settings: alerts & digest, underwriting defaults, outreach identity.

INSERT OR IGNORE INTO app_settings (key, value) VALUES ('alerts_enabled', 'false');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('alert_email', '');
INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('underwriting', '{"rateSpread":0.5,"points":2,"termMonths":12,"maxLtv":70,"minLoan":100000,"lenderName":"LienWolf Lending","validDays":7}');
INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('outreach', '{"senderName":"","company":"","signature":"","defaultChannel":"email"}');
