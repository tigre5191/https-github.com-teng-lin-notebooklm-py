/* TrapMap — personal Waze-style speed trap map.
   Spots live in localStorage; known fixed cameras come from OpenStreetMap
   (Overpass API). Alerts fire while the app is open, based on GPS distance. */
'use strict';

/* ================= storage ================= */

const LS_SPOTS = 'trapmap.spots';
const LS_SETTINGS = 'trapmap.settings';
const LS_SEEN_INTRO = 'trapmap.intro';
const LS_VIEW = 'trapmap.view';

const TYPE_INFO = {
  police: { emoji: '👮', label: 'Police reported', cls: 'police', temp: true },
  trap:   { emoji: '🪤', label: 'Known trap spot', cls: 'trap',   temp: false },
  camera: { emoji: '📷', label: 'Speed camera',    cls: 'camera', temp: false },
  'osm-camera': { emoji: '📷', label: 'Speed camera (OpenStreetMap)', cls: 'osm', temp: false },
};

let settings = Object.assign({
  units: 'mph',      // 'mph' | 'kmh'
  radius: 500,       // alert distance, meters
  policeTtlH: 4,     // hours before police reports expire
  sound: true,
  vibrate: true,
}, load(LS_SETTINGS) || {});

let spots = load(LS_SPOTS) || [];

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}
function saveSpots() { save(LS_SPOTS, spots); }
function saveSettings() { save(LS_SETTINGS, settings); }

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    ('id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
}

function policeTtlMs() { return settings.policeTtlH * 3600 * 1000; }

/* Drop expired police reports. Returns true if anything changed. */
function purgeExpired() {
  const cutoff = Date.now() - policeTtlMs();
  const before = spots.length;
  spots = spots.filter(s => !(TYPE_INFO[s.type]?.temp && s.created < cutoff));
  if (spots.length !== before) { saveSpots(); return true; }
  return false;
}

/* ================= geometry ================= */

