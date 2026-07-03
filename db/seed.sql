-- ============================================================
-- LienWolf demo seed — dates are relative to `now` so trigger
-- windows (8-10mo maturities, 60-day cash buys) always fire.
-- ============================================================

DELETE FROM triggers; DELETE FROM watchlist; DELETE FROM lead_events; DELETE FROM liens;
DELETE FROM permits; DELETE FROM loans; DELETE FROM transactions; DELETE FROM contacts;
DELETE FROM entity_principals; DELETE FROM principals; DELETE FROM properties;
DELETE FROM entities; DELETE FROM ingestion_runs; DELETE FROM users;

INSERT INTO users (id, email, name, org_name, role) VALUES
  ('usr_01', 'max@alluraimports.com', 'Max', 'Allura Capital', 'owner');

-- ---------- Entities ----------
INSERT INTO entities (id, kind, name, state, formation_date, registered_agent, principal_name, flips_36mo, avg_margin_pct, avg_hold_days, volume_36mo, velocity_score) VALUES
  ('ent_01','llc','BUSHWICK EQUITY GROUP LLC','NY','2019-03-11','Cogency Global','Marcus Delgado',14,21.4,127,6840000,91),
  ('ent_02','llc','ASTORIA DEVELOPMENT PARTNERS LLC','NY','2017-08-02','CT Corporation','Priya Raman',9,18.2,164,9120000,84),
  ('ent_03','individual','DANIEL OKAFOR','NY',NULL,NULL,'Daniel Okafor',11,24.8,98,4210000,88),
  ('ent_04','llc','CANARSIE GATE HOLDINGS LLC','NY','2021-01-19','Registered Agents Inc','Sofia Anand',6,15.1,143,3380000,72),
  ('ent_05','llc','BLUE HERON BUILDERS LLC','NY','2016-05-27','NW Registered Agent','Tom Kowalski',17,19.7,151,11260000,89),
  ('ent_06','llc','MORRIS PARK CAPITAL LLC','NY','2020-11-03','Cogency Global','Elena Vasquez',8,22.3,112,3970000,81),
  ('ent_07','llc','EMPIRE URBAN INFILL LLC','NY','2018-02-14','CT Corporation','James Whitfield',5,17.9,201,7450000,69),
  ('ent_08','individual','GRACE LIU','NY',NULL,NULL,'Grace Liu',7,26.1,89,2890000,86),
  ('ent_09','llc','PELHAM RIDGE VENTURES LLC','NY','2022-06-08','Sunshine Corporate Filings','Andre Boyd',4,13.4,177,2140000,58),
  ('ent_10','llc','CROWN HEIGHTS RESTORATIONS LLC','NY','2019-09-30','Registered Agents Inc','Nina Petrov',12,20.6,119,5530000,87);

-- ---------- Contacts (skip-traced) ----------
INSERT INTO contacts (id, entity_id, name, title, phone, email, linkedin, source, confidence, verified_at) VALUES
  ('con_01','ent_01','Marcus Delgado','Managing Member','(718) 555-0134','marcus@bushwickequity.com','linkedin.com/in/marcusdelgado-re','skip_trace',0.94,date('now','-12 days')),
  ('con_02','ent_02','Priya Raman','Principal','(347) 555-0182','praman@astoriadev.com','linkedin.com/in/priyaraman-dev','skip_trace',0.91,date('now','-30 days')),
  ('con_03','ent_03','Daniel Okafor',NULL,'(917) 555-0197','d.okafor@gmail.com',NULL,'skip_trace',0.88,date('now','-8 days')),
  ('con_04','ent_04','Sofia Anand','Managing Member','(718) 555-0121','sofia@canarsiegate.co',NULL,'sos_filing',0.79,NULL),
  ('con_05','ent_05','Tom Kowalski','Owner','(718) 555-0158','tom@blueheronbuild.com','linkedin.com/in/tomkowalski-fl','skip_trace',0.96,date('now','-5 days')),
  ('con_06','ent_06','Elena Vasquez','Managing Member','(347) 555-0176','elena@morrisparkcap.com',NULL,'skip_trace',0.85,date('now','-19 days')),
  ('con_07','ent_07','James Whitfield','Principal','(929) 555-0110','jw@empireinfill.com','linkedin.com/in/jwhitfield-atx','permit',0.82,NULL),
  ('con_08','ent_08','Grace Liu',NULL,'(347) 555-0143','grace.liu.re@gmail.com',NULL,'skip_trace',0.9,date('now','-3 days')),
  ('con_09','ent_09','Andre Boyd','Managing Member','(917) 555-0129','andre@pelhamridge.io',NULL,'sos_filing',0.74,NULL),
  ('con_10','ent_10','Nina Petrov','Owner','(646) 555-0165','nina@crownheights.build','linkedin.com/in/ninapetrov-az','skip_trace',0.93,date('now','-15 days'));

