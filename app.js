/* NutriLog — local calorie & nutrient tracker (PWA)
   All data is stored on-device in IndexedDB. Barcode/search lookups use the
   free Open Food Facts database (openfoodfacts.org). */

'use strict';

/* ---------- Nutrient definitions ----------
   off  = Open Food Facts nutriments key (values per 100g, in grams unless kcal)
   factor converts OFF grams to the display unit. */
const NUTRIENTS = [
  { key: 'kcal',        label: 'Calories',      unit: 'kcal', off: 'energy-kcal',   factor: 1,   core: true },
  { key: 'protein',     label: 'Protein',       unit: 'g',    off: 'proteins',      factor: 1,   core: true },
  { key: 'carbs',       label: 'Carbs',         unit: 'g',    off: 'carbohydrates', factor: 1,   core: true },
  { key: 'fat',         label: 'Fat',           unit: 'g',    off: 'fat',           factor: 1,   core: true },
  { key: 'sugar',       label: 'Sugar',         unit: 'g',    off: 'sugars',        factor: 1,   core: true },
  { key: 'fiber',       label: 'Fiber',         unit: 'g',    off: 'fiber',         factor: 1,   core: true },
  { key: 'satfat',      label: 'Saturated fat', unit: 'g',    off: 'saturated-fat', factor: 1 },
  { key: 'transfat',    label: 'Trans fat',     unit: 'g',    off: 'trans-fat',     factor: 1 },
  { key: 'cholesterol', label: 'Cholesterol',   unit: 'mg',   off: 'cholesterol',   factor: 1000 },
  { key: 'sodium',      label: 'Sodium',        unit: 'mg',   off: 'sodium',        factor: 1000 },
  { key: 'potassium',   label: 'Potassium',     unit: 'mg',   off: 'potassium',     factor: 1000 },
  { key: 'calcium',     label: 'Calcium',       unit: 'mg',   off: 'calcium',       factor: 1000 },
  { key: 'iron',        label: 'Iron',          unit: 'mg',   off: 'iron',          factor: 1000 },
  { key: 'magnesium',   label: 'Magnesium',     unit: 'mg',   off: 'magnesium',     factor: 1000 },
  { key: 'zinc',        label: 'Zinc',          unit: 'mg',   off: 'zinc',          factor: 1000 },
  { key: 'vita',        label: 'Vitamin A',     unit: 'µg',   off: 'vitamin-a',     factor: 1e6 },
  { key: 'vitc',        label: 'Vitamin C',     unit: 'mg',   off: 'vitamin-c',     factor: 1000 },
  { key: 'vitd',        label: 'Vitamin D',     unit: 'µg',   off: 'vitamin-d',     factor: 1e6 },
  { key: 'vite',        label: 'Vitamin E',     unit: 'mg',   off: 'vitamin-e',     factor: 1000 },
  { key: 'vitb12',      label: 'Vitamin B12',   unit: 'µg',   off: 'vitamin-b12',   factor: 1e6 },
  { key: 'caffeine',    label: 'Caffeine',      unit: 'mg',   off: 'caffeine',      factor: 1000 },
  { key: 'alcohol',     label: 'Alcohol',       unit: 'g',    off: 'alcohol',       factor: 1 },
];
const MACRO_KEYS = ['protein', 'carbs', 'fat'];

/* ---------- IndexedDB ---------- */
let db;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('nutrilog', 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore('entries', { keyPath: 'id' });
      store.createIndex('date', 'date');
    };
    req.onsuccess = () => { db = req.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('entries', mode);
    const out = fn(tx.objectStore('entries'));
    tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}
const saveEntry = e => idb('readwrite', s => s.put(e));
const removeEntry = id => idb('readwrite', s => s.delete(id));
function entriesForDate(date) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readonly');
    const req = tx.objectStore('entries').index('date').getAll(date);
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.id - b.id));
    req.onerror = () => reject(req.error);
  });
}

