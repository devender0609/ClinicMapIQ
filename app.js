/* ClinicMap IQ v7 — Referral growth workspace
   Public data only. Optional Google Places through serverless API.
*/
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const MI_TO_M = 1609.344;
const OSM_MAX_MILES = 20;
const SEARCH_CACHE_TTL = 30 * 60 * 1000;
const MAX_BG_GEOCODE = 14;

const STATE_ABBR = {texas:'TX',california:'CA','new york':'NY',florida:'FL',illinois:'IL',ohio:'OH',georgia:'GA',arizona:'AZ',colorado:'CO',tennessee:'TN',michigan:'MI','north carolina':'NC','south carolina':'SC',pennsylvania:'PA'};
const CITY_FALLBACKS = {
  'austin tx': {lat:30.2672, lon:-97.7431, city:'Austin', state:'TX'},
  'houston tx': {lat:29.7604, lon:-95.3698, city:'Houston', state:'TX'},
  'dallas tx': {lat:32.7767, lon:-96.7970, city:'Dallas', state:'TX'},
  'san antonio tx': {lat:29.4241, lon:-98.4936, city:'San Antonio', state:'TX'}
};

const OFFICE_TYPES = {
  primary: {label:'Primary care', npi:['Family Medicine','Internal Medicine','General Practice','Primary Care'], osm:['clinic','doctors'], terms:['primary care','family medicine','internal medicine','general practice']},
  pt: {label:'Physical therapy', npi:['Physical Therapist','Physical Medicine & Rehabilitation'], osm:['physiotherapist','rehabilitation'], terms:['physical therapy','physiotherapy','rehabilitation']},
  urgent: {label:'Urgent care', npi:['Clinic/Center','Urgent Care'], osm:['urgent care','clinic'], terms:['urgent care','walk in clinic','minor emergency']},
  imaging: {label:'Imaging', npi:['Radiology','Diagnostic Radiology','Clinic/Center'], osm:['radiology','imaging'], terms:['imaging center','radiology','mri','x-ray','diagnostic imaging']},
  chiro: {label:'Chiropractic', npi:['Chiropractor'], osm:['chiropractor','alternative'], terms:['chiropractic','chiropractor']},
  pain: {label:'Pain clinics', npi:['Pain Medicine','Anesthesiology'], osm:['pain'], terms:['pain management','pain clinic','interventional pain']},
  specialist: {label:'Specialty offices', npi:['Neurology','Rheumatology','Sports Medicine','Orthopaedic Surgery','Neurological Surgery','Clinic/Center'], osm:['clinic','doctor'], terms:['neurology','rheumatology','sports medicine','specialty clinic','orthopedic','orthopaedic','spine','neurosurgery']},
  hospital: {label:'Hospitals', npi:['General Acute Care Hospital','Hospital'], osm:['hospital'], terms:['hospital','medical center']}
};

const SPECIALTY = {
  spine: {
    referralTerms:['primary care','family medicine','internal medicine','physical therapy','physiotherapy','urgent care','imaging','radiology','chiropractic','neurology','rheumatology','occupational medicine','rehabilitation','sports medicine'],
    competitorTerms:['orthopedic','orthopaedic','spine','neurosurgery','neurological surgery','pain management','pain medicine','sports medicine','musculoskeletal']
  },
  pain: {referralTerms:['primary care','family medicine','physical therapy','orthopedic','spine','imaging','neurology'], competitorTerms:['pain management','pain medicine','interventional pain','anesthesiology']},
  cardiology: {referralTerms:['primary care','internal medicine','family medicine','urgent care','imaging','vascular'], competitorTerms:['cardiology','heart','cardiovascular']},
  dermatology: {referralTerms:['primary care','family medicine','pediatrics','urgent care','aesthetic'], competitorTerms:['dermatology','skin clinic']},
  primary: {referralTerms:['urgent care','imaging','laboratory','specialty clinic','pharmacy'], competitorTerms:['primary care','family medicine','internal medicine','general practice']},
  dental: {referralTerms:['primary care','orthodontics','oral surgery','pediatric dentistry'], competitorTerms:['dental','dentist','orthodontic','oral surgery']}
};
const RECOMMENDED = {
  spine:['primary','pt','urgent','imaging','chiro','pain','specialist'],
  pain:['primary','pt','imaging','chiro','specialist'],
  cardiology:['primary','urgent','imaging','hospital','specialist'],
  dermatology:['primary','urgent','specialist'],
  primary:['urgent','imaging','specialist','hospital'],
  dental:['primary','specialist']
};
const GOALS = {
  general:'Prioritize contactable offices with strong public listings and reasonable distance.',
  surgical:'Prioritize PT, primary care, imaging, urgent care, neurology, and pain offices that may see patients needing surgical consults.',
  procedures:'Prioritize primary care, PT, imaging, pain/orthopedic-adjacent offices, and specialty groups.',
  new_market:'Prioritize broad office coverage, mapped areas, and high-contact completeness before building relationships.',
  reactivation:'Prioritize saved offices, follow-ups due, and prior contacts that need another touchpoint.'
};
const STATUSES = ['Not contacted','Called','Left message','Sent information','Follow-up needed','Relationship active','Poor fit','Do not pursue'];
const BARRIERS = ['No referral coordinator found','Missing fax/portal','Insurance uncertainty','Already uses another specialist','Needs physician visit','Needs imaging workflow clarification','Positive relationship','Poor fit'];