-- ---------- Properties ----------
INSERT INTO properties (id, apn, address, city, county, state, zip, property_type, beds, baths, sqft, year_built, est_value) VALUES
  ('prp_01','173-24-091','448 Lefferts Ave','Brooklyn','Kings','NY','11225','sfr',4,3,2450,1978,912000),
  ('prp_02','215-06-330','19-17 Ditmars Blvd','Queens','Queens','NY','11105','sfr',3,2,1710,1962,748000),
  ('prp_03','118-51-207','789 Hancock St','Brooklyn','Kings','NY','11233','sfr',5,3.5,3120,1989,1130000),
  ('prp_04','402-88-014','22-05 31st Ave','Queens','Queens','NY','11106','multi',8,8,6400,2024,2850000),
  ('prp_05','30-3129-004','1174 Boston Rd','Bronx','Bronx','NY','10456','sfr',3,2,1440,1954,517000),
  ('prp_06','173-09-556','603 Bainbridge St','Brooklyn','Kings','NY','11233','sfr',4,4,3380,2001,1620000),
  ('prp_07','051-77-102','91-12 95th St','Queens','Queens','NY','11416','sfr',3,1,1180,1958,442000),
  ('prp_08','A-1902-88','331 Bement Ave','Staten Island','Richmond','NY','10310','sfr',5,4,3890,2025,2210000),
  ('prp_09','133-18-440','224 Malcolm X Blvd','Brooklyn','Kings','NY','11221','sfr',3,2,1560,1971,486000),
  ('prp_10','215-44-019','55-01 Myrtle Ave','Queens','Queens','NY','11385','sfr',4,3,2280,2024,1390000),
  ('prp_11','30-4411-233','842 E 224th St','Bronx','Bronx','NY','10466','multi',6,6,4820,2025,1980000),
  ('prp_12','162-30-078','410 Quincy St','Brooklyn','Kings','NY','11225','sfr',3,2,1820,1965,689000),
  ('prp_13','097-25-611','160-05 89th Ave','Queens','Queens','NY','11432','sfr',4,2,1950,1974,538000),
  ('prp_14','B-2277-13','52 Harrison Ave','Staten Island','Richmond','NY','10302','sfr',3,2,1610,1959,472000);