/* ---------- State ---------- */
const $ = id => document.getElementById(id);
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
let currentDate = todayStr();
let dayEntries = [];
let editingId = null;      // entry id being edited, or null for new
let formPhoto = null;      // dataURL for the form's photo
let formPer100 = null;     // per-100g nutrient map when entry came from a product
let formBarcode = null;
let showAllForm = false;
let goals = JSON.parse(localStorage.getItem('nutrilog-goals') || '{}');

/* ---------- Rendering ---------- */
function fmt(n, digits) {
  if (!isFinite(n)) return '0';
  const d = digits !== undefined ? digits : (n >= 100 ? 0 : n >= 10 ? 1 : 2);
  return (+n.toFixed(d)).toLocaleString();
}

function dateLabelText(dateStr) {
  if (dateStr === todayStr()) return 'Today';
  const d = new Date(dateStr + 'T12:00:00');
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function totalsFor(entries) {
  const t = {};
  for (const n of NUTRIENTS) t[n.key] = 0;
  for (const e of entries)
    for (const n of NUTRIENTS)
      t[n.key] += Number(e.nutrients?.[n.key]) || 0;
  return t;
}

function render() {
  $('dateLabel').textContent = dateLabelText(currentDate);
  const totals = totalsFor(dayEntries);

  // Calories + ring
  $('kcalTotal').textContent = fmt(totals.kcal, 0);
  const goal = Number(goals.kcal) || 0;
  $('kcalGoalText').textContent = goal ? `of ${fmt(goal, 0)} kcal goal` : 'calories';
  const pct = goal ? Math.min(totals.kcal / goal, 1) : 0;
  $('kcalRing').style.strokeDashoffset = 264 * (1 - pct);
  $('kcalPct').textContent = goal ? Math.round((totals.kcal / goal) * 100) + '%' : '';

  // Macro tiles
  $('macroGrid').innerHTML = MACRO_KEYS.map(k => {
    const n = NUTRIENTS.find(x => x.key === k);
    const g = Number(goals[k]) || 0;
    const p = g ? Math.min(totals[k] / g * 100, 100) : 0;
    return `<div class="macro"><div class="m-label">${n.label}</div>
      <div class="m-val">${fmt(totals[k])}${n.unit}${g ? ` <small style="color:var(--muted);font-weight:500">/ ${fmt(g, 0)}</small>` : ''}</div>
      <div class="bar"><i style="width:${p}%"></i></div></div>`;
  }).join('');

  // Full nutrient table
  $('nutrientTable').innerHTML = NUTRIENTS.map(n =>
    `<div class="nrow"><span>${n.label}</span><span>${fmt(totals[n.key])} ${n.unit}</span></div>`
  ).join('');

  // Entry list
  const list = $('entryList');
  list.innerHTML = '';
  $('emptyMsg').classList.toggle('hidden', dayEntries.length > 0);
  for (const e of dayEntries) {
    const btn = document.createElement('button');
    btn.className = 'entry';
    const thumb = e.photo
      ? `<img class="thumb" src="${e.photo}" alt="">`
      : `<span class="thumb">🍽️</span>`;
    const subBits = [e.time, e.brand, e.amount ? fmt(e.amount, 0) + ' g' : null].filter(Boolean);
    btn.innerHTML = `${thumb}<span class="e-main"><span class="e-name">${esc(e.name)}</span>
      <span class="e-sub">${esc(subBits.join(' · '))}</span></span>
      <span class="e-kcal">${fmt(e.nutrients?.kcal || 0, 0)}<small> kcal</small></span>`;
    btn.onclick = () => openEntryForm(e);
    list.appendChild(btn);
  }
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadDay() {
  dayEntries = await entriesForDate(currentDate);
  render();
}

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

/* ---------- Entry form ---------- */
function buildNutrientInputs() {
  $('nutrientInputs').innerHTML = NUTRIENTS.map(n =>
    `<label data-core="${!!n.core}" ${n.core || showAllForm ? '' : 'class="hidden"'}>
       ${n.label} <small>(${n.unit})</small>
       <input data-nkey="${n.key}" type="number" inputmode="decimal" min="0" step="any" placeholder="0">
     </label>`).join('');
}

function openEntryForm(entry, prefill) {
  editingId = entry ? entry.id : null;
  formPhoto = entry?.photo || prefill?.photo || null;
  formPer100 = entry?.per100 || prefill?.per100 || null;
  formBarcode = entry?.barcode || prefill?.barcode || null;
  showAllForm = false;
  buildNutrientInputs();

  $('entryTitle').textContent = entry ? 'Edit food' : 'Add food';
  $('fName').value = entry?.name || prefill?.name || '';
  $('fBrand').value = entry?.brand || prefill?.brand || '';
  $('deleteEntry').classList.toggle('hidden', !entry);
  $('moreNutrients').textContent = 'More nutrients ▾';

  // Photo preview
  const pv = $('photoPreview');
  if (formPhoto) { pv.src = formPhoto; pv.classList.remove('hidden'); }
  else { pv.classList.add('hidden'); }
  $('photoBtn').textContent = formPhoto ? '📷 Change photo' : '📷 Add photo';

  // Amount + serving shortcuts (only when per-100g product data exists)
  const hasProduct = !!formPer100;
  $('amountBlock').classList.toggle('hidden', !hasProduct);
  $('servingBtns').innerHTML = '';
  if (hasProduct) {
    const amount = entry?.amount || prefill?.amount || 100;
    $('fAmount').value = amount;
    const chips = [['100 g', 100]];
    const sq = prefill?.servingQty || entry?.servingQty;
    if (sq) chips.unshift([`1 serving (${fmt(sq, 0)} g)`, sq]);
    for (const [label, grams] of chips) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label;
      b.onclick = () => { $('fAmount').value = grams; applyAmount(); };
      $('servingBtns').appendChild(b);
    }
  }

  // Nutrient values
  const source = entry?.nutrients
    || (hasProduct ? scaledNutrients(formPer100, Number($('fAmount').value) || 100) : {});
  for (const inp of document.querySelectorAll('#nutrientInputs input')) {
    const v = source[inp.dataset.nkey];
    inp.value = (v || v === 0) && v !== '' ? +Number(v).toFixed(2) : '';
  }
  if (entry?.amount) $('fAmount').value = entry.amount;
  if (entry?.servingQty) $('entryForm').dataset.servingQty = entry.servingQty;

  $('entryModal').classList.remove('hidden');
}

function scaledNutrients(per100, grams) {
  const out = {};
  for (const n of NUTRIENTS) {
    if (per100[n.key] !== undefined) out[n.key] = per100[n.key] * grams / 100;
  }
  return out;
}
function applyAmount() {
  if (!formPer100) return;
  const grams = Number($('fAmount').value) || 0;
  const scaled = scaledNutrients(formPer100, grams);
  for (const inp of document.querySelectorAll('#nutrientInputs input')) {
    const v = scaled[inp.dataset.nkey];
    if (v !== undefined) inp.value = +v.toFixed(2);
  }
}

function closeEntryForm() { $('entryModal').classList.add('hidden'); }

async function submitEntry(ev) {
  ev.preventDefault();
  const nutrients = {};
  for (const inp of document.querySelectorAll('#nutrientInputs input')) {
    const v = parseFloat(inp.value);
    if (!isNaN(v)) nutrients[inp.dataset.nkey] = v;
  }
  const now = new Date();
  const existing = editingId ? dayEntries.find(e => e.id === editingId) : null;
  const entry = {
    id: editingId || Date.now(),
    date: existing?.date || currentDate,
    time: existing?.time || now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    name: $('fName').value.trim(),
    brand: $('fBrand').value.trim(),
    amount: formPer100 ? (Number($('fAmount').value) || null) : null,
    photo: formPhoto,
    per100: formPer100,
    barcode: formBarcode,
    servingQty: Number($('entryForm').dataset.servingQty) || null,
    nutrients,
  };
  await saveEntry(entry);
  delete $('entryForm').dataset.servingQty;
  closeEntryForm();
  await loadDay();
  toast(editingId ? 'Updated ✓' : 'Added to your log ✓');
}

/* ---------- Photos ---------- */
function pickPhoto() { $('photoInput').click(); }
function handlePhoto(file) {
  const img = new Image();
  img.onload = () => {
    const max = 900;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    formPhoto = c.toDataURL('image/jpeg', 0.8);
    URL.revokeObjectURL(img.src);
    const pv = $('photoPreview');
    pv.src = formPhoto; pv.classList.remove('hidden');
    $('photoBtn').textContent = '📷 Change photo';
  };
  img.src = URL.createObjectURL(file);
}

/* ---------- Open Food Facts ---------- */
function productToPrefill(p) {
  const nutr = p.nutriments || {};
  const per100 = {};
  for (const n of NUTRIENTS) {
    const v = nutr[n.off + '_100g'];
    if (v !== undefined && v !== '' && v !== null) per100[n.key] = Number(v) * n.factor;
  }
  // OFF sometimes only has kJ
  if (per100.kcal === undefined && nutr['energy-kj_100g'])
    per100.kcal = Number(nutr['energy-kj_100g']) / 4.184;
  return {
    name: p.product_name || p.generic_name || '',
    brand: (p.brands || '').split(',')[0].trim(),
    per100,
    servingQty: Number(p.serving_quantity) || null,
    barcode: p.code || null,
    amount: Number(p.serving_quantity) || 100,
  };
}

async function lookupBarcode(code) {
  const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`);
  if (!res.ok) throw new Error('lookup failed');
  const data = await res.json();
  if (data.status !== 1 || !data.product) return null;
  return productToPrefill(data.product);
}

async function searchFoods(q) {
  const url = 'https://world.openfoodfacts.org/cgi/search.pl?json=1&page_size=12&action=process&fields=code,product_name,generic_name,brands,nutriments,serving_quantity&search_terms=' + encodeURIComponent(q);
  const res = await fetch(url);
  if (!res.ok) throw new Error('search failed');
  return (await res.json()).products || [];
}

/* ---------- Barcode scanning ---------- */
let codeReader = null;
async function startScan() {
  $('addSheet').classList.add('hidden');
  $('scanModal').classList.remove('hidden');
  $('scanStatus').textContent = '';
  try {
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8,
      ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E,
      ZXing.BarcodeFormat.CODE_128,
    ]);
    codeReader = new ZXing.BrowserMultiFormatReader(hints);
    await codeReader.decodeFromConstraints(
      { video: { facingMode: 'environment' } },
      $('scanVideo'),
      async (result) => {
        if (!result) return;
        const code = result.getText();
        stopScan();
        toast('Looking up ' + code + '…');
        try {
          const prefill = await lookupBarcode(code);
          if (prefill) openEntryForm(null, prefill);
          else { toast('Not found in database — enter it manually'); openEntryForm(null, { barcode: code }); }
        } catch {
          toast('Lookup failed — check your connection');
          openEntryForm(null, { barcode: code });
        }
      }
    );
  } catch (err) {
    $('scanStatus').textContent =
      'Camera unavailable. Check Settings → Safari (or the app) → Camera access. (' + err.message + ')';
  }
}
function stopScan() {
  if (codeReader) { try { codeReader.reset(); } catch {} codeReader = null; }
  $('scanModal').classList.add('hidden');
}

/* ---------- Search UI ---------- */
async function runSearch() {
  const q = $('searchInput').value.trim();
  if (!q) return;
  const box = $('searchResults');
  box.innerHTML = '<p class="search-msg">Searching…</p>';
  try {
    const products = (await searchFoods(q)).filter(p => p.product_name || p.generic_name);
    if (!products.length) { box.innerHTML = '<p class="search-msg">No results. Try another name or scan the barcode.</p>'; return; }
    box.innerHTML = '';
    for (const p of products) {
      const pre = productToPrefill(p);
      const b = document.createElement('button');
      b.className = 'entry';
      b.innerHTML = `<span class="thumb">🍎</span><span class="e-main">
        <span class="e-name">${esc(pre.name)}</span>
        <span class="e-sub">${esc(pre.brand || '')}</span></span>
        <span class="e-kcal">${pre.per100.kcal !== undefined ? fmt(pre.per100.kcal, 0) : '–'}<small> kcal/100g</small></span>`;
      b.onclick = () => { $('searchModal').classList.add('hidden'); openEntryForm(null, pre); };
      box.appendChild(b);
    }
  } catch {
    box.innerHTML = '<p class="search-msg">Search failed — check your connection.</p>';
  }
}

/* ---------- Settings ---------- */
function openSettings() {
  $('gKcal').value = goals.kcal || '';
  $('gProtein').value = goals.protein || '';
  $('gCarbs').value = goals.carbs || '';
  $('gFat').value = goals.fat || '';
  $('settingsModal').classList.remove('hidden');
}
function saveSettings(ev) {
  ev.preventDefault();
  goals = {
    kcal: Number($('gKcal').value) || 0,
    protein: Number($('gProtein').value) || 0,
    carbs: Number($('gCarbs').value) || 0,
    fat: Number($('gFat').value) || 0,
  };
  localStorage.setItem('nutrilog-goals', JSON.stringify(goals));
  $('settingsModal').classList.add('hidden');
  render();
  toast('Goals saved ✓');
}

/* ---------- Wire-up ---------- */
function shiftDay(delta) {
  const d = new Date(currentDate + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  currentDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  loadDay();
}

async function main() {
  await openDB();
  await loadDay();

  $('prevDay').onclick = () => shiftDay(-1);
  $('nextDay').onclick = () => shiftDay(1);
  $('dateLabel').onclick = () => { currentDate = todayStr(); loadDay(); };
  $('settingsBtn').onclick = openSettings;

  $('addBtn').onclick = () => $('addSheet').classList.remove('hidden');
  document.querySelector('#addSheet [data-close]').onclick = () => $('addSheet').classList.add('hidden');

  $('optScan').onclick = startScan;
  $('optPhoto').onclick = () => { $('addSheet').classList.add('hidden'); openEntryForm(null, {}); setTimeout(pickPhoto, 150); };
  $('optSearch').onclick = () => {
    $('addSheet').classList.add('hidden');
    $('searchResults').innerHTML = ''; $('searchInput').value = '';
    $('searchModal').classList.remove('hidden');
    setTimeout(() => $('searchInput').focus(), 100);
  };
  $('optManual').onclick = () => { $('addSheet').classList.add('hidden'); openEntryForm(null, {}); };

  $('scanCancel').onclick = stopScan;

  document.querySelector('[data-close-search]').onclick = () => $('searchModal').classList.add('hidden');
  $('searchGo').onclick = runSearch;
  $('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });

  document.querySelector('[data-close-entry]').onclick = closeEntryForm;
  $('entryForm').addEventListener('submit', submitEntry);
  $('photoBtn').onclick = pickPhoto;
  $('photoInput').addEventListener('change', e => { if (e.target.files[0]) handlePhoto(e.target.files[0]); e.target.value = ''; });
  $('fAmount').addEventListener('input', applyAmount);
  $('moreNutrients').onclick = () => {
    showAllForm = !showAllForm;
    $('moreNutrients').textContent = showAllForm ? 'Fewer nutrients ▴' : 'More nutrients ▾';
    for (const l of document.querySelectorAll('#nutrientInputs label[data-core="false"]'))
      l.classList.toggle('hidden', !showAllForm);
  };
  $('deleteEntry').onclick = async () => {
    if (editingId && confirm('Delete this entry?')) {
      await removeEntry(editingId);
      closeEntryForm();
      await loadDay();
      toast('Deleted');
    }
  };

  document.querySelector('[data-close-settings]').onclick = () => $('settingsModal').classList.add('hidden');
  $('settingsForm').addEventListener('submit', saveSettings);

  $('toggleNutrients').onclick = () => {
    const t = $('nutrientTable');
    t.classList.toggle('hidden');
    $('toggleNutrients').textContent = t.classList.contains('hidden')
      ? 'Show all nutrients ▾' : 'Hide nutrients ▴';
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

main();
