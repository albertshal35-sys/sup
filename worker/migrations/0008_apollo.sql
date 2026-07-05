-- 0008 — Enrichment connector is native Apollo.io, on-demand only.
UPDATE connector_config SET
  label = 'Apollo contact enrichment',
  base_url = 'https://api.apollo.io',
  notes = 'Paste your Apollo API key (apollo.io → Settings → Integrations → API). Enrichment is on-demand: the Enrich button on a borrower resume matches that one borrower via people/match + people search (owner/principal titles) and links the person into the cross-LLC network. Run now enriches the top 5 open signals lacking contacts. The daily pipeline never bulk-spends credits.'
WHERE id = 'skip_trace';