-- ---------- Loans (maturity sniffer fuel: originated 8-10 months ago) ----------
INSERT INTO loans (id, property_id, entity_id, lender_name, lender_type, principal, rate_pct, originated_at, term_months, maturity_date, status) VALUES
  ('lon_01','prp_01','ent_01','Anchor Bridge Capital','hard_money',618000,11.25,date('now','-9 months','-6 days'),12,date('now','+2 months','+24 days'),'active'),
  ('lon_02','prp_03','ent_10','Hudson Peak Funding','private',742000,10.75,date('now','-9 months','-19 days'),12,date('now','+2 months','+11 days'),'active'),
  ('lon_03','prp_02','ent_03','Empire State Note Co','hard_money',505000,11.9,date('now','-8 months','-11 days'),12,date('now','+3 months','+19 days'),'active'),
  ('lon_04','prp_06','ent_06','Anchor Bridge Capital','hard_money',1090000,10.5,date('now','-10 months','+3 days'),12,date('now','+2 months','-3 days'),'active'),
  ('lon_05','prp_05','ent_08','Gotham Private Lending','private',352000,12.1,date('now','-8 months','-27 days'),12,date('now','+3 months','+3 days'),'active'),
  ('lon_06','prp_07','ent_07','Empire State Note Co','hard_money',298000,11.5,date('now','-9 months','-2 days'),12,date('now','+2 months','+28 days'),'active'),
  ('lon_07','prp_09','ent_04','Hudson Peak Funding','private',331000,10.9,date('now','-10 months','-8 days'),12,date('now','+1 months','+22 days'),'active'),
  -- historical / non-triggering loans for resume depth
  ('lon_08','prp_12','ent_01','Anchor Bridge Capital','hard_money',447000,11.0,date('now','-22 months'),12,date('now','-10 months'),'paid_off'),
  ('lon_09','prp_13','ent_10','Hudson Peak Funding','private',365000,10.5,date('now','-17 months'),12,date('now','-5 months'),'paid_off'),
  ('lon_10','prp_14','ent_05','Gotham Private Lending','private',312000,11.75,date('now','-14 months'),12,date('now','-2 months'),'refinanced');

-- ---------- Transactions (cash-poor fuel: multiple all-cash buys < 60 days) ----------
INSERT INTO transactions (id, property_id, entity_id, side, price, is_cash, deed_type, buyer_name, seller_name, recorded_at) VALUES
  -- ent_02 Ironwood: 3 cash buys in last 45 days
  ('trx_01','prp_04','ent_02','purchase',1410000,1,'special_warranty','ASTORIA DEVELOPMENT PARTNERS LLC','ESTATE OF R MARTIN',date('now','-41 days')),
  ('trx_02','prp_10','ent_02','purchase',866000,1,'warranty','ASTORIA DEVELOPMENT PARTNERS LLC','KELLER 1990 TRUST',date('now','-26 days')),
  ('trx_03','prp_07','ent_02','purchase',401000,1,'warranty','ASTORIA DEVELOPMENT PARTNERS LLC','VARGAS FAMILY LP',date('now','-9 days')),
  -- ent_05 Blue Heron: 2 cash buys in last 30 days
  ('trx_04','prp_11','ent_05','purchase',1235000,1,'special_warranty','BLUE HERON BUILDERS LLC','82ND TERRACE PROP CO',date('now','-24 days')),
  ('trx_05','prp_14','ent_05','purchase',438000,1,'warranty','BLUE HERON BUILDERS LLC','J & M SANDERS',date('now','-13 days')),
  -- ent_03 Daniel Okafor: 2 cash buys in last 55 days
  ('trx_06','prp_02','ent_03','purchase',592000,1,'warranty','DANIEL OKAFOR','TRAVIS CTY TAX SALE',date('now','-52 days')),
  ('trx_07','prp_13','ent_03','purchase',417000,1,'warranty','DANIEL OKAFOR','WEBER DR HOLDINGS LLC',date('now','-17 days')),
  -- resume history (flips) for ent_01
  ('trx_08','prp_12','ent_01','purchase',521000,0,'warranty','BUSHWICK EQUITY GROUP LLC','PRIVATE SELLER',date('now','-22 months')),
  ('trx_09','prp_12','ent_01','sale',689000,0,'warranty','OWNER OCCUPANT','BUSHWICK EQUITY GROUP LLC',date('now','-15 months')),
  ('trx_10','prp_01','ent_01','purchase',655000,0,'warranty','BUSHWICK EQUITY GROUP LLC','ESTATE SALE',date('now','-9 months','-6 days')),
  ('trx_11','prp_09','ent_04','purchase',389000,0,'warranty','CANARSIE GATE HOLDINGS LLC','HUD',date('now','-10 months','-8 days')),
  ('trx_12','prp_03','ent_10','purchase',818000,0,'warranty','CROWN HEIGHTS RESTORATIONS LLC','RELOCATION CO',date('now','-9 months','-19 days'));

