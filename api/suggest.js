module.exports = async function handler(req, res) {
  try {
    const q = String(req.query.q || '').trim();
    if (!q || q.length < 3) return res.status(200).json({ suggestions: [] });
    const key = process.env.GOOGLE_PLACES_API_KEY;
    if (key) {
      try {
        const url = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
        url.searchParams.set('input', q);
        url.searchParams.set('types', 'geocode');
        url.searchParams.set('components', 'country:us');
        url.searchParams.set('key', key);
        const r = await fetch(url.toString());
        const j = await r.json();
        if (Array.isArray(j.predictions) && j.predictions.length) {
          const suggestions = j.predictions.slice(0, 6).map(p => ({
            label: p.description,
            main: (p.structured_formatting && p.structured_formatting.main_text) || p.description,
            secondary: (p.structured_formatting && p.structured_formatting.secondary_text) || 'Google Places address suggestion',
            source: 'Google Places'
          }));
          return res.status(200).json({ suggestions });
        }
      } catch (_) {}
    }
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', q);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', '6');
    url.searchParams.set('countrycodes', 'us');
    const r = await fetch(url.toString(), { headers: { 'User-Agent': 'ClinicMapIQ/1.0 address suggestions' } });
    const j = await r.json();
    const suggestions = (Array.isArray(j) ? j : []).slice(0, 6).map(x => {
      const a = x.address || {};
      const main = x.name || a.road || a.house_number && a.road ? `${a.house_number} ${a.road}` : x.display_name;
      const parts = [a.city || a.town || a.village || a.hamlet, a.state, a.postcode].filter(Boolean).join(', ');
      return { label: x.display_name, main, secondary: parts || 'OpenStreetMap address suggestion', source: 'OpenStreetMap' };
    });
    return res.status(200).json({ suggestions });
  } catch (err) {
    return res.status(200).json({ suggestions: [] });
  }
};
