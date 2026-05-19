module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const city = String(req.query.city || '').trim();
  const state = String(req.query.state || '').trim().toUpperCase();
  const taxonomy = String(req.query.taxonomy_description || '').trim();
  const limit = Math.min(Math.max(Number(req.query.limit || 80), 1), 200);
  if (!city || !/^[A-Z]{2}$/.test(state)) return res.status(400).json({ results: [], error: 'City and 2-letter state are required.' });
  try {
    const url = new URL('https://npiregistry.cms.hhs.gov/api/');
    url.searchParams.set('version', '2.1');
    url.searchParams.set('city', city);
    url.searchParams.set('state', state);
    url.searchParams.set('limit', String(limit));
    if (taxonomy) url.searchParams.set('taxonomy_description', taxonomy);
    // Prefer organizations, but if too few, frontend will call multiple terms.
    if (req.query.enumeration_type) url.searchParams.set('enumeration_type', String(req.query.enumeration_type));
    const r = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    if (!r.ok) return res.status(r.status).json({ results: [], error: `NPI Registry returned ${r.status}` });
    const json = await r.json();
    return res.status(200).json(json);
  } catch (e) {
    return res.status(502).json({ results: [], error: e.message || 'NPI lookup failed.' });
  }
};
