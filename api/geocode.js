module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const q = String(req.query.q || req.query.address || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing address.' });
  try {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('q', q);
    const r = await fetch(url.toString(), { headers: { Accept: 'application/json', 'User-Agent': 'ClinicMapIQ/7 public referral outreach planner devender0309@gmail.com' } });
    if (!r.ok) return res.status(r.status).json({ error: `Geocoding returned ${r.status}` });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return res.status(404).json({ error: 'No public address match found.' });
    const item = rows[0];
    return res.status(200).json({ lat: Number(item.lat), lon: Number(item.lon), display_name: item.display_name || q, address: item.address || {}, source: 'Nominatim public geocoding' });
  } catch (e) {
    return res.status(502).json({ error: e.message || 'Geocoding failed.' });
  }
};
