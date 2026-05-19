export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const key = process.env.RESEND_API_KEY || process.env.SEND_EMAIL_API_KEY || '';
  const from = process.env.EMAIL_FROM || 'ClinicMap IQ <onboarding@resend.dev>';
  if (!key) return res.status(501).json({ error: 'Email provider not configured' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const to = String(body.to || '').trim();
    const subject = String(body.subject || 'ClinicMap IQ reminder').slice(0, 180);
    const text = String(body.text || '').slice(0, 20000);
    if (!to || !to.includes('@')) return res.status(400).json({ error: 'Valid recipient email required' });
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: 'Email send failed', details: data });
    return res.status(200).json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ error: 'Email send error', message: e?.message || String(e) });
  }
}
