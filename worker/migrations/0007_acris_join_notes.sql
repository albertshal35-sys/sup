-- 0007 — The ACRIS three-dataset join is now native: refresh the seeded
-- connector notes (only where the operator hasn't rewritten them).

UPDATE connector_config SET notes =
  'ACRIS native join: Master (bnx9-e6tj) + Legals (8h5j-fqxa) + Parties (636b-3b5g) are joined automatically by document_id — complete deed records with names and addresses, no field map needed. Default filter doc_type = ''DEED'' (override via field map "where"). Covers Manhattan/Brooklyn/Queens/Bronx; Staten Island = Richmond County Clerk (scrape). All-cash detection reconciles against mortgage recordings automatically.'
WHERE id = 'county_deeds' AND notes LIKE '%master alone lacks%';

UPDATE connector_config SET notes =
  'ACRIS native join (Master + Legals + Parties by document_id) — complete mortgage records with borrower, lender and address. Default filter doc_type IN (''MTGE'',''AGMT''). Lender type auto-classified bank vs private from the name. Note: NYC recordings carry amounts but rarely interest rates.'
WHERE id = 'county_loans' AND notes LIKE '%Same join caveat%';

UPDATE connector_config SET notes =
  'ACRIS native join, doc_type = ''SAT''. Satisfactions match open loans by borrower + lender and close them (paid_off + satisfied_at).'
WHERE id = 'satisfactions' AND notes LIKE '%Parties 636b-3b5g join%';
