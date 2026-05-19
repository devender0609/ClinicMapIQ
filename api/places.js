function query(lat, lon, radius) {
  return `[out:json][timeout:24];
(
  nwr(around:${radius},${lat},${lon})["amenity"~"clinic|doctors|hospital|dentist",i];
  nwr(around:${radius},${lat},${lon})["healthcare"~"clinic|doctor|hospital|physiotherapist|rehabilitation|dentist|alternative|laboratory",i];
  nwr(around:${radius},${lat},${lon})["office"~"physician|therapist",i];
  nwr(around:${radius},${lat},${lon})["name"~"physical therapy|physiotherapy|orthopedic|orthopaedic|spine|pain|chiropractic|urgent care|primary care|family medicine|radiology|imaging|neurosurgery|rehabilitation|sports medicine|rheumatology|neurology",i];
);
out center tags 500;`;
}
const ENDPOINTS = ['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter','https://overpass.openstreetmap.ru/api/interpreter'];
async function post(endpoint, data, ms=22000){ const ctrl=new AbortController(); const id=setTimeout(()=>ctrl.abort(), ms); try { return await fetch(endpoint, { method:'POST', headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','User-Agent':'ClinicMapIQ/7'}, body:new URLSearchParams({data}), signal:ctrl.signal }); } finally { clearTimeout(id); } }
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const lat=Number(req.query.lat), lon=Number(req.query.lon), miles=Math.min(Math.max(Number(req.query.radiusMiles||8), 2), 20);
  if(!Number.isFinite(lat)||!Number.isFinite(lon)) return res.status(400).json({elements:[], error:'Missing valid center.'});
  const q=query(lat,lon,Math.round(miles*1609.344)); let last='';
  for(const ep of ENDPOINTS){ try{ const r=await post(ep,q); if(!r.ok){last=`Overpass returned ${r.status}`; continue;} const j=await r.json(); return res.status(200).json({elements:j.elements||[], endpoint:ep, radiusMiles:miles}); } catch(e){ last=e.name==='AbortError'?'public map request timed out':e.message; } }
  return res.status(200).json({elements:[], warning:last || 'Public map source unavailable.'});
};