function distM(a, b) { // haversine, meters
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function bearing(a, b) { // degrees 0-360 from a to b
  const toRad = d => d * Math.PI / 180;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function fmtDist(m) {
  if (settings.units === 'mph') {
    const ft = m * 3.28084;
    if (ft < 1000) return Math.round(ft / 50) * 50 + ' ft';
    return (m / 1609.34).toFixed(1) + ' mi';
  }
  if (m < 1000) return Math.round(m / 50) * 50 + ' m';
  return (m / 1000).toFixed(1) + ' km';
}

function fmtAge(created) {
  const mins = Math.round((Date.now() - created) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const h = Math.floor(mins / 60);
  if (h < 24) return h + 'h ' + (mins % 60) + 'm ago';
  return Math.floor(h / 24) + 'd ago';
}

/* ================= map ================= */

const savedView = load(LS_VIEW);
const map = L.map('map', {
  zoomControl: false,
  center: savedView ? [savedView.lat, savedView.lng] : [39.5, -98.35], // continental US until located
  zoom: savedView ? savedView.zoom : 4,
});

const dark = matchMedia('(prefers-color-scheme: dark)').matches;
L.tileLayer(
  dark
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }
).addTo(map);

map.on('moveend', () => {
  const c = map.getCenter();
  save(LS_VIEW, { lat: c.lat, lng: c.lng, zoom: map.getZoom() });
});

const spotLayer = L.layerGroup().addTo(map);
const markers = new Map(); // spot id -> L.marker

function spotIcon(spot) {
  const info = TYPE_INFO[spot.type] || TYPE_INFO.camera;
  const stale = info.temp && (Date.now() - spot.created) > policeTtlMs() / 2;
  return L.divIcon({
    className: '',
    html: `<div class="mark ${info.cls}${stale ? ' stale' : ''}"><div class="pin"><span>${info.emoji}</span></div></div>`,
    iconSize: [38, 38],
    iconAnchor: [19, 36],
    popupAnchor: [8, -32],
  });
}

function popupHtml(spot) {
  const info = TYPE_INFO[spot.type] || TYPE_INFO.camera;
  const bits = [];
  if (info.temp) bits.push(fmtAge(spot.created));
  if (spot.source === 'import') bits.push('shared with you');
  if (spot.source === 'osm') bits.push('from OpenStreetMap');
  if (spot.note) bits.push(spot.note);
  return `
    <div class="pop-title">${info.emoji} ${info.label}</div>
    <div class="pop-sub">${bits.join(' · ') || 'saved spot'}</div>
    <div class="pop-btns">
      ${info.temp ? `<button onclick="renewSpot('${spot.id}')">👍 Still there</button>` : ''}
      <button class="del" onclick="deleteSpot('${spot.id}')">🗑 Remove</button>
    </div>`;
}

function renderSpots() {
  purgeExpired();
  const alive = new Set();
  for (const s of spots) {
    alive.add(s.id);
    let m = markers.get(s.id);
    if (!m) {
      m = L.marker([s.lat, s.lng], { icon: spotIcon(s) }).addTo(spotLayer);
      markers.set(s.id, m);
    } else {
      m.setIcon(spotIcon(s)); // refresh staleness fade
    }
    m.bindPopup(popupHtml(s));
  }
  for (const [id, m] of markers) {
    if (!alive.has(id)) { spotLayer.removeLayer(m); markers.delete(id); }
  }
}

window.renewSpot = id => {
  const s = spots.find(x => x.id === id);
  if (s) { s.created = Date.now(); saveSpots(); renderSpots(); map.closePopup(); toast('Report renewed 👍'); }
};
window.deleteSpot = id => {
  spots = spots.filter(x => x.id !== id);
  saveSpots(); renderSpots(); map.closePopup(); toast('Removed');
};

/* ================= my location ================= */

let youMarker = null;
let lastPos = null;      // {lat, lng, speed, heading, time}
let follow = false;
let geoWatchId = null;

function onPosition(pos) {
  const { latitude, longitude, speed, heading } = pos.coords;
  lastPos = { lat: latitude, lng: longitude, speed, heading, time: pos.timestamp };
  if (!youMarker) {
    youMarker = L.marker([latitude, longitude], {
      icon: L.divIcon({ className: '', html: '<div class="you-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      interactive: false,
      zIndexOffset: 500,
    }).addTo(map);
  } else {
    youMarker.setLatLng([latitude, longitude]);
  }
  if (follow) map.setView([latitude, longitude], Math.max(map.getZoom(), 15));
  if (driveMode) driveTick();
}

function startWatching() {
  if (geoWatchId != null) return;
  if (!navigator.geolocation) { toast('No GPS available on this device'); return; }
  geoWatchId = navigator.geolocation.watchPosition(onPosition, err => {
    if (err.code === 1) { // permission denied — stop; anything else is transient, keep watching
      navigator.geolocation.clearWatch(geoWatchId);
      geoWatchId = null;
      toast('Location permission denied — enable it in Settings');
      if (driveMode) $('driveStatus').textContent = 'Location denied';
    }
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
}

$('btnLocate').addEventListener('click', () => {
  follow = !follow;
  $('btnLocate').classList.toggle('on', follow);
  if (follow) {
    startWatching();
    if (lastPos) map.setView([lastPos.lat, lastPos.lng], Math.max(map.getZoom(), 15));
  }
});
map.on('dragstart', () => { follow = false; $('btnLocate').classList.remove('on'); });

/* ================= reporting ================= */

function addSpot(type, lat, lng, source = 'me', extra = {}) {
  const s = Object.assign({ id: uid(), type, lat, lng, created: Date.now(), source }, extra);
  spots.push(s);
  saveSpots();
  renderSpots();
  return s;
}

function reportHere(type) {
  const info = TYPE_INFO[type];
  if (lastPos && (Date.now() - lastPos.time) < 30000) {
    addSpot(type, lastPos.lat, lastPos.lng);
    toast(`${info.emoji} ${info.label} — marked at your location`);
  } else {
    startWatching();
    const c = map.getCenter();
    addSpot(type, c.lat, c.lng);
    toast(`${info.emoji} Marked at map center (no GPS fix yet)`);
  }
  if (settings.vibrate && navigator.vibrate) navigator.vibrate(30);
}

document.querySelectorAll('.report[data-type]').forEach(btn =>
  btn.addEventListener('click', () => reportHere(btn.dataset.type)));

/* long-press (contextmenu) on map → add menu at that point */
let addMenuLatLng = null;
map.on('contextmenu', e => {
  addMenuLatLng = e.latlng;
  $('addMenu').classList.remove('hidden');
});
$('addMenu').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  $('addMenu').classList.add('hidden');
  if (btn.dataset.type && addMenuLatLng) {
    addSpot(btn.dataset.type, addMenuLatLng.lat, addMenuLatLng.lng);
    toast(`${TYPE_INFO[btn.dataset.type].emoji} Spot added`);
  }
});

/* ================= OSM speed cameras (Overpass) ================= */

$('btnCameras').addEventListener('click', async () => {
  const btn = $('btnCameras');
  if (btn.classList.contains('loading')) return;
  if (map.getZoom() < 9) { toast('Zoom in to your area first, then load cameras'); return; }
  btn.classList.add('loading');
  btn.textContent = '📡 Loading…';
  try {
    const b = map.getBounds();
    const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].join(',');
    const query = `[out:json][timeout:25];node["highway"="speed_camera"](${bbox});out body 600;`;
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const known = new Set(spots.filter(s => s.osmId).map(s => s.osmId));
    let added = 0;
    for (const el of data.elements || []) {
      if (known.has(el.id)) continue;
      addSpot('osm-camera', el.lat, el.lon, 'osm', { osmId: el.id, note: el.tags?.maxspeed ? 'limit ' + el.tags.maxspeed : undefined });
      added++;
    }
    toast(added ? `📷 ${added} known camera${added > 1 ? 's' : ''} added` : 'No mapped cameras in this area');
  } catch (e) {
    toast('Camera lookup failed — try again in a minute');
  } finally {
    btn.classList.remove('loading');
    btn.textContent = '📡 Cameras';
  }
});

/* ================= drive mode ================= */

let driveMode = false;
let wakeLock = null;
const alerted = new Set(); // spot ids currently alerted

$('btnDrive').addEventListener('click', () => setDrive(true));
$('btnExitDrive').addEventListener('click', () => setDrive(false));

async function setDrive(on) {
  driveMode = on;
  $('driveOverlay').classList.toggle('hidden', !on);
  if (on) {
    follow = true;
    startWatching();
    unlockAudio();
    $('speedUnit').textContent = settings.units === 'mph' ? 'mph' : 'km/h';
    $('driveStatus').textContent = lastPos ? 'GPS locked' : 'Waiting for GPS…';
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
    driveTick();
  } else {
    try { wakeLock?.release(); } catch {}
    wakeLock = null;
    alerted.clear();
    $('driveAlert').classList.add('hidden');
  }
}
document.addEventListener('visibilitychange', async () => {
  if (driveMode && document.visibilityState === 'visible') {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  }
});

function driveTick() {
  if (!driveMode || !lastPos) return;
  $('driveStatus').textContent = 'GPS locked';

  // speed
  const ms = lastPos.speed;
  let shown = 0;
  if (ms != null && !isNaN(ms) && ms >= 0) {
    shown = settings.units === 'mph' ? ms * 2.23694 : ms * 3.6;
  }
  $('speedVal').textContent = Math.round(shown);

  // threats
  purgeExpired();
  const here = { lat: lastPos.lat, lng: lastPos.lng };
  const moving = lastPos.speed != null && lastPos.speed > 2.2; // > ~5 mph
  let nearest = null;
  const inRange = [];
  for (const s of spots) {
    const d = distM(here, s);
    if (!nearest || d < nearest.d) nearest = { s, d };
    if (d > settings.radius) continue;
    // if we know our heading and are moving, skip spots clearly behind us
    if (moving && lastPos.heading != null && !isNaN(lastPos.heading) && d > 180) {
      let diff = Math.abs(bearing(here, s) - lastPos.heading);
      if (diff > 180) diff = 360 - diff;
      if (diff > 110) continue;
    }
    inRange.push({ s, d });
  }
  inRange.sort((a, b) => a.d - b.d);

  // clear alerts once well past the spot
  for (const id of [...alerted]) {
    const s = spots.find(x => x.id === id);
    if (!s || distM(here, s) > settings.radius * 1.5) alerted.delete(id);
  }

  if (inRange.length) {
    const top = inRange[0];
    const info = TYPE_INFO[top.s.type] || TYPE_INFO.camera;
    $('driveAlertIcon').textContent = info.emoji;
    $('driveAlertTitle').textContent = info.label + ' ahead';
    $('driveAlertDist').textContent = fmtDist(top.d);
    $('driveAlert').classList.remove('hidden');
    if (!alerted.has(top.s.id)) {
      alerted.add(top.s.id);
      if (settings.sound) alarm();
      if (settings.vibrate && navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);
    }
  } else {
    $('driveAlert').classList.add('hidden');
  }

  $('driveNearest').textContent = nearest
    ? `Nearest: ${TYPE_INFO[nearest.s.type]?.emoji || ''} ${TYPE_INFO[nearest.s.type]?.label || 'spot'} · ${fmtDist(nearest.d)}`
    : 'No known traps saved yet — tap a button when you spot one';
}

/* two-tone alert via WebAudio (iOS needs a user gesture to unlock) */
let audioCtx = null;
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {}
}
function alarm() {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  [[880, 0], [660, .18], [880, .36], [660, .54]].forEach(([freq, dt]) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(.0001, t0 + dt);
    g.gain.exponentialRampToValueAtTime(.3, t0 + dt + .02);
    g.gain.exponentialRampToValueAtTime(.0001, t0 + dt + .16);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0 + dt); o.stop(t0 + dt + .18);
  });
}