-- ---------- Permits (permit-to-social fuel) ----------
INSERT INTO permits (id, property_id, entity_id, permit_no, permit_type, description, valuation, filed_at, status, contractor) VALUES
  ('pmt_01','prp_04','ent_02','2026-BP-18834','ground_up','New 8-unit multifamily, 3-story, 6,400 sqft','2350000',date('now','-11 days'),'in_review','Astoria Development (owner-builder)'),
  ('pmt_02','prp_08','ent_05','BLD-26-04412','ground_up','New SFR 3,890 sqft w/ detached ADU','1180000',date('now','-6 days'),'filed','Blue Heron Builders LLC'),
  ('pmt_03','prp_06','ent_06','2026-BP-17501','structural','Full gut: remove 2 bearing walls, new steel beam, 900 sqft addition','487000',date('now','-15 days'),'issued','Morris Park Capital (GC: Sunline Const.)'),
  ('pmt_04','prp_11','ent_05','MIA-26-22093','ground_up','New 6-unit townhome cluster','1640000',date('now','-19 days'),'in_review','Blue Heron Builders LLC'),
  ('pmt_05','prp_10','ent_07','2026-BP-19112','structural','Second-story addition + foundation underpinning','362000',date('now','-4 days'),'filed','Empire Urban Infill LLC');

-- ---------- Mechanics liens (rescue capital fuel) ----------
INSERT INTO liens (id, property_id, entity_id, lien_type, claimant, amount, filed_at, status) VALUES
  ('lin_01','prp_06','ent_06','mechanics','Sunline Construction Inc',148500,date('now','-3 days'),'active'),
  ('lin_02','prp_04','ent_02','mechanics','Capital City Concrete LLC',86200,date('now','-7 days'),'active'),
  ('lin_03','prp_01','ent_01','mechanics','Delgado Bros Plumbing (no relation)',23400,date('now','-12 days'),'disputed'),
  ('lin_04','prp_11','ent_05','mechanics','Biscayne Steel Erectors',211700,date('now','-2 days'),'active');