let map, markerLayer, zoneLayer, baseMarker;
let markers = new Map();
let current = {center:null, city:'', state:'', places:[], referrals:[], similar:[], zones:[], messages:[], sourceStatus:{}};
let filters = {mode:'all', hidePoor:false, noWaste:false};
let activityExpanded = false;
let sortMode = 'fit';
let expanded = {referrals:false, similar:false};
let visibleLayers = {referral:true, similar:true, existing:true};
let areaMode = false;
let areaCircle = null;
let areaMarker = null;
let selectedArea = null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
const deg = x => x * Math.PI / 180;
const milesToMeters = m => Math.round(Number(m) * MI_TO_M);
function distanceMiles(a,b,c,d){ if(![a,b,c,d].every(Number.isFinite)) return 9999; const R=3958.8, dLat=deg(c-a), dLon=deg(d-b); const x=Math.sin(dLat/2)**2 + Math.cos(deg(a))*Math.cos(deg(c))*Math.sin(dLon/2)**2; return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x)); }
function bearing(a,b,c,d){ const y=Math.sin(deg(d-b))*Math.cos(deg(c)); const x=Math.cos(deg(a))*Math.sin(deg(c))-Math.sin(deg(a))*Math.cos(deg(c))*Math.cos(deg(d-b)); return (Math.atan2(y,x)*180/Math.PI+360)%360; }
function sectorName(b){ return ['North','Northeast','East','Southeast','South','Southwest','West','Northwest'][Math.round(b/45)%8]; }
function safeUrl(u){ const v=String(u||'').trim(); if(!v) return ''; return /^https?:\/\//i.test(v) ? v : `https://${v}`; }
function mapsUrl(p){ const q = p.lat && p.lon ? `${p.lat},${p.lon}` : `${p.name} ${p.address||''}`; return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`; }
function webSearchUrl(p){ return `https://www.google.com/search?q=${encodeURIComponent(`${p.name} ${p.address||''} ${p.phone||''}`.trim())}`; }
function googleCalendarUrl(p){
  const rec=savedRecord(p.id);
  const date=(rec.followUpDate || todayISO()).replace(/-/g,'');
  const details=[p.category,p.phone,p.address,rec.notes,'ClinicMap IQ follow-up'].filter(Boolean).join(' | ');
  const u=new URL('https://calendar.google.com/calendar/render');
  u.searchParams.set('action','TEMPLATE');
  u.searchParams.set('text',`Follow up with ${p.name}`);
  u.searchParams.set('dates',`${date}/${date}`);
  u.searchParams.set('details',details);
  if(p.address) u.searchParams.set('location',p.address);
  return u.toString();
}

function hashStr(s){ let h=2166136261; for(let i=0;i<String(s).length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return h>>>0; }
function storage(key, fallback){ try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; } }
function saveStorage(key, val){ try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }
function officeKey(p){ return p.id || `office:${hashStr(`${p.name}|${p.address}|${p.phone}`)}`; }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function isDue(date){ return date && date <= todayISO(); }

function savedStore(){ return storage('cmiq_saved_records_v7', {}); }
function activityStore(){ return storage('cmiq_activity_history_v8', []); }
function saveActivityStore(v){ saveStorage('cmiq_activity_history_v8', (v||[]).slice(0,250)); }
function teamStore(){ return storage('cmiq_team_members_v8', []); }
function saveTeamStore(v){ saveStorage('cmiq_team_members_v8', Array.isArray(v)?v:[]); }
function campaignStore(){ return storage('cmiq_outreach_campaigns_v94', []); }
function saveCampaignStore(v){ saveStorage('cmiq_outreach_campaigns_v94', Array.isArray(v)?v.slice(0,30):[]); }
function logActivity(action, place, detail=''){
  const name = place?.name || findPlace(place?.id||place)?.name || 'Office';
  const id = place?.id || (typeof place==='string'?place:'');
  const list = activityStore();
  list.unshift({id:`act:${Date.now()}:${Math.random().toString(36).slice(2,8)}`, officeId:id, officeName:name, action, detail, at:new Date().toISOString()});
  saveActivityStore(list);
  if(typeof renderActivityHistory==='function') renderActivityHistory();
  if(typeof renderManagerDashboard==='function') renderManagerDashboard();
}
function updateSavedRecord(id, patch){ const s=savedStore(); s[id]={...(s[id]||{}),...patch,id,lastUpdated:new Date().toISOString()}; saveStorage('cmiq_saved_records_v7', s); }
function removeSavedRecord(id){ const s=savedStore(); const old=s[id]; delete s[id]; saveStorage('cmiq_saved_records_v7', s); if(old) logActivity('Removed from saved list', old); }
function savedRecord(id){ return savedStore()[id] || existingStore()[id] || {}; }
function updateWorkflowRecord(id, patch){ const p=findPlace(id)||{id}; const before=savedRecord(id); if(p.kind==='existing') updateExistingRecord(id,{...p,...patch}); else updateSavedRecord(id,{...placeToSaved(p),...patch}); const keys=Object.keys(patch||{}); if(keys.length){ const detail=keys.map(k=>`${k}: ${before[k]||'—'} → ${patch[k]||'—'}`).join('; '); logActivity('Updated workflow', {...p,id}, detail); } }
function isSaved(id){ return !!savedStore()[id]; }
function getSavedPlaces(){ const s=savedStore(); return Object.values(s).filter(Boolean); }
function existingStore(){ return storage('cmiq_existing_network_v72', {}); }
function saveExistingStore(v){ saveStorage('cmiq_existing_network_v72', v || {}); }
function getExistingPlaces(){ return Object.values(existingStore()).filter(Boolean); }
function updateExistingRecord(id, patch){ const s=existingStore(); s[id]={...(s[id]||{}),...patch,id,lastUpdated:new Date().toISOString()}; saveExistingStore(s); }
function clearExistingNetwork(){ const n=getExistingPlaces().length; saveExistingStore({}); logActivity('Cleared existing referral network', {name:'Existing referral network'}, `${n} records removed`); renderExistingNetwork(); renderNetworkCoverage(); renderMap(); renderSummary();  }
function searchHistoryKey(){ return `cmiq_seen_${hashStr(`${norm($('#locationInput')?.value||'')}:${$('#specialtySelect')?.value||''}:${selectedTypes().sort().join(',')}`)}`; }
function annotateNewPlaces(places){
  const key=searchHistoryKey(); const previous=storage(key, []); const prevSet=new Set(previous); let count=0;
  places.forEach(p=>{ p.isNew = !prevSet.has(p.id); if(p.isNew) count++; });
  saveStorage(key, places.map(p=>p.id)); current.newCount=count; return places;
}

async function fetchJSON(url, opts={}, timeout=14000){ const ctrl=new AbortController(); const id=setTimeout(()=>ctrl.abort(), timeout); try{ const r=await fetch(url,{...opts,signal:ctrl.signal}); const j=await r.json().catch(()=>({})); if(!r.ok) throw new Error(j.error || `${r.status}`); return j; } finally { clearTimeout(id); } }

function setMessage(type, title, text){ const area=$('#messageArea'); if(!text){ area.innerHTML=''; return; } area.innerHTML = `<div class="notice ${type||''}"><b>${esc(title)}</b><br>${esc(text)}</div>`; }
function setLoading(text){ const btn=$('#searchBtn'); btn.disabled=true; btn.textContent=text || 'Searching public data...'; }
function clearLoading(){ const btn=$('#searchBtn'); btn.disabled=false; btn.textContent='Build outreach map'; }

function initMap(){
  map = L.map('map', {scrollWheelZoom:false, preferCanvas:true, zoomControl:true, worldCopyJump:true}).setView([30.2672,-97.7431], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, updateWhenIdle:false, keepBuffer:4, crossOrigin:true, attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  zoneLayer = L.layerGroup().addTo(map);
  setTimeout(()=>map.invalidateSize(false), 120);
  setTimeout(()=>map.invalidateSize(false), 450);
  setTimeout(()=>map.invalidateSize(), 900);
  if(window.ResizeObserver){
    const ro = new ResizeObserver(()=>{ if(map) requestAnimationFrame(()=>map.invalidateSize(false)); });
    ro.observe(document.getElementById('map'));
  }
  window.addEventListener('resize', ()=>{ if(map) setTimeout(()=>map.invalidateSize(false), 80); });
  map.on('click', handleAreaMapClick);
}

function allMappedPlaces(){
  return [...(current.places||[]), ...getExistingPlaces()].filter(p=>p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)));
}
function toggleAreaMode(){
  areaMode = !areaMode;
  const btn=$('#areaSelectBtn');
  if(btn){ btn.classList.toggle('active', areaMode); btn.innerHTML = areaMode ? '<span class="gold-dot"></span>Click map area' : '<span class="gold-dot"></span>Mark area'; }
  const box=$('#areaAnalysis');
  if(areaMode && box){ box.hidden=false; box.innerHTML='<b>Area review mode</b><span>Click the map to place the area. After it appears, drag the center pin or adjust the radius to include more or fewer offices.</span>'; }
}
function handleAreaMapClick(e){
  if(!areaMode || !e || !e.latlng) return;
  markArea(e.latlng.lat, e.latlng.lng);
}
function markArea(lat, lon){
  const radiusMiles = selectedArea?.radiusMiles || Math.max(1, Math.min(3, selectedRadius()/6 || 1.5));
  selectedArea={lat,lon,radiusMiles};
  drawAreaLayer();
  const clear=$('#areaClearBtn'); if(clear) clear.hidden=false;
  renderAreaAnalysis();
}
function drawAreaLayer(){
  if(!selectedArea) return;
  if(areaCircle) zoneLayer.removeLayer(areaCircle);
  if(areaMarker) zoneLayer.removeLayer(areaMarker);
  areaCircle = L.circle([selectedArea.lat,selectedArea.lon], {radius:selectedArea.radiusMiles*MI_TO_M, color:'#f4b12b', weight:3, fillColor:'#f4b12b', fillOpacity:.13}).addTo(zoneLayer);
  areaMarker = L.marker([selectedArea.lat,selectedArea.lon], {icon:markerIcon('zone'), draggable:true}).addTo(zoneLayer).bindPopup('Drag this pin to move the review area');
  areaMarker.on('dragend', e=>{
    const ll=e.target.getLatLng();
    selectedArea.lat=ll.lat; selectedArea.lon=ll.lng;
    if(areaCircle){ areaCircle.setLatLng(ll); }
    renderAreaAnalysis();
  });
}
function clearArea(){
  selectedArea=null; areaMode=false;
  if(areaCircle){ zoneLayer.removeLayer(areaCircle); areaCircle=null; }
  if(areaMarker){ zoneLayer.removeLayer(areaMarker); areaMarker=null; }
  const btn=$('#areaSelectBtn'); if(btn){ btn.classList.remove('active'); btn.innerHTML='<span class="gold-dot"></span>Mark area'; }
  const clear=$('#areaClearBtn'); if(clear) clear.hidden=true;
  const box=$('#areaAnalysis'); if(box){ box.hidden=true; box.innerHTML=''; }
}
function areaPlaces(){
  if(!selectedArea) return [];
  return allMappedPlaces()
    .map(p=>({...p, areaDistance:distanceMiles(selectedArea.lat, selectedArea.lon, Number(p.lat), Number(p.lon))}))
    .filter(p=>p.areaDistance<=selectedArea.radiusMiles)
    .sort((a,b)=>a.areaDistance-b.areaDistance);
}
function areaStrategyHtml(pts, referrals, similar, existing, contactable){
  const topTargets=pts.filter(p=>p.kind!=='similar').sort((a,b)=>(b.score||0)-(a.score||0)).slice(0,3);
  const score=Math.max(0, referrals*2 + contactable + existing - similar*2);
  let strategy='Needs review: public data is limited in this pocket.';
  if(referrals>similar && contactable>0) strategy='Good outreach pocket: save the top contactable offices and route this area.';
  if(similar>referrals) strategy='Competitor-heavy pocket: review differentiation before broad outreach.';
  if(existing>0 && referrals>0) strategy='Expansion pocket: existing relationships are nearby; add high-fit new offices around them.';
  return `<div class="area-strategy-card"><div><b>Area strategy</b><span>Score ${score}</span></div><p>${esc(strategy)}</p>${topTargets.length?`<small>Top targets: ${topTargets.map(p=>esc(p.name)).join(' · ')}</small>`:''}</div>`;
}
function areaControlsHtml(){
  if(!selectedArea) return '';
  const r=Number(selectedArea.radiusMiles||1.5);
  return `<div class="area-control-card"><div><b>Adjust marked area</b><span>Drag the gold center pin, or change the radius below.</span></div><label>Area radius <input id="areaRadiusRange" type="range" min="0.5" max="5" step="0.5" value="${esc(r)}" /> <strong>${r.toFixed(1)} mi</strong></label><div class="area-radius-buttons"><button type="button" class="tiny-btn action-map" data-area-radius="minus">Smaller</button><button type="button" class="tiny-btn action-map" data-area-radius="plus">Bigger</button></div></div>`;
}
function bindAreaControls(){
  const range=$('#areaRadiusRange');
  if(range){
    range.addEventListener('input',()=>{
      if(!selectedArea) return;
      selectedArea.radiusMiles=Math.max(0.5, Math.min(5, Number(range.value)||1.5));
      if(areaCircle) areaCircle.setRadius(selectedArea.radiusMiles*MI_TO_M);
      renderAreaAnalysis();
    });
  }
  document.querySelectorAll('[data-area-radius]').forEach(btn=>btn.addEventListener('click',()=>{
    if(!selectedArea) return;
    const delta=btn.dataset.areaRadius==='plus'?0.5:-0.5;
    selectedArea.radiusMiles=Math.max(0.5, Math.min(5, Number(selectedArea.radiusMiles||1.5)+delta));
    if(areaCircle) areaCircle.setRadius(selectedArea.radiusMiles*MI_TO_M);
    renderAreaAnalysis();
  }));
}

function renderAreaAnalysis(){
  const box=$('#areaAnalysis'); if(!box || !selectedArea) return;
  const pts=areaPlaces();
  box.hidden=false;
  if(!pts.length){ box.innerHTML=`${areaControlsHtml()}<div class="area-summary"><b>Marked area</b><span>No mapped offices found within ${selectedArea.radiusMiles.toFixed(1)} miles. Increase the area radius, drag the center pin, or click a nearby location on the map.</span></div>`; bindAreaControls(); return; }
  const referrals=pts.filter(p=>p.kind!=='similar' && p.kind!=='existing').length;
  const similar=pts.filter(p=>p.kind==='similar').length;
  const existing=pts.filter(p=>p.kind==='existing').length;
  const contactable=pts.filter(p=>p.phone||p.website).length;
  box.innerHTML=`
    ${areaControlsHtml()}
    <div class="area-topline">
      <div><b>${pts.length} mapped offices in selected area</b><span>Within ${selectedArea.radiusMiles.toFixed(1)} miles of your marked point. Drag the center pin or change radius to refine the area.</span></div>
      <div class="area-actions"><button type="button" class="tiny-btn action-save" id="areaSaveBtn">Save area targets</button><button type="button" class="tiny-btn action-directions" id="areaRouteBtn">Route area</button><button type="button" class="tiny-btn action-web" id="areaExportBtn">Export area</button></div>
    </div>
    <div class="area-metrics"><span><b>${referrals}</b> referral offices</span><span><b>${similar}</b> competitors</span><span><b>${existing}</b> existing sources</span><span><b>${contactable}</b> with contact</span></div>
    ${areaStrategyHtml(pts, referrals, similar, existing, contactable)}
    <div class="area-office-list">${pts.slice(0,10).map(p=>`<button type="button" data-area-open="${esc(p.id)}"><i class="${p.kind==='similar'?'red-dot':p.kind==='existing'?'green-dot':'blue-dot'}"></i><span>${esc(p.name)}</span><small>${esc(p.category||'Office')} · ${p.areaDistance.toFixed(1)} mi</small></button>`).join('')}${pts.length>10?`<span class="helper-text">+ ${pts.length-10} more nearby mapped offices</span>`:''}</div>`;
  bindAreaControls();
  box.querySelectorAll('[data-area-open]').forEach(b=>b.addEventListener('click',()=>{ const p=findPlace(b.dataset.areaOpen); if(p) selectPlace(p,true); }));
  const saveBtn=$('#areaSaveBtn'); if(saveBtn) saveBtn.addEventListener('click', saveAreaTargets);
  const routeBtn=$('#areaRouteBtn'); if(routeBtn) routeBtn.addEventListener('click', routeAreaTargets);
  const exportBtn=$('#areaExportBtn'); if(exportBtn) exportBtn.addEventListener('click', exportAreaTargets);
}
function saveAreaTargets(){
  const pts=areaPlaces().filter(p=>p.kind!=='similar').slice(0,25);
  if(!pts.length) return;
  pts.forEach(p=>{ if(!isSaved(p.id) && p.kind!=='existing') updateSavedRecord(p.id, placeToSaved(p)); });
  logActivity('Saved marked-area targets', {name:'Marked area'}, `${pts.length} offices reviewed`);
  renderLists(); renderSaved(); renderPipelineBoard();  renderManagerDashboard(); renderAreaAnalysis();
}
function routeAreaTargets(){
  const pts=areaPlaces().filter(p=>p.kind!=='similar' && p.lat&&p.lon).slice(0,10);
  if(!pts.length) return;
  window.open('https://www.google.com/maps/dir/'+pts.map(p=>`${p.lat},${p.lon}`).join('/'),'_blank','noopener');
  logActivity('Opened marked-area route', {name:'Marked area'}, `${pts.length} stops`);
}
function exportAreaTargets(){
  const pts=areaPlaces(); if(!pts.length) return;
  const header=['name','role','type','address','phone','website','distance_from_marked_point','source'];
  const rows=[header].concat(pts.map(p=>[p.name,placeRoleLabel(p),p.category||'',p.address||'',p.phone||'',p.website||'',p.areaDistance.toFixed(2),p.source||''].map(v=>`"${String(v).replace(/"/g,'""')}"`)));
  download('clinicmapiq_marked_area.csv', rows.map(r=>r.join(',')).join('\n'), 'text/csv');
  logActivity('Exported marked-area CSV', {name:'Marked area'}, `${pts.length} offices`);
}

function selectedTypes(){ return $$('#officeTypeGrid input:checked').map(i=>i.value); }
function selectedConfig(){ return SPECIALTY[$('#specialtySelect').value] || SPECIALTY.spine; }
function selectedRadius(){ return Number($('#radiusSelect').value || 8); }
function selectedMode(){ return $('#searchMode').value; }
function selectedGoal(){ return $('#growthGoalSelect').value || 'general'; }
function cacheKey(){ return `search:${norm($('#locationInput').value)}:${$('#specialtySelect').value}:${selectedRadius()}:${selectedTypes().sort().join(',')}:${selectedMode()}:${$('#googleToggle').checked?'g1':'g0'}`; }
function getCached(){ try{ const c=JSON.parse(localStorage.getItem(cacheKey())||'null'); if(c && Date.now()-c.time<SEARCH_CACHE_TTL) return c.data; }catch{} return null; }
function setCached(data){ try{ localStorage.setItem(cacheKey(), JSON.stringify({time:Date.now(), data})); }catch{} }

async function geocodeMarket(q){
  const direct = String(q).match(/([^,]+),\s*([A-Za-z]{2})(\b|$)/);
  const key=norm(q).replace(/\btexas\b/g,'tx');
  if(CITY_FALLBACKS[key]) return {...CITY_FALLBACKS[key], display_name:q, address:{city:CITY_FALLBACKS[key].city, state:CITY_FALLBACKS[key].state}};
  try{
    const u=new URL('/api/geocode', window.location.origin); u.searchParams.set('q', q);
    const j=await fetchJSON(u.toString(), {}, 12000);
    const parsed=parseCityState(q, j);
    return {lat:Number(j.lat), lon:Number(j.lon), city:parsed.city, state:parsed.state, display_name:j.display_name||q, address:j.address||{}};
  }catch(e){
    if(direct) return {lat:30.2672, lon:-97.7431, city:direct[1].trim(), state:direct[2].toUpperCase(), display_name:q, address:{city:direct[1].trim(), state:direct[2].toUpperCase()}, fallback:true};
    throw e;
  }
}
function parseCityState(input, geo){
  const m=String(input).match(/([^,]+),\s*([A-Z]{2})(\b|$)/i); if(m) return {city:m[1].trim(), state:m[2].toUpperCase()};
  const a=geo?.address||{}; const city=a.city||a.town||a.village||a.hamlet||''; let state=a.state_code||a.state||''; state=STATE_ABBR[norm(state)] || String(state).toUpperCase().slice(0,2); return {city, state};
}

function classifyRole(name, category, selected){
  const blob=norm(`${name} ${category}`); const cfg=selectedConfig();
  const isComp=cfg.competitorTerms.some(t=>blob.includes(norm(t)));
  const isReferral=cfg.referralTerms.some(t=>blob.includes(norm(t))) || selected.some(t => OFFICE_TYPES[t].terms.some(x=>blob.includes(norm(x))));
  if(isComp) return 'similar';
  if(isReferral) return 'referral';
  return 'referral';
}
function inferOfficeType(name, category){
  const b=norm(`${name} ${category}`);
  for(const [key,val] of Object.entries(OFFICE_TYPES)){ if(val.terms.some(t=>b.includes(norm(t))) || val.npi.some(t=>b.includes(norm(t)))) return val.label; }
  return category || 'Healthcare office';
}
function verification(p){
  let score=0, reasons=[];
  if(p.name){score++; reasons.push('name');}
  if(p.address){score++; reasons.push('address');}
  if(p.phone){score+=2; reasons.push('phone');}
  if(p.website){score+=2; reasons.push('website');}
  if(p.lat&&p.lon){score+=2; reasons.push('mapped');}
  if(p.source?.includes('Google')){score+=2; reasons.push('Google Places');}
  if(p.source?.includes('NPI')){score+=1; reasons.push('NPI');}
  if(p.source?.includes('OpenStreetMap')){score+=1; reasons.push('map record');}
  const level=score>=7?'Strong public listing':score>=4?'Moderate public listing':'Needs review';
  return {score, level, reasons};
}
function fitScore(p){
  let s=0;
  if(p.kind==='referral') s+=30; else s-=5;
  if(p.phone) s+=16; if(p.website) s+=12; if(p.lat&&p.lon) s+=10; if(p.verification?.score) s+=p.verification.score*4;
  if(p.distance < 5) s+=12; else if(p.distance<12) s+=8; else if(p.distance<30) s+=3;
  if(isSaved(p.id)) s+=5;
  if(selectedGoal()==='surgical' && /physical|primary|family|imaging|urgent|neuro|pain/i.test(`${p.name} ${p.category}`)) s+=12;
  if(selectedGoal()==='procedures' && /pain|imaging|primary|physical|ortho/i.test(`${p.name} ${p.category}`)) s+=10;
  return Math.max(0, Math.round(s));
}
function fitLabel(score){ return score>=72?{label:'High fit', cls:'high'}:score>=48?{label:'Good fit', cls:'med'}:{label:'Review', cls:'low'}; }
function contactConfidence(p){
  if((p.phone||p.website) && p.lat&&p.lon && (p.verification?.score||0)>=4) return {label:'Ready to contact', cls:'ready'};
  if((p.phone||p.website) && p.lat&&p.lon) return {label:'Contactable', cls:'contactable'};
  if(p.lat&&p.lon) return {label:'Map-only', cls:'maponly'};
  return {label:'Directory-only', cls:'directory'};
}
function noWasteCandidate(p){
  const rec=savedRecord(p.id);
  const status=rec.status||p.status||'';
  if(['Do not pursue','Poor fit'].includes(status)) return false;
  if((p.score||0)<48) return false;
  if(!(p.phone||p.website)) return false;
  if(!(p.lat&&p.lon)) return false;
  return true;
}

function goalMatchReason(p){
  const b=norm(`${p.name} ${p.category}`);
  const goal=selectedGoal();
  if(goal==='surgical' && /physical|primary|family|imaging|urgent|neuro|pain/.test(b)) return 'matches the surgical growth goal';
  if(goal==='procedures' && /pain|imaging|primary|physical|ortho/.test(b)) return 'matches the procedure-growth goal';
  if(goal==='referrals' && p.kind==='referral') return 'fits the referral-growth goal';
  return '';
}
function officeActionTier(p){
  const rec=savedRecord(p.id);
  const status=rec.status || p.status || 'Not contacted';
  const hasContact=Boolean(p.phone||p.website);
  const mapped=Boolean(p.lat&&p.lon);
  const score=p.score||0;
  if(status==='Do not pursue' || status==='Poor fit') return {label:'Do not pursue', cls:'blocked', action:'Avoid this target unless the status changes.'};
  if(p.kind==='existing') return {label:'Protect relationship', cls:'protect', action:'Keep this source warm and make the referral pathway complete.'};
  if(isDue(rec.followUpDate)) return {label:'Follow-up due', cls:'due', action:'Contact this office before adding new outreach.'};
  if(p.kind==='similar') return {label:'Competitor / watch', cls:'watch', action:'Use for competitor awareness, not referral outreach.'};
  if(isSaved(p.id) && status==='Not contacted' && hasContact && mapped && score>=48) return {label:'Call this week', cls:'call', action:'Saved, contactable, and ready for first outreach.'};
  if(!hasContact || !mapped || p.approximatePin || score<48) return {label:'Verify first', cls:'verify', action:'Check contact details and location before outreach.'};
  if(score>=72 && hasContact && mapped) return {label:'Call this week', cls:'call', action:'High-fit, contactable, and mapped.'};
  if(score>=48 && hasContact && mapped) return {label:'Save for review', cls:'save', action:'Reasonable target; compare with current priorities.'};
  return {label:'Review only', cls:'review', action:'Low signal until more information is verified.'};
}
function officeWhyText(p){
  const reasons=[];
  const score=p.score||0;
  if(p.kind==='existing') reasons.push('relationship to maintain');
  else if(p.kind==='similar') reasons.push('watch for competitive positioning');
  else if(score>=72) reasons.push('high fit score');
  else if(score>=48) reasons.push('workable fit score');
  if(p.distance<999) reasons.push(`${p.distance.toFixed(1)} mi from search center`);
  if(p.phone && p.website) reasons.push('phone + website available');
  else if(p.phone) reasons.push('phone available');
  else if(p.website) reasons.push('website available');
  else reasons.push('missing public contact info');
  if(p.lat&&p.lon && !p.approximatePin) reasons.push('mapped location');
  if(p.approximatePin) reasons.push('location needs verification');
  const goal=goalMatchReason(p); if(goal) reasons.push(goal);
  const rec=savedRecord(p.id);
  if(rec.assignedTo) reasons.push(`assigned to ${rec.assignedTo}`);
  if(isDue(rec.followUpDate)) reasons.push('follow-up due');
  return reasons.slice(0,4).join(' · ');
}
function tierBadgeHtml(p){
  const tier=officeActionTier(p);
  return `<span class="action-tier ${tier.cls}">${esc(tier.label)}</span>`;
}
function actionTargetLists(){
  const saved=getSavedPlaces();
  const due=saved.filter(p=>isDue(p.followUpDate) && (p.status||'')!=='Do not pursue').sort((a,b)=>String(a.followUpDate||'').localeCompare(String(b.followUpDate||''))).slice(0,8);
  const call=nextBestOffices(12).filter(p=>officeActionTier(p).cls==='call').slice(0,8);
  const verify=(current.referrals||[]).filter(p=>!isSaved(p.id)).filter(p=>['verify','review'].includes(officeActionTier(p).cls)).sort((a,b)=>(b.score||0)-(a.score||0)).slice(0,8);
  const protect=saved.filter(p=>(p.status||'')==='Relationship active' || p.kind==='existing').slice(0,8);
  return {due,call,verify,protect};
}
function weeklyPlanHtml(){
  const lists=actionTargetLists();
  const contact=contactReadinessScore();
  const exec=executionScore();
  const pressure=competitorPressure();
  const nextMove=recommendedNextMove();
  const firstStep=lists.due.length?'Work due follow-ups first':lists.call.length?'Call the best contactable offices':'Verify records before outreach';
  const secondStep=contact.score<75?'Improve contact readiness':'Save/assign the strongest targets';
  const thirdStep=exec.saved && exec.score<60?'Assign owners and follow-up dates':'Build route or campaign';
  const fourthStep=pressure.label==='High'?'Use competitor-aware targeting':'Use visit route for field outreach';
  return `<div class="agent-panel-title"><h3>7-day outreach plan</h3></div>
    <div class="decision-summary"><b>Recommended next move</b><span>${esc(nextMove)}</span></div>
    <div class="action-plan-grid">
      <div class="action-card blue-card"><span>Step 1</span><b>${esc(firstStep)}</b><p>${lists.due.length?`${lists.due.length} saved office${lists.due.length>1?'s are':' is'} due.`:lists.call.length?`${lists.call.length} call-ready office${lists.call.length>1?'s':''} found.`:'Contact data is thin or filtered out.'}</p></div>
      <div class="action-card green-card"><span>Step 2</span><b>${esc(secondStep)}</b><p>Contact readiness ${contact.score}/100. Target 75+ before broad outreach.</p></div>
      <div class="action-card gold-card"><span>Step 3</span><b>${esc(thirdStep)}</b><p>Execution score ${exec.score}/100. Saved targets need owners, touches, and dates.</p></div>
      <div class="action-card rose-card"><span>Step 4</span><b>${esc(fourthStep)}</b><p>${esc(pressure.text)}</p></div>
    </div>
    <div class="agent-panel-title mini-heading"><h3>Start with these offices</h3><p>Each recommendation shows the action tier and the reason.</p></div>
    ${miniList(lists.due.length?lists.due:lists.call.length?lists.call:lists.verify,'No actionable offices yet. Run a broader search, enable richer sources, or upload existing referral sources.')}`;
}
function nextBestOffices(limit=10){
  return (current.referrals||[])
    .filter(p=>!isSaved(p.id))
    .filter(noWasteCandidate)
    .sort((a,b)=> (b.score||0)-(a.score||0) || (a.distance||999)-(b.distance||999))
    .slice(0,limit);
}
function visitDayPlaces(limit=8){
  const savedMapped=getSavedPlaces().filter(p=>p.lat&&p.lon && (p.status||'')!=='Do not pursue');
  const topMapped=nextBestOffices(20).filter(p=>p.lat&&p.lon);
  const seen=new Set();
  return [...savedMapped, ...topMapped].filter(p=>{ if(seen.has(p.id)) return false; seen.add(p.id); return true; }).slice(0,limit);
}
function visitDaySheetText(){
  const pts=visitDayPlaces(8);
  const lines=[`ClinicMap IQ Visit Day Sheet`, `Date: ${new Date().toLocaleDateString()}`, `Market: ${$('#locationInput')?.value||''}`, `Specialty: ${$('#specialtySelect')?.selectedOptions?.[0]?.textContent||''}`, ``, `Stops`];
  pts.forEach((p,i)=>{
    const rec=savedRecord(p.id); const conf=contactConfidence(p).label;
    lines.push(`${i+1}. ${p.name}`);
    lines.push(`   Type: ${p.category||'Office'} | ${p.distance<999?p.distance.toFixed(1)+' mi':'distance unknown'} | ${conf}`);
    lines.push(`   Phone: ${p.phone||'not listed'} | Website: ${p.website||'not listed'}`);
    lines.push(`   Address: ${p.address||'not listed'}`);
    lines.push(`   Verify: referral coordinator, fax/portal, payer fit, next follow-up`);
    if(rec.notes) lines.push(`   Notes: ${rec.notes}`);
  });
  lines.push(``, `Public data note: verify all public listings before visiting or outreach.`);
  return lines.join('\n');
}
function openVisitRoute(){
  const pts=visitDayPlaces(8).filter(p=>p.lat&&p.lon);
  if(!pts.length){ alert('No mapped visit-day stops yet. Save mapped offices or run a search with map pins.'); return; }
  const url='https://www.google.com/maps/dir/'+pts.map(p=>`${p.lat},${p.lon}`).join('/');
  window.open(url,'_blank','noopener');
  logActivity('Opened visit-day route', {name:'Visit day'}, `${pts.length} stops`);
}
function downloadVisitDaySheet(){
  const pts=visitDayPlaces(8);
  if(!pts.length){ alert('No visit-day offices yet. Save offices or run a search first.'); return; }
  download('clinicmapiq_visit_day_sheet.txt', visitDaySheetText(), 'text/plain');
  logActivity('Downloaded visit-day sheet', {name:'Visit day'}, `${pts.length} stops`);
}
function saveNextBestOffices(){
  const pts=nextBestOffices(10);
  if(!pts.length){ alert('No high-fit contactable offices to save with current results.'); return; }
  pts.forEach(p=>updateSavedRecord(p.id, placeToSaved(p)));
  logActivity('Saved next best offices', {name:'Next best 10'}, `${pts.length} targets`);
  renderLists(); renderSaved(); renderPipelineBoard(); renderManagerDashboard(); renderAgent('best10');
}
function relationshipTimelineHtml(p){
  const rec=savedRecord(p.id); const acts=activityStore().filter(a=>a.officeId===p.id).slice(0,8);
  const rows=[];
  rows.push({title:`Current stage: ${outreachStage(p).label}`, meta:rec.status||p.status||'Not contacted'});
  if(rec.followUpDate) rows.push({title:'Follow-up date', meta:rec.followUpDate});
  if(rec.assignedTo) rows.push({title:'Owner assigned', meta:rec.assignedTo});
  acts.forEach(a=>rows.push({title:a.action, meta:`${new Date(a.at).toLocaleString()}${a.detail?' · '+a.detail:''}`}));
  return `<div class="activity-mini timeline-mini"><h3>Relationship timeline</h3>${rows.length?rows.map(r=>`<div><b>${esc(r.title)}</b><span>${esc(r.meta||'')}</span></div>`).join(''):'<p class="helper-text">No relationship activity yet. Save the office or update status to start the timeline.</p>'}</div>`;
}

function barrierList(p){ const rec=savedRecord(p.id); return Array.isArray(rec.barriers) ? rec.barriers : []; }
function outreachStage(p){
  const rec=savedRecord(p.id);
  const status=rec.status || p.status || 'Not contacted';
  const due=isDue(rec.followUpDate);
  const touches=activityStore().filter(a=>a.officeId===p.id).length;
  if(status==='Do not pursue' || status==='Poor fit') return {label:'Do not pursue', cls:'blocked'};
  if(status==='Relationship active') return {label:'Active', cls:'active'};
  if(due || status==='Follow-up needed') return {label:'At risk / needs follow-up', cls:'risk'};
  if(['Called','Left message','Sent information'].includes(status) || touches>=2) return {label:'Warm', cls:'warm'};
  return {label:'Cold', cls:'cold'};
}
function barrierTagsHtml(id, selected=[]){
  return `<div class="barrier-tags">${BARRIERS.map(b=>`<label><input type="checkbox" class="barrier-input" data-id="${esc(id)}" value="${esc(b)}" ${selected.includes(b)?'checked':''}/> ${esc(b)}</label>`).join('')}</div>`;
}
function automaticBarrierList(p){
  const rec=savedRecord(p.id);
  const list=[];
  if(!p.phone) list.push('Missing phone');
  if(!p.website) list.push('Missing website');
  if(!p.lat || !p.lon || p.approximatePin) list.push('Location needs verification');
  if(p.kind==='similar') list.push('Similar clinic / competitor');
  if((p.score||0)<48) list.push('Low fit / review first');
  if(isSaved(p.id)){
    const status=rec.status || p.status || 'Not contacted';
    if(status==='Not contacted') list.push('Saved but not contacted');
    if(isDue(rec.followUpDate)) list.push('Follow-up due');
    if(!rec.assignedTo) list.push('No owner assigned');
    if(!rec.coordinator || !rec.faxPortal) list.push('Referral pathway incomplete');
    if(!rec.payerNotes) list.push('Payer notes missing');
  }
  return list;
}
function barrierUniverse(){
  const map=new Map();
  [...(current.places||[]), ...getSavedPlaces(), ...getExistingPlaces()].forEach(p=>{
    if(!p || !p.id || map.has(p.id)) return;
    map.set(p.id,p);
  });
  return Array.from(map.values());
}
function topBarriers(limit=4){
  const counts={};
  barrierUniverse().forEach(p=>{
    automaticBarrierList(p).forEach(b=>counts[b]=(counts[b]||0)+1);
    barrierList(p).forEach(b=>counts[b]=(counts[b]||0)+1);
  });
  return Object.entries(counts).sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,limit);
}
function officesForBarrier(barrier){
  return barrierUniverse().filter(p=>[...automaticBarrierList(p), ...barrierList(p)].includes(barrier));
}
function barrierFocusHtml(barrier){
  const matches=officesForBarrier(barrier).slice(0,6);
  if(!matches.length) return '<p class="helper-text no-margin">No offices currently match this barrier.</p>';
  return `<div class="barrier-focus-list"><b>${esc(barrier)}</b>${matches.map(p=>`<button type="button" data-open-barrier-office="${esc(p.id)}"><span>${esc(p.name)}</span><small>${esc(p.category||'Office')}${p.distance<999?' · '+p.distance.toFixed(1)+' mi':''}</small></button>`).join('')}</div>`;
}
function opportunityGap(){
  if(!current.zones?.length) return null;
  return current.zones.slice().sort((a,b)=>((b.referrals||0)-(b.similar||0)) - ((a.referrals||0)-(a.similar||0)))[0] || null;
}

function competitorPressure(){
  const sim=current.similar.length, refs=current.referrals.length;
  if(!current.places.length) return {label:'Search first', cls:'neutral', text:'Search a market to estimate competitor pressure.'};
  const ratio = refs ? sim / Math.max(refs,1) : sim;
  if(ratio>.45 || sim>20) return {label:'High', cls:'warn', text:'Many similar clinics are present. Prioritize differentiated outreach and existing gaps.'};
  if(ratio>.18 || sim>5) return {label:'Moderate', cls:'gold', text:'Similar clinics are present. Focus on contactable offices in less crowded pockets.'};
  return {label:'Low', cls:'success', text:'Competitor density appears lower in the available public data.'};
}
function dataQualitySignal(){
  const total=current.places.length+getExistingPlaces().length;
  const pinned=current.places.filter(p=>p.lat&&p.lon).length+getExistingPlaces().filter(p=>p.lat&&p.lon).length;
  const contact=current.places.filter(p=>p.phone||p.website).length+getExistingPlaces().filter(p=>p.phone||p.website).length;
  if(!total) return {label:'Search first', cls:'neutral', text:'Run a search to evaluate contact and map quality.'};
  const score=Math.round(((pinned/total)*50)+((contact/total)*50));
  if(score>=70) return {label:'Strong', cls:'success', text:`${pinned} mapped and ${contact} have contact info.`};
  if(score>=40) return {label:'Mixed', cls:'gold', text:`${pinned} mapped and ${contact} have contact info. Verify weaker records before outreach.`};
  return {label:'Limited', cls:'warn', text:`Only ${pinned} mapped and ${contact} have contact info. Use Google Places or a narrower market if needed.`};
}

function growthMissionLabel(){
  const sel=$('#growthGoalSelect');
  const label=sel?.selectedOptions?.[0]?.textContent || 'General referral growth';
  return {label, text: GOALS[selectedGoal()] || GOALS.general};
}
function expansionScore(){
  const refs=current.referrals.length, sim=current.similar.length, existing=getExistingPlaces().length;
  const total=current.places.length+existing;
  if(!total) return {score:0,label:'Search first',text:'Run a search to calculate an outreach planning score.'};
  const contact=current.places.filter(p=>p.phone||p.website).length+getExistingPlaces().filter(p=>p.phone||p.website).length;
  const pinned=current.places.filter(p=>p.lat&&p.lon).length+getExistingPlaces().filter(p=>p.lat&&p.lon).length;
  const saved=getSavedPlaces().length;
  let score=0;
  score += Math.min(32, refs*1.6);
  score += Math.min(24, contact*1.2);
  score += Math.min(18, pinned*0.9);
  score += Math.min(12, saved*1.2);
  score -= Math.min(18, sim*1.1);
  if(existing===0 && refs>8) score += 8;
  score=Math.max(0,Math.min(100,Math.round(score)));
  const label=score>=75?'Strong expansion pocket':score>=55?'Promising market':score>=35?'Needs verification':'Limited public signal';
  const text=score>=75?'Prioritize high-fit, contactable offices and build a visit route.':score>=55?'Start with the cleanest contactable offices and verify weak listings.':score>=35?'Use marked-area review and existing-source upload to clarify the market.':'Public data is thin; use Google Places and manual verification before broad outreach.';
  return {score,label,text};
}
function scoreBand(score){
  if(score>=75) return {label:'Strong', cls:'success'};
  if(score>=55) return {label:'Workable', cls:'gold'};
  if(score>=35) return {label:'Needs verification', cls:'warn'};
  return {label:'Limited', cls:'neutral'};
}
function contactReadinessScore(){
  const total=(current.places||[]).length+getExistingPlaces().length;
  if(!total) return {score:0,label:'Search first',text:'Run a search to measure whether offices can actually be contacted.'};
  const all=[...(current.places||[]), ...getExistingPlaces()];
  const phone=all.filter(p=>p.phone).length;
  const web=all.filter(p=>p.website).length;
  const mapped=all.filter(p=>p.lat&&p.lon).length;
  const strong=all.filter(p=>(p.verification?.score||0)>=7).length;
  const score=Math.round(Math.min(100, ((phone/total)*40)+((web/total)*25)+((mapped/total)*25)+((strong/total)*10)));
  const band=scoreBand(score);
  const text=score>=75?'Good for direct calling, website review, and visit-route planning.':score>=55?'Usable, but verify weak records before outreach.':'Public contact data is incomplete; narrow the search, enable Google Places, or verify manually.';
  return {score,label:band.label,cls:band.cls,text,phone,web,mapped,total};
}
function executionScore(){
  const saved=getSavedPlaces();
  if(!saved.length) return {score:0,label:'Build list first',text:'Save targets to start tracking execution.'};
  const active=saved.filter(p=>(p.status||'')==='Relationship active').length;
  const touched=saved.filter(p=>p.status && p.status!=='Not contacted').length;
  const assigned=saved.filter(p=>p.assignedTo).length;
  const follow=saved.filter(p=>p.followUpDate).length;
  const blocked=saved.filter(p=>(p.status||'')==='Do not pursue' || (p.status||'')==='Poor fit').length;
  const score=Math.round(Math.max(0, Math.min(100, ((touched/saved.length)*35)+((assigned/saved.length)*25)+((follow/saved.length)*25)+((active/saved.length)*15)-((blocked/saved.length)*10))));
  const band=scoreBand(score);
  const text=score>=70?'The outreach list is being worked: owners, touches, and follow-ups are in place.':score>=40?'Some outreach is moving, but add owners and follow-up dates.':'The market is mostly a static list; assign owners and contact saved targets.';
  return {score,label:band.label,cls:band.cls,text,saved:saved.length,touched,assigned,follow,active};
}
function opportunityScore(){
  const refs=current.referrals.length, sim=current.similar.length, existing=getExistingPlaces().length;
  const contactable=current.referrals.filter(p=>p.phone||p.website).length;
  if(!current.places.length && !existing) return {score:0,label:'Search first',text:'Run a search to score market opportunity.'};
  let score=0;
  score+=Math.min(42, refs*2.1);
  score+=Math.min(22, contactable*1.4);
  score+=existing?Math.min(12, existing*2):Math.min(12, refs>8?8:0);
  score-=Math.min(24, sim*1.3);
  score=Math.max(0,Math.min(100,Math.round(score)));
  const band=scoreBand(score);
  const text=score>=70?'There are enough potential referral offices to justify a focused outreach plan.':score>=50?'There may be opportunity, but target the cleanest offices first.':'Opportunity signal is limited or competitor-heavy; verify before investing time.';
  return {score,label:band.label,cls:band.cls,text,refs,sim,existing,contactable};
}
function planningScoreSummary(){
  const plan=expansionScore(), opp=opportunityScore(), contact=contactReadinessScore(), exec=executionScore();
  const barriers=topBarriers(3);
  const target=plan.score>=70 && contact.score>=75 ? 'Ready for a focused outreach week' : plan.score>=70 ? 'Good market, but improve contact readiness' : 'Build data quality and target list before broad outreach';
  return {plan, opp, contact, exec, barriers, target};
}

