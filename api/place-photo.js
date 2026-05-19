module.exports = async function handler(req, res) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  const ref = String(req.query.ref || '').trim();
  const maxwidth = String(req.query.maxwidth || '420');
  if (!key || !ref) return res.status(404).send('Photo unavailable');
  const url = new URL('https://maps.googleapis.com/maps/api/place/photo');
  url.searchParams.set('maxwidth', maxwidth);
  url.searchParams.set('photo_reference', ref);
  url.searchParams.set('key', key);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.redirect(302, url.toString());
};