/* ================= nearby list ================= */

$('btnList').addEventListener('click', () => {
  renderList();
  $('listSheet').classList.remove('hidden');
});

function renderList() {
  purgeExpired();
  const box = $('spotList');
  if (!spots.length) {
    box.innerHTML = '<div class="spot-empty">Nothing saved yet.<br>Tap 👮 🪤 or 📷 when you spot something,<br>or long-press the map.</div>';
    return;
  }
  const here = lastPos ? { lat: lastPos.lat, lng: lastPos.lng } : null;
  const rows = spots.map(s => ({ s, d: here ? distM(here, s) : null }))
    .sort((a, b) => (a.d ?? Infinity) - (b.d ?? Infinity) || b.s.created - a.s.created);
  box.innerHTML = rows.map(({ s, d }) => {
    const info = TYPE_INFO[s.type] || TYPE_INFO.camera;
    const meta = [info.temp ? fmtAge(s.created) : null,
      s.source === 'osm' ? 'OpenStreetMap' : s.source === 'import' ? 'shared' : null, s.note]
      .filter(Boolean).join(' · ');
    return `<div class="spot-row" data-id="${s.id}">
      <span class="emoji">${info.emoji}</span>
      <div class="info"><div class="name">${info.label}</div><div class="meta">${meta || 'saved spot'}</div></div>
      <span class="dist">${d != null ? fmtDist(d) : ''}</span>
    </div>`;
  }).join('');
  box.querySelectorAll('.spot-row').forEach(row =>
    row.addEventListener('click', () => {
      const s = spots.find(x => x.id === row.dataset.id);
      if (!s) return;
      $('listSheet').classList.add('hidden');
      map.setView([s.lat, s.lng], 16);
      markers.get(s.id)?.openPopup();
    }));
}