function partnerReadiness(p){
  const rec=savedRecord(p.id);
  return [
    {label:'Phone or website', ok:Boolean(p.phone||p.website)},
    {label:'Mapped location', ok:Boolean(p.lat&&p.lon)},
    {label:'Referral contact', ok:Boolean(rec.coordinator)},
    {label:'Fax / portal', ok:Boolean(rec.faxPortal)},
    {label:'Payer notes', ok:Boolean(rec.payerNotes)},
    {label:'Follow-up set', ok:Boolean(rec.followUpDate)}
  ];
}
function readinessChecklistHtml(p){
  const ready=partnerReadiness(p); const ok=ready.filter(x=>x.ok).length;
  const label=ok>=5?'Ready for outreach':ok>=3?'Partially ready':'Needs setup';
  return `<div class="readiness-card"><div class="readiness-head"><span>Referral partner readiness</span><b>${esc(label)} · ${ok}/${ready.length}</b></div><div class="readiness-list">${ready.map(x=>`<span class="${x.ok?'ok':'missing'}">${x.ok?'✓':'○'} ${esc(x.label)}</span>`).join('')}</div></div>`;
}
function commandReportText(){
  const saved=getSavedPlaces(); const due=saved.filter(p=>isDue(p.followUpDate)); const active=saved.filter(p=>(p.status||'')==='Relationship active'); const blocked=saved.filter(p=>(p.status||'')==='Do not pursue' || (p.status||'')==='Poor fit');
  const exp=expansionScore(); const pressure=competitorPressure(); const quality=dataQualitySignal(); const gap=opportunityGap(); const barriers=topBarriers(5);
  const lines=[
    'ClinicMap IQ Growth Command Report',
    `Generated: ${new Date().toLocaleString()}`,
    `Market: ${$('#locationInput')?.value||'Not selected'}`,
    `Mission: ${growthMissionLabel().label}`,
    '',
    `Expansion score: ${exp.score}/100 — ${exp.label}`,
    `Competitor pressure: ${pressure.label}`,
    `Data quality: ${quality.label}`,
    `Opportunity gap: ${gap?`${gap.name} — ${gap.referrals||0} possible offices, ${gap.existing||0} existing sources, ${gap.similar||0} similar clinics`:'Not enough mapped data'}`,
    '',
    `Saved targets: ${saved.length}`,
    `Follow-ups due: ${due.length}`,
    `Active relationships: ${active.length}`,
    `Do-not-contact / poor fit: ${blocked.length}`,
    '',
    'Top barriers:',
    ...(barriers.length?barriers.map(([b,c])=>`- ${b}: ${c}`):['- None entered yet']),
    '',
    'Recommended next move:',
    recommendedNextMove(),
    '',
    'How office priority is chosen:',
    'Call this week = high/workable fit with contact details and map location; Verify first = missing contact/location or low public signal; Follow-up due = saved office with due date; Competitor/watch = similar clinic; Protect relationship = existing/active source.',
    '',
    'Next best offices:',
    ...nextBestOffices(10).map((p,i)=>`${i+1}. ${p.name} — ${officeActionTier(p).label} — ${officeWhyText(p)} — ${p.phone||'no phone'} — ${p.website||'no website'}`)
  ];
  return lines.join('\n');
}
function recommendedNextMove(){
  const due=getSavedPlaces().filter(p=>isDue(p.followUpDate)).length;
  const best10=nextBestOffices(10);
  const gap=opportunityGap();
  if(due>0) return `Work ${due} follow-up${due>1?'s':''} due before adding new outreach.`;
  if(best10.length>=5) return `Save and review ${Math.min(best10.length,10)} contactable high-fit offices, then build a visit route.`;
  if(gap && gap.referrals>0) return `Review ${gap.name} first; it has ${gap.referrals} possible offices and ${gap.similar||0} similar clinics.`;
  if(current.places.length) return 'Use No-waste mode or enable Google Places to improve the actionable list.';
  return 'Run a market search to generate a recommendation.';
}
function renderMarketOpportunityBrief(){
  const el=$('#briefContent'); if(!el) return;
  const badge=$('#briefBadge');
  const existing=getExistingPlaces(), saved=getSavedPlaces();
  const total=current.places.length+existing.length;
  const gap=opportunityGap();
  const pressure=competitorPressure();
  const quality=dataQualitySignal();
  const due=saved.filter(p=>isDue(p.followUpDate)).length;
  const contact=current.places.filter(p=>p.phone||p.website).length+existing.filter(p=>p.phone||p.website).length;
  if(!total){
    if(badge) badge.textContent='Search first';
    el.innerHTML='<div class="brief-empty"><b>No market loaded yet.</b><span>Run a search to generate one concise brief instead of multiple overlapping summary cards.</span></div>';
    return;
  }
  const exp=expansionScore(); const mission=growthMissionLabel(); const summary=planningScoreSummary();
  if(badge) badge.textContent=`${exp.score}/100 planning · target 70+`;
  const gapText=gap?`${gap.name}: ${gap.referrals||0} possible offices, ${gap.existing||0} existing, ${gap.similar||0} similar`:'Not enough mapped data yet';
  const gapSub=gap?(gap.referrals>0 && (gap.existing||0)===0?'Potential network gap: few/no existing sources in this direction.':gap.similar>gap.referrals?'Competitor-heavy pocket; review differentiation first.':'Good outreach pocket; start with contactable offices.'):'Add mapped results or existing sources to identify gaps.';
  const barrierText=summary.barriers.length?summary.barriers.map(([b,c])=>`${b} (${c})`).join(' · '):'No major barriers detected yet';
  el.innerHTML=`<div class="brief-grid upgraded-brief">
    <div class="brief-main"><span>Recommended next move</span><b>${esc(recommendedNextMove())}</b><p>${esc(mission.label)} · ${esc(mission.text)}</p></div>
    <div class="brief-card indigo"><span>Planning score</span><b>${exp.score}/100 · ${esc(exp.label)}</b><p>${esc(exp.text)} Target: 70+ planning plus 75+ contact readiness.</p></div>
    <div class="brief-card blue"><span>Market opportunity</span><b>${summary.opp.score}/100 · ${esc(summary.opp.label)}</b><p>${esc(summary.opp.text)}</p></div>
    <div class="brief-card green"><span>Contact readiness</span><b>${summary.contact.score}/100 · ${esc(summary.contact.label)}</b><p>${esc(summary.contact.text)}</p></div>
    <div class="brief-card gold"><span>Outreach execution</span><b>${summary.exec.score}/100 · ${esc(summary.exec.label)}</b><p>${esc(summary.exec.text)}</p></div>
    <div class="brief-card rose"><span>Top barriers</span><b>${esc(summary.target)}</b><p>${esc(barrierText)}</p></div>
    <div class="brief-card blue"><span>Best pocket</span><b>${esc(gapText)}</b><p>${esc(gapSub)}</p></div>
    <div class="brief-card rose"><span>Competitor pressure</span><b>${esc(pressure.label)}</b><p>${esc(pressure.text)}</p></div>
    <div class="brief-card green"><span>Data quality</span><b>${esc(quality.label)}</b><p>${esc(quality.text)}</p></div>
    <div class="brief-card gold"><span>Pipeline signal</span><b>${saved.length} saved · ${due} due</b><p>${contact} offices have public contact details. Use the pipeline for follow-up work.</p></div>
  </div>`;
}
function officeApproach(p){
  const b=norm(`${p.name} ${p.category}`);
  if(p.kind==='similar') return {title:'Competitor review', text:'Review differentiation, proximity to target offices, and whether this area is worth broad outreach first.'};
  if(/physical therapy|physiotherapy|rehab/.test(b)) return {title:'Best approach: PT office', text:'Ask about patients who fail conservative care, imaging workflow, and how your clinic communicates return-to-therapy plans.'};
  if(/primary|family|internal|general/.test(b)) return {title:'Best approach: primary care', text:'Emphasize easy referral access, red flags, imaging expectations, insurance fit, and direct scheduling pathway.'};
  if(/urgent/.test(b)) return {title:'Best approach: urgent care', text:'Focus on escalation criteria, radiculopathy/weakness pathways, and fast follow-up for appropriate cases.'};
  if(/imaging|radiology|mri|x-ray/.test(b)) return {title:'Best approach: imaging center', text:'Clarify image transfer, report sharing, referral contact, and how patients can be routed after abnormal findings.'};
  if(/pain/.test(b)) return {title:'Best approach: pain clinic', text:'Consider co-management, differentiation, and when surgical or specialty consult referral is appropriate.'};
  return {title:'Best approach', text:'Verify referral coordinator, fax/portal, payer fit, typical referral needs, and best next follow-up date.'};
}
function officeSuggestedAction(p){
  const rec=savedRecord(p.id), conf=contactConfidence(p), stage=outreachStage(p);
  if(stage.cls==='blocked') return 'Keep out of active outreach unless the team changes its decision.';
  if(isDue(rec.followUpDate)) return 'Follow up now; this office is due or overdue.';
  if(!isSaved(p.id) && conf.cls==='ready') return 'Save this office and add it to the next outreach route.';
  if(!p.phone && !p.website) return 'Verify contact details before assigning outreach time.';
  if(!rec.coordinator) return 'Ask for the referral coordinator or best referral contact.';
  return 'Update status after the next call/visit and set a follow-up date.';
}
function officeIntelligenceHtml(p){
  const approach=officeApproach(p);
  const conf=contactConfidence(p);
  return `<div class="office-intel"><div class="intel-head"><span>Office intelligence profile</span><b>${esc(officeSuggestedAction(p))}</b></div><div class="intel-grid"><div><small>${esc(approach.title)}</small><p>${esc(approach.text)}</p></div><div><small>Contact confidence</small><p>${esc(conf.label)} · ${esc(p.verification?.level||'Needs review')}</p></div></div>${readinessChecklistHtml(p)}</div>`;
}

async function fetchMapPlaces(center, radius){
  const u=new URL('/api/places', window.location.origin); u.searchParams.set('lat', center.lat); u.searchParams.set('lon', center.lon); u.searchParams.set('radiusMiles', radius);
  const j=await fetchJSON(u.toString(), {}, 26000);
  return (j.elements||[]).map((el,i)=>placeFromOsm(el, center, i)).filter(Boolean);
}
function placeFromOsm(el, center, i){
  const tags=el.tags||{}; const lat=Number(el.lat || el.center?.lat); const lon=Number(el.lon || el.center?.lon); if(!Number.isFinite(lat)||!Number.isFinite(lon)) return null;
  const name=tags.name||tags.operator||'Unnamed public listing';
  const category=tags.healthcare||tags.amenity||tags.office||tags.shop||tags.speciality||'healthcare';
  const address=[tags['addr:housenumber'],tags['addr:street'],tags['addr:city'],tags['addr:state'],tags['addr:postcode']].filter(Boolean).join(' ');
  const phone=tags.phone||tags['contact:phone']||tags['contact:mobile']||''; const website=tags.website||tags['contact:website']||tags.url||'';
  const kind=classifyRole(name, category, selectedTypes());
  const p={id:`osm:${el.type}:${el.id}`, name, category:inferOfficeType(name, category), rawCategory:category, address, phone, website, lat, lon, distance:distanceMiles(center.lat,center.lon,lat,lon), source:'OpenStreetMap', kind, approximatePin:false};
  p.verification=verification(p); p.score=fitScore(p); return p;
}

async function fetchNpiRecords(center, city, state, radius){
  if(!city || !state) return [];
  const mode=selectedMode(); const selected=selectedTypes();
  const baseTerms = selected.flatMap(t=>OFFICE_TYPES[t]?.npi || []);
  const extra = mode==='comprehensive' ? ['Clinic/Center','Family Medicine','Internal Medicine','Physical Therapist','Radiology','Chiropractor','Pain Medicine','Neurology','Rheumatology','Sports Medicine','Orthopaedic Surgery','Physical Medicine & Rehabilitation','Urgent Care','General Practice'] : [];
  const terms=[...new Set([...baseTerms, ...extra])].slice(0, mode==='comprehensive'?18:10);
  const limit = radius<=5?40:radius<=8?70:radius<=12?100:radius<=20?140:180;
  const calls=terms.map(term=>{ const u=new URL('/api/npi', window.location.origin); u.searchParams.set('city', city); u.searchParams.set('state', state); u.searchParams.set('limit', limit); u.searchParams.set('taxonomy_description', term); return fetchJSON(u.toString(), {}, 16000).catch(e=>({results:[], error:e.message})); });
  const data=await Promise.all(calls);
  const rows=data.flatMap(x=>x.results||[]); const seen=new Set(); const out=[];
  for(const r of rows){
    const basic=r.basic||{}; const tax=(r.taxonomies||[]).map(t=>t.desc).filter(Boolean).join(', '); const loc=(r.addresses||[]).find(a=>a.address_purpose==='LOCATION') || (r.addresses||[])[0] || {};
    const name=(basic.organization_name || [basic.first_name,basic.last_name].filter(Boolean).join(' ') || '').trim(); if(!name) continue;
    const address=[loc.address_1,loc.address_2,loc.city,loc.state,loc.postal_code].filter(Boolean).join(' ');
    const key=norm(`${name}|${address}|${loc.telephone_number}`); if(seen.has(key)) continue; seen.add(key);
    const kind=classifyRole(name, tax, selected);
    const p={id:`npi:${r.number}`, name, category:inferOfficeType(name,tax), rawCategory:tax||'NPI public record', address, phone:loc.telephone_number||'', website:'', lat:null, lon:null, distance:999, source:'NPI Registry', kind, approximatePin:false, npi:r.number, cityStateOnly:true};
    p.verification=verification(p); p.score=fitScore(p); out.push(p);
  }
  return out;
}

async function fetchGooglePlaces(center, radius){
  if(!$('#googleToggle').checked) return [];
  const selected=selectedTypes(); const terms = selected.flatMap(t=>OFFICE_TYPES[t].terms).concat(selectedConfig().competitorTerms).slice(0, selectedMode()==='comprehensive'?24:14);
  const calls=terms.map(term=>{ const u=new URL('/api/google-places', window.location.origin); u.searchParams.set('query', term); u.searchParams.set('lat', center.lat); u.searchParams.set('lon', center.lon); u.searchParams.set('radiusMiles', radius); return fetchJSON(u.toString(), {}, 14000).catch(e=>({places:[], disabled:true, error:e.message})); });
  const data=await Promise.all(calls); const rows=data.flatMap(x=>x.places||[]); const seen=new Set(); const out=[];
  for(const g of rows){
    const name=g.name||''; if(!name) continue; const address=g.address||''; const key=norm(`${name}|${address}|${g.phone||''}`); if(seen.has(key)) continue; seen.add(key);
    const lat=Number(g.lat), lon=Number(g.lon); const dist=distanceMiles(center.lat,center.lon,lat,lon); if(dist>radius+0.5) continue;
    const cat=g.category||g.types?.join(', ')||'Business listing'; const kind=classifyRole(name, cat, selected);
    const p={id:`google:${g.place_id||hashStr(key)}`, name, category:inferOfficeType(name,cat), rawCategory:cat, address, phone:g.phone||'', website:g.website||'', lat, lon, distance:dist, source:'Google Places', kind, approximatePin:false, rating:g.rating, user_ratings_total:g.user_ratings_total, photoUrl:g.photo_url||''};
    p.verification=verification(p); p.score=fitScore(p); out.push(p);
  }
  return out;
}

async function geocodeTop(records, center, radius){
  const candidates=records.filter(p=>!p.lat && p.address).sort((a,b)=>b.score-a.score).slice(0,MAX_BG_GEOCODE);
  for(let i=0;i<candidates.length;i++){
    const p=candidates[i];
    try{
      const u=new URL('/api/geocode', window.location.origin); u.searchParams.set('q', `${p.name} ${p.address}`);
      const j=await fetchJSON(u.toString(), {}, 8000);
      const lat=Number(j.lat), lon=Number(j.lon); const d=distanceMiles(center.lat,center.lon,lat,lon);
      if(Number.isFinite(lat)&&Number.isFinite(lon)&&d<=radius+1){ p.lat=lat; p.lon=lon; p.distance=d; p.approximatePin=true; p.source += ' + geocoded address'; p.verification=verification(p); p.score=fitScore(p); }
    }catch(e){
      // approximate fallback within the selected radius, based on real public record but not exact. Limit to top candidates.
      if(i<10){ const approx=approximatePin(p, center, i, radius); p.lat=approx.lat; p.lon=approx.lon; p.distance=distanceMiles(center.lat,center.lon,p.lat,p.lon); p.approximatePin=true; p.source += ' + approximate public-address pin'; p.verification=verification(p); p.score=fitScore(p); }
    }
  }
}
function approximatePin(p, center, i, radius){ const seed=hashStr(`${p.name}|${p.address}|${radius}`); const angle=(seed%360)*Math.PI/180; const r=0.4+((seed>>>8)%1000)/1000*Math.max(0.8,Math.min(radius*.82,18)-0.4); return {lat:center.lat+(r/69)*Math.cos(angle), lon:center.lon+(r/(69*Math.cos(deg(center.lat))))*Math.sin(angle)}; }

function mergePlaces(arrays, center, radius){
  const all=arrays.flat().filter(Boolean); const buckets=[];
  for(const p of all){
    if(p.lat&&p.lon){ p.distance=distanceMiles(center.lat,center.lon,p.lat,p.lon); if(p.distance>radius+1 && p.source!=='NPI Registry') continue; }
    let m=buckets.find(x=>samePlace(x,p));
    if(m) Object.assign(m, mergeTwo(m,p)); else buckets.push({...p});
  }
  for(const p of buckets){ p.id=officeKey(p); p.verification=verification(p); p.score=fitScore(p); }
  return buckets.sort((a,b)=>b.score-a.score);
}
function samePlace(a,b){
  if(a.phone && b.phone && a.phone.replace(/\D/g,'').slice(-7)===b.phone.replace(/\D/g,'').slice(-7)) return true;
  const an=norm(a.name), bn=norm(b.name); const aa=norm(a.address), ba=norm(b.address);
  if(an && bn && (an.includes(bn)||bn.includes(an)) && aa && ba && (aa.includes(ba.slice(0,20))||ba.includes(aa.slice(0,20)))) return true;
  if(a.lat&&a.lon&&b.lat&&b.lon&&distanceMiles(a.lat,a.lon,b.lat,b.lon)<0.08 && an.split(' ')[0]===bn.split(' ')[0]) return true;
  return false;
}
function mergeTwo(a,b){
  const out={...a};
  out.phone=a.phone||b.phone; out.website=a.website||b.website; out.address=a.address||b.address; out.lat=a.lat||b.lat; out.lon=a.lon||b.lon; out.distance=Math.min(a.distance||999,b.distance||999);
  out.source=[...new Set(String(`${a.source}; ${b.source}`).split(';').map(x=>x.trim()).filter(Boolean))].join(' + ');
  out.kind = a.kind==='similar'||b.kind==='similar' ? 'similar' : 'referral';
  out.approximatePin = Boolean(a.approximatePin || b.approximatePin);
  out.category = a.category || b.category;
  return out;
}

function computeZones(places, center){
  const sectors=['North','Northeast','East','Southeast','South','Southwest','West','Northwest'].map(n=>({name:n, referrals:0, similar:0, score:0, lat:0, lon:0, count:0}));
  for(const p of places){ if(!(p.lat&&p.lon)) continue; const sec=sectors.find(s=>s.name===sectorName(bearing(center.lat,center.lon,p.lat,p.lon))); if(!sec) continue; if(p.kind==='similar') sec.similar++; else sec.referrals++; sec.lat+=p.lat; sec.lon+=p.lon; sec.count++; }
  for(const s of sectors){ s.score=s.referrals*2 - s.similar*1.2; if(s.count){s.lat/=s.count;s.lon/=s.count;} }
  return sectors.sort((a,b)=>b.score-a.score);
}

function resetRecommended(){ const spec=$('#specialtySelect').value; const rec=new Set(RECOMMENDED[spec]||RECOMMENDED.spine); $$('#officeTypeGrid input').forEach(cb=>cb.checked=rec.has(cb.value)); }

async function runSearch(e){
  if(e) e.preventDefault();
  const loc=$('#locationInput').value.trim(); if(!loc) return setMessage('error','Location needed','Enter a city/state or clinic address first.');
  setLoading('Finding mapped clinics…'); setMessage('', '', '');
  const radius=selectedRadius(); const mode=selectedMode();
  try{
    const cached=getCached(); if(cached){ current=cached; renderAll(); updateSavedSearchAfterRun(); setMessage('', '', ''); return; }
    const center=await geocodeMarket(loc); current.center={lat:center.lat,lon:center.lon}; current.city=center.city; current.state=center.state;
    updateMapBase(center);
    let mapPromise=Promise.resolve([]), npiPromise=Promise.resolve([]), googlePromise=Promise.resolve([]);
    if(mode!=='contact_first'){ setLoading('Finding mapped clinics…'); mapPromise=fetchMapPlaces(center, Math.min(radius, OSM_MAX_MILES)).catch(e=>{current.messages.push('Public map data was limited.');return[];}); }
    if(mode!=='map_first'){ setLoading('Loading public contact records…'); npiPromise=fetchNpiRecords(center, current.city, current.state, radius).catch(e=>{current.messages.push('NPI contact records were limited.');return[];}); }
    if($('#googleToggle').checked){ googlePromise=fetchGooglePlaces(center, radius).catch(e=>{current.messages.push('Google Places unavailable or not configured.');return[];}); }
    const [mapPlaces, npiPlaces, googlePlaces] = await Promise.all([mapPromise,npiPromise,googlePromise]);
    let places=mergePlaces([mapPlaces, googlePlaces, npiPlaces], center, radius);
    setLoading('Placing offices on the map…');
    await geocodeTop(places, center, radius);
    places=mergePlaces([places], center, radius);
    places=annotateNewPlaces(places);
    current.places=places;
    current.referrals=places.filter(p=>p.kind!=='similar');
    current.similar=places.filter(p=>p.kind==='similar');
    current.zones=computeZones(places, center);
    current.sourceStatus={map:mapPlaces.length, npi:npiPlaces.length, google:googlePlaces.length, radius};
    setCached(current);
    renderAll();
    updateSavedSearchAfterRun();
    logActivity('Ran market search', {id:`search:${Date.now()}`, name:loc}, `${places.length} listings · ${places.filter(p=>p.lat&&p.lon).length} pinned · radius ${radius} mi`);
    if(!mapPlaces.length && !googlePlaces.length){ setMessage('warn','Public map data limited','Showing available contact records and any addresses that could be mapped. NPI records are city/state based until mapped.'); }
    else setMessage('', '', '');
  }catch(err){ console.error(err); setMessage('error','Search could not start',err.message||'Try city + state such as Austin, TX.'); }
  finally{ clearLoading(); }
}