-- ---------- Materialized triggers (what the nightly job would emit) ----------
INSERT INTO triggers (id, kind, entity_id, property_id, ref_id, score, urgency, headline, payload_json, detected_at, status) VALUES
  ('trg_01','maturity','ent_04','prp_09','lon_07',94,'critical','Note matures in ~52 days — originated 10 mo ago with Hudson Peak','{"principal":331000,"lender":"Hudson Peak Funding","rate":10.9,"daysToMaturity":52}',datetime('now','-1 days'),'new'),
  ('trg_02','maturity','ent_06','prp_06','lon_04',92,'critical','$1.09M hard money note ~57 days from maturity; active mechanics lien on same asset','{"principal":1090000,"lender":"Anchor Bridge Capital","rate":10.5,"daysToMaturity":57}',datetime('now','-1 days'),'new'),
  ('trg_03','maturity','ent_10','prp_03','lon_02',88,'hot','12-mo private note at 10.75% enters month 10 next week','{"principal":742000,"lender":"Hudson Peak Funding","rate":10.75,"daysToMaturity":71}',datetime('now','-2 days'),'new'),
  ('trg_04','maturity','ent_01','prp_01','lon_01',86,'hot','Serial flipper (14 exits/36mo) holding an 11.25% bridge in month 9','{"principal":618000,"lender":"Anchor Bridge Capital","rate":11.25,"daysToMaturity":84}',datetime('now','-1 days'),'viewed'),
  ('trg_05','maturity','ent_07','prp_07','lon_06',79,'hot','Bridge note month 9 of 12; permit activity suggests project mid-flight','{"principal":298000,"lender":"Empire State Note Co","rate":11.5,"daysToMaturity":88}',datetime('now','-3 days'),'new'),
  ('trg_06','maturity','ent_03','prp_02','lon_03',77,'warm','High-margin flipper in month 8; refi window opening','{"principal":505000,"lender":"Empire State Note Co","rate":11.9,"daysToMaturity":109}',datetime('now','-2 days'),'new'),
  ('trg_07','maturity','ent_08','prp_05','lon_05',74,'warm','12.1% private note in month 8 — rate-relief refi candidate','{"principal":352000,"lender":"Gotham Private Lending","rate":12.1,"daysToMaturity":93}',datetime('now','-4 days'),'new'),
  ('trg_08','cash_poor','ent_02','prp_04',NULL,90,'critical','$2.68M deployed cash across 3 buys in 41 days — delayed-financing window open on all three','{"cashDeployed":2677000,"buys":3,"windowDays":41}',datetime('now','-1 days'),'new'),
  ('trg_09','cash_poor','ent_05','prp_11',NULL,85,'hot','$1.67M cash across 2 buys in 24 days while carrying 2 ground-up permits','{"cashDeployed":1673000,"buys":2,"windowDays":24}',datetime('now','-1 days'),'new'),
  ('trg_10','cash_poor','ent_03','prp_13',NULL,76,'warm','$1.01M cash across 2 buys in 52 days incl. tax-sale acquisition','{"cashDeployed":1009000,"buys":2,"windowDays":52}',datetime('now','-2 days'),'new'),
  ('trg_11','permit','ent_02','prp_04','pmt_01',89,'hot','$2.35M ground-up 8-unit filed 11 days ago; LLC matched, principal skip-traced','{"valuation":2350000,"permitType":"ground_up"}',datetime('now','-1 days'),'new'),
  ('trg_12','permit','ent_05','prp_11','pmt_04',84,'hot','$1.64M 6-unit townhome cluster in review; owner-builder','{"valuation":1640000,"permitType":"ground_up"}',datetime('now','-2 days'),'new'),
  ('trg_13','permit','ent_05','prp_08','pmt_02',80,'warm','$1.18M new SFR + ADU filed 6 days ago','{"valuation":1180000,"permitType":"ground_up"}',datetime('now','-1 days'),'new'),
  ('trg_14','permit','ent_06','prp_06','pmt_03',73,'warm','$487K structural gut issued; same asset carries maturing note','{"valuation":487000,"permitType":"structural"}',datetime('now','-3 days'),'viewed'),
  ('trg_15','lien','ent_05','prp_11','lin_04',93,'critical','$211.7K steel lien filed 2 days ago on active 6-unit build — draw likely frozen','{"amount":211700,"claimant":"Biscayne Steel Erectors"}',datetime('now'),'new'),
  ('trg_16','lien','ent_06','prp_06','lin_01',91,'critical','$148.5K GC lien on Brooklyn gut reno; note matures in ~57 days','{"amount":148500,"claimant":"Sunline Construction Inc"}',datetime('now','-1 days'),'new'),
  ('trg_17','lien','ent_02','prp_04','lin_02',82,'hot','$86.2K concrete lien on new 8-unit; entity also cash-poor','{"amount":86200,"claimant":"Capital City Concrete LLC"}',datetime('now','-2 days'),'new'),
  ('trg_18','lien','ent_01','prp_01','lin_03',61,'warm','$23.4K plumbing lien (disputed) on bridge-financed flip','{"amount":23400,"claimant":"Delgado Bros Plumbing"}',datetime('now','-5 days'),'viewed');

-- ---------- Ingestion audit trail ----------
INSERT INTO ingestion_runs (id, connector, started_at, finished_at, status, rows_ingested, rows_skipped, attempts, checksum) VALUES
  ('run_01','county_deeds',datetime('now','-8 hours'),datetime('now','-8 hours','+4 minutes'),'ok',1284,17,1,'a91c3f'),
  ('run_02','county_loans',datetime('now','-8 hours'),datetime('now','-8 hours','+6 minutes'),'ok',402,3,1,'77be02'),
  ('run_03','permits',datetime('now','-8 hours'),datetime('now','-8 hours','+3 minutes'),'ok',356,9,2,'c04d11'),
  ('run_04','liens',datetime('now','-8 hours'),datetime('now','-8 hours','+2 minutes'),'ok',88,1,1,'19ffa8'),
  ('run_05','skip_trace',datetime('now','-8 hours'),datetime('now','-7 hours','+52 minutes'),'partial',61,12,3,'e2a940'),
  ('run_06','scoring',datetime('now','-7 hours'),datetime('now','-7 hours','+1 minutes'),'ok',18,0,1,NULL);