/* ================= settings / share ================= */

$('btnSettings').addEventListener('click', () => {
  $('setUnits').value = settings.units;
  $('setRadius').value = String(settings.radius);
  $('setTtl').value = String(settings.policeTtlH);
  $('setSound').checked = settings.sound;
  $('setVibe').checked = settings.vibrate;
  $('settingsSheet').classList.remove('hidden');
});

$('setUnits').addEventListener('change', e => { settings.units = e.target.value; saveSettings(); });
$('setRadius').addEventListener('change', e => { settings.radius = +e.target.value; saveSettings(); });
$('setTtl').addEventListener('change', e => { settings.policeTtlH = +e.target.value; saveSettings(); renderSpots(); });
$('setSound').addEventListener('change', e => { settings.sound = e.target.checked; saveSettings(); });
$('setVibe').addEventListener('change', e => { settings.vibrate = e.target.checked; saveSettings(); });

document.querySelectorAll('.sheet-close').forEach(btn =>
  btn.addEventListener('click', () => $(btn.dataset.close).classList.add('hidden')));

$('btnExport').addEventListener('click', async () => {
  purgeExpired();
  const payload = JSON.stringify({ app: 'trapmap', version: 1, exported: new Date().toISOString(), spots }, null, 1);
  const file = new File([payload], 'trapmap-spots.json', { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'TrapMap spots' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('btnImport').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'trapmap' || !Array.isArray(data.spots)) throw new Error('bad file');
    const have = new Set(spots.map(s => s.id));
    const haveOsm = new Set(spots.filter(s => s.osmId).map(s => s.osmId));
    let added = 0;
    const cutoff = Date.now() - policeTtlMs();
    for (const s of data.spots) {
      if (!s || !TYPE_INFO[s.type] || typeof s.lat !== 'number' || typeof s.lng !== 'number') continue;
      if (have.has(s.id) || (s.osmId && haveOsm.has(s.osmId))) continue;
      if (TYPE_INFO[s.type].temp && (!s.created || s.created < cutoff)) continue; // stale police reports
      spots.push({ id: s.id || uid(), type: s.type, lat: s.lat, lng: s.lng,
        created: s.created || Date.now(), source: 'import', note: s.note, osmId: s.osmId });
      added++;
    }
    saveSpots(); renderSpots();
    toast(added ? `Imported ${added} spot${added > 1 ? 's' : ''} 🎉` : 'Nothing new in that file');
  } catch {
    toast('That file doesn’t look like a TrapMap export');
  }
});

$('btnClearAll').addEventListener('click', () => {
  if (!confirm('Delete ALL saved spots? This can’t be undone.')) return;
  spots = [];
  saveSpots(); renderSpots();
  toast('All spots deleted');
});

/* ================= misc UI ================= */

function $(id) { return document.getElementById(id); }

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.classList.add('hidden'), 350);
  }, 2600);
}

/* first run */
if (!localStorage.getItem(LS_SEEN_INTRO)) $('intro').classList.remove('hidden');
$('introGo').addEventListener('click', () => {
  localStorage.setItem(LS_SEEN_INTRO, '1');
  $('intro').classList.add('hidden');
  follow = true;
  $('btnLocate').classList.add('on');
  startWatching();
});

/* keep ages / expiry fresh */
setInterval(() => { renderSpots(); if (driveMode) driveTick(); }, 60000);

renderSpots();
if (localStorage.getItem(LS_SEEN_INTRO)) startWatching();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