function updateMapBase(center){
  markerLayer.clearLayers(); zoneLayer.clearLayers(); markers.clear();
  map.setView([center.lat,center.lon], radiusZoom(selectedRadius()));
  baseMarker = L.marker([center.lat,center.lon]).addTo(markerLayer).bindPopup('<b>Your clinic / market center</b>');
  setTimeout(()=>map.invalidateSize(), 200);
}
function radiusZoom(r){ return r<=5?12:r<=8?11:r<=12?10:r<=20?10:r<=30?9:8; }
function markerIcon(kind, approx=false){ const cls=kind==='similar'?'similar':kind==='existing'?'existing':kind==='base'?'base':kind==='zone'?'zone':'referral'; return L.divIcon({className:'', html:`<div class="map-marker ${cls} ${approx?'approx':''}"></div>`, iconSize:[22,22], iconAnchor:[11,11]}); }
function placeRoleLabel(p){
  return p.kind==='existing' ? 'Existing referral source' : p.kind==='similar' ? 'Competitor / similar clinic' : 'Possible referral office';
}
function contactCompleteness(p){
  const items=[];
  if(p.phone) items.push('phone');
  if(p.website) items.push('website');
  if(p.address) items.push('address');
  if(p.lat && p.lon) items.push('mapped');
  return items.length ? items.join(' + ') : 'needs contact verification';
}

function clinicVisual(p, compact=false){
  const label = p.kind==='similar' ? 'Similar clinic' : p.kind==='existing' ? 'Existing source' : 'Referral office';
  const cls = p.kind==='similar' ? 'similar' : p.kind==='existing' ? 'existing' : 'referral';
  const href = p.website ? safeUrl(p.website) : mapsUrl(p);
  const targetLabel = p.website ? 'clinic website' : 'map listing';
  if(p.photoUrl){
    return `<a class="clinic-visual ${cls} ${compact?'compact':''}" href="${href}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="Open ${esc(targetLabel)}"><img src="${esc(p.photoUrl)}" alt="${esc(p.name)} public clinic photo" loading="lazy" onerror="this.closest('.clinic-visual').classList.add('no-photo');this.remove();"/><span>${esc(label)}</span></a>`;
  }
  return `<a class="clinic-visual ${cls} no-photo ${compact?'compact':''}" href="${href}" target="_blank" rel="noopener" onclick="event.stopPropagation()" aria-label="Open ${esc(targetLabel)}"><div class="building-icon"><i></i><i></i><i></i><i></i></div><span>No public photo</span></a>`;
}
function popupHtml(p){
  const rec=savedRecord(p.id); const status=rec.status||'Not contacted';
  const role=placeRoleLabel(p);
  const fit=fitLabel(p.score||0).label;
  const completeness=contactCompleteness(p);
  const phone=p.phone?`<a href="tel:${p.phone.replace(/\D/g,'')}">${esc(p.phone)}</a>`:'Phone not listed';
  const website=p.website?`<a target="_blank" rel="noopener" href="${safeUrl(p.website)}">Open website</a>`:'Website not listed';
  const address=p.address||'Address not listed';
  const pinType=p.approximatePin?'Approximate public-address pin; verify before visiting':'Mapped public coordinate';
  return `<div class="pin-popup rich-popup">
    ${clinicVisual(p,true)}
    <h3>${esc(p.name)}</h3>
    <div class="popup-role ${p.kind}">${esc(role)}</div>
    <dl>
      <dt>Type</dt><dd>${esc(p.category||'Healthcare office')}</dd>
      <dt>Distance</dt><dd>${p.distance<999?p.distance.toFixed(1)+' mi':'City/state contact record'}</dd>
      <dt>Address</dt><dd>${esc(address)}</dd>
      <dt>Phone</dt><dd>${phone}</dd>
      <dt>Website</dt><dd>${website}</dd>
      <dt>Contact</dt><dd>${esc(completeness)}</dd>
      <dt>Listing</dt><dd>${esc(p.verification?.level||'Needs review')}</dd>
      <dt>Map pin</dt><dd>${esc(pinType)}</dd>
      <dt>Fit</dt><dd>${esc(fit)}</dd>
      <dt>Status</dt><dd>${esc(status)}${rec.assignedTo?' · assigned to '+esc(rec.assignedTo):''}${rec.followUpDate?' · follow-up '+esc(rec.followUpDate):''}</dd>
      ${rec.notes?`<dt>Notes</dt><dd>${esc(rec.notes).slice(0,180)}</dd>`:''}
    </dl>
    <div class="pin-actions">
      <button class="tiny-btn action-manage" onclick="window.__cmiqOpenOffice && window.__cmiqOpenOffice('${esc(p.id)}')">Open details</button>
      <a class="tiny-btn action-directions" target="_blank" rel="noopener" href="${mapsUrl(p)}">Directions</a>
      ${p.phone?`<a class="tiny-btn action-call" href="tel:${p.phone.replace(/\D/g,'')}">Call</a>`:''}
      ${p.website?`<a class="tiny-btn action-web" target="_blank" rel="noopener" href="${safeUrl(p.website)}">Website</a>`:''}
      <a class="tiny-btn action-verify" target="_blank" rel="noopener" href="${webSearchUrl(p)}">Verify</a>
    </div>
  </div>`;
}
function tooltipHtml(p){
  const rec=savedRecord(p.id);
  const role=placeRoleLabel(p);
  const fit=fitLabel(p.score||0).label;
  return `<div class="pin-tooltip-detail">
    <strong>${esc(p.name)}</strong>
    <span>${esc(role)}</span>
    <span>${esc(p.category||'Healthcare office')}${p.distance<999?' · '+p.distance.toFixed(1)+' mi':''}</span>
    <span>${p.phone?esc(p.phone):'No phone in public data'}${p.website?' · website':''}</span>
    <span>${esc(p.verification?.level||'Needs review')}</span>
    <span>${esc(fit)}${rec.followUpDate?' · follow-up '+esc(rec.followUpDate):''}</span>
  </div>`;
}
function renderMap(){
  markerLayer.clearLayers(); zoneLayer.clearLayers(); markers.clear();
  const center=current.center; if(!center) return;
  L.marker([center.lat,center.lon], {icon:markerIcon('base')}).addTo(markerLayer).bindPopup('<b>Your clinic / market center</b>');
  const pts=[];
  const basePlaces=current.places.filter(p=>p.lat&&p.lon && (p.kind==='similar'?visibleLayers.similar:visibleLayers.referral));
  const existingPlaces=getExistingPlaces().filter(p=>p.lat&&p.lon && visibleLayers.existing);
  const places=[...basePlaces, ...existingPlaces];
  for(const p of places){
    const m=L.marker([p.lat,p.lon], {icon:markerIcon(p.kind,p.approximatePin)}).addTo(markerLayer).bindPopup(popupHtml(p), {maxWidth:360, className:'rich-office-popup'}).bindTooltip(tooltipHtml(p), {direction:'top', opacity:.97, sticky:true, className:'rich-office-tooltip'});
    m.on('click',()=>selectPlace(p,false));
    markers.set(p.id,m); pts.push([p.lat,p.lon]);
  }
  const best=current.zones.find(z=>z.score>0 && z.count>0);
  if(best && Number.isFinite(best.lat)){ L.circle([best.lat,best.lon], {radius:Math.min(selectedRadius(),10)*420, color:'#f4b12b', fillColor:'#f4b12b', fillOpacity:.10, weight:2}).addTo(zoneLayer); }
  if(selectedArea){ drawAreaLayer(); renderAreaAnalysis(); }
  if(pts.length){ map.fitBounds(pts.concat([[center.lat,center.lon]]), {padding:[35,35], maxZoom:13}); }
  else map.setView([center.lat,center.lon], radiusZoom(selectedRadius()));
  setTimeout(()=>map.invalidateSize(false), 120);
  setTimeout(()=>map.invalidateSize(false), 450);
  setTimeout(()=>map.invalidateSize(), 900);
  updateLayerControlUI();
}
function updateLayerControlUI(){
  const allOn = visibleLayers.referral && visibleLayers.similar && visibleLayers.existing;
  $$('.layer-btn[data-layer], .legend [data-layer]').forEach(el=>{
    const layer=el.dataset.layer;
    const on=!!visibleLayers[layer];
    el.classList.toggle('active', on);
    el.classList.toggle('muted-layer', !on);
    el.setAttribute('aria-pressed', String(on));
    el.title = allOn ? 'Click to show only this layer' : (on ? 'Click again to show all layers' : 'Click to show only this layer');
  });
}
function setExclusiveLayer(layer){
  if(!['referral','similar','existing'].includes(layer)) return;
  const onlyThis = visibleLayers[layer] && Object.entries(visibleLayers).every(([k,v])=>k===layer ? v : !v);
  if(onlyThis){ visibleLayers={referral:true, similar:true, existing:true}; }
  else { visibleLayers={referral:false, similar:false, existing:false}; visibleLayers[layer]=true; }
  renderMap();
}

function renderAll(){ renderMap(); renderSummary(); renderMarketOpportunityBrief(); renderMarketFigures(); renderLists(); renderSaved(); renderPipelineBoard(); renderCampaignBoard(); renderAgent('weekly'); renderExistingNetwork(); renderNetworkCoverage(); renderTeamWorkspace(); renderManagerDashboard(); renderActivityHistory(); renderSavedSearches(); renderCloudStatus(); $('#layerToggles').hidden=false; }
function renderSummary(){
  const existing=getExistingPlaces(); const pinned=current.places.filter(p=>p.lat&&p.lon).length + existing.filter(p=>p.lat&&p.lon).length; const contact=current.places.filter(p=>p.phone||p.website).length + existing.filter(p=>p.phone||p.website).length;
  $('#summaryTitle').textContent = current.places.length ? 'Complete' : 'Ready';
  $('#summaryText').textContent = '';
  $('#referralCount').textContent=current.referrals.length; $('#similarCount').textContent=current.similar.length; $('#contactCount').textContent=contact; $('#pinnedCount').textContent=pinned; $('#mapPinBadge').textContent=pinned?`${pinned} pinned`:'No pins yet';
  const best=current.zones.find(z=>z.score>0);
  if(best){ $('#bestAreaTitle').textContent=best.name; $('#bestAreaText').textContent='See Market Opportunity Brief below for the full recommendation.'; }
  else { $('#bestAreaTitle').textContent=current.places.length?'Review data quality':'Search first'; $('#bestAreaText').textContent=current.places.length?'Not enough mapped data to name a single pocket yet.':'Run a search to generate a market brief and action plan.'; }
  $('#routeBtn').disabled=!current.places.some(p=>p.lat&&p.lon) && !getExistingPlaces().some(p=>p.lat&&p.lon); $('#csvBtn').disabled=!current.places.length && !getSavedPlaces().length; $('#reportBtn').disabled=!current.places.length && !getSavedPlaces().length; if($('#pdfBtn')) $('#pdfBtn').disabled=!current.places.length && !getSavedPlaces().length;
}
function applyFilters(items){
  let out=[...items]; const saved=savedStore(); const today=todayISO();
  switch(filters.mode){
    case 'high': out=out.filter(p=>p.score>=72); break;
    case 'phone': out=out.filter(p=>p.phone); break;
    case 'website': out=out.filter(p=>p.website); break;
    case 'mapped': out=out.filter(p=>p.lat&&p.lon); break;
    case 'saved': out=out.filter(p=>saved[p.id]); break;
    case 'due': out=out.filter(p=>saved[p.id]?.followUpDate && saved[p.id].followUpDate<=today); break;
    case 'dnc': out=out.filter(p=>(saved[p.id]?.status||'')==='Do not pursue'); break;
    case 'verified': out=out.filter(p=>(p.phone||p.website) && p.verification?.score>=4); break;
    case 'needsverify': out=out.filter(p=>p.approximatePin || !p.phone || !p.website || (p.verification?.score||0)<4); break;
  }
  if(filters.hidePoor) out=out.filter(p=>(p.score||0)>=48);
  if(filters.noWaste) out=out.filter(noWasteCandidate);
  out.sort((a,b)=>{
    if(sortMode==='distance') return (a.distance||999)-(b.distance||999);
    if(sortMode==='name') return a.name.localeCompare(b.name);
    if(sortMode==='contact') return Number(Boolean(b.phone||b.website))-Number(Boolean(a.phone||a.website)) || b.score-a.score;
    if(sortMode==='strength') return (b.verification.score||0)-(a.verification.score||0);
    if(sortMode==='followup'){ const sa=saved[a.id]?.followUpDate||'9999'; const sb=saved[b.id]?.followUpDate||'9999'; return sa.localeCompare(sb); }
    return b.score-a.score;
  });
  return out;
}
function renderLists(){ renderList('#referralList', current.referrals, 'Search a market to see possible referral offices.', false, expanded.referrals); renderList('#similarList', current.similar, 'No similar clinics found in the available public data.', true, expanded.similar); }
function renderList(sel, items, empty, similar, isExpanded){
  const el=$(sel); const filtered=applyFilters(items); if(!filtered.length){ el.className='empty-list'; el.textContent=empty; return; }
  el.className='card-list'; const collapsedLimit=similar?4:6; const limit=isExpanded?filtered.length:collapsedLimit; const shown=filtered.slice(0,limit).map(p=>officeCard(p)).join('');
  const btn = filtered.length>collapsedLimit ? `<button type="button" class="${isExpanded?'show-less':'show-more'}" data-list="${sel}">${isExpanded?'Review less ▲':`View ${filtered.length-collapsedLimit} more ▼`}</button>` : '';
  el.innerHTML=shown+btn; bindCardEvents(el);
}

function teamOptions(selected='') {
  const teams=teamStore();
  const opts=['<option value="">Unassigned</option>'].concat(teams.map(t=>`<option value="${esc(t.name)}" ${t.name===selected?'selected':''}>${esc(t.name)}</option>`));
  return opts.join('');
}
function officeNewBadge(p){
  if(!p?.isNew) return '';
  const rec=savedRecord(p.id);
  const touched=Boolean(rec.lastUpdated) || activityStore().some(a=>a.officeId===p.id);
  return touched ? '<span class="badge reviewed">Reviewed this run</span>' : '<span class="badge new">New this run</span>';
}

function officeCard(p){
  const rec=savedRecord(p.id); const status=rec.status||'Not contacted'; const follow=rec.followUpDate||''; const note=rec.notes||''; const assigned=rec.assignedTo||''; const coordinator=rec.coordinator||''; const faxPortal=rec.faxPortal||''; const payerNotes=rec.payerNotes||''; const fit=fitLabel(p.score); const isS=isSaved(p.id);
  const stage=outreachStage(p); const barriers=barrierList(p); const confidence=contactConfidence(p);
  const opts=STATUSES.map(s=>`<option value="${esc(s)}" ${s===status?'selected':''}>${esc(s)}</option>`).join('');
  return `<div class="office-card" data-id="${esc(p.id)}"><div class="office-top with-visual">${clinicVisual(p,true)}<div class="office-main"><div class="office-title">${esc(p.name)}</div><div class="office-meta">${esc(p.category)} · ${p.distance<999?p.distance.toFixed(1)+' mi':'Public contact record'}${p.approximatePin?' · approximate pin':''}</div></div><span class="priority ${fit.cls}">${fit.label}</span></div><div class="badge-row"><span class="badge good">${esc(p.verification.level)}</span><span class="badge ${p.phone||p.website?'good':'warn'}">${p.phone||p.website?'Contact available':'Needs contact check'}</span>${officeNewBadge(p)}${assigned?`<span class="badge blue-badge">Assigned: ${esc(assigned)}</span>`:''}<span class="badge strength ${stage.cls}">${esc(stage.label)}</span><span class="badge confidence ${confidence.cls}">${esc(confidence.label)}</span></div><div class="why-line">${tierBadgeHtml(p)}<span>${esc(officeWhyText(p))}</span></div><div class="office-actions">${p.phone?`<a class="tiny-btn action-call" href="tel:${p.phone.replace(/\D/g,'')}" onclick="event.stopPropagation()">Call</a>`:''}${p.website?`<a class="tiny-btn action-web" href="${safeUrl(p.website)}" target="_blank" onclick="event.stopPropagation()">Website</a>`:''}<a class="tiny-btn action-directions" href="${mapsUrl(p)}" target="_blank" onclick="event.stopPropagation()">Directions</a><button class="tiny-btn save action-save" data-save="${esc(p.id)}" type="button">${isS?'✓ Saved':'+ Save'}</button><button class="tiny-btn manage action-manage" type="button">Manage</button></div><div class="compact-status">${esc(status)}${assigned?' · '+esc(assigned):''}${follow?' · follow-up '+esc(follow):''}</div><div class="manage-panel"><div class="manage-grid"><label>Status<select class="status-select" data-id="${esc(p.id)}">${opts}</select></label><label>Assigned to<select class="assign-select" data-id="${esc(p.id)}">${teamOptions(assigned)}</select></label><label>Follow-up<input type="date" class="follow-input" data-id="${esc(p.id)}" value="${esc(follow)}" /></label><label>Referral coordinator<input type="text" class="coord-input" data-id="${esc(p.id)}" value="${esc(coordinator)}" placeholder="name / role" /></label><label>Fax / portal<input type="text" class="fax-input" data-id="${esc(p.id)}" value="${esc(faxPortal)}" placeholder="fax, portal, or referral email" /></label><label>Insurance / payer notes<input type="text" class="payer-input" data-id="${esc(p.id)}" value="${esc(payerNotes)}" placeholder="accepted plans or payer notes" /></label></div><textarea class="note-input" data-id="${esc(p.id)}" placeholder="Notes: contact outcome, barriers, next step...">${esc(note)}</textarea><div class="barrier-label">User-entered barrier tags</div>${barrierTagsHtml(p.id, barriers)}</div></div>`;
}

function bindCardEvents(root){
  root.querySelectorAll('.office-card').forEach(card=>card.addEventListener('click',e=>{ if(e.target.closest('a,button,input,select,textarea')) return; const p=findPlace(card.dataset.id); if(p) selectPlace(p,true); }));
  root.querySelectorAll('.manage').forEach(btn=>btn.addEventListener('click',e=>{ e.stopPropagation(); btn.closest('.office-card').classList.toggle('expanded'); }));
  root.querySelectorAll('[data-save]').forEach(btn=>btn.addEventListener('click',e=>{ e.stopPropagation(); const p=findPlace(btn.dataset.save); if(!p) return; if(isSaved(p.id)){ removeSavedRecord(p.id); } else { updateSavedRecord(p.id, placeToSaved(p)); logActivity('Saved to outreach list', p); } renderLists(); renderSaved(); renderAgent('saved'); refreshPlanningViews(); }));
  root.querySelectorAll('.status-select').forEach(inp=>inp.addEventListener('change',e=>{ e.stopPropagation(); updateWorkflowRecord(inp.dataset.id, {status:inp.value}); renderLists(); renderSaved(); refreshPlanningViews(); }));
  root.querySelectorAll('.follow-input').forEach(inp=>inp.addEventListener('change',e=>{ e.stopPropagation(); updateWorkflowRecord(inp.dataset.id, {followUpDate:inp.value}); renderLists(); renderSaved(); refreshPlanningViews(); }));
  root.querySelectorAll('.assign-select').forEach(inp=>inp.addEventListener('change',e=>{ e.stopPropagation(); updateWorkflowRecord(inp.dataset.id, {assignedTo:inp.value}); renderLists(); renderSaved(); renderTeamWorkspace(); refreshPlanningViews(); }));
  root.querySelectorAll('.coord-input').forEach(inp=>inp.addEventListener('change',e=>{ e.stopPropagation(); updateWorkflowRecord(inp.dataset.id, {coordinator:inp.value}); renderLists(); renderSaved(); refreshPlanningViews(); }));
  root.querySelectorAll('.fax-input').forEach(inp=>inp.addEventListener('change',e=>{ e.stopPropagation(); updateWorkflowRecord(inp.dataset.id, {faxPortal:inp.value}); renderLists(); renderSaved(); refreshPlanningViews(); }));
  root.querySelectorAll('.payer-input').forEach(inp=>inp.addEventListener('change',e=>{ e.stopPropagation(); updateWorkflowRecord(inp.dataset.id, {payerNotes:inp.value}); renderLists(); renderSaved(); refreshPlanningViews(); }));
  root.querySelectorAll('.note-input').forEach(inp=>inp.addEventListener('change',e=>{ e.stopPropagation(); updateWorkflowRecord(inp.dataset.id, {notes:inp.value}); renderLists(); renderSaved(); refreshPlanningViews(); }));
  root.querySelectorAll('.barrier-input').forEach(inp=>inp.addEventListener('change',e=>{ e.stopPropagation(); const id=inp.dataset.id; const vals=Array.from(root.querySelectorAll(`.barrier-input[data-id=\"${CSS.escape(id)}\"]:checked`)).map(x=>x.value); updateWorkflowRecord(id,{barriers:vals}); renderLists(); renderSaved(); refreshPlanningViews(); }));
  const more=root.querySelector('.show-more'); if(more) more.addEventListener('click',()=>{ if(more.dataset.list==='#referralList') expanded.referrals=true; else expanded.similar=true; renderLists(); });
  const less=root.querySelector('.show-less'); if(less) less.addEventListener('click',()=>{ if(less.dataset.list==='#referralList') expanded.referrals=false; else expanded.similar=false; renderLists(); });
}

function refreshPlanningViews(){
  renderMarketOpportunityBrief();
  renderMarketFigures();
  renderManagerDashboard();
  renderPipelineBoard();
  renderActivityHistory();
}

