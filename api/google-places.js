module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return res.status(200).json({ places: [], disabled: true, message: 'GOOGLE_PLACES_API_KEY is not configured.' });
  const query = String(req.query.query || '').trim();
  const lat = Number(req.query.lat), lon = Number(req.query.lon), radiusMiles = Math.min(Math.max(Number(req.query.radiusMiles || 8), 1), 50);
  if (!query || !Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ places: [], error: 'Missing query or location.' });
  try {
    const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
    url.searchParams.set('query', `${query} healthcare office clinic`);
    url.searchParams.set('location', `${lat},${lon}`);
    url.searchParams.set('radius', String(Math.round(radiusMiles * 1609.344)));
    url.searchParams.set('key', key);
    const r = await fetch(url.toString());
    const j = await r.json();
    if (j.status && !['OK','ZERO_RESULTS'].includes(j.status)) return res.status(200).json({ places: [], error: j.error_message || j.status });
    const rows = (j.results || []).slice(0, 20).map(x => ({
      place_id: x.place_id,
      name: x.name,
      address: x.formatted_address || x.vicinity || '',
      lat: x.geometry && x.geometry.location ? x.geometry.location.lat : null,
      lon: x.geometry && x.geometry.location ? x.geometry.location.lng : null,
      rating: x.rating,
      user_ratings_total: x.user_ratings_total,
      photo_reference: x.photos && x.photos[0] ? x.photos[0].photo_reference : '',
      photo_url: x.photos && x.photos[0] ? `/api/place-photo?ref=${encodeURIComponent(x.photos[0].photo_reference)}` : '',
      category: (x.types || []).join(', '),
      types: x.types || [],
      phone: '',
      website: ''
    }));
    // Fetch details for top 8 to improve phone/website without excessive cost.
    const detailed = [];
    for (const p of rows.slice(0, 8)) {
      try {
        const du = new URL('https://maps.googleapis.com/maps/api/place/details/json');
        du.searchParams.set('place_id', p.place_id);
        du.searchParams.set('fields', 'name,formatted_address,formatted_phone_number,website,geometry,type,url,business_status,photos');
        du.searchParams.set('key', key);
        const dr = await fetch(du.toString());
        const dj = await dr.json();
        if (dj.result) {
          p.phone = dj.result.formatted_phone_number || p.phone;
          p.website = dj.result.website || '';
          p.address = dj.result.formatted_address || p.address;
          p.business_status = dj.result.business_status || '';
          if (dj.result.photos && dj.result.photos[0]) {
            p.photo_reference = dj.result.photos[0].photo_reference;
            p.photo_url = `/api/place-photo?ref=${encodeURIComponent(p.photo_reference)}`;
          }
        }
      } catch (_) {}
      detailed.push(p);
    }
    return res.status(200).json({ places: [...detailed, ...rows.slice(8)] });
  } catch (e) {
    return res.status(502).json({ places: [], error: e.message || 'Google Places lookup failed.' });
  }
};