-- ---------- Principals & cross-LLC links (borrower network) ----------
INSERT INTO principals (id, name, phone, email, origin) VALUES
  ('prn_01','Marcus Delgado','(718) 555-0134','marcus@bushwickequity.com','demo'),
  ('prn_02','Priya Raman','(347) 555-0182','praman@astoriadev.com','demo'),
  ('prn_03','Tom Kowalski','(718) 555-0158','tom@blueheronbuild.com','demo'),
  ('prn_04','Daniel Okafor','(917) 555-0197','d.okafor@gmail.com','demo'),
  ('prn_05','Elena Vasquez','(347) 555-0176','elena@morrisparkcap.com','demo');

INSERT INTO entity_principals (id, principal_id, entity_id, role, source, confidence) VALUES
  ('ep_01','prn_01','ent_01','managing_member','sos_filing',0.95),
  ('ep_02','prn_01','ent_04','manager','sos_filing',0.82),
  ('ep_03','prn_02','ent_02','managing_member','sos_filing',0.94),
  ('ep_04','prn_02','ent_07','managing_member','sos_filing',0.88),
  ('ep_05','prn_03','ent_05','managing_member','sos_filing',0.96),
  ('ep_06','prn_03','ent_09','managing_member','sos_filing',0.9),
  ('ep_07','prn_04','ent_03','owner','county_recorder',1.0),
  ('ep_08','prn_05','ent_06','managing_member','sos_filing',0.9);

-- ---------- Mark every seeded record as demo data ----------
UPDATE entities SET origin='demo';
UPDATE properties SET origin='demo';
UPDATE transactions SET origin='demo';
UPDATE loans SET origin='demo';
UPDATE permits SET origin='demo';
UPDATE liens SET origin='demo';
UPDATE triggers SET origin='demo';
UPDATE principals SET origin='demo';

-- App defaults (idempotent — also created by migration 0001)
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('data_mode', 'demo');

-- Approximate coordinates for map view
UPDATE properties SET lat=40.6605, lng=-73.953 WHERE address='448 Lefferts Ave';
UPDATE properties SET lat=40.7757, lng=-73.9095 WHERE address='19-17 Ditmars Blvd';
UPDATE properties SET lat=40.6852, lng=-73.9223 WHERE address='789 Hancock St';
UPDATE properties SET lat=40.7648, lng=-73.926 WHERE address='22-05 31st Ave';
UPDATE properties SET lat=40.8299, lng=-73.8944 WHERE address='1174 Boston Rd';
UPDATE properties SET lat=40.6817, lng=-73.913 WHERE address='603 Bainbridge St';
UPDATE properties SET lat=40.6867, lng=-73.85 WHERE address='91-12 95th St';
UPDATE properties SET lat=40.6321, lng=-74.108 WHERE address='331 Bement Ave';
UPDATE properties SET lat=40.687, lng=-73.935 WHERE address='224 Malcolm X Blvd';
UPDATE properties SET lat=40.6997, lng=-73.899 WHERE address='55-01 Myrtle Ave';
UPDATE properties SET lat=40.888, lng=-73.86 WHERE address='842 E 224th St';
UPDATE properties SET lat=40.689, lng=-73.937 WHERE address='410 Quincy St';
UPDATE properties SET lat=40.706, lng=-73.799 WHERE address='160-05 89th Ave';
UPDATE properties SET lat=40.636, lng=-74.115 WHERE address='52 Harrison Ave';