function placeToSaved(p){ const rec=savedRecord(p.id); return {id:p.id,name:p.name,kind:p.kind,category:p.category,address:p.address,phone:p.phone,website:p.website,lat:p.lat,lon:p.lon,distance:p.distance,source:p.source,verification:p.verification,score:p.score,approximatePin:p.approximatePin,photoUrl:p.photoUrl||'',barriers:rec.barriers||[],coordinator:rec.coordinator||p.coordinator||'',faxPortal:rec.faxPortal||p.faxPortal||'',payerNotes:rec.payerNotes||p.payerNotes||''}; }
function findPlace(id){ return current.places.find(p=>p.id===id) || getExistingPlaces().find(p=>p.id===id) || getSavedPlaces().find(p=>p.id===id); }
function selectPlace(p, move=true){
  if(move && markers.has(p.id)){ markers.get(p.id).openPopup(); map.panTo(markers.get(p.id).getLatLng(), {animate:true}); }
  const rec=savedRecord(p.id); const opts=STATUSES.map(s=>`<option value="${esc(s)}" ${s===(rec.status||'Not contacted')?'selected':''}>${esc(s)}</option>`).join('');
  const history=activityStore().filter(a=>a.officeId===p.id).slice(0,6);
  const coordinator=rec.coordinator||''; const faxPortal=rec.faxPortal||''; const payerNotes=rec.payerNotes||'';
  $('#selectedSection').hidden=false; $('#selectedTitle').textContent=p.name;
  $('#selectedDetails').innerHTML=`${clinicVisual(p)}<dl><dt>Role</dt><dd>${p.kind==='existing'?'Existing referral source':p.kind==='similar'?'Similar clinic / competitor':'Possible referral office'}</dd><dt>Type</dt><dd>${esc(p.category)}</dd><dt>Address</dt><dd>${esc(p.address||'Not listed')}</dd><dt>Phone</dt><dd>${p.phone?`<a href="tel:${p.phone.replace(/\D/g,'')}">${esc(p.phone)}</a>`:'Not listed'}</dd><dt>Website</dt><dd>${p.website?`<a target="_blank" href="${safeUrl(p.website)}">Open website</a>`:'Not listed'}</dd><dt>Map pin</dt><dd>${p.approximatePin?'Approximate public-address pin; verify before visiting':'Mapped public coordinate when available'}</dd><dt>Listing</dt><dd>${esc(p.verification?.level||'Needs review')}</dd><dt>Outreach stage</dt><dd><span class="badge strength ${outreachStage(p).cls}">${esc(outreachStage(p).label)}</span></dd></dl><div class="manage-grid"><label>Status<select id="selectedStatus">${opts}</select></label><label>Assigned to<select id="selectedAssign">${teamOptions(rec.assignedTo||'')}</select></label><label>Follow-up<input id="selectedFollow" type="date" value="${esc(rec.followUpDate||'')}" /></label><label>Referral coordinator<input id="selectedCoord" type="text" value="${esc(coordinator)}" placeholder="name / role" /></label><label>Fax / portal<input id="selectedFax" type="text" value="${esc(faxPortal)}" placeholder="fax, portal, referral email" /></label><label>Insurance / payer notes<input id="selectedPayer" type="text" value="${esc(payerNotes)}" placeholder="accepted plans, barriers" /></label></div><textarea id="selectedNotes" placeholder="Notes: contact outcome, barriers, next action...">${esc(rec.notes||'')}</textarea><div class="barrier-label">User-entered barrier tags</div>${barrierTagsHtml(p.id, barrierList(p))}<div class="office-actions"><button class="tiny-btn save action-save" id="selectedSave">${isSaved(p.id)?'✓ Saved':'+ Save'}</button><a class="tiny-btn action-directions" href="${mapsUrl(p)}" target="_blank">Directions</a>${p.phone?`<a class="tiny-btn action-call" href="tel:${p.phone.replace(/\D/g,'')}">Call</a>`:''}${p.website?`<a class="tiny-btn action-web" target="_blank" href="${safeUrl(p.website)}">Website</a>`:''}<a class="tiny-btn action-calendar" target="_blank" href="${googleCalendarUrl(p)}">Google Calendar</a></div>${officeIntelligenceHtml(p)}${relationshipTimelineHtml(p)}`;
  $('#selectedStatus').addEventListener('change',e=>{updateWorkflowRecord(p.id,{status:e.target.value}); renderLists(); renderSaved(); refreshPlanningViews(); selectPlace(findPlace(p.id)||p,false);});
  $('#selectedAssign').addEventListener('change',e=>{updateWorkflowRecord(p.id,{assignedTo:e.target.value}); renderLists(); renderSaved(); renderTeamWorkspace(); refreshPlanningViews(); selectPlace(findPlace(p.id)||p,false);});
  $('#selectedFollow').addEventListener('change',e=>{updateWorkflowRecord(p.id,{followUpDate:e.target.value}); renderLists(); renderSaved(); refreshPlanningViews(); selectPlace(findPlace(p.id)||p,false);});
  $('#selectedCoord').addEventListener('change',e=>{updateWorkflowRecord(p.id,{coordinator:e.target.value}); renderLists(); renderSaved(); refreshPlanningViews(); selectPlace(findPlace(p.id)||p,false);});
  $('#selectedFax').addEventListener('change',e=>{updateWorkflowRecord(p.id,{faxPortal:e.target.value}); renderLists(); renderSaved(); refreshPlanningViews(); selectPlace(findPlace(p.id)||p,false);});
  $('#selectedPayer').addEventListener('change',e=>{updateWorkflowRecord(p.id,{payerNotes:e.target.value}); renderLists(); renderSaved(); refreshPlanningViews(); selectPlace(findPlace(p.id)||p,false);});
  $('#selectedNotes').addEventListener('change',e=>{updateWorkflowRecord(p.id,{notes:e.target.value}); renderLists(); renderSaved(); refreshPlanningViews(); selectPlace(findPlace(p.id)||p,false);});
  $$('#selectedDetails .barrier-input').forEach(inp=>inp.addEventListener('change',()=>{ const vals=$$('#selectedDetails .barrier-input:checked').map(x=>x.value); updateWorkflowRecord(p.id,{barriers:vals}); renderLists(); renderSaved(); refreshPlanningViews(); selectPlace(findPlace(p.id)||p,false); }));
  $('#selectedSave').addEventListener('click',()=>{ if(isSaved(p.id)) removeSavedRecord(p.id); else { updateSavedRecord(p.id, placeToSaved(p)); logActivity('Saved to outreach list', p); } renderSaved(); renderLists(); refreshPlanningViews(); selectPlace(findPlace(p.id)||p,false); });
}



function savedSearchesStore(){ return storage('cmiq_saved_searches_v82', []); }
function saveSavedSearches(v){ saveStorage('cmiq_saved_searches_v82', Array.isArray(v)?v.slice(0,12):[]); }
function currentSearchConfig(){
  return {
    id:`search:${hashStr(`${norm($('#locationInput')?.value||'')}|${$('#specialtySelect')?.value||''}|${$('#radiusSelect')?.value||''}|${$('#growthGoalSelect')?.value||''}|${selectedTypes().sort().join(',')}`)}`,
    location:$('#locationInput')?.value?.trim() || '',
    specialty:$('#specialtySelect')?.value || 'spine',
    radius:$('#radiusSelect')?.value || '8',
    goal:$('#growthGoalSelect')?.value || 'general',
    mode:$('#searchMode')?.value || 'auto',
    google:Boolean($('#googleToggle')?.checked),
    types:selectedTypes(),
    resultCount:current?.places?.length || 0,
    pinnedCount:(current?.places||[]).filter(p=>p.lat&&p.lon).length,
    updatedAt:new Date().toISOString(),
    resultIds:(current?.places||[]).map(p=>p.id),
    similarIds:(current?.similar||[]).map(p=>p.id),
    referralIds:(current?.referrals||[]).map(p=>p.id)
  };
}
function searchLabel(s){
  const spec=$(`#specialtySelect option[value="${s.specialty}"]`)?.textContent || s.specialty || 'Specialty';
  return `${s.location || 'Market'} · ${spec} · ${s.radius || '?'} mi`;
}
function saveCurrentSearch(silent=false){
  const cfg=currentSearchConfig(); if(!cfg.location) return;
  const arr=savedSearchesStore().filter(s=>s.id!==cfg.id);
  arr.unshift(cfg); saveSavedSearches(arr); renderSavedSearches();
  if(!silent) logActivity('Saved search', {name:cfg.location}, searchLabel(cfg));
}
function updateSavedSearchAfterRun(){
  const cfg=currentSearchConfig();
  if(!cfg.location) return;
  const arr=savedSearchesStore();
  const idx=arr.findIndex(s=>s.id===cfg.id);
  const prev=idx>=0 ? arr[idx] : null;
  const prevSet=new Set(prev?.resultIds||[]);
  const prevSim=new Set(prev?.similarIds||[]);
  cfg.lastChange=prev ? {
    newResults:(cfg.resultIds||[]).filter(id=>!prevSet.has(id)).length,
    newCompetitors:(cfg.similarIds||[]).filter(id=>!prevSim.has(id)).length,
    oldResultCount:prev.resultCount||0,
    oldPinnedCount:prev.pinnedCount||0,
    checkedAt:new Date().toISOString()
  } : {
    newResults:cfg.resultCount||0,
    newCompetitors:(cfg.similarIds||[]).length,
    oldResultCount:0,
    oldPinnedCount:0,
    checkedAt:new Date().toISOString(),
    firstRun:true
  };
  const next=arr.filter(s=>s.id!==cfg.id);
  next.unshift(cfg);
  saveSavedSearches(next);
  renderSavedSearches();
}
function savedSearchChangeText(s){
  if(!s?.lastChange) return s.resultCount?`${s.resultCount} results saved`:'';
  const c=s.lastChange;
  if(c.firstRun) return `baseline saved · ${s.resultCount||0} total`;
  return `${c.newResults} new · ${c.newCompetitors} new competitors · ${s.resultCount||0} total`;
}
function marketWatchHtml(active, arr){
  if(!arr.length) return 'Save a market to compare changes after rerunning it.';
  if(active){
    const txt=savedSearchChangeText(active);
    const checked=active.lastChange?.checkedAt ? new Date(active.lastChange.checkedAt).toLocaleString() : '';
    return `<b>Active market watch:</b> ${esc(searchLabel(active))}${txt?' · '+esc(txt):''}${checked?' · checked '+esc(checked):''}`;
  }
  const latest=arr[0];
  return `<b>No active saved watch for this search.</b> Latest saved: ${esc(searchLabel(latest))}${savedSearchChangeText(latest)?' · '+esc(savedSearchChangeText(latest)):''}. Save or run this market to make the watch match the current search.`;
}
function renderSavedSearches(){
  const sel=$('#savedSearchSelect'); if(!sel) return;
  const arr=savedSearchesStore();
  sel.innerHTML='<option value="">Recent saved markets</option>'+arr.map(s=>`<option value="${esc(s.id)}">${esc(searchLabel(s))}${savedSearchChangeText(s)?` — ${esc(savedSearchChangeText(s))}`:''}</option>`).join('');
  const hint=$('#savedSearchChangeHint');
  if(hint){
    const currentId=currentSearchConfig().id;
    const active=arr.find(s=>s.id===currentId);
    hint.innerHTML = marketWatchHtml(active, arr);
  }
}
function applySavedSearch(id, run=false){
  const s=savedSearchesStore().find(x=>x.id===id); if(!s) return;
  if($('#locationInput')) $('#locationInput').value=s.location||'';
  if($('#specialtySelect')) $('#specialtySelect').value=s.specialty||'spine';
  if($('#radiusSelect')) $('#radiusSelect').value=s.radius||'8';
  if($('#growthGoalSelect')) $('#growthGoalSelect').value=s.goal||'general';
  if($('#searchMode')) $('#searchMode').value=s.mode||'auto';
  if($('#googleToggle')) $('#googleToggle').checked=Boolean(s.google);
  if(Array.isArray(s.types)) $$('#officeTypeGrid input').forEach(i=>{ i.checked=s.types.includes(i.value); });
  if(run) runSearch();
}
function clearSavedSearches(){ saveSavedSearches([]); renderSavedSearches(); logActivity('Cleared saved searches', {name:'Saved searches'}); }
function pipelineBucket(p){
  const status=p.status || 'Not contacted';
  if(status==='Do not pursue') return 'dnc';
  if(status==='Relationship active') return 'active';
  if(status==='Follow-up needed' || isDue(p.followUpDate)) return 'followup';
  if(['Called','Left message','Sent information'].includes(status)) return 'contacted';
  return 'not';
}
function renderPipelineBoard(){
  const board=$('#pipelineBoard'); if(!board) return;
  const saved=getSavedPlaces(); const badge=$('#pipelineBadge'); if(badge) badge.textContent=`${saved.length} saved`;
  if(!saved.length){
    board.innerHTML='<div class="pipeline-empty"><b>No saved offices yet.</b><span>Click + Save on any result. This board will automatically sort saved offices into Not contacted, Contacted, Follow-up, and Active so your outreach team knows what to do next.</span></div>';
    return;
  }
  const groups=[
    ['not','Not contacted','Start here','Save offices and assign an owner.'],
    ['contacted','Contacted','Working list','Called, left message, or sent info.'],
    ['followup','Follow-up','Due soon','Needs another touch or scheduled reminder.'],
    ['active','Active','Relationship','Offices already sending or engaged.'],
    ['dnc','Do not contact','Excluded','Poor fit or do-not-pursue offices kept out of outreach.']
  ];
  board.innerHTML=groups.map(([key,label,kicker,help])=>{
    const bucket=saved.filter(p=>pipelineBucket(p)===key);
    const items=bucket.slice(0,5);
    return `<div class="pipeline-col ${key}"><div class="pipeline-head"><div><small>${esc(kicker)}</small><b>${esc(label)}</b></div><span>${bucket.length}</span></div><p class="pipeline-help">${esc(help)}</p>${items.length?items.map(p=>`<button type="button" class="pipeline-card" data-open="${esc(p.id)}"><strong>${esc(p.name)}</strong><small>${esc(p.category||'Office')}${p.followUpDate?' · follow-up '+esc(p.followUpDate):''}${p.assignedTo?' · '+esc(p.assignedTo):''}</small></button>`).join(''):'<p class="pipeline-muted">No offices in this stage</p>'}${bucket.length>5?`<em>${bucket.length-5} more in saved list</em>`:''}</div>`;
  }).join('');
  board.querySelectorAll('[data-open]').forEach(btn=>btn.addEventListener('click',()=>{ const p=findPlace(btn.dataset.open); if(p) selectPlace(p,true); }));
}


function monthlyScorecardHtml(){
  const saved=getSavedPlaces(); const activity=activityStore();
  const since=new Date(); since.setDate(since.getDate()-30);
  const recent=activity.filter(a=>new Date(a.at)>=since);
  const contacted=saved.filter(p=>['Called','Left message','Sent information','Follow-up needed','Relationship active'].includes(p.status||'')).length;
  const due=saved.filter(p=>isDue(p.followUpDate)).length;
  const active=saved.filter(p=>(p.status||'')==='Relationship active').length;
  const dnc=saved.filter(p=>(p.status||'')==='Do not pursue').length;
  return `<div class="monthly-scorecard"><h3>30-day scorecard</h3><div><span>Actions</span><b>${recent.length}</b></div><div><span>Contacted</span><b>${contacted}</b></div><div><span>Due</span><b>${due}</b></div><div><span>Active</span><b>${active}</b></div><div><span>Do-not-contact</span><b>${dnc}</b></div></div>`;
}

function renderSaved(){ const saved=getSavedPlaces(); const sec=$('#savedSection'); if(!saved.length){sec.hidden=true; renderPipelineBoard(); return;} sec.hidden=false; $('#savedCountBadge').textContent=`${saved.length} saved`; $('#savedList').innerHTML=saved.map(officeCard).join(''); bindCardEvents($('#savedList')); renderPipelineBoard(); }
function renderAgent(mode='weekly'){
  const out=$('#agentOutput'), saved=getSavedPlaces(), refs=applyFilters(current.referrals).filter(p=>(savedRecord(p.id).status||'Not contacted')!=='Do not pursue'), due=saved.filter(p=>isDue(p.followUpDate));
  const top=refs.filter(p=>!isSaved(p.id)).slice(0,8); const best=current.zones.find(z=>z.score>0); const comp=current.zones.slice().sort((a,b)=>b.similar-a.similar)[0];
  if(!current.places.length && !saved.length){ out.innerHTML='<div class="agent-empty"><b>Search first.</b><span>After a market search, this will turn the map results into a practical action plan, not just a list of clinics.</span></div>'; return; }
  let html='';
  if(mode==='new') html=`<div class="agent-panel-title"><h3>New sources to review</h3><p>Prioritized offices not already saved.</p></div>${miniList(top,'No new offices after current filters. Try Comprehensive mode or a larger radius.')}`;
  else if(mode==='best10') { const best10=nextBestOffices(10); html=`<div class="agent-panel-title"><h3>Next best 10 offices</h3><p>High-fit, contactable, mapped offices that are not already saved or marked do-not-pursue.</p></div>${miniList(best10,'No no-waste matches yet. Try a different radius, enable Google Places, or relax filters.')}<div class="agent-actions"><button type="button" id="saveNextBestBtn" class="soft-btn">Save these targets</button></div>`; }
  else if(mode==='visit') { const stops=visitDayPlaces(8); html=`<div class="agent-panel-title"><h3>Visit day builder</h3><p>Builds a focused route from saved mapped offices first, then high-fit new offices nearby.</p></div>${miniList(stops,'No mapped visit stops yet. Save mapped offices or run a search with pins.')}<div class="agent-actions"><button type="button" id="openVisitRouteBtn" class="soft-btn">Open visit route</button><button type="button" id="downloadVisitSheetBtn" class="soft-btn">Download visit sheet</button></div>`; }
  else if(mode==='followups') html=`<div class="agent-panel-title"><h3>Follow-ups due</h3><p>Saved offices with due or overdue follow-up dates.</p></div>${miniList(due,'No follow-ups due. Save offices and set dates to build a recurring queue.')}`;
  else if(mode==='competition') html=`<div class="agent-panel-title"><h3>Competitor-aware moves</h3><p>Use red pins to decide where to differentiate before outreach.</p></div><div class="action-plan-grid"><div class="action-card blue-card"><span>Best area</span><b>${best?best.name:'Review mapped zones'}</b><p>${best?`${best.referrals} referral offices and ${best.similar} similar clinics.`:'Run a search with mapped data to score zones.'}</p></div><div class="action-card rose-card"><span>Crowded area</span><b>${comp&&comp.similar?comp.name:'No crowded zone yet'}</b><p>${comp&&comp.similar?`${comp.similar} similar clinics. Prepare a stronger value message before outreach.`:'Not enough similar clinic pins to identify a crowded area.'}</p></div></div>`;
  else if(mode==='saved') html=`<div class="agent-panel-title"><h3>Saved outreach summary</h3><p>Your live pipeline from saved offices.</p></div><div class="action-plan-grid saved-summary-grid"><div class="action-card blue-card"><span>Total</span><b>${saved.length}</b><p>saved offices</p></div><div class="action-card gold-card"><span>Due</span><b>${due.length}</b><p>follow-ups due</p></div><div class="action-card green-card"><span>Active</span><b>${saved.filter(p=>p.status==='Relationship active').length}</b><p>relationships</p></div><div class="action-card teal-card"><span>New</span><b>${saved.filter(p=>(p.status||'Not contacted')==='Not contacted').length}</b><p>not contacted</p></div></div>`;
  else html=weeklyPlanHtml();
  out.innerHTML=html; out.querySelectorAll('[data-open]').forEach(b=>b.addEventListener('click',()=>{ const p=findPlace(b.dataset.open); if(p) selectPlace(p,true); })); const saveBest=$('#saveNextBestBtn'); if(saveBest) saveBest.addEventListener('click', saveNextBestOffices); const routeVisit=$('#openVisitRouteBtn'); if(routeVisit) routeVisit.addEventListener('click', openVisitRoute); const dlVisit=$('#downloadVisitSheetBtn'); if(dlVisit) dlVisit.addEventListener('click', downloadVisitDaySheet);
}
function miniList(items, empty){
  if(!items.length) return `<div class="agent-empty"><b>No matches yet.</b><span>${esc(empty)}</span></div>`;
  return `<div class="smart-office-list">${items.map((p,i)=>{ const fit=fitLabel(p.score||0); const tier=officeActionTier(p); return `<button type="button" class="smart-office-row enhanced" data-open="${esc(p.id)}"><span class="rank">${i+1}</span><span class="smart-office-main"><b>${esc(p.name)}</b><small>${esc(p.category||'Office')}${p.distance<999?' · '+p.distance.toFixed(1)+' mi':''}${p.phone?' · phone':''}${p.website?' · website':''}</small><em>Why: ${esc(officeWhyText(p))}</em></span><span class="smart-fit ${fit.cls}">${esc(fit.label)}</span><span class="action-tier ${tier.cls}">${esc(tier.label)}</span></button>`; }).join('')}</div>`;
}
function renderRadar(){ const saved=getSavedPlaces(), existing=getExistingPlaces(), due=saved.filter(p=>isDue(p.followUpDate)), best=current.zones.find(z=>z.score>0), verify=current.places.filter(p=>p.approximatePin||!p.phone||!p.website).length; $('#radarOutput').innerHTML=`<div class="agent-grid radar-grid"><div class="agent-item blue-card"><b>${best?best.name:'Search first'}</b><p>Best outreach area to review</p></div><div class="agent-item gold-card"><b>${due.length}</b><p>follow-ups due</p></div><div class="agent-item teal-card"><b>${saved.length}</b><p>saved offices</p></div><div class="agent-item green-card"><b>${existing.length}</b><p>existing referral sources</p></div></div>`; }


function campaignTypeMatches(p,type){
  if(type==='all') return true;
  const b=norm(`${p.name} ${p.category}`);
  if(type==='pt') return /physical|therapy|physio|rehab/.test(b);
  if(type==='primary') return /primary|family|internal|general/.test(b);
  if(type==='urgent') return /urgent|walk in|minor emergency/.test(b);
  if(type==='imaging') return /imaging|radiology|mri|x ray|x-ray/.test(b);
  if(type==='specialist') return /specialty|neuro|rheum|sports|ortho|spine|pain|surgery/.test(b);
  return true;
}

const CAMPAIGN_RECIPES={
  custom:null,
  pcp_back_pain:{label:'PCP back-pain referral', type:'primary', goal:'Build referral access with primary care offices managing neck/back pain.', verify:['Referral coordinator','Fax/portal/referral email','Accepted payer notes'], cadence:'Call now → send access info → follow up in 7–10 days.', script:'We are updating referral access for spine and orthopedic patients. Who handles referral coordination for your office?'},
  urgent_spine:{label:'Urgent care spine pathway', type:'urgent', goal:'Create a fast-access path for acute back/neck pain, radiculopathy, and work-injury evaluations.', verify:['Best referral contact','Urgent scheduling pathway','Imaging or red-flag workflow'], cadence:'Call office manager → send pathway info → follow up in 3–5 business days.', script:'We are sharing a simple pathway for urgent spine or orthopedic evaluation when patients need specialty follow-up.'},
  pt_comanagement:{label:'PT co-management', type:'pt', goal:'Build co-management relationships with therapy offices for conservative care, post-op rehab, and second-opinion pathways.', verify:['Clinical lead or clinic director','Preferred communication method','When they refer for surgical opinion'], cadence:'Call/visit → share co-management notes → follow up after one week.', script:'We are coordinating with therapy teams so patients have a clear path when symptoms are not progressing as expected.'},
  imaging_coordination:{label:'Imaging coordination', type:'imaging', goal:'Identify imaging partners and referral-coordination friction points. This is coordination support, not a claim that imaging centers refer patients.', verify:['Scheduling access','Fax/portal details','Common payer friction'], cadence:'Verify contact → document pathway → review with referring-office campaign.', script:'We are confirming imaging coordination details so referrals and records move smoothly.'},
  pain_neuro_review:{label:'Pain / neurology review', type:'specialist', goal:'Review co-management or cross-referral opportunities with pain, neurology, PM&R, and related specialists.', verify:['Referral pathway','Care model fit','Payer/access limitations'], cadence:'Relationship review → document pathway → follow up in 10–14 days.', script:'We are reviewing co-management pathways for patients who may need spine or orthopedic evaluation after conservative care.'}
};
function activeCampaignRecipe(){ return CAMPAIGN_RECIPES[$('#campaignRecipe')?.value||'custom'] || null; }
function recipeTargets(recipe, limit=12){
  const type=recipe?.type || ($('#campaignType')?.value||'all');
  return nextBestOffices(40).filter(p=>campaignTypeMatches(p,type)).slice(0,limit);
}
function renderCampaignRecipePreview(){
  const box=$('#campaignRecipePreview'); if(!box) return;
  const recipe=activeCampaignRecipe();
  if(!recipe){ box.innerHTML='<div class="recipe-empty">Choose a recipe to turn the campaign into a focused outreach playbook, or keep Custom campaign for a simple target list.</div>'; return; }
  const targets=recipeTargets(recipe, 8);
  const targetText=targets.length?`${targets.length} preview targets from current results`:'Run a search or adjust filters to preview matching targets';
  box.innerHTML=`<div class="recipe-card"><div class="recipe-main"><span>Campaign recipe</span><b>${esc(recipe.label)}</b><p>${esc(recipe.goal)}</p></div><div class="recipe-pill-grid"><em>${esc(targetText)}</em><em>Verify: ${esc(recipe.verify.slice(0,2).join(' · '))}</em><em>${esc(recipe.cadence)}</em></div><div class="recipe-script"><b>Suggested first call</b><span>${esc(recipe.script)}</span></div></div>`;
}
function applyCampaignRecipe(){
  const recipe=activeCampaignRecipe();
  if(!recipe){ renderCampaignRecipePreview(); return; }
  const type=$('#campaignType'); if(type) type.value=recipe.type;
  const name=$('#campaignName'); if(name && !name.value.trim()) name.value=recipe.label;
  renderCampaignRecipePreview();
}
function createCampaign(){
  const recipe=activeCampaignRecipe();
  const name=($('#campaignName')?.value||'').trim() || (recipe?.label || `${$('#growthGoalSelect')?.selectedOptions?.[0]?.textContent||'Growth'} campaign`);
  const type=recipe?.type || ($('#campaignType')?.value||'all'); const owner=($('#campaignOwner')?.value||'').trim(); const due=$('#campaignDue')?.value||'';
  const targets=nextBestOffices(40).filter(p=>campaignTypeMatches(p,type)).slice(0,20);
  if(!targets.length){ alert('No matching high-fit targets found yet. Run a search or adjust filters first.'); return; }
  targets.forEach(p=>{ if(!isSaved(p.id)) updateSavedRecord(p.id, {...placeToSaved(p), status:'Not contacted', campaign:name}); else updateSavedRecord(p.id,{campaign:name}); });
  const arr=campaignStore().filter(c=>c.name!==name);
  arr.unshift({id:`camp:${hashStr(name+'|'+Date.now())}`, name, type, recipeKey:$('#campaignRecipe')?.value||'custom', recipeLabel:recipe?.label||'', recipeGoal:recipe?.goal||'', recipeVerify:recipe?.verify||[], recipeCadence:recipe?.cadence||'', recipeScript:recipe?.script||'', owner, due, targetIds:targets.map(p=>p.id), createdAt:new Date().toISOString(), market:$('#locationInput')?.value||'', goal:selectedGoal()});
  saveCampaignStore(arr); logActivity('Created outreach campaign', {name}, `${targets.length} targets · ${owner||'unassigned'}`);
  renderCampaignBoard(); renderSaved(); renderPipelineBoard(); renderManagerDashboard(); renderAgent('saved'); renderCampaignRecipePreview();
}
function campaignProgress(c){
  const ids=new Set(c.targetIds||[]); const records=getSavedPlaces().filter(p=>ids.has(p.id) || p.campaign===c.name);
  const contacted=records.filter(p=>['Called','Left message','Sent information','Follow-up needed','Relationship active'].includes(p.status||'')).length;
  const active=records.filter(p=>(p.status||'')==='Relationship active').length;
  const due=records.filter(p=>isDue(p.followUpDate)).length;
  return {total:records.length || (c.targetIds||[]).length, contacted, active, due};
}
function renderCampaignBoard(){
  const board=$('#campaignBoard'); if(!board) return; const arr=campaignStore(); const badge=$('#campaignBadge'); if(badge) badge.textContent=`${arr.length} campaign${arr.length===1?'':'s'}`;
  if(!arr.length){ board.innerHTML='<div class="campaign-empty"><b>No campaigns yet.</b><span>Create a focused outreach push from the next best targets. Campaigns stay compact and use your existing saved-office pipeline.</span></div>'; return; }
  board.innerHTML=arr.slice(0,6).map(c=>{ const p=campaignProgress(c); const pct=p.total?Math.round((p.contacted/p.total)*100):0; const recipe=c.recipeLabel?`<div class="campaign-recipe-line"><b>${esc(c.recipeLabel)}</b><span>${esc(c.recipeCadence||'Focused outreach cadence')}</span></div>`:''; return `<div class="campaign-card enhanced-campaign"><div><b>${esc(c.name)}</b><span>${esc(c.market||'Market')} · ${esc(c.owner||'Unassigned')}${c.due?' · due '+esc(c.due):''}</span>${recipe}</div><div class="campaign-stats"><span>${p.total} targets</span><span>${p.contacted} contacted</span><span>${p.due} due</span><span>${p.active} active</span></div><div class="campaign-bar"><i style="width:${pct}%"></i></div><button type="button" class="tiny-btn action-manage" data-open-campaign="${esc(c.id)}">Open targets</button><button type="button" class="tiny-btn action-calendar" data-remove-campaign="${esc(c.id)}">Remove</button></div>`; }).join('');
  board.querySelectorAll('[data-open-campaign]').forEach(b=>b.addEventListener('click',()=>{ const c=campaignStore().find(x=>x.id===b.dataset.openCampaign); if(!c) return; filters.mode='saved'; renderLists(); renderSaved(); alert(`${c.name}: open Saved outreach list to work these targets. Use the pipeline to update status.`); }));
  board.querySelectorAll('[data-remove-campaign]').forEach(b=>b.addEventListener('click',()=>{ const arr=campaignStore().filter(c=>c.id!==b.dataset.removeCampaign); saveCampaignStore(arr); renderCampaignBoard(); renderManagerDashboard(); }));
}

function renderExistingNetwork(){
  const list=$('#existingNetworkList'), status=$('#existingUploadStatus'); if(!list) return;
  const existing=getExistingPlaces();
  if(status) status.textContent = existing.length ? `${existing.length} existing referral sources saved. ${existing.filter(p=>p.lat&&p.lon).length} can be shown as green pins.` : 'No existing referral-source CSV uploaded yet.';
  if(!existing.length){ list.innerHTML=''; return; }
  list.innerHTML = existing.slice(0,12).map(p=>`<div class="network-row" data-existing="${esc(p.id)}"><div><b>${esc(p.name)}</b><br><small>${esc(p.category||'Existing source')} ${p.distance<999?'· '+p.distance.toFixed(1)+' mi':''}</small></div><small>${esc(p.status||'Existing')}</small><div class="network-row-actions"><button class="tiny-btn action-manage" data-open-existing="${esc(p.id)}" type="button">Open</button><button class="tiny-btn action-calendar" data-delete-existing="${esc(p.id)}" type="button">Remove</button></div></div>`).join('') + (existing.length>12?`<div class="helper-text">${existing.length-12} more existing sources saved.</div>`:'');
  list.querySelectorAll('[data-open-existing]').forEach(b=>b.addEventListener('click',()=>{ const p=findPlace(b.dataset.openExisting); if(p) selectPlace(p,true); }));
  list.querySelectorAll('[data-delete-existing]').forEach(b=>b.addEventListener('click',()=>{ const s=existingStore(); const p=s[b.dataset.deleteExisting]; if(!p) return; if(confirm(`Remove ${p.name} from existing referral network?`)){ delete s[b.dataset.deleteExisting]; saveExistingStore(s); logActivity('Removed existing referral source', p); renderExistingNetwork(); renderNetworkCoverage(); renderMap(); renderSummary(); } }));
}

function clearManualExistingForm(){
  ['manualExistingName','manualExistingType','manualExistingAddress','manualExistingPhone','manualExistingWebsite','manualExistingContact','manualExistingFax','manualExistingNotes'].forEach(id=>{ const el=$('#'+id); if(el) el.value=''; });
  const status=$('#manualExistingStatus'); if(status) status.value='Relationship active';
}
async function saveManualExistingReferral(){
  const name=($('#manualExistingName')?.value||'').trim();
  const category=($('#manualExistingType')?.value||'Existing referral source').trim() || 'Existing referral source';
  const address=($('#manualExistingAddress')?.value||'').trim();
  if(!name){ alert('Enter the office name first.'); return; }
  const phone=($('#manualExistingPhone')?.value||'').trim();
  const website=($('#manualExistingWebsite')?.value||'').trim();
  const contact=($('#manualExistingContact')?.value||'').trim();
  const faxPortal=($('#manualExistingFax')?.value||'').trim();
  const notes=($('#manualExistingNotes')?.value||'').trim();
  const status=($('#manualExistingStatus')?.value||'Relationship active').trim();
  const id='existing:'+hashStr(`${name}|${address}|${phone}|manual`);
  const p={id,name,category,address,phone,website,lat:null,lon:null,distance:999,source:'Manual existing referral source',kind:'existing',approximatePin:false,status,notes,coordinator:contact,faxPortal,payerNotes:'',followUpDate:'',createdAt:new Date().toISOString()};
  if(address){
    try{
      const u=new URL('/api/geocode', window.location.origin); u.searchParams.set('q', `${name} ${address}`);
      const j=await fetchJSON(u.toString(), {}, 9000);
      const lat=Number(j.lat), lon=Number(j.lon);
      if(Number.isFinite(lat)&&Number.isFinite(lon)){ p.lat=lat; p.lon=lon; if(current.center) p.distance=distanceMiles(current.center.lat,current.center.lon,lat,lon); else { current.center={lat,lon}; current.city=''; current.state=''; updateMapBase(current.center); p.distance=0; } }
    }catch(e){ console.warn('Manual existing geocode failed', e); }
  }
  p.verification=verification(p); p.score=fitScore({...p,kind:'referral'});
  updateExistingRecord(id,p);
  logActivity('Added existing referral source', p, p.lat&&p.lon?'Mapped as green pin':'Saved; address needs mapping');
  clearManualExistingForm();
  renderExistingNetwork(); renderNetworkCoverage(); renderMap(); renderSummary();  renderPipelineBoard(); renderManagerDashboard();
  if(p.lat&&p.lon) selectPlace(p,true);
  else alert('Saved existing referral source. It will appear as a green pin after a valid address is mapped.');
}

async function handleExistingCSV(e){
  const file=e.target.files && e.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=async()=>{
    const rows=parseCSV(String(reader.result||'')); const out={...existingStore()};
    for(const r of rows){
      const name=getText(r,['office name','office','source','referral source','provider','clinic','name','organization']); if(!name) continue;
      const type=getText(r,['type','specialty','category','taxonomy']) || 'Existing referral source';
      const addressParts=[getText(r,['address','address 1','street']),getText(r,['city']),getText(r,['state']),getText(r,['zip','postal','postal code'])].filter(Boolean);
      const address=addressParts.join(' ');
      const phone=getText(r,['phone','telephone','tel']); const website=getText(r,['website','url']); const notes=getText(r,['notes','note']); const contact=getText(r,['contact','contact person','referral coordinator']); const status=getText(r,['status','current status']) || 'Relationship active';
      const id='existing:'+hashStr(`${name}|${address}|${phone}`);
      let lat=Number(getText(r,['lat','latitude'])); let lon=Number(getText(r,['lon','lng','longitude']));
      const p={id,name,category:type,address,phone,website,lat:Number.isFinite(lat)?lat:null,lon:Number.isFinite(lon)?lon:null,distance:999,source:'Uploaded existing referral network',kind:'existing',approximatePin:false,status,notes:notes || (contact?`Contact: ${contact}`:''),followUpDate:getText(r,['follow up','follow-up','follow_up_date','followup date'])};
      p.verification=verification(p); p.score=fitScore({...p,kind:'referral'}); out[id]=p;
    }
    saveExistingStore(out); renderExistingNetwork(); renderNetworkCoverage();
    const center=current.center; if(center){ await geocodeExistingTop(center, selectedRadius()); renderMap(); renderSummary();  }
  };
  reader.readAsText(file);
}
async function geocodeExistingTop(center, radius){
  const s=existingStore(); const arr=Object.values(s).filter(p=>!p.lat && p.address).slice(0,35);
  for(const p of arr){
    try{ const u=new URL('/api/geocode', window.location.origin); u.searchParams.set('q', `${p.name} ${p.address}`); const j=await fetchJSON(u.toString(), {}, 8000); const lat=Number(j.lat), lon=Number(j.lon), d=distanceMiles(center.lat,center.lon,lat,lon); if(Number.isFinite(lat)&&Number.isFinite(lon)&&d<=radius+1){ p.lat=lat; p.lon=lon; p.distance=d; p.approximatePin=false; } }
    catch(e){}
  }
  for(const p of Object.values(s)){ if(p.lat&&p.lon&&center) p.distance=distanceMiles(center.lat,center.lon,p.lat,p.lon); p.verification=verification(p); }
  saveExistingStore(s);
}
function exportExistingNetwork(){ const existing=getExistingPlaces(); if(!existing.length){ alert('No existing referral network uploaded yet.'); return; } const header=['name','type','address','phone','website','status','follow_up_date','referral_coordinator','fax_or_portal','insurance_payer_notes','notes','mapped']; const rows=[header].concat(existing.map(p=>[p.name,p.category,p.address||'',p.phone||'',p.website||'',p.status||'',p.followUpDate||'',p.notes||'',p.lat&&p.lon?'yes':'no'].map(v=>`"${String(v).replace(/"/g,'""')}"`))); download('clinicmapiq_existing_referral_network.csv', rows.map(r=>r.join(',')).join('\n'), 'text/csv'); }

function exportCSV(){ const existing=getExistingPlaces(); const rows=[...current.places, ...existing.filter(x=>!current.places.some(p=>p.id===x.id)), ...getSavedPlaces().filter(s=>!current.places.some(p=>p.id===s.id) && !existing.some(e=>e.id===s.id))]; const header=['name','role','type','address','phone','website','distance','source','listing_strength','pinned_on_map','approximate_pin','status','follow_up_date','referral_coordinator','fax_or_portal','insurance_payer_notes','outreach_stage','contact_confidence','barriers','notes']; const data=[header].concat(rows.map(p=>{ const rec=savedRecord(p.id); return [p.name,p.kind==='existing'?'existing referral source':p.kind==='similar'?'similar/competitor':'referral',p.category,p.address||'',p.phone||'',p.website||'',p.distance<999?p.distance.toFixed(2):'',p.source,p.verification?.level||'',p.lat&&p.lon?'yes':'no',p.approximatePin?'yes':'no',rec.status||'',rec.followUpDate||'',rec.coordinator||'',rec.faxPortal||'',rec.payerNotes||'',outreachStage(p).label,contactConfidence(p).label,(rec.barriers||[]).join('; '),rec.notes||''].map(v=>`"${String(v).replace(/"/g,'""')}"`); })); download('clinicmapiq_contacts.csv', data.map(r=>r.join(',')).join('\n'), 'text/csv'); logActivity('Exported contacts CSV', {name:'Export'}, `${rows.length} rows`); }
function downloadReport(){ const saved=getSavedPlaces(); const lines=[`ClinicMap IQ Report`, `Date: ${new Date().toLocaleString()}`, `Market: ${$('#locationInput').value}`, `Specialty: ${$('#specialtySelect').selectedOptions[0].textContent}`, `Radius: ${selectedRadius()} miles`, `Goal: ${$('#growthGoalSelect').selectedOptions[0].textContent}`, ``, `Counts`, `Possible referral offices: ${current.referrals.length}`, `Similar clinics: ${current.similar.length}`, `Pinned on map: ${current.places.filter(p=>p.lat&&p.lon).length}`, `Saved offices: ${saved.length}`, `Existing referral sources: ${getExistingPlaces().length}`, `Campaigns: ${campaignStore().length}`, `Expansion score: ${expansionScore().score}/100 — ${expansionScore().label}`,  ``, `Best area: ${$('#bestAreaTitle').textContent}`, ``, `Saved outreach list`, ...saved.map(p=>`- ${p.name} | ${p.category} | ${p.phone||'no phone'} | ${p.status||'Not contacted'} | follow-up ${p.followUpDate||'none'} | coordinator ${p.coordinator||'none'} | fax/portal ${p.faxPortal||'none'} | payer ${p.payerNotes||'none'} | outreach stage ${outreachStage(p).label} | barriers ${(p.barriers||[]).join('; ')||'none'} | ${p.notes||''}`), ``, `Public data limitations`, `This app uses public map data, NPI Registry, and optional Google Places. It does not invent clinics, demand, revenue, or referral relationships. Verify public listings before outreach.`]; download('clinicmapiq_report.txt', lines.join('\n'), 'text/plain'); logActivity('Downloaded text report', {name:'Report'}, `${saved.length} saved offices included`); }
function download(name, text, type){ const blob=new Blob([text],{type}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000); }
function route(){ const pts=[...getSavedPlaces(), ...getExistingPlaces()].filter(p=>p.lat&&p.lon).slice(0,10); const use=pts.length?pts:current.referrals.filter(p=>p.lat&&p.lon).slice(0,5); if(!use.length) return; const url='https://www.google.com/maps/dir/'+use.map(p=>`${p.lat},${p.lon}`).join('/'); window.open(url,'_blank','noopener'); logActivity('Opened outreach route', {name:'Route'}, `${use.length} mapped stops`); }


/* ---------- Enterprise workspace additions: local login, reminders, CSV analytics, PDF ---------- */
function accountStore(){ return storage('cmiq_account_v7', {}); }
function saveAccountStore(p){ saveStorage('cmiq_account_v7', p || {}); }
function weeklyStore(){ return storage('cmiq_weekly_report_v7', {}); }
function saveWeeklyStore(p){ saveStorage('cmiq_weekly_report_v7', p || {}); }
function analyticsStore(){ return storage('cmiq_referral_analytics_v7', {rows:[], updatedAt:null}); }
function saveAnalyticsStore(p){ saveStorage('cmiq_referral_analytics_v7', p || {rows:[], updatedAt:null}); }

let cloud={ready:false,user:null,app:null,auth:null,db:null,config:null};
async function initCloud(){
  const badge=$('#cloudSyncBadge'), status=$('#cloudAuthStatus');
  try{
    if(!window.firebase){ if(status) status.textContent='Cloud login library not loaded. Local workspace is available.'; return; }
    const cfg=await fetchJSON('/api/firebase-config', {}, 5000);
    if(!cfg || !cfg.apiKey || !cfg.projectId){ if(status) status.textContent='Cloud login not configured. Add Firebase env vars in Vercel to enable team sync.'; if(badge) badge.textContent='Local'; return; }
    cloud.config=cfg;
    cloud.app=window.firebase.apps?.length?window.firebase.app():window.firebase.initializeApp(cfg);
    cloud.auth=window.firebase.auth();
    cloud.db=window.firebase.firestore();
    cloud.ready=true;
    cloud.auth.onAuthStateChanged(user=>{
      cloud.user=user||null;
      renderCloudStatus();
      if(user) {
        const a=accountStore();
        if(!a.email) saveAccountStore({name:user.displayName||'',email:user.email||'',updatedAt:new Date().toISOString()});
        renderAccount();
      }
    });
    try{
      const redirectResult=await cloud.auth.getRedirectResult();
      if(redirectResult && redirectResult.user){
        cloud.user=redirectResult.user;
        renderCloudStatus('Signed in with Google. Cloud workspace is ready to sync.');
        const m=$('#loginModal'); if(m) m.hidden=true;
      }
    }catch(err){
      console.warn('Redirect sign-in check failed', err);
    }
    if(status) status.textContent='Cloud login is ready. Sign in with Google to sync this workspace.';
  }catch(e){ if(status) status.textContent='Cloud login unavailable. Local workspace still works.'; if(badge) badge.textContent='Local'; }
}
function workspacePayload(){ return {version:'ClinicMapIQ cloud workspace v1', updatedAt:new Date().toISOString(), account:accountStore(), saved:savedStore(), existing:existingStore(), team:teamStore(), activity:activityStore(), weekly:weeklyStore(), analytics:analyticsStore(), campaigns:campaignStore()}; }
async function signInGoogle(){
  if(!cloud.ready){ alert('Cloud login is not configured yet. Add Firebase environment variables in Vercel.'); return; }
  const provider=new window.firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({prompt:'select_account'});
  const btn=$('#googleSignInBtn');
  const original=btn?btn.textContent:'';
  try{
    if(btn){ btn.disabled=true; btn.textContent='Opening Google sign-in…'; }
    await cloud.auth.signInWithPopup(provider);
    await cloudSaveWorkspace();
    const m=$('#loginModal'); if(m) m.hidden=true;
  }catch(err){
    console.warn('Google sign-in error', err);
    const popupIssues=['auth/popup-blocked','auth/popup-closed-by-user','auth/cancelled-popup-request','auth/operation-not-supported-in-this-environment'];
    if(popupIssues.includes(err.code)){
      renderCloudStatus('Popup could not stay open in this browser. Redirecting to Google sign-in instead…');
      await cloud.auth.signInWithRedirect(provider);
      return;
    }
    if(err.code==='auth/unauthorized-domain'){
      const msg='This site domain is not in Firebase Authorized domains. Add your Vercel domain in Firebase Authentication → Settings → Authorized domains.';
      renderCloudStatus(msg); alert(msg); return;
    }
    const msg = err?.message || 'Google sign-in could not start.';
    renderCloudStatus(msg); alert(msg);
  }finally{
    if(btn){ btn.disabled=false; btn.textContent=original || 'Sign in with Google'; }
  }
}
async function signOutCloud(){ if(cloud.auth) await cloud.auth.signOut(); renderCloudStatus(); }
async function cloudSaveWorkspace(){ if(!cloud.ready || !cloud.user){ alert('Sign in first to sync to cloud.'); return; } await cloud.db.collection('clinicMapWorkspaces').doc(cloud.user.uid).set(workspacePayload(), {merge:true}); logActivity('Synced workspace to cloud', {name:'Cloud workspace'}); renderCloudStatus('Cloud sync complete.'); }
async function cloudLoadWorkspace(){ if(!cloud.ready || !cloud.user){ alert('Sign in first to load cloud workspace.'); return; } const doc=await cloud.db.collection('clinicMapWorkspaces').doc(cloud.user.uid).get(); if(!doc.exists){ alert('No cloud workspace found yet.'); return; } const j=doc.data()||{}; if(j.saved) saveStorage('cmiq_saved_records_v7', j.saved); if(j.existing) saveExistingStore(j.existing); if(j.team) saveTeamStore(j.team); if(j.activity) saveActivityStore(j.activity); if(j.account) saveAccountStore(j.account); if(j.weekly) saveWeeklyStore(j.weekly); if(j.analytics) saveAnalyticsStore(j.analytics); if(j.campaigns) saveCampaignStore(j.campaigns); logActivity('Loaded workspace from cloud', {name:'Cloud workspace'}); renderAll(); renderAccount(); renderWeeklyStatus(); renderEnterpriseAnalytics(); renderCampaignBoard(); renderCloudStatus('Cloud workspace loaded.'); const m=$('#loginModal'); if(m) m.hidden=true; }
function renderCloudStatus(msg){
  const badge=$('#cloudSyncBadge'), status=$('#cloudAuthStatus');
  if(badge) { badge.textContent=cloud.user?'Cloud synced':(cloud.ready?'Cloud ready':'Local'); badge.className='small-badge '+(cloud.user?'success':cloud.ready?'blue-badge':'neutral'); }
  if(status){ status.innerHTML = msg || (cloud.user?`Signed in as <b>${esc(cloud.user.email||cloud.user.displayName||'cloud user')}</b>. Use Sync cloud / Load cloud from Team workspace.`: cloud.ready?'Cloud login ready. Sign in with Google to sync across devices.':'Cloud login not configured. Local save/export still works.'); }
}

function renderAccount(){
  const a=accountStore();
  const display=$('#accountDisplay'); if(!display) return;
  if(a.name || a.email){
    display.innerHTML=`<div class="account-saved"><b>${esc(a.name||'Local user')}</b><span>${esc(a.email||'No email saved')}</span><button type="button" id="clearAccountBtn" class="tiny-btn">Clear</button></div>`;
    $('#accountQuickBtn').textContent=cloud.user?`Cloud: ${cloud.user.email||cloud.user.displayName}`:(a.name?`Local: ${a.name}`:'Local account saved');
    const clear=$('#clearAccountBtn'); if(clear) clear.addEventListener('click',()=>{saveAccountStore({}); $('#accountName').value=''; $('#accountEmail').value=''; renderAccount();});
  } else {
    display.innerHTML=`<div class="account-saved muted-box">No local account saved. Reports and reminders can still be downloaded.</div>`;
    $('#accountQuickBtn').textContent=cloud.user?'Cloud workspace':'Sign in / Sync';
  }
}

function saveAccount(){
  const name=$('#accountName')?.value.trim() || '';
  const email=$('#accountEmail')?.value.trim() || '';
  saveAccountStore({name,email,updatedAt:new Date().toISOString()});
  renderAccount();
}

function dueSavedOffices(){ return getSavedPlaces().filter(p=>isDue(p.followUpDate)); }
function reminderSummary(){
  const saved=getSavedPlaces(); const due=dueSavedOffices();
  const lines=[`ClinicMap IQ Follow-up Summary`, `Generated: ${new Date().toLocaleString()}`, `Saved offices: ${saved.length}`, `Existing referral sources: ${getExistingPlaces().length}`,  `Follow-ups due/overdue: ${due.length}`, ``];
  const list=(due.length?due:saved.slice(0,12));
  if(!list.length) lines.push('No saved offices yet. Save offices from a search first.');
  list.forEach(p=>lines.push(`- ${p.name} | ${p.category||''} | ${p.phone||'no phone'} | ${p.status||'Not contacted'} | follow-up ${p.followUpDate||'not set'} | ${p.notes||''}`));
  return lines.join('\n');
}
async function emailReminder(){
  const a=accountStore(); const subject='ClinicMap IQ follow-up reminders'; const body=reminderSummary();
  if(!a.email){ alert('Add an email in Login / Sync first.'); return; }
  try{
    const res=await fetch('/api/send-email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:a.email,subject,text:body})});
    if(res.ok){ logActivity('Sent follow-up email', {name:'Reminder center'}, `To ${a.email}`); alert('Email reminder sent.'); return; }
  }catch(e){}
  window.location.href=`mailto:${encodeURIComponent(a.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`; logActivity('Prepared follow-up email', {name:'Reminder center'}, `Mail client opened for ${a.email}`);
}
function calendarReminders(){
  const offices=getSavedPlaces().filter(p=>p.followUpDate);
  if(!offices.length){ alert('No saved offices have follow-up dates yet.'); return; }
  const dtstamp=new Date().toISOString().replace(/[-:]/g,'').split('.')[0]+'Z';
  const events=offices.map((p,i)=>{
    const d=p.followUpDate.replace(/-/g,'');
    const desc=[p.category,p.phone,p.address,p.notes].filter(Boolean).join(' | ').replace(/[\n\r,;]/g,' ');
    return ['BEGIN:VEVENT',`UID:cmiq-${p.id}-${i}@clinicmapiq`,`DTSTAMP:${dtstamp}`,`DTSTART;VALUE=DATE:${d}`,`SUMMARY:Follow up with ${icsEsc(p.name)}`,`DESCRIPTION:${icsEsc(desc || 'ClinicMap IQ follow-up')}`,'END:VEVENT'].join('\n');
  }).join('\n');
  download('clinicmapiq_followups.ics', `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//ClinicMap IQ//Followups//EN\n${events}\nEND:VCALENDAR`, 'text/calendar'); logActivity('Downloaded calendar reminders', {name:'Reminder center'}, `${offices.length} follow-up events`);
}
function icsEsc(s){ return String(s||'').replace(/\\/g,'\\\\').replace(/,/g,'\\,').replace(/;/g,'\\;').replace(/\n/g,'\\n'); }
function saveWeekly(){
  const day=$('#weeklyDay')?.value || '1'; const time=$('#weeklyTime')?.value || '08:00'; const a=accountStore();
  saveWeeklyStore({day,time,email:a.email||'',updatedAt:new Date().toISOString()}); renderWeeklyStatus();
}
function renderWeeklyStatus(){
  const el=$('#weeklyStatus'); if(!el) return; const w=weeklyStore();
  if(!w.day){ el.textContent='No weekly report schedule saved yet.'; return; }
  const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  el.innerHTML=`Weekly local report reminder set for <b>${days[Number(w.day)]}</b> at <b>${esc(w.time||'08:00')}</b>. Use “Email my follow-up list” or “Full PDF report” to send/share it. Automated sending requires a connected email service later.`;
}

function parseCSV(text){
  const rows=[]; let row=[], cell='', q=false;
  for(let i=0;i<text.length;i++){ const c=text[i], n=text[i+1];
    if(c==='"' && q && n==='"'){ cell+='"'; i++; }
    else if(c==='"'){ q=!q; }
    else if(c===',' && !q){ row.push(cell); cell=''; }
    else if((c==='\n'||c==='\r') && !q){ if(c==='\r'&&n==='\n') i++; row.push(cell); if(row.some(x=>String(x).trim())) rows.push(row); row=[]; cell=''; }
    else cell+=c;
  }
  row.push(cell); if(row.some(x=>String(x).trim())) rows.push(row);
  if(!rows.length) return [];
  const headers=rows.shift().map(h=>norm(h));
  return rows.map(r=>{ const o={}; headers.forEach((h,i)=>o[h]=r[i]||''); return o; });
}
function handleReferralCSV(e){
  const file=e.target.files && e.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=()=>{ const rows=parseCSV(String(reader.result||'')); saveAnalyticsStore({rows, updatedAt:new Date().toISOString(), fileName:file.name}); renderEnterpriseAnalytics(); };
  reader.readAsText(file);
}
function getNum(row, keys){ for(const k of keys){ const nk=norm(k); if(row[nk]!=null && row[nk]!=='' && !isNaN(Number(String(row[nk]).replace(/[$,]/g,'')))) return Number(String(row[nk]).replace(/[$,]/g,'')); } return 0; }
function getText(row, keys){ for(const k of keys){ const nk=norm(k); if(row[nk]) return String(row[nk]); } return ''; }
function renderEnterpriseAnalytics(){
  const data=analyticsStore(); const rows=data.rows||[]; const box=$('#enterpriseAnalytics'); const status=$('#csvUploadStatus'); if(!box) return;
  if(status) status.textContent=rows.length?`Loaded ${rows.length} referral-source rows${data.fileName?' from '+data.fileName:''}.`:'No clinic CSV uploaded yet. Default projection is shown until you upload actual data.';
  const avg=Number($('#avgValueInput')?.value||0); const defaultCost=Number($('#outreachCostInput')?.value||0); const projected=Number($('#projectedConvertedInput')?.value||0);
  if(!rows.length){
    const projectedRevenue=projected*avg; const roi=defaultCost?Math.round(((projectedRevenue-defaultCost)/defaultCost)*100):0; const breakeven=avg?Math.ceil(defaultCost/avg):0;
    box.innerHTML=`<div class="analytics-hero"><div><span class="kicker">Planning projection</span><b>${roi}%</b><p>Projected ROI from defaults</p></div><div><span class="kicker">Estimated monthly value</span><b>$${Math.round(projectedRevenue).toLocaleString()}</b><p>${projected} converted referrals × $${avg.toLocaleString()}</p></div></div><div class="agent-grid analytics-kpis"><div class="agent-item blue-card"><b>${projected}</b><p>projected converted referrals/month</p></div><div class="agent-item green-card"><b>$${Math.round(avg).toLocaleString()}</b><p>value per converted referral</p></div><div class="agent-item gold-card"><b>$${Math.round(defaultCost).toLocaleString()}</b><p>monthly outreach cost</p></div><div class="agent-item teal-card"><b>${breakeven}</b><p>break-even conversions</p></div></div><div class="analytics-bars">${miniBar('Projected revenue', Math.round(projectedRevenue), Math.max(projectedRevenue, defaultCost, 1), 'green')}${miniBar('Outreach cost', Math.round(defaultCost), Math.max(projectedRevenue, defaultCost, 1), 'gold')}</div><p class="helper-text">Projection only. Upload referral-source data for actual leakage, conversion, and value estimates.</p>`;
    return;
  }
  let referrals=0, converted=0, revenue=0, cost=0;
  const sources=[];
  rows.forEach(r=>{ const src=getText(r,['source','referral source','provider','office','name','clinic']) || 'Unknown source'; const ref=getNum(r,['referrals','referred','leads','patients','new patients']); const conv=getNum(r,['converted','scheduled','visits','consults','surgeries','procedures']); const rev=getNum(r,['revenue','value','collections']); const c=getNum(r,['cost','marketing cost','outreach cost']); referrals+=ref; converted+=conv; revenue+=rev; cost+=c; sources.push({src,ref,conv,rev,c}); });
  const estRevenue=revenue || (converted*avg); const totalCost=cost || defaultCost; const leakage=Math.max(0, referrals-converted); const convRate=referrals?Math.round((converted/referrals)*100):0; const roi=totalCost?Math.round(((estRevenue-totalCost)/totalCost)*100):0;
  const topLost=sources.filter(x=>x.ref).sort((a,b)=>(b.ref-b.conv)-(a.ref-a.conv)).slice(0,4);
  box.innerHTML=`<div class="analytics-hero"><div><span class="kicker">Conversion rate</span><b>${convRate}%</b><p>${converted} converted from ${referrals} referred/leads</p></div><div><span class="kicker">Estimated value</span><b>$${Math.round(estRevenue).toLocaleString()}</b><p>${leakage} possible leakage records</p></div></div><div class="agent-grid analytics-kpis"><div class="agent-item blue-card"><b>${referrals}</b><p>referred / lead records</p></div><div class="agent-item green-card"><b>${converted}</b><p>converted / scheduled</p></div><div class="agent-item rose-card"><b>${leakage}</b><p>possible leakage</p></div><div class="agent-item teal-card"><b>${roi}%</b><p>estimated ROI</p></div></div><div class="analytics-bars">${miniBar('Converted', converted, Math.max(referrals,1), 'green')}${miniBar('Possible leakage', leakage, Math.max(referrals,1), 'red')}</div><div class="leakage-list"><h3>Sources to review</h3>${topLost.length?topLost.map(x=>`<div class="leakage-row"><b>${esc(x.src)}</b><span>${x.ref} referred · ${x.conv} converted · ${Math.max(0,x.ref-x.conv)} leakage</span></div>`).join(''):'<p class="helper-text">No referral-source rows with volume yet.</p>'}</div>`;
}

function enterpriseLines(){
  const data=analyticsStore(); const rows=data.rows||[]; if(!rows.length) return ['No referral-source CSV uploaded.'];
  let referrals=0, converted=0; rows.forEach(r=>{referrals+=getNum(r,['referrals','referred','leads','patients','new patients']); converted+=getNum(r,['converted','scheduled','visits','consults','surgeries','procedures']);});
  return [`Referral-source CSV rows: ${rows.length}`,`Total referred/leads: ${referrals}`,`Total converted/scheduled: ${converted}`,`Possible leakage: ${Math.max(0,referrals-converted)}`];
}

function downloadPDFReport(){
  const jsPDF = window.jspdf && window.jspdf.jsPDF;
  if(!jsPDF){ alert('PDF library did not load. Use Download report instead or check internet access.'); return; }
  const doc=new jsPDF({unit:'pt', format:'letter'}); let y=48; const left=48; const line=(txt, size=10, bold=false)=>{ doc.setFont('helvetica', bold?'bold':'normal'); doc.setFontSize(size); const parts=doc.splitTextToSize(String(txt), 510); parts.forEach(p=>{ if(y>740){doc.addPage(); y=48;} doc.text(p,left,y); y+=size+6; }); };
  const saved=getSavedPlaces(); const a=accountStore();
  line('ClinicMap IQ Growth Report',18,true); line(`Prepared for: ${a.name||'Local workspace'} ${a.email?'('+a.email+')':''}`,10); line(`Generated: ${new Date().toLocaleString()}`,10); y+=8;
  line(`Market: ${$('#locationInput').value}`,11,true); line(`Specialty: ${$('#specialtySelect').selectedOptions[0].textContent} | Radius: ${selectedRadius()} miles | Goal: ${$('#growthGoalSelect').selectedOptions[0].textContent}`,10); y+=8;
  line('Search summary',13,true); line(`Possible referral offices: ${current.referrals.length} | Similar clinics: ${current.similar.length} | Pinned on map: ${current.places.filter(p=>p.lat&&p.lon).length} | Saved offices: ${saved.length}`,10); line(`Best area to review: ${$('#bestAreaTitle').textContent}`,10); y+=8;
  line('Saved outreach list',13,true); if(saved.length) saved.slice(0,30).forEach(p=>line(`• ${p.name} — ${p.category||''} — ${p.phone||'no phone'} — ${p.status||'Not contacted'} — follow-up ${p.followUpDate||'not set'} — ${p.notes||''}`,9)); else line('No saved offices yet.',9); y+=6; line('Existing referral network',13,true); const existing=getExistingPlaces(); if(existing.length) existing.slice(0,30).forEach(p=>line(`• ${p.name} — ${p.category||''} — ${p.phone||'no phone'} — ${p.status||'Existing'} — ${p.notes||''}`,9)); else line('No existing referral network uploaded.',9);
  y+=8; line('Referral analytics',13,true); enterpriseLines().forEach(x=>line(x,9));
  y+=8; line('Data limitations',13,true); line('ClinicMap IQ uses public map data, NPI Registry records, and optional Google Places. It does not invent clinics, patient demand, referral volume, revenue, or referral relationships. Verify public listings before outreach.',9);
  doc.save('clinicmapiq_growth_report.pdf');
}


function pct(n,d){ return d ? Math.max(0, Math.min(100, Math.round((n/d)*100))) : 0; }
function miniBar(label, value, total, cls='blue'){
  const w=pct(value,total);
  return `<div class="mini-bar-row"><div class="mini-bar-head"><span>${esc(label)}</span><b>${value}</b></div><div class="mini-bar-track"><i class="${cls}" style="width:${w}%"></i></div></div>`;
}
function renderMarketFigures(){
  const existing=getExistingPlaces();
  const total=current.places.length + existing.length;
  const referral=current.referrals.length;
  const similar=current.similar.length;
  const contact=current.places.filter(p=>p.phone||p.website).length + existing.filter(p=>p.phone||p.website).length;
  const pinned=current.places.filter(p=>p.lat&&p.lon).length + existing.filter(p=>p.lat&&p.lon).length;
  const saved=getSavedPlaces().length;
  const due=getSavedPlaces().filter(p=>isDue(p.followUpDate)).length;
  const mix=$('#officeMixFigure'), funnel=$('#funnelFigure'), quality=$('#qualityFigure'), badge=$('#dataQualityBadge');
  if(!mix||!funnel||!quality) return;
  if(!total){
    mix.className='figure-body muted-figure'; funnel.className='figure-body muted-figure'; quality.className='figure-body muted-figure';
    mix.textContent='Run a search to see referral offices, competitors, and existing sources.';
    funnel.textContent='Save offices to build your active outreach pipeline.';
    quality.textContent='Shows how many records have contact details and map pins.';
    if(badge) badge.textContent='Search first';
    return;
  }
  mix.className='figure-body'; funnel.className='figure-body'; quality.className='figure-body';
  mix.innerHTML = `${miniBar('Possible offices', referral, total, 'blue')}${miniBar('Similar clinics', similar, total, 'red')}${miniBar('Existing sources', existing.length, total, 'green')}`;
  funnel.innerHTML = `${miniBar('Public listings', total, total, 'blue')}${miniBar('Saved targets', saved, Math.max(total, saved), 'green')}${miniBar('Follow-ups due', due, Math.max(saved, due, 1), 'gold')}`;
  quality.innerHTML = `${miniBar('With contact info', contact, total, 'green')}${miniBar('Pinned on map', pinned, total, 'blue')}${miniBar('Need verification', Math.max(0,total-pinned), total, 'gold')}`;
  if(badge) badge.textContent = pinned ? `${pinned} mapped` : 'Contact records only';
}

let suggestTimer=null;
async function handleAddressSuggest(){
  const input=$('#locationInput'); const box=$('#addressSuggestBox'); if(!input||!box) return;
  const q=input.value.trim();
  clearTimeout(suggestTimer);
  if(q.length<4){ box.hidden=true; box.innerHTML=''; return; }
  suggestTimer=setTimeout(async()=>{
    try{
      const u=new URL('/api/suggest', window.location.origin); u.searchParams.set('q', q);
      const j=await fetchJSON(u.toString(), {}, 6500);
      const arr=Array.isArray(j.suggestions)?j.suggestions:[];
      if(!arr.length){ box.hidden=true; box.innerHTML=''; return; }
      box.innerHTML=arr.slice(0,6).map(x=>`<button type="button" class="suggest-item" data-value="${esc(x.label||x)}"><b>${esc(x.main||x.label||x)}</b><span>${esc(x.secondary||'')}</span></button>`).join('');
      box.hidden=false;
      box.querySelectorAll('.suggest-item').forEach(btn=>btn.addEventListener('click',()=>{ input.value=btn.dataset.value; box.hidden=true; box.innerHTML=''; input.focus(); }));
    }catch(e){ box.hidden=true; box.innerHTML=''; }
  }, 260);
}



function setupVoiceSearchSupport(){
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn=$('#voiceSearchBtn'), status=$('#voiceSearchStatus');
  if(!btn) return;
  if(!SpeechRecognition){
    btn.hidden=true;
    btn.disabled=true;
    btn.setAttribute('aria-hidden','true');
    if(status){ status.hidden=true; status.textContent=''; }
  } else {
    btn.hidden=false;
    btn.disabled=false;
    btn.title='Speak a clinic address or market';
  }
}

function startVoiceSearch(){
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn=$('#voiceSearchBtn'), status=$('#voiceSearchStatus'), input=$('#locationInput');
  if(!SpeechRecognition){
    if(status){ status.hidden=false; status.textContent='Voice search works best in Chrome or Edge.'; setTimeout(()=>{ status.hidden=true; }, 2200); }
    return;
  }
  if(!input) return;
  const rec=new SpeechRecognition();
  rec.lang='en-US'; rec.interimResults=false; rec.maxAlternatives=1;
  if(btn){ btn.classList.add('listening'); btn.textContent='●'; }
  if(status){ status.hidden=false; status.textContent='Listening… say a city or clinic address'; }
  rec.onresult=e=>{
    const spoken=(e.results?.[0]?.[0]?.transcript||'').trim();
    if(spoken){
      input.value=spoken;
      input.dispatchEvent(new Event('input', {bubbles:true}));
      if(status) status.textContent=`Heard: ${spoken}`;
    }
  };
  rec.onerror=e=>{
    if(status){ status.hidden=false; status.textContent=e.error==='not-allowed'?'Microphone permission was blocked.':'Voice search could not hear the address.'; }
  };
  rec.onend=()=>{
    if(btn){ btn.classList.remove('listening'); btn.textContent='🎙'; }
    setTimeout(()=>{ if(status) status.hidden=true; }, 2200);
  };
  rec.start();
}

function directionForPlace(p){
  const center=current.center;
  if(!center || !Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lon))) return p.zone || 'Unmapped';
  return sectorName(bearing(center.lat, center.lon, Number(p.lat), Number(p.lon)));
}
function directionalCoverageRows(){
  const dirs=['North','Northeast','East','Southeast','South','Southwest','West','Northwest'];
  const rows=dirs.map(d=>({d, ex:0, ref:0, sim:0, saved:0, contact:0, score:0}));
  const byDir=Object.fromEntries(rows.map(r=>[r.d,r]));
  const existing=getExistingPlaces(); const refs=current.referrals||[]; const sim=current.similar||[]; const saved=getSavedPlaces();
  refs.forEach(p=>{ const r=byDir[directionForPlace(p)]; if(r){ r.ref++; if(p.phone||p.website) r.contact++; }});
  sim.forEach(p=>{ const r=byDir[directionForPlace(p)]; if(r) r.sim++; });
  existing.forEach(p=>{ const r=byDir[directionForPlace(p)]; if(r) r.ex++; });
  saved.forEach(p=>{ const r=byDir[directionForPlace(p)]; if(r) r.saved++; });
  rows.forEach(r=>{ r.score=(r.ref*3)+(r.contact*2)+(r.saved*1.5)-(r.sim*2)-(r.ex*1.2); });
  return rows;
}
function placesInDirection(dir, limit=10){
  const all=[...(current.referrals||[]), ...(current.similar||[]), ...getExistingPlaces(), ...getSavedPlaces()];
  const seen=new Set();
  return all.filter(p=>p && directionForPlace(p)===dir && !seen.has(p.id) && seen.add(p.id))
    .sort((a,b)=>(b.kind==='referral')-(a.kind==='referral') || (b.score||0)-(a.score||0) || (a.distance||999)-(b.distance||999))
    .slice(0, limit);
}
function directionalStrategy(dir){ 
  const r=directionalCoverageRows().find(x=>x.d===dir) || {d:dir, ref:0, contact:0, ex:0, sim:0, saved:0, score:0};
  const existing=getExistingPlaces().length;
  const contactRate=r.ref ? Math.round((r.contact/r.ref)*100) : 0;
  const pressure=r.ref ? Math.round((r.sim/Math.max(1,r.ref))*100) : (r.sim?100:0);
  let use='Verify first'; let tone='verify'; let why='Not enough contactable referral-office data yet.';
  if(r.ref>0 && r.contact>=8 && r.sim<=Math.max(3, r.ref*.25) && r.ex===0){ use='First outreach pocket'; tone='ready'; why='Strong contact readiness with low mapped competitor pressure and no current source in this direction.'; }
  else if(r.ref>0 && r.ex===0){ use='Potential gap pocket'; tone='gap'; why='Possible offices are present, but no existing referral source is mapped here yet.'; }
  else if(r.sim>Math.max(5,r.ref*.35)){ use='Differentiate carefully'; tone='pressure'; why='Similar clinics are relatively dense, so focus on the most contactable offices and avoid broad outreach.'; }
  else if(r.contact>0){ use='Focused outreach pocket'; tone='ready'; why='There are contactable offices here; start with the strongest-fit targets and document the referral pathway.'; }
  const action= existing ? (r.ex===0?'Check whether this is truly uncovered, then save the best contactable offices.':'Build around existing relationships and add nearby contactable offices carefully.') : 'Upload current referral sources to convert this from public opportunity into a true coverage-gap view.';
  return {row:r, use, tone, why, action, contactRate, pressure};
}
function areaSignalLabel(score){
  if(score>=800) return 'Very strong pocket';
  if(score>=250) return 'Strong pocket';
  if(score>=80) return 'Promising pocket';
  if(score>0) return 'Early signal';
  return 'Verify first';
}
function areaSaveCandidates(dir){
  return placesInDirection(dir, 30)
    .filter(p=>p.kind!=='similar' && p.kind!=='existing' && (p.phone||p.website))
    .sort((a,b)=>(b.score||0)-(a.score||0) || (a.distance||999)-(b.distance||999))
    .slice(0,12);
}
function directionalStrategyHtml(dir){
  if(!dir) return '';
  const s=directionalStrategy(dir); const r=s.row;
  const candidates=areaSaveCandidates(dir);
  const unsaved=candidates.filter(p=>!isSaved(p.id));
  const notice=window.__cmiqGapNotice && window.__cmiqGapNotice.dir===dir ? `<div class="strategy-success">${esc(window.__cmiqGapNotice.message)}</div>` : '';
  const saveLabel=unsaved.length ? `Save ${unsaved.length} top office${unsaved.length>1?'s':''}` : (candidates.length ? 'Top offices saved' : 'No call-ready offices');
  const disabled=!unsaved.length ? 'disabled aria-disabled="true"' : '';
  return `<div class="area-strategy-card ${s.tone}"><div class="area-strategy-head"><div><span>Area strategy</span><b>${esc(dir)} · ${esc(s.use)}</b></div><em title="Area score is a planning score based on possible offices, contactable offices, saved targets, similar clinics, and existing referral sources.">${esc(areaSignalLabel(r.score))}</em></div><p>${esc(s.why)}</p><div class="strategy-metrics"><span><b>${r.ref}</b> possible</span><span><b>${r.contact}</b> contactable</span><span><b>${r.ex}</b> existing</span><span><b>${r.sim}</b> similar</span></div><div class="strategy-note">${esc(s.action)}</div>${notice}<div class="strategy-actions"><button type="button" class="tiny-btn action-save" data-gap-save-dir="${esc(dir)}" ${disabled}>${esc(saveLabel)}</button><button type="button" class="tiny-btn action-directions" data-gap-route-dir="${esc(dir)}">Build route</button></div></div>`;
}
function gapFocusHtml(dir){
  if(!dir) return '';
  const matches=placesInDirection(dir, 8);
  const strategy=directionalStrategyHtml(dir);
  if(!matches.length) return `<div class="gap-focus-panel">${strategy}<p class="helper-text no-margin">No mapped offices are available in this direction yet.</p></div>`;
  return `<div class="gap-focus-panel">${strategy}<div class="gap-focus-head"><b>${esc(dir)} offices</b><span>${matches.length} shown</span></div>${matches.map(p=>`<div class="gap-office-row"><button type="button" data-open-gap-office="${esc(p.id)}"><strong>${esc(p.name)}</strong><small>${esc(placeRoleLabel(p))} · ${esc(p.category||'Office')}${p.distance<999?' · '+p.distance.toFixed(1)+' mi':''}</small></button><a href="${mapsUrl(p)}" target="_blank" rel="noopener" class="tiny-btn action-directions">Directions</a></div>`).join('')}</div>`;
}
function saveDirectionalTargets(dir){
  const candidates=areaSaveCandidates(dir);
  const targets=candidates.filter(p=>!isSaved(p.id));
  if(!candidates.length){
    window.__cmiqGapNotice={dir, message:'No call-ready referral offices in this area yet. Try a broader search or verify contact data first.'};
    renderNetworkCoverage();
    return;
  }
  if(!targets.length){
    window.__cmiqGapNotice={dir, message:'The top call-ready offices in this area are already saved.'};
    renderNetworkCoverage();
    return;
  }
  targets.forEach(p=>{ updateSavedRecord(p.id, {...placeToSaved(p), status:savedRecord(p.id).status || 'Not contacted'}); });
  window.__cmiqGapNotice={dir, message:`Saved ${targets.length} top office${targets.length>1?'s':''} from ${dir} to the outreach list.`};
  logActivity('Saved area strategy targets', {name:dir}, `${targets.length} offices`);
  renderLists(); renderSaved(); renderPipelineBoard(); renderManagerDashboard(); renderNetworkCoverage(); refreshPlanningViews();
}
function routeDirectionalTargets(dir){
  const pts=placesInDirection(dir, 12).filter(p=>p.kind!=='similar' && p.lat&&p.lon).slice(0,8);
  if(!pts.length){ alert('No mapped route-ready offices in this area yet.'); return; }
  window.open('https://www.google.com/maps/dir/'+pts.map(p=>`${p.lat},${p.lon}`).join('/'),'_blank','noopener');
  logActivity('Opened area strategy route', {name:dir}, `${pts.length} stops`);
}
function focusDirectionOnMap(dir){
  const pts=placesInDirection(dir, 200).filter(p=>Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon))).map(p=>[Number(p.lat), Number(p.lon)]);
  if(!pts.length || !map) return;
  visibleLayers={referral:true, similar:true, existing:true};
  renderMap();
  setTimeout(()=>{
    map.fitBounds(pts.concat(current.center?[[current.center.lat,current.center.lon]]:[]), {padding:[45,45], maxZoom:13});
  }, 80);
}
function renderNetworkCoverage(){
  const el=$('#networkCoverageContent'); if(!el) return;
  const existing=getExistingPlaces(); const refs=current.referrals||[]; const sim=current.similar||[]; const saved=getSavedPlaces();
  if(!current.places.length && !existing.length){
    el.innerHTML='<p class="helper-text no-margin">Run a market search or upload existing referral sources to compare public opportunity against current relationship coverage.</p>';
    return;
  }
  const rows=directionalCoverageRows().filter(r=>r.ref>0 || r.ex>0 || r.sim>0 || r.saved>0);
  const ranked=rows.slice().sort((a,b)=>b.score-a.score).slice(0,4);
  const top=ranked[0];
  const hasBaseline=existing.length>0;
  const title=hasBaseline ? 'Best coverage gap' : 'Public opportunity snapshot';
  const mainLine=top ? `${top.d}: ${top.ref} possible offices · ${top.contact} contactable · ${top.sim} similar clinics` : 'No mapped directional signal yet';
  let action='Add current referral sources to turn this from a public opportunity snapshot into a true relationship-gap analysis.';
  if(hasBaseline && top){
    action = top.ex===0 && top.ref>0 ? 'Potential relationship gap: possible offices are present but no existing source is mapped in this direction.' : top.sim>top.ref ? 'Competitor-heavy pocket: review differentiation before spending outreach time.' : 'Covered but still promising: add contactable offices around existing relationships.';
  } else if(top && top.contact>0){
    action = 'Start by saving the highest-fit contactable offices here; upload existing sources later to measure true coverage gaps.';
  }
  const activeDir=window.__cmiqGapFocus && ranked.some(r=>r.d===window.__cmiqGapFocus) ? window.__cmiqGapFocus : (top?.d || '');
  const rowsHtml=ranked.length ? `<div class="gap-row-list">${ranked.map(r=>{
    const note = r.ex===0 && r.ref>0 ? 'Gap candidate' : r.sim>r.ref ? 'Competitor pressure' : r.contact>0 ? 'Contactable pocket' : 'Verify first';
    const cls = r.ex===0 && r.ref>0 ? 'gap' : r.sim>r.ref ? 'pressure' : r.contact>0 ? 'ready' : 'verify';
    const strength=Math.max(8, Math.min(100, Math.round((r.score / Math.max(1, ranked[0]?.score || 1))*100)));
    return `<button type="button" class="gap-row ${cls} ${r.d===activeDir?'active':''}" data-gap-direction="${esc(r.d)}" title="Click to zoom map and view offices in ${esc(r.d)}"><div class="gap-row-head"><b>${esc(r.d)}</b><span>${esc(note)}</span></div><div class="gap-row-metrics"><em>${r.ref} possible</em><em>${r.contact} contactable</em><em>${r.ex} existing</em><em>${r.sim} similar</em></div><i style="width:${strength}%"></i></button>`;
  }).join('')}</div>${gapFocusHtml(activeDir)}` : '<p class="helper-text no-margin">No directional pockets yet. Run a mapped search or add existing sources.</p>';
  el.innerHTML=`<div class="coverage-kpis"><div><b>${existing.length}</b><span>existing sources</span></div><div><b>${refs.length}</b><span>possible offices</span></div><div><b>${sim.length}</b><span>similar clinics</span></div><div><b>${saved.length}</b><span>saved targets</span></div></div><div class="coverage-gap-list"><h3>Market gap finder</h3><div class="gap-brief"><b>${esc(title)}</b><span>${esc(mainLine)}</span><small>${esc(action)}</small></div>${rowsHtml}</div>`;
  el.querySelectorAll('[data-gap-direction]').forEach(btn=>btn.addEventListener('click',()=>{ window.__cmiqGapFocus=btn.dataset.gapDirection; renderNetworkCoverage(); focusDirectionOnMap(window.__cmiqGapFocus); }));
  el.querySelectorAll('[data-open-gap-office]').forEach(btn=>btn.addEventListener('click',()=>{ const p=findPlace(btn.dataset.openGapOffice) || getSavedPlaces().find(x=>x.id===btn.dataset.openGapOffice) || getExistingPlaces().find(x=>x.id===btn.dataset.openGapOffice); if(p) selectPlace(p,true); }));
  el.querySelectorAll('[data-gap-save-dir]').forEach(btn=>btn.addEventListener('click',e=>{ e.preventDefault(); e.stopPropagation(); if(!btn.disabled) saveDirectionalTargets(btn.dataset.gapSaveDir); }));
  el.querySelectorAll('[data-gap-route-dir]').forEach(btn=>btn.addEventListener('click',e=>{ e.preventDefault(); e.stopPropagation(); routeDirectionalTargets(btn.dataset.gapRouteDir); }));
}

function renderTeamWorkspace(){
  const list=$('#teamList'); if(!list) return;
  const teams=teamStore();
  list.innerHTML = teams.length ? teams.map((t,i)=>`<div class="team-chip"><span>${esc(t.name)}</span><small>${getSavedPlaces().filter(p=>(p.assignedTo||'')===t.name).length} assigned</small><button type="button" data-remove-team="${i}">×</button></div>`).join('') : '<p class="helper-text">No team members yet. Add liaison names to assign offices.</p>';
  list.querySelectorAll('[data-remove-team]').forEach(btn=>btn.addEventListener('click',()=>{ const arr=teamStore(); const removed=arr.splice(Number(btn.dataset.removeTeam),1)[0]; saveTeamStore(arr); logActivity('Removed team member', {name:removed?.name||'Team member'}); renderTeamWorkspace(); renderLists(); renderSaved(); renderManagerDashboard(); renderPipelineBoard(); }));
}
function addTeamMember(){
  const input=$('#teamMemberInput'); const name=(input?.value||'').trim(); if(!name) return;
  const arr=teamStore(); if(!arr.some(t=>norm(t.name)===norm(name))) arr.push({name, createdAt:new Date().toISOString()}); saveTeamStore(arr); input.value=''; logActivity('Added team member', {name}); renderTeamWorkspace(); renderLists(); renderSaved(); renderManagerDashboard();
}
function exportWorkspace(){
  const payload={version:'ClinicMapIQ workspace v1', exportedAt:new Date().toISOString(), account:accountStore(), saved:savedStore(), existing:existingStore(), team:teamStore(), activity:activityStore(), weekly:weeklyStore(), analytics:analyticsStore(), campaigns:campaignStore()};
  download('clinicmapiq_workspace.json', JSON.stringify(payload,null,2), 'application/json');
}
function importWorkspace(e){
  const file=e.target.files && e.target.files[0]; if(!file) return;
  const reader=new FileReader(); reader.onload=()=>{ try{ const j=JSON.parse(String(reader.result||'{}')); if(j.saved) saveStorage('cmiq_saved_records_v7', j.saved); if(j.existing) saveExistingStore(j.existing); if(j.team) saveTeamStore(j.team); if(j.activity) saveActivityStore(j.activity); if(j.account) saveAccountStore(j.account); if(j.weekly) saveWeeklyStore(j.weekly); if(j.analytics) saveAnalyticsStore(j.analytics); if(j.campaigns) saveCampaignStore(j.campaigns); logActivity('Imported shared workspace', {name:'Workspace'}, file.name); renderAll(); renderAccount(); renderWeeklyStatus(); renderEnterpriseAnalytics(); renderCampaignBoard(); }catch(err){ alert('Could not import workspace JSON.'); } } ; reader.readAsText(file);
}
function renderManagerDashboard(){
  const el=$('#managerDashboard'); if(!el) return;
  const saved=getSavedPlaces(); const due=saved.filter(p=>isDue(p.followUpDate)); const active=saved.filter(p=>(p.status||'')==='Relationship active').length; const notContacted=saved.filter(p=>!p.status || p.status==='Not contacted').length; const assigned=saved.filter(p=>p.assignedTo).length; const teams=teamStore(); const newCount=current.newCount||0;
  const teamRows=teams.length?teams.map(t=>`<div class="team-progress"><span>${esc(t.name)}</span><b>${saved.filter(p=>(p.assignedTo||'')===t.name).length}</b></div>`).join(''):'<p class="helper-text">Add team members to assign saved offices. Recent activity is shown in the Activity History section below.</p>';
  const barriers=topBarriers();
  const gap=opportunityGap();
  const maxBarrier=Math.max(1,...barriers.map(x=>x[1]||0));
  const activeBarrier=window.__cmiqBarrierFocus && barriers.some(([b])=>b===window.__cmiqBarrierFocus) ? window.__cmiqBarrierFocus : (barriers[0]?.[0] || '');
  const barrierHtml=barriers.length?`<div class="barrier-heatmap clickable-barriers">${barriers.map(([b,c])=>`<button type="button" class="barrier-row ${b===activeBarrier?'active':''}" data-barrier-focus="${esc(b)}"><b>${esc(b)}</b><span>${c} office${c>1?'s':''}</span><i style="width:${Math.max(12,Math.round((c/maxBarrier)*100))}%"></i></button>`).join('')}</div><div id="barrierFocusPanel">${barrierFocusHtml(activeBarrier)}</div>`:'<p class="helper-text no-margin">No barriers detected yet. This updates after a search and after users add Manage details.</p>';
  const gapHtml=gap?`<p><b>${esc(gap.name)}</b><span>${gap.referrals||0} referral offices · ${gap.similar||0} similar clinics</span></p>`:'<p class="helper-text no-margin">Run a mapped search to identify opportunity gaps.</p>';
  const campaigns=campaignStore(); const activeCampaigns=campaigns.length; const campaignTargets=campaigns.reduce((sum,c)=>sum+(campaignProgress(c).total||0),0);
  const command=`<div class="growth-command-card"><div><span>Growth command report</span><b>${expansionScore().score}/100 planning score</b><p>${esc(recommendedNextMove())}</p></div><button type="button" id="downloadCommandReportBtn" class="tiny-btn action-directions">Download command report</button></div>`;
  el.innerHTML=`<div class="manager-kpis"><div><b>${saved.length}</b><span>saved targets</span></div><div><b>${due.length}</b><span>follow-ups due</span></div><div><b>${active}</b><span>active relationships</span></div><div><b>${notContacted}</b><span>not contacted</span></div><div><b>${activeCampaigns}</b><span>campaigns</span></div><div><b>${campaignTargets}</b><span>campaign targets</span></div></div>${monthlyScorecardHtml()}${command}<div class="manager-focus-grid"><div class="manager-focus"><h3>Team assignments</h3>${teamRows}</div><div class="manager-focus"><h3>Top barriers</h3><p class="mini-helper">Click a barrier to see matching offices.</p>${barrierHtml}</div><div class="manager-focus"><h3>Opportunity gap</h3>${gapHtml}</div></div>`;
  const cmd=$('#downloadCommandReportBtn'); if(cmd) cmd.addEventListener('click',()=>{ download('clinicmapiq_growth_command_report.txt', commandReportText(), 'text/plain'); logActivity('Downloaded growth command report', {name:'Growth command report'}); });
  el.querySelectorAll('[data-barrier-focus]').forEach(btn=>btn.addEventListener('click',()=>{ window.__cmiqBarrierFocus=btn.dataset.barrierFocus; renderManagerDashboard(); }));
  el.querySelectorAll('[data-open-barrier-office]').forEach(btn=>btn.addEventListener('click',()=>{ const p=findPlace(btn.dataset.openBarrierOffice); if(p) selectPlace(p,true); }));
}
function renderActivityHistory(){
  const list=$('#activityHistoryList'); if(!list) return;
  const arr=activityStore();
  const badge=$('#activityCountBadge'); if(badge) badge.textContent=`${arr.length} actions`;
  if(!arr.length){
    list.innerHTML='<div class="empty-activity"><b>No activity yet.</b><span>Run a search, save offices, assign owners, change status, export reports, or add follow-ups to build the history automatically.</span></div>';
    return;
  }
  const limit=activityExpanded?arr.length:5;
  const rows=arr.slice(0,limit).map(a=>`<div class="activity-row"><div><b>${esc(a.action)}</b><span>${esc(a.officeName)}${a.detail?' · '+esc(a.detail):''}</span></div><time>${new Date(a.at).toLocaleString()}</time></div>`).join('');
  const more=arr.length>5 ? `<button type="button" id="activityToggleBtn" class="show-more activity-toggle">${activityExpanded?'View less actions ▲':`View ${arr.length-5} more actions ▼`}</button>` : '';
  list.innerHTML=rows+more;
  const btn=$('#activityToggleBtn'); if(btn) btn.addEventListener('click',()=>{ activityExpanded=!activityExpanded; renderActivityHistory(); });
}
function newOfficesSinceLastSearch(){ return current.places.filter(p=>p.isNew); }


function renderFilterUI(){
  const visibleModes=['all','saved','due'];
  const moreActive = !visibleModes.includes(filters.mode);
  const hidePoor = !!filters.hidePoor;
  const count = (moreActive?1:0) + (hidePoor?1:0);
  const badge=$('#activeFilterCount');
  if(badge){ badge.hidden=count===0; badge.textContent=count===1?'1 active':`${count} active`; }
  const menu=$('#moreFilterMenu');
  if(menu) menu.classList.toggle('has-active-filters', count>0);
  const hp=$('#hidePoorToggle'); if(hp) hp.checked=hidePoor;
  const nw=$('#noWasteBtn'); if(nw) nw.classList.toggle('active', !!filters.noWaste);
}

function initEvents(){
  setupVoiceSearchSupport();
  renderFilterUI();
  if($('#closeMoreFiltersBtn')) $('#closeMoreFiltersBtn').addEventListener('click', e=>{ e.preventDefault(); e.stopPropagation(); const menu=$('#moreFilterMenu'); if(menu){ menu.removeAttribute('open'); menu.open=false; } });
  document.addEventListener('click', e=>{ const menu=$('#moreFilterMenu'); if(menu && menu.open && !menu.contains(e.target)) menu.open=false; });
  document.addEventListener('keydown', e=>{ if(e.key==='Escape'){ const menu=$('#moreFilterMenu'); if(menu) menu.open=false; }});
  $('#searchForm').addEventListener('submit', runSearch); $('#resetRecommended').addEventListener('click', resetRecommended);
  if($('#locationInput')){ $('#locationInput').addEventListener('input', handleAddressSuggest); $('#locationInput').addEventListener('blur',()=>setTimeout(()=>{ const b=$('#addressSuggestBox'); if(b) b.hidden=true; },180)); }
  if($('#voiceSearchBtn')) $('#voiceSearchBtn').addEventListener('click', startVoiceSearch);
  if($('#scoreExplainBtn')) $('#scoreExplainBtn').addEventListener('click',()=>{ const box=$('#scoreExplainBox'); if(box) box.hidden=!box.hidden; });
  $('#specialtySelect').addEventListener('change', resetRecommended); $('#sortSelect').addEventListener('change', e=>{sortMode=e.target.value; renderLists(); renderSaved();});
  if($('#hidePoorToggle')) $('#hidePoorToggle').addEventListener('change', e=>{filters.hidePoor=e.target.checked; renderFilterUI(); renderLists(); renderSaved();});
  if($('#savedSearchSelect')) $('#savedSearchSelect').addEventListener('change', e=>{ if(e.target.value) applySavedSearch(e.target.value,false); });
  if($('#runSavedSearchBtn')) $('#runSavedSearchBtn').addEventListener('click',()=>{ const id=$('#savedSearchSelect')?.value; if(id) applySavedSearch(id,true); else alert('Choose a saved search first.'); });
  if($('#saveSearchBtn')) $('#saveSearchBtn').addEventListener('click',()=>saveCurrentSearch(false));
  if($('#clearSavedSearchesBtn')) $('#clearSavedSearchesBtn').addEventListener('click',clearSavedSearches);
  $$('.filter-chip[data-filter]').forEach(b=>b.addEventListener('click',()=>{$$('.filter-chip[data-filter]').forEach(x=>x.classList.remove('active')); b.classList.add('active'); filters.mode=b.dataset.filter; const menu=b.closest('#moreFilterMenu'); if(menu) menu.open=false; renderFilterUI(); renderLists(); renderSaved();}));
  if($('#noWasteBtn')) $('#noWasteBtn').addEventListener('click',()=>{ filters.noWaste=!filters.noWaste; renderFilterUI(); renderLists(); renderSaved(); renderAgent('best10'); });
  $$('.layer-btn[data-layer]').forEach(b=>b.addEventListener('click',()=>setExclusiveLayer(b.dataset.layer)));
  $$('.legend [data-layer]').forEach(b=>b.addEventListener('click',()=>setExclusiveLayer(b.dataset.layer)));
  if($('#areaSelectBtn')) $('#areaSelectBtn').addEventListener('click', toggleAreaMode);
  if($('#areaClearBtn')) $('#areaClearBtn').addEventListener('click', clearArea);
  $$('.agent-btn').forEach(b=>b.addEventListener('click',()=>renderAgent(b.dataset.agent)));
  $('#routeBtn').addEventListener('click', route); $('#csvBtn').addEventListener('click', exportCSV); $('#reportBtn').addEventListener('click', downloadReport); if($('#pdfBtn')) $('#pdfBtn').addEventListener('click', downloadPDFReport); $('#closeSelected').addEventListener('click',()=>$('#selectedSection').hidden=true);
  if($('#saveAccountBtn')) $('#saveAccountBtn').addEventListener('click', saveAccount);
  if($('#emailReminderBtn')) $('#emailReminderBtn').addEventListener('click', emailReminder);
  if($('#calendarBtn')) $('#calendarBtn').addEventListener('click', calendarReminders);
  if($('#saveWeeklyBtn')) $('#saveWeeklyBtn').addEventListener('click', saveWeekly);
  if($('#referralCsvInput')) $('#referralCsvInput').addEventListener('change', handleReferralCSV);
  if($('#existingReferralInput')) $('#existingReferralInput').addEventListener('change', handleExistingCSV);
  if($('#saveManualExistingBtn')) $('#saveManualExistingBtn').addEventListener('click', saveManualExistingReferral);
  if($('#clearManualExistingBtn')) $('#clearManualExistingBtn').addEventListener('click', clearManualExistingForm);
  if($('#clearExistingBtn')) $('#clearExistingBtn').addEventListener('click', clearExistingNetwork);
  if($('#exportExistingBtn')) $('#exportExistingBtn').addEventListener('click', exportExistingNetwork);
  if($('#accountQuickBtn')) $('#accountQuickBtn').addEventListener('click',()=>{ const m=$('#loginModal'); if(m){ m.hidden=false; setTimeout(()=>$('#accountName')?.focus(),60); } });
  if($('#closeLoginBtn')) $('#closeLoginBtn').addEventListener('click',()=>{ const m=$('#loginModal'); if(m) m.hidden=true; });
  if($('#loginModal')) $('#loginModal').addEventListener('click',e=>{ if(e.target.id==='loginModal') e.currentTarget.hidden=true; });
  if($('#avgValueInput')) $('#avgValueInput').addEventListener('input', renderEnterpriseAnalytics);
  if($('#outreachCostInput')) $('#outreachCostInput').addEventListener('input', renderEnterpriseAnalytics);
  if($('#projectedConvertedInput')) $('#projectedConvertedInput').addEventListener('input', renderEnterpriseAnalytics);
  if($('#createCampaignBtn')) $('#createCampaignBtn').addEventListener('click', createCampaign);
  if($('#campaignRecipe')) $('#campaignRecipe').addEventListener('change', applyCampaignRecipe);
  if($('#campaignType')) $('#campaignType').addEventListener('change', renderCampaignRecipePreview);
  if($('#addTeamMemberBtn')) $('#addTeamMemberBtn').addEventListener('click', addTeamMember);
  if($('#teamMemberInput')) $('#teamMemberInput').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); addTeamMember(); }});
  if($('#exportWorkspaceBtn')) $('#exportWorkspaceBtn').addEventListener('click', exportWorkspace);
  if($('#importWorkspaceInput')) $('#importWorkspaceInput').addEventListener('change', importWorkspace);
  if($('#googleSignInBtn')) $('#googleSignInBtn').addEventListener('click', signInGoogle);
  if($('#cloudSignOutBtn')) $('#cloudSignOutBtn').addEventListener('click', signOutCloud);
  if($('#cloudSaveBtn')) $('#cloudSaveBtn').addEventListener('click', cloudSaveWorkspace);
  if($('#cloudLoadBtn')) $('#cloudLoadBtn').addEventListener('click', cloudLoadWorkspace);
}

window.__cmiqOpenOffice = id => { const p=findPlace(id); if(p) selectPlace(p,true); };
window.addEventListener('load',()=>{ initMap(); initEvents(); renderAccount(); renderWeeklyStatus(); renderEnterpriseAnalytics(); renderExistingNetwork(); renderSummary(); renderSaved(); renderMarketOpportunityBrief(); renderMarketFigures(); renderTeamWorkspace(); renderNetworkCoverage(); renderManagerDashboard(); renderPipelineBoard(); renderActivityHistory(); renderSavedSearches(); renderCampaignRecipePreview(); initCloud(); setTimeout(()=>map.invalidateSize(),500); });
