/* NutriLog — local calorie & nutrient tracker (PWA)
   Food data stays on-device (IndexedDB). Barcode/search lookups use the free
   Open Food Facts database. Optional AI photo analysis calls the Claude API
   with the user's own key. */

'use strict';

const APP_VERSION = '2.8';

/* ---------- Nutrient definitions ----------
   off    = Open Food Facts nutriments key (per 100g, grams except kcal)
   factor = converts OFF grams to display unit
   dv     = FDA adult daily value in display units (goalKey: user goal overrides)
   limit  = true when the target is a ceiling (stay under), not a goal */
const NUTRIENTS = [
  { key: 'kcal',        label: 'Calories',      unit: 'kcal', off: 'energy-kcal',   factor: 1,   core: true, dv: 2000, goalKey: 'kcal' },
  { key: 'protein',     label: 'Protein',       unit: 'g',    off: 'proteins',      factor: 1,   core: true, dv: 50,   goalKey: 'protein' },
  { key: 'carbs',       label: 'Carbs',         unit: 'g',    off: 'carbohydrates', factor: 1,   core: true, dv: 275,  goalKey: 'carbs' },
  { key: 'fat',         label: 'Fat',           unit: 'g',    off: 'fat',           factor: 1,   core: true, dv: 78,   goalKey: 'fat' },
  { key: 'sugar',       label: 'Sugar',         unit: 'g',    off: 'sugars',        factor: 1,   core: true, dv: 50,   limit: true },
  { key: 'fiber',       label: 'Fiber',         unit: 'g',    off: 'fiber',         factor: 1,   core: true, dv: 28 },
  { key: 'satfat',      label: 'Saturated fat', unit: 'g',    off: 'saturated-fat', factor: 1,   dv: 20,   limit: true },
  { key: 'transfat',    label: 'Trans fat',     unit: 'g',    off: 'trans-fat',     factor: 1 },
  { key: 'cholesterol', label: 'Cholesterol',   unit: 'mg',   off: 'cholesterol',   factor: 1000, dv: 300, limit: true },
  { key: 'sodium',      label: 'Sodium',        unit: 'mg',   off: 'sodium',        factor: 1000, dv: 2300, limit: true },
  { key: 'potassium',   label: 'Potassium',     unit: 'mg',   off: 'potassium',     factor: 1000, dv: 4700 },
  { key: 'calcium',     label: 'Calcium',       unit: 'mg',   off: 'calcium',       factor: 1000, dv: 1300 },
  { key: 'iron',        label: 'Iron',          unit: 'mg',   off: 'iron',          factor: 1000, dv: 18 },
  { key: 'magnesium',   label: 'Magnesium',     unit: 'mg',   off: 'magnesium',     factor: 1000, dv: 420 },
  { key: 'zinc',        label: 'Zinc',          unit: 'mg',   off: 'zinc',          factor: 1000, dv: 11 },
  { key: 'vita',        label: 'Vitamin A',     unit: 'µg',   off: 'vitamin-a',     factor: 1e6,  dv: 900 },
  { key: 'vitc',        label: 'Vitamin C',     unit: 'mg',   off: 'vitamin-c',     factor: 1000, dv: 90 },
  { key: 'vitd',        label: 'Vitamin D',     unit: 'µg',   off: 'vitamin-d',     factor: 1e6,  dv: 20 },
  { key: 'vite',        label: 'Vitamin E',     unit: 'mg',   off: 'vitamin-e',     factor: 1000, dv: 15 },
  { key: 'vitb12',      label: 'Vitamin B12',   unit: 'µg',   off: 'vitamin-b12',   factor: 1e6,  dv: 2.4 },
  { key: 'caffeine',    label: 'Caffeine',      unit: 'mg',   off: 'caffeine',      factor: 1000, dv: 400, limit: true },
  { key: 'alcohol',     label: 'Alcohol',       unit: 'g',    off: 'alcohol',       factor: 1 },
];
const MACRO_KEYS = ['protein', 'carbs', 'fat'];
const MEALS = [
  { key: 'breakfast', label: 'Breakfast', ico: '🌅' },
  { key: 'lunch',     label: 'Lunch',     ico: '☀️' },
  { key: 'dinner',    label: 'Dinner',    ico: '🌙' },
  { key: 'snacks',    label: 'Snacks',    ico: '🍿' },
];
const GLASS_ML = 250, WATER_GOAL = 8;

/* ---------- IndexedDB ---------- */
let db;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('nutrilog', 4);
    req.onupgradeneeded = (ev) => {
      const d = req.result;
      if (ev.oldVersion < 1) {
        d.createObjectStore('entries', { keyPath: 'id' }).createIndex('date', 'date');
      }
      if (ev.oldVersion < 2) {
        d.createObjectStore('metrics', { keyPath: 'date' }); // {date, water, weight, steps}
      }
      if (ev.oldVersion < 3) {
        d.createObjectStore('peptides', { keyPath: 'id' });  // {id, name, dose, days[0-6], time, notes}
        d.createObjectStore('doses', { keyPath: 'key' });    // {key: pepId|date, pepId, date, time}
      }
      if (ev.oldVersion < 4) {
        d.createObjectStore('foods', { keyPath: 'key' });    // library of every food ever logged
      }
    };
    req.onsuccess = () => { db = req.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}
function idbPut(store, val) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(val);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
function idbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function entriesForDate(date) {
  return new Promise((resolve, reject) => {
    const req = db.transaction('entries').objectStore('entries').index('date').getAll(date);
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.id - b.id));
    req.onerror = () => reject(req.error);
  });
}

/* ---------- State ---------- */
const $ = id => document.getElementById(id);
function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const todayStr = () => toDateStr(new Date());

let currentDate = todayStr();
let dayEntries = [];
let dayMetrics = { water: 0, weight: null };
let editingId = null;
let formPhoto = null;
let formPer100 = null;
let formBarcode = null;
let formMeal = 'snacks';
let showAllForm = false;
let showTargets = false;
let goals = JSON.parse(localStorage.getItem('nutrilog-goals') || '{}');
let settings = JSON.parse(localStorage.getItem('nutrilog-settings') || '{"unit":"kg"}');

function targetFor(n) {
  if (n.goalKey && Number(goals[n.goalKey])) return Number(goals[n.goalKey]);
  return n.dv || 0;
}
function mealByHour(h) {
  if (h >= 4 && h < 11) return 'breakfast';
  if (h >= 11 && h < 16) return 'lunch';
  if (h >= 16 && h < 22) return 'dinner';
  return 'snacks';
}

/* ---------- Formatting ---------- */
function fmt(n, digits) {
  if (!isFinite(n)) return '0';
  const d = digits !== undefined ? digits : (n >= 100 ? 0 : n >= 10 ? 1 : 2);
  return (+n.toFixed(d)).toLocaleString();
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function dateLabelText(dateStr) {
  if (dateStr === todayStr()) return 'Today';
  const d = new Date(dateStr + 'T12:00:00');
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/* ---------- Diary rendering ---------- */
function totalsFor(entries) {
  const t = {};
  for (const n of NUTRIENTS) t[n.key] = 0;
  for (const e of entries)
    for (const n of NUTRIENTS)
      t[n.key] += Number(e.nutrients?.[n.key]) || 0;
  return t;
}

function renderDiary() {
  $('dateLabel').textContent = dateLabelText(currentDate);
  const totals = totalsFor(dayEntries);

  // Calories ring + remaining
  $('kcalTotal').textContent = fmt(totals.kcal, 0);
  const goal = targetFor(NUTRIENTS[0]);
  const left = goal - totals.kcal;
  $('kcalGoalText').textContent = left >= 0
    ? `of ${fmt(goal, 0)} kcal · ${fmt(left, 0)} left`
    : `of ${fmt(goal, 0)} kcal · ${fmt(-left, 0)} over`;
  const pct = Math.min(totals.kcal / goal, 1);
  $('kcalRing').style.strokeDashoffset = 264 * (1 - pct);
  $('kcalPct').textContent = Math.round((totals.kcal / goal) * 100) + '%';

  // Macro tiles
  $('macroGrid').innerHTML = MACRO_KEYS.map(k => {
    const n = NUTRIENTS.find(x => x.key === k);
    const g = targetFor(n);
    const p = Math.min(totals[k] / g * 100, 100);
    return `<div class="macro"><div class="m-label">${n.label}</div>
      <div class="m-val">${fmt(totals[k])}<small>/${fmt(g, 0)}${n.unit}</small></div>
      <div class="bar"><i style="width:${p}%"></i></div></div>`;
  }).join('');

  // Nutrient target bars (Cronometer-style)
  $('nutrientTable').innerHTML = NUTRIENTS.map(n => {
    const t = targetFor(n);
    const v = totals[n.key];
    if (!t) return `<div class="trow"><span class="t-name">${n.label}</span>
      <span class="t-val">${fmt(v)} ${n.unit}</span><div class="t-bar"></div></div>`;
    const p = Math.min(v / t * 100, 100);
    const over = n.limit && v > t;
    return `<div class="trow"><span class="t-name">${n.label}${n.limit ? ' <small class="muted">(limit)</small>' : ''}</span>
      <span class="t-val">${fmt(v)} / ${fmt(t)} ${n.unit}</span>
      <div class="t-bar"><i class="${over ? 'over' : ''}" style="width:${p}%"></i></div></div>`;
  }).join('');

  // Water
  const water = dayMetrics.water || 0;
  $('waterCount').textContent = water;
  $('waterMl').textContent = `${water * GLASS_ML} ml`;

  // Steps
  $('stepsCount').textContent = dayMetrics.steps ? fmt(dayMetrics.steps, 0) : '—';

  // Meals
  const box = $('mealSections');
  box.innerHTML = '';
  for (const meal of MEALS) {
    const items = dayEntries.filter(e => (e.meal || 'snacks') === meal.key);
    const kcal = items.reduce((s, e) => s + (Number(e.nutrients?.kcal) || 0), 0);
    const sec = document.createElement('section');
    sec.innerHTML = `<div class="meal-head"><span>${meal.ico} ${meal.label}</span>
      <span class="muted">${items.length ? fmt(kcal, 0) + ' kcal' : '—'}</span></div>`;
    const list = document.createElement('div');
    list.className = 'entry-list';
    for (const e of items) {
      const btn = document.createElement('button');
      btn.className = 'entry';
      const thumb = e.photo ? `<img class="thumb" src="${e.photo}" alt="">` : `<span class="thumb">🍽️</span>`;
      const sub = [e.time, e.brand, e.amount ? fmt(e.amount, 0) + ' g' : null].filter(Boolean).join(' · ');
      btn.innerHTML = `${thumb}<span class="e-main"><span class="e-name">${esc(e.name)}</span>
        <span class="e-sub">${esc(sub)}</span></span>
        <span class="e-kcal">${fmt(e.nutrients?.kcal || 0, 0)}<small> kcal</small></span>`;
      btn.onclick = () => openEntryForm(e);
      list.appendChild(btn);
    }
    sec.appendChild(list);
    box.appendChild(sec);
  }
}

async function loadDay() {
  dayEntries = await entriesForDate(currentDate);
  dayMetrics = (await idbGet('metrics', currentDate)) || { date: currentDate, water: 0, weight: null };
  renderDiary();
  updateStreak();
  updatePepBanner();
}

/* ---------- Logging streak ---------- */
async function updateStreak() {
  let streak = 0;
  const d = new Date();
  // today counts if logged; otherwise the streak may still be alive from yesterday
  if ((await entriesForDate(toDateStr(d))).length) streak++;
  for (let i = 1; i <= 60; i++) {
    const day = new Date(); day.setDate(day.getDate() - i);
    if ((await entriesForDate(toDateStr(day))).length) streak++;
    else break;
  }
  const chip = $('streakChip');
  chip.classList.toggle('hidden', streak < 2);
  if (streak >= 2) chip.textContent = `🔥 ${streak}-day logging streak`;
}

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
}

/* ---------- Entry form ---------- */
function buildNutrientInputs() {
  $('nutrientInputs').innerHTML = NUTRIENTS.map(n =>
    `<label data-core="${!!n.core}" ${n.core || showAllForm ? '' : 'class="hidden"'}>
       ${n.label} <small>(${n.unit})</small>
       <input data-nkey="${n.key}" type="number" inputmode="decimal" min="0" step="any" placeholder="0">
     </label>`).join('');
}
function renderMealChips() {
  $('mealChips').innerHTML = MEALS.map(m =>
    `<button type="button" data-meal="${m.key}" class="chip ${formMeal === m.key ? 'sel' : ''}">${m.label}</button>`).join('');
  for (const b of document.querySelectorAll('#mealChips .chip'))
    b.onclick = () => { formMeal = b.dataset.meal; renderMealChips(); };
}

function openEntryForm(entry, prefill) {
  editingId = entry ? entry.id : null;
  formPhoto = entry?.photo || prefill?.photo || null;
  formPer100 = entry?.per100 || prefill?.per100 || null;
  formBarcode = entry?.barcode || prefill?.barcode || null;
  formMeal = entry?.meal || prefill?.meal || mealByHour(new Date().getHours());
  showAllForm = false;
  buildNutrientInputs();
  renderMealChips();

  $('entryTitle').textContent = entry ? 'Edit food' : 'Add food';
  $('fName').value = entry?.name || prefill?.name || '';
  $('fBrand').value = entry?.brand || prefill?.brand || '';
  $('deleteEntry').classList.toggle('hidden', !entry);
  $('moreNutrients').textContent = 'More nutrients ▾';
  $('aiStatus').classList.add('hidden');

  const pv = $('photoPreview');
  if (formPhoto) { pv.src = formPhoto; pv.classList.remove('hidden'); }
  else pv.classList.add('hidden');
  updateAiButton();

  const hasProduct = !!formPer100;
  $('amountBlock').classList.toggle('hidden', !hasProduct);
  $('servingBtns').innerHTML = '';
  if (hasProduct) {
    const amount = entry?.amount || prefill?.amount || 100;
    $('fAmount').value = amount;
    const sq = prefill?.servingQty || entry?.servingQty;
    const sl = prefill?.servingLabel || entry?.servingLabel;
    if (sq) $('entryForm').dataset.servingQty = sq;
    if (sl) $('entryForm').dataset.servingLabel = sl; else delete $('entryForm').dataset.servingLabel;
    const chips = [['100 g', 100]];
    if (sq) chips.unshift([`${sl || '1 serving'} (${fmt(sq, 0)} g)`, sq]);
    for (const [label, grams] of chips) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label;
      b.onclick = () => { $('fAmount').value = grams; applyAmount(); };
      $('servingBtns').appendChild(b);
    }
  } else {
    delete $('entryForm').dataset.servingQty;
    delete $('entryForm').dataset.servingLabel;
  }

  if (!entry && hasProduct) {
    const gaps = NUTRIENTS.filter(n => n.core && formPer100[n.key] === undefined).length;
    if (gaps >= 2) {
      $('aiStatus').classList.remove('hidden');
      $('aiStatus').textContent =
        'ℹ️ This product’s database entry is incomplete (' + gaps +
        ' basics missing). Photograph its nutrition label and tap ✨ to read the exact values.';
    }
  }

  const source = entry?.nutrients
    || prefill?.nutrients
    || (hasProduct ? scaledNutrients(formPer100, Number($('fAmount').value) || 100) : {});
  for (const inp of document.querySelectorAll('#nutrientInputs input')) {
    const v = source[inp.dataset.nkey];
    inp.value = (v !== undefined && v !== null && v !== '') ? +Number(v).toFixed(2) : '';
  }

  $('entryModal').classList.remove('hidden');
}

function scaledNutrients(per100, grams) {
  const out = {};
  for (const n of NUTRIENTS)
    if (per100[n.key] !== undefined) out[n.key] = per100[n.key] * grams / 100;
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

/* ---------- My Foods library: every food/drink ever logged ---------- */
const foodKey = e => ((e.name || '') + '|' + (e.brand || '')).toLowerCase().trim();

async function rememberFood(entry, ts) {
  if (!entry.name) return;
  const key = foodKey(entry);
  const prev = await idbGet('foods', key);
  await idbPut('foods', {
    key,
    name: entry.name,
    brand: entry.brand || '',
    per100: entry.per100 || prev?.per100 || null,
    servingQty: entry.servingQty || prev?.servingQty || null,
    servingLabel: entry.servingLabel || prev?.servingLabel || null,
    amount: entry.amount || prev?.amount || null,
    nutrients: entry.nutrients || prev?.nutrients || {},
    barcode: entry.barcode || prev?.barcode || null,
    uses: (prev?.uses || 0) + 1,
    lastUsed: ts ?? Date.now(),
  });
}

/* One-time: seed the library from everything already logged */
async function backfillFoods() {
  if (localStorage.getItem('nutrilog-foods-v1')) return;
  const entries = (await idbGetAll('entries')).sort((a, b) => a.id - b.id);
  for (const e of entries) await rememberFood(e, e.id);
  for (const r of JSON.parse(localStorage.getItem('nutrilog-recents') || '[]'))
    await rememberFood(r);
  localStorage.setItem('nutrilog-foods-v1', '1');
}

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
    meal: formMeal,
    amount: formPer100 ? (Number($('fAmount').value) || null) : null,
    photo: formPhoto,
    per100: formPer100,
    barcode: formBarcode,
    servingQty: Number($('entryForm').dataset.servingQty) || null,
    servingLabel: $('entryForm').dataset.servingLabel || null,
    nutrients,
  };
  const wasEdit = !!editingId;
  await idbPut('entries', entry);
  await rememberFood(entry);
  closeEntryForm();
  await loadDay();
  toast(wasEdit ? 'Updated ✓' : 'Added to your log ✓');
}

/* ---------- Photos ---------- */
function pickPhoto() { $('photoInput').click(); }
function pickGallery() { $('galleryInput').click(); }
function handlePhoto(file) {
  const img = new Image();
  img.onerror = () => {
    URL.revokeObjectURL(img.src);
    toast('⚠️ Couldn’t read that image — try another one');
  };
  img.onload = () => {
    const max = 1100;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    formPhoto = c.toDataURL('image/jpeg', 0.8);
    URL.revokeObjectURL(img.src);
    const pv = $('photoPreview');
    pv.src = formPhoto; pv.classList.remove('hidden');
    updateAiButton();
  };
  img.src = URL.createObjectURL(file);
}

/* ---------- AI nutrition analysis ----------
   Works from a photo, a typed description, or both. Accepts either a free
   Google Gemini key (AIza…, aistudio.google.com) or a Claude API key
   (sk-ant…, console.anthropic.com) — routed by key prefix. */
const AI_FIELDS =
  'name (string, short dish name), amount_g (number, estimated grams of the whole portion), ' +
  'kcal, protein, carbs, fat, sugar, fiber, satfat (numbers; grams except kcal), ' +
  'cholesterol, sodium, potassium, calcium, iron, vitc (numbers, in mg), ' +
  'vita, vitd, vitb12 (numbers, in µg), confidence ("low"|"medium"|"high")';

const AI_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short name of the dish or food' },
    amount_g: { type: 'number', description: 'Estimated weight of the whole visible portion in grams' },
    kcal: { type: 'number' }, protein: { type: 'number' }, carbs: { type: 'number' },
    fat: { type: 'number' }, sugar: { type: 'number' }, fiber: { type: 'number' },
    satfat: { type: 'number' }, cholesterol: { type: 'number', description: 'mg' },
    sodium: { type: 'number', description: 'mg' }, potassium: { type: 'number', description: 'mg' },
    calcium: { type: 'number', description: 'mg' }, iron: { type: 'number', description: 'mg' },
    vita: { type: 'number', description: 'Vitamin A in µg RAE' },
    vitc: { type: 'number', description: 'Vitamin C in mg' },
    vitd: { type: 'number', description: 'Vitamin D in µg' },
    vitb12: { type: 'number', description: 'Vitamin B12 in µg' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['name', 'amount_g', 'kcal', 'protein', 'carbs', 'fat', 'sugar', 'fiber',
             'satfat', 'cholesterol', 'sodium', 'potassium', 'calcium', 'iron',
             'vita', 'vitc', 'vitd', 'vitb12', 'confidence'],
  additionalProperties: false,
};

function updateAiButton() {
  $('aiBtn').textContent = formPhoto ? '✨ Analyze photo with AI' : '✨ Estimate from name with AI';
  $('aiBtn').classList.remove('hidden');
}

function aiPrompt(desc) {
  let p = 'You are a nutrition expert using USDA-typical nutrient values. ';
  if (formPhoto) {
    p += 'If the photo shows a Nutrition Facts or Supplement Facts label, READ the exact ' +
         'printed values for one serving (set amount_g to the printed serving size, and set ' +
         'any nutrient the label lists as 0 to 0; nutrients the label does not mention, ' +
         'estimate from the ingredients or set to 0). Otherwise, estimate the nutrition of ' +
         'the food in this photo, judging the portion size from visual cues (plate size, ' +
         'utensils, packaging). ';
    if (desc) p += `The user describes it as: "${desc}". `;
  } else {
    p += `Estimate the nutrition of this food: "${desc}". ` +
         'Assume one typical serving unless the description states a quantity. ';
  }
  p += 'Give totals for the whole portion (not per 100 g).';
  return p;
}

/* Tolerant JSON extraction: handles markdown fences, prose around the object,
   trailing commas, and truncated output (closes open strings/braces). */
function parseAiJson(raw) {
  let t = String(raw).trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = t.indexOf('{');
  if (start < 0) throw new Error('no JSON in answer');
  t = t.slice(start);
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  let candidate = end >= 0 ? t.slice(0, end + 1) : t;
  try { return JSON.parse(candidate); } catch {}
  let fixed = candidate;
  if (end < 0) { // truncated mid-object: close what's open
    if (inStr) fixed += '"';
    fixed = fixed.replace(/[,:]\s*$/, '');
    fixed += '}'.repeat(Math.max(1, depth));
  }
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(fixed); // throws to caller if still unreadable
}

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-2.0-flash'];
const AI_TIMEOUT_MS = 20000;   // per request
const AI_DEADLINE_MS = 60000;  // whole analysis

function fetchT(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(t));
}

/* The AI doesn't need full resolution — a small JPEG uploads much faster on
   weak signal. The stored photo keeps its original quality. */
function shrinkForAi(dataUrl, max = 768, q = 0.72) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      if (s >= 1) return resolve(dataUrl);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', q));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function friendlyGeminiError(status, msg) {
  if (msg === 'network')
    return 'Slow or no connection — the AI couldn’t be reached. Check your signal and tap ✨ again.';
  if (/^garbled:/.test(msg))
    return 'The AI answer came back garbled — tap ✨ to try again. (' + msg.slice(8) + '…)';
  if (/API key not valid|API_KEY_INVALID|API key expired/i.test(msg))
    return 'Gemini rejected the key. Re-copy the whole key (starts with AIza or AQ.) from aistudio.google.com/apikey and paste it again in Settings.';
  if (status === 503 || /high demand|overloaded/i.test(msg))
    return 'Google’s free AI is busy right now — wait a few seconds and tap ✨ again.';
  if (status === 429) {
    if (/PerDay|per day|daily/i.test(msg))
      return 'Today’s free AI allowance is used up — it resets at midnight Pacific time. Barcodes, search, and manual entry still work.';
    return 'Google is rate-limiting short bursts — wait about a minute, then tap ✨ again.';
  }
  if (status === 403) return 'This key isn’t allowed here — create a plain key at aistudio.google.com/apikey without website restrictions.';
  return 'Gemini: ' + msg;
}

// Busy/quota/retired responses hop to the next free model; a second pass after
// a pause covers brief demand spikes before we give up.
async function geminiEstimate(key, desc) {
  const parts = [];
  if (formPhoto)
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: (await shrinkForAi(formPhoto)).split(',')[1] } });
  parts.push({ text: aiPrompt(desc) +
    ` Respond with ONLY a JSON object with exactly these keys: ${AI_FIELDS}.` });
  let lastStatus = 503, lastMsg = 'high demand';
  const started = Date.now();
  let tryNo = 0, retryHintSec = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const model of GEMINI_MODELS) {
      if (Date.now() - started > AI_DEADLINE_MS) throw new Error(friendlyGeminiError(lastStatus, lastMsg));
      if (++tryNo > 1) $('aiStatus').textContent = `✨ Still working — backup attempt ${tryNo}…`;
      let res;
      try {
        res = await fetchT(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
          }),
        }, AI_TIMEOUT_MS);
      } catch {
        // timed out or dropped connection — transient, try the next model
        lastStatus = 0; lastMsg = 'network';
        continue;
      }
      if (res.ok) {
        const data = await res.json();
        // skip "thought" parts some models emit; keep answer text only
        const text = (data.candidates?.[0]?.content?.parts || [])
          .filter(p => !p.thought).map(p => p.text || '').join('');
        try {
          if (!text) throw new Error('empty');
          return parseAiJson(text);
        } catch {
          // garbled/empty answer — treat as transient and try the next model
          lastStatus = 0; lastMsg = 'garbled:' + text.slice(0, 60);
          continue;
        }
      }
      const err = await res.json().catch(() => ({}));
      const details = JSON.stringify(err?.error?.details || []);
      const msg = (err?.error?.message || `error ${res.status}`) +
                  (res.status === 429 ? ' ' + details : '');
      const transient = [404, 429, 503].includes(res.status) || /high demand|overloaded/i.test(msg);
      if (!transient) throw new Error(friendlyGeminiError(res.status, msg));
      lastStatus = res.status; lastMsg = msg;
      const rd = details.match(/"retryDelay"\s*:\s*"(\d+)/);
      if (rd) retryHintSec = Math.min(+rd[1], 25);
    }
    if (attempt === 0) {
      if (/PerDay|per day|daily/i.test(lastMsg)) break; // daily quota — waiting won't help
      const waitMs = retryHintSec ? retryHintSec * 1000 : 2500;
      if (Date.now() - started + waitMs > AI_DEADLINE_MS) break;
      $('aiStatus').textContent = retryHintSec
        ? `✨ Google asked for a ${retryHintSec}s pause — waiting, then retrying…`
        : '✨ Google is busy — retrying…';
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw new Error(friendlyGeminiError(lastStatus, lastMsg));
}

async function claudeEstimate(key, desc) {
  const content = [];
  if (formPhoto)
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: (await shrinkForAi(formPhoto)).split(',')[1] } });
  content.push({ type: 'text', text: aiPrompt(desc) });
  const res = await fetchT('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 2048,
      messages: [{ role: 'user', content }],
      output_config: { format: { type: 'json_schema', schema: AI_SCHEMA } },
    }),
  }, AI_DEADLINE_MS).catch(() => {
    throw new Error('Slow or no connection — the AI couldn’t be reached. Check your signal and try again.');
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Claude API error ${res.status}`);
  }
  const msg = await res.json();
  if (msg.stop_reason === 'refusal') throw new Error('The AI declined to analyze this');
  const text = (msg.content || []).find(b => b.type === 'text')?.text;
  if (!text) throw new Error('No answer returned — try again');
  return parseAiJson(text);
}

async function aiAnalyze() {
  const key = (settings.apiKey || '').trim();
  const status = $('aiStatus');
  status.classList.remove('hidden');
  if (!key) {
    status.textContent = 'Add a free Gemini key (or a Claude key) in Settings ⚙ to enable AI.';
    return;
  }
  const desc = [$('fName').value.trim(), $('fBrand').value.trim()].filter(Boolean).join(' by ');
  if (!formPhoto && !desc) {
    status.textContent = 'Type a food name or add a photo first.';
    return;
  }
  if (navigator.onLine === false) {
    status.textContent = '⚠️ No internet connection — the AI needs to be online.';
    return;
  }
  status.textContent = formPhoto ? '✨ Analyzing photo…' : '✨ Estimating from description…';
  $('aiBtn').disabled = true;
  try {
    // Claude keys start with sk-ant; Google keys are AIza… (classic) or AQ.… (new
    // format) — treat everything non-Claude as a Gemini key.
    const est = key.startsWith('sk-ant')
      ? await claudeEstimate(key, desc)
      : await geminiEstimate(key, desc);
    if (!$('fName').value.trim()) $('fName').value = est.name || '';
    for (const inp of document.querySelectorAll('#nutrientInputs input')) {
      const v = est[inp.dataset.nkey];
      if (typeof v === 'number' && isFinite(v)) inp.value = +v.toFixed(1);
    }
    // Fill gaps in the product's per-100g data so serving-size scaling
    // (and the My Foods library) keep the AI-read values
    if (formPer100 && typeof est.amount_g === 'number' && est.amount_g > 0) {
      for (const n of NUTRIENTS) {
        const v = est[n.key];
        if (formPer100[n.key] === undefined && typeof v === 'number' && isFinite(v))
          formPer100[n.key] = v / est.amount_g * 100;
      }
      const grams = Number($('fAmount').value);
      if (!grams) $('fAmount').value = est.amount_g;
    }
    status.textContent = `✨ Estimated ~${fmt(est.amount_g, 0)} g portion (confidence: ${est.confidence || 'medium'}). Adjust anything that looks off.`;
  } catch (e) {
    status.textContent = '⚠️ ' + e.message;
  } finally {
    $('aiBtn').disabled = false;
  }
}

/* ---------- Open Food Facts ---------- */
function productToPrefill(p) {
  const nutr = p.nutriments || {};
  const per100 = {};
  for (const n of NUTRIENTS) {
    const v = nutr[n.off + '_100g'];
    if (v !== undefined && v !== '' && v !== null) per100[n.key] = Number(v) * n.factor;
  }
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
  closeSheet();
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
          else { toast('Not in database — enter it manually'); openEntryForm(null, { barcode: code }); }
        } catch {
          toast('Lookup failed — check your connection');
          openEntryForm(null, { barcode: code });
        }
      }
    );
  } catch (err) {
    $('scanStatus').textContent =
      'Camera unavailable. Check camera permission for this app. (' + err.message + ')';
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


/* ---------- Basic foods (built-in, USDA-typical values per 100 g) ----------
   n=name c=category s=typical serving grams l=serving label v=per-100g */
const CAT_ICONS = { protein: '🥩', veg: '🥦', fruit: '🍎', carb: '🍚', dairy: '🥛', nuts: '🥜', drink: '☕' };
const BASIC_CATS = [
  ['protein', '🥩 Protein'], ['veg', '🥦 Veggies'], ['fruit', '🍎 Fruits'],
  ['carb', '🍚 Carbs'], ['dairy', '🥛 Dairy'], ['nuts', '🥜 Nuts & oils'], ['drink', '☕ Drinks'],
];
const BASIC_FOODS = [
  { n: 'Egg', c: 'protein', s: 50, l: '1 large egg', v: { kcal: 143, protein: 12.6, carbs: 0.7, fat: 9.5, sugar: 0.4, satfat: 3.1, cholesterol: 372, sodium: 142, vita: 160, vitd: 2, vitb12: 0.9 } },
  { n: 'Egg white', c: 'protein', s: 33, l: '1 egg white', v: { kcal: 52, protein: 10.9, carbs: 0.7, fat: 0.2, sodium: 166 } },
  { n: 'Chicken breast (cooked)', c: 'protein', s: 140, l: '1 breast', v: { kcal: 165, protein: 31, carbs: 0, fat: 3.6, satfat: 1, cholesterol: 85, sodium: 74, potassium: 256 } },
  { n: 'Ground beef 90% (cooked)', c: 'protein', s: 110, l: '4 oz', v: { kcal: 217, protein: 26, carbs: 0, fat: 12, satfat: 4.7, cholesterol: 86, iron: 2.4, zinc: 6, vitb12: 2.5 } },
  { n: 'Steak, sirloin (cooked)', c: 'protein', s: 170, l: '6 oz', v: { kcal: 212, protein: 29, carbs: 0, fat: 10, satfat: 3.9, cholesterol: 89, iron: 1.6, zinc: 5.5 } },
  { n: 'Salmon (cooked)', c: 'protein', s: 140, l: '1 fillet', v: { kcal: 206, protein: 22, carbs: 0, fat: 12, satfat: 2.5, cholesterol: 63, potassium: 384, vitd: 13 } },
  { n: 'Tuna (canned in water)', c: 'protein', s: 120, l: '1 can drained', v: { kcal: 116, protein: 25.5, carbs: 0, fat: 0.8, sodium: 338, vitd: 1.7, vitb12: 2.5 } },
  { n: 'Shrimp (cooked)', c: 'protein', s: 85, l: '~9 large', v: { kcal: 99, protein: 24, carbs: 0.2, fat: 0.3, cholesterol: 189, sodium: 111 } },
  { n: 'Turkey breast', c: 'protein', s: 85, l: '3 oz', v: { kcal: 135, protein: 30, carbs: 0, fat: 0.7, sodium: 99 } },
  { n: 'Bacon (cooked)', c: 'protein', s: 16, l: '2 slices', v: { kcal: 541, protein: 37, carbs: 1.4, fat: 42, satfat: 14, sodium: 1717, cholesterol: 110 } },
  { n: 'Tofu (firm)', c: 'protein', s: 85, l: '¼ block', v: { kcal: 78, protein: 8.9, carbs: 1.5, fat: 4.2, calcium: 201, iron: 1.6 } },
  { n: 'Whey protein powder', c: 'protein', s: 31, l: '1 scoop', v: { kcal: 375, protein: 75, carbs: 12.5, fat: 3, sugar: 5, calcium: 400 } },
  { n: 'Celery', c: 'veg', s: 40, l: '1 stalk', v: { kcal: 14, protein: 0.7, carbs: 3, fat: 0.2, sugar: 1.3, fiber: 1.6, sodium: 80, potassium: 260 } },
  { n: 'Broccoli', c: 'veg', s: 91, l: '1 cup', v: { kcal: 34, protein: 2.8, carbs: 6.6, fat: 0.4, sugar: 1.7, fiber: 2.6, vitc: 89, potassium: 316 } },
  { n: 'Spinach (raw)', c: 'veg', s: 30, l: '1 cup', v: { kcal: 23, protein: 2.9, carbs: 3.6, fat: 0.4, fiber: 2.2, vita: 469, iron: 2.7, magnesium: 79 } },
  { n: 'Carrot', c: 'veg', s: 61, l: '1 medium', v: { kcal: 41, protein: 0.9, carbs: 9.6, fat: 0.2, sugar: 4.7, fiber: 2.8, vita: 835, potassium: 320 } },
  { n: 'Cucumber', c: 'veg', s: 100, l: '⅓ cucumber', v: { kcal: 15, protein: 0.7, carbs: 3.6, fat: 0.1, sugar: 1.7, fiber: 0.5, potassium: 147 } },
  { n: 'Tomato', c: 'veg', s: 123, l: '1 medium', v: { kcal: 18, protein: 0.9, carbs: 3.9, fat: 0.2, sugar: 2.6, fiber: 1.2, vitc: 14, potassium: 237 } },
  { n: 'Bell pepper', c: 'veg', s: 119, l: '1 medium', v: { kcal: 26, protein: 1, carbs: 6, fat: 0.3, sugar: 4.2, fiber: 2.1, vitc: 128, vita: 157 } },
  { n: 'Onion', c: 'veg', s: 110, l: '1 medium', v: { kcal: 40, protein: 1.1, carbs: 9.3, fat: 0.1, sugar: 4.2, fiber: 1.7 } },
  { n: 'Lettuce (romaine)', c: 'veg', s: 47, l: '1 cup', v: { kcal: 17, protein: 1.2, carbs: 3.3, fat: 0.3, fiber: 2.1, vita: 436 } },
  { n: 'Avocado', c: 'veg', s: 100, l: '½ avocado', v: { kcal: 160, protein: 2, carbs: 8.5, fat: 14.7, satfat: 2.1, sugar: 0.7, fiber: 6.7, potassium: 485 } },
  { n: 'Green beans', c: 'veg', s: 100, l: '1 cup', v: { kcal: 31, protein: 1.8, carbs: 7, fat: 0.2, sugar: 3.3, fiber: 2.7, vitc: 12 } },
  { n: 'Asparagus', c: 'veg', s: 90, l: '6 spears', v: { kcal: 20, protein: 2.2, carbs: 3.9, fat: 0.1, sugar: 1.9, fiber: 2.1 } },
  { n: 'Mushrooms', c: 'veg', s: 70, l: '1 cup sliced', v: { kcal: 22, protein: 3.1, carbs: 3.3, fat: 0.3, fiber: 1, potassium: 318, vitd: 0.2 } },
  { n: 'Cauliflower', c: 'veg', s: 107, l: '1 cup', v: { kcal: 25, protein: 1.9, carbs: 5, fat: 0.3, sugar: 1.9, fiber: 2, vitc: 48 } },
  { n: 'Zucchini', c: 'veg', s: 124, l: '1 cup', v: { kcal: 17, protein: 1.2, carbs: 3.1, fat: 0.3, sugar: 2.5, fiber: 1, vitc: 18 } },
  { n: 'Kale', c: 'veg', s: 67, l: '1 cup', v: { kcal: 35, protein: 2.9, carbs: 4.4, fat: 1.5, fiber: 4.1, vita: 241, vitc: 93, calcium: 254 } },
  { n: 'Corn (sweet)', c: 'veg', s: 90, l: '1 ear', v: { kcal: 86, protein: 3.3, carbs: 18.7, fat: 1.4, sugar: 6.3, fiber: 2 } },
  { n: 'Peas', c: 'veg', s: 80, l: '½ cup', v: { kcal: 81, protein: 5.4, carbs: 14.5, fat: 0.4, sugar: 5.7, fiber: 5.7, vitc: 40 } },
  { n: 'Potato (baked, with skin)', c: 'carb', s: 173, l: '1 medium', v: { kcal: 93, protein: 2.5, carbs: 21.2, fat: 0.1, sugar: 1.2, fiber: 2.2, potassium: 535, vitc: 9.6 } },
  { n: 'Sweet potato (baked)', c: 'carb', s: 114, l: '1 medium', v: { kcal: 90, protein: 2, carbs: 20.7, fat: 0.2, sugar: 6.5, fiber: 3.3, vita: 961, potassium: 475 } },
  { n: 'White rice (cooked)', c: 'carb', s: 158, l: '1 cup', v: { kcal: 130, protein: 2.7, carbs: 28.2, fat: 0.3, fiber: 0.4 } },
  { n: 'Brown rice (cooked)', c: 'carb', s: 195, l: '1 cup', v: { kcal: 112, protein: 2.3, carbs: 23.5, fat: 0.8, fiber: 1.8, magnesium: 44 } },
  { n: 'Pasta (cooked)', c: 'carb', s: 140, l: '1 cup', v: { kcal: 158, protein: 5.8, carbs: 30.9, fat: 0.9, fiber: 1.8 } },
  { n: 'Oats (dry)', c: 'carb', s: 40, l: '½ cup dry', v: { kcal: 389, protein: 16.9, carbs: 66.3, fat: 6.9, sugar: 1, fiber: 10.6, iron: 4.7, magnesium: 177 } },
  { n: 'Bread, whole wheat', c: 'carb', s: 28, l: '1 slice', v: { kcal: 247, protein: 13, carbs: 41, fat: 3.4, sugar: 4.3, fiber: 6, sodium: 450 } },
  { n: 'Bread, white', c: 'carb', s: 28, l: '1 slice', v: { kcal: 265, protein: 9, carbs: 49, fat: 3.2, sugar: 5, fiber: 2.7, sodium: 490 } },
  { n: 'Quinoa (cooked)', c: 'carb', s: 185, l: '1 cup', v: { kcal: 120, protein: 4.4, carbs: 21.3, fat: 1.9, fiber: 2.8, magnesium: 64, iron: 1.5 } },
  { n: 'Flour tortilla', c: 'carb', s: 49, l: '1 tortilla', v: { kcal: 297, protein: 8, carbs: 49, fat: 7.3, sodium: 600, fiber: 2.9 } },
  { n: 'Bagel', c: 'carb', s: 105, l: '1 bagel', v: { kcal: 250, protein: 10, carbs: 49, fat: 1.5, sugar: 5, fiber: 2.1, sodium: 430 } },
  { n: 'Black beans (cooked)', c: 'carb', s: 86, l: '½ cup', v: { kcal: 132, protein: 8.9, carbs: 23.7, fat: 0.5, fiber: 8.7, iron: 2.1, magnesium: 70 } },
  { n: 'Lentils (cooked)', c: 'carb', s: 99, l: '½ cup', v: { kcal: 116, protein: 9, carbs: 20.1, fat: 0.4, fiber: 7.9, iron: 3.3 } },
  { n: 'Apple', c: 'fruit', s: 182, l: '1 medium', v: { kcal: 52, protein: 0.3, carbs: 13.8, fat: 0.2, sugar: 10.4, fiber: 2.4, vitc: 4.6 } },
  { n: 'Banana', c: 'fruit', s: 118, l: '1 medium', v: { kcal: 89, protein: 1.1, carbs: 22.8, fat: 0.3, sugar: 12.2, fiber: 2.6, potassium: 358 } },
  { n: 'Orange', c: 'fruit', s: 131, l: '1 medium', v: { kcal: 47, protein: 0.9, carbs: 11.8, fat: 0.1, sugar: 9.4, fiber: 2.4, vitc: 53 } },
  { n: 'Strawberries', c: 'fruit', s: 152, l: '1 cup', v: { kcal: 32, protein: 0.7, carbs: 7.7, fat: 0.3, sugar: 4.9, fiber: 2, vitc: 59 } },
  { n: 'Blueberries', c: 'fruit', s: 148, l: '1 cup', v: { kcal: 57, protein: 0.7, carbs: 14.5, fat: 0.3, sugar: 10, fiber: 2.4, vitc: 9.7 } },
  { n: 'Grapes', c: 'fruit', s: 92, l: '1 cup', v: { kcal: 69, protein: 0.7, carbs: 18.1, fat: 0.2, sugar: 15.5, fiber: 0.9 } },
  { n: 'Watermelon', c: 'fruit', s: 154, l: '1 cup', v: { kcal: 30, protein: 0.6, carbs: 7.6, fat: 0.2, sugar: 6.2, vita: 28, vitc: 8.1 } },
  { n: 'Peach', c: 'fruit', s: 150, l: '1 medium', v: { kcal: 39, protein: 0.9, carbs: 9.5, fat: 0.3, sugar: 8.4, fiber: 1.5 } },
  { n: 'Pear', c: 'fruit', s: 178, l: '1 medium', v: { kcal: 57, protein: 0.4, carbs: 15.2, fat: 0.1, sugar: 9.8, fiber: 3.1 } },
  { n: 'Pineapple', c: 'fruit', s: 165, l: '1 cup', v: { kcal: 50, protein: 0.5, carbs: 13.1, fat: 0.1, sugar: 9.9, fiber: 1.4, vitc: 48 } },
  { n: 'Mango', c: 'fruit', s: 165, l: '1 cup', v: { kcal: 60, protein: 0.8, carbs: 15, fat: 0.4, sugar: 13.7, fiber: 1.6, vita: 54, vitc: 36 } },
  { n: 'Milk, 2%', c: 'dairy', s: 244, l: '1 cup', v: { kcal: 50, protein: 3.3, carbs: 4.8, fat: 2, sugar: 4.9, satfat: 1.3, calcium: 120, vitd: 1.1, vitb12: 0.5 } },
  { n: 'Milk, whole', c: 'dairy', s: 244, l: '1 cup', v: { kcal: 61, protein: 3.2, carbs: 4.8, fat: 3.3, sugar: 5, satfat: 1.9, calcium: 113, vitd: 1.3 } },
  { n: 'Greek yogurt (plain, nonfat)', c: 'dairy', s: 170, l: '1 container', v: { kcal: 59, protein: 10.2, carbs: 3.6, fat: 0.4, sugar: 3.2, calcium: 110, vitb12: 0.8 } },
  { n: 'Cheddar cheese', c: 'dairy', s: 28, l: '1 oz', v: { kcal: 403, protein: 24.9, carbs: 1.3, fat: 33.1, satfat: 21, sodium: 621, calcium: 721 } },
  { n: 'Mozzarella', c: 'dairy', s: 28, l: '1 oz', v: { kcal: 280, protein: 27.5, carbs: 3.1, fat: 17.1, satfat: 10.9, sodium: 627, calcium: 505 } },
  { n: 'Cottage cheese, 2%', c: 'dairy', s: 113, l: '½ cup', v: { kcal: 84, protein: 11, carbs: 4.3, fat: 2.3, sugar: 4.1, sodium: 330, calcium: 111 } },
  { n: 'Butter', c: 'dairy', s: 14, l: '1 tbsp', v: { kcal: 717, protein: 0.9, carbs: 0.1, fat: 81.1, satfat: 51, sodium: 643, vita: 684 } },
  { n: 'Almonds', c: 'nuts', s: 28, l: '~23 almonds', v: { kcal: 579, protein: 21.2, carbs: 21.6, fat: 49.9, satfat: 3.8, sugar: 4.4, fiber: 12.5, calcium: 269, magnesium: 270, vite: 25.6 } },
  { n: 'Peanut butter', c: 'nuts', s: 32, l: '2 tbsp', v: { kcal: 588, protein: 25.1, carbs: 19.6, fat: 50, satfat: 10, sugar: 9.2, fiber: 6, sodium: 430, magnesium: 154 } },
  { n: 'Walnuts', c: 'nuts', s: 28, l: '1 oz', v: { kcal: 654, protein: 15.2, carbs: 13.7, fat: 65.2, satfat: 6.1, sugar: 2.6, fiber: 6.7, magnesium: 158 } },
  { n: 'Peanuts', c: 'nuts', s: 28, l: '1 oz', v: { kcal: 567, protein: 25.8, carbs: 16.1, fat: 49.2, satfat: 6.3, fiber: 8.5, magnesium: 168 } },
  { n: 'Cashews', c: 'nuts', s: 28, l: '1 oz', v: { kcal: 553, protein: 18.2, carbs: 30.2, fat: 43.9, satfat: 7.8, sugar: 5.9, fiber: 3.3, magnesium: 292, iron: 6.7, zinc: 5.8 } },
  { n: 'Olive oil', c: 'nuts', s: 14, l: '1 tbsp', v: { kcal: 884, protein: 0, carbs: 0, fat: 100, satfat: 13.8, vite: 14.4 } },
  { n: 'Coffee (black)', c: 'drink', s: 240, l: '1 cup', v: { kcal: 1, protein: 0.1, carbs: 0, fat: 0, caffeine: 40 } },
  { n: 'Orange juice', c: 'drink', s: 248, l: '1 cup', v: { kcal: 45, protein: 0.7, carbs: 10.4, fat: 0.2, sugar: 8.4, vitc: 50, potassium: 200 } },
  { n: 'Coca-Cola', c: 'drink', s: 355, l: '1 can', v: { kcal: 42, protein: 0, carbs: 10.6, fat: 0, sugar: 10.6, caffeine: 9.6, sodium: 4 } },
  { n: 'Beer', c: 'drink', s: 355, l: '1 can/bottle', v: { kcal: 43, protein: 0.5, carbs: 3.6, fat: 0, alcohol: 3.9 } },
  { n: 'Red wine', c: 'drink', s: 147, l: '1 glass', v: { kcal: 85, protein: 0.1, carbs: 2.6, fat: 0, sugar: 0.6, alcohol: 10.6 } },
];
let basicsCat = null;

function basicPrefill(f) {
  return { name: f.n, per100: { ...f.v }, servingQty: f.s, servingLabel: f.l, amount: f.s };
}
function basicRow(f) {
  const row = document.createElement('button');
  row.className = 'entry';
  row.innerHTML = `<span class="thumb">${CAT_ICONS[f.c]}</span><span class="e-main">
    <span class="e-name">${esc(f.n)}</span><span class="e-sub">${esc(f.l)}</span></span>
    <span class="e-kcal">${fmt((f.v.kcal || 0) * f.s / 100, 0)}<small> kcal</small></span>`;
  row.onclick = () => { closeSheet(); openEntryForm(null, basicPrefill(f)); };
  return row;
}
function renderBasics() {
  $('basicsCats').innerHTML = BASIC_CATS.map(([k, label]) =>
    `<button type="button" data-cat="${k}" class="chip ${basicsCat === k ? 'sel' : ''}">${label}</button>`).join('');
  for (const b of document.querySelectorAll('#basicsCats .chip'))
    b.onclick = () => { basicsCat = basicsCat === b.dataset.cat ? null : b.dataset.cat; renderBasics(); };
  const list = $('basicsList');
  list.innerHTML = '';
  if (!basicsCat) return;
  for (const f of BASIC_FOODS.filter(f => f.c === basicsCat)) list.appendChild(basicRow(f));
}


/* ---------- Cheat code: fast food (chain-published nutrition per item) ----------
   Items: [name, kcal, protein, carbs, fat, sodium mg, satfat, sugar, fiber] */
const FAST_FOOD = [
  { chain: "McDonald's", ico: '🍟', items: [
    ['Big Mac', 590, 25, 46, 34, 1050, 11, 9, 3],
    ['Quarter Pounder with Cheese', 520, 30, 42, 26, 1140, 13, 10, 2],
    ['McDouble', 400, 22, 33, 20, 920, 9, 7, 2],
    ['Cheeseburger', 300, 15, 32, 13, 720, 6, 7, 2],
    ['McChicken', 400, 14, 39, 21, 560, 3.5, 5, 2],
    ['Chicken McNuggets (10 pc)', 410, 23, 26, 24, 770, 4, 0, 1],
    ['Filet-O-Fish', 390, 16, 39, 19, 580, 4, 5, 2],
    ['Fries (medium)', 320, 5, 43, 15, 260, 2, 0, 4],
    ['Fries (large)', 480, 7, 65, 23, 400, 3, 0, 6],
    ['Egg McMuffin', 310, 17, 30, 13, 770, 6, 3, 2],
    ['Hash Browns', 140, 1, 18, 8, 310, 1, 0, 2],
    ['Oreo McFlurry', 510, 12, 80, 16, 280, 8, 60, 1],
  ]},
  { chain: 'Burger King', ico: '👑', items: [
    ['Whopper', 670, 28, 54, 40, 980, 12, 11, 3],
    ['Whopper with Cheese', 740, 32, 55, 46, 1340, 16, 11, 3],
    ['Bacon King', 1150, 61, 50, 79, 2150, 31, 10, 2],
    ['Royal Crispy Chicken', 620, 32, 51, 33, 1170, 6, 5, 2],
    ['Chicken Fries (9 pc)', 430, 21, 27, 26, 1050, 4.5, 1, 2],
    ['Fries (medium)', 380, 5, 53, 17, 570, 2.5, 1, 4],
    ['Onion Rings (medium)', 410, 5, 51, 21, 1160, 3.5, 5, 3],
  ]},
  { chain: "Wendy's", ico: '🍔', items: [
    ["Dave's Single", 570, 29, 39, 34, 1160, 13, 9, 2],
    ['Baconator', 960, 58, 40, 66, 1740, 27, 9, 2],
    ['Jr. Bacon Cheeseburger', 380, 20, 26, 22, 700, 9, 5, 1],
    ['Spicy Chicken Sandwich', 500, 28, 49, 21, 1280, 4, 6, 3],
    ['Nuggets (10 pc)', 420, 23, 25, 26, 900, 5, 0, 1],
    ['Fries (medium)', 420, 6, 56, 19, 480, 3, 0, 5],
    ['Chili (small)', 240, 15, 19, 11, 890, 4.5, 5, 5],
    ['Chocolate Frosty (medium)', 580, 15, 98, 15, 270, 9, 79, 1],
  ]},
  { chain: 'Taco Bell', ico: '🌮', items: [
    ['Crunchy Taco', 170, 8, 13, 10, 310, 3.5, 1, 3],
    ['Soft Taco (beef)', 180, 9, 17, 9, 500, 4, 1, 2],
    ['Doritos Locos Taco', 170, 8, 13, 10, 360, 3.5, 1, 3],
    ['Crunchwrap Supreme', 530, 16, 71, 21, 1200, 6, 6, 5],
    ['Burrito Supreme (beef)', 390, 14, 51, 14, 1110, 6, 4, 7],
    ['Bean Burrito', 350, 13, 54, 9, 1000, 3.5, 3, 11],
    ['Chicken Quesadilla', 510, 26, 37, 27, 1250, 12, 3, 3],
    ['Cheesy Gordita Crunch', 500, 20, 41, 28, 850, 10, 4, 4],
    ['Nachos BellGrande', 740, 16, 82, 38, 1050, 7, 5, 11],
  ]},
  { chain: 'Chick-fil-A', ico: '🐔', items: [
    ['Chicken Sandwich', 420, 28, 41, 18, 1300, 4, 6, 1],
    ['Spicy Chicken Sandwich', 450, 28, 45, 19, 1620, 4, 6, 2],
    ['Grilled Chicken Sandwich', 390, 28, 44, 12, 850, 2, 9, 3],
    ['Nuggets (8 ct)', 250, 27, 11, 12, 1210, 2.5, 1, 0],
    ['Nuggets (12 ct)', 380, 40, 16, 18, 1810, 4, 2, 0],
    ['Grilled Nuggets (8 ct)', 130, 25, 1, 3, 440, 0.5, 1, 0],
    ['Waffle Fries (medium)', 420, 5, 45, 24, 240, 4, 1, 5],
    ['Mac & Cheese (medium)', 450, 20, 29, 29, 1210, 16, 3, 1],
    ['Chick-fil-A Sauce', 140, 0, 6, 13, 170, 2, 6, 0],
  ]},
  { chain: 'Chipotle', ico: '🌯', items: [
    ['Chicken (portion)', 180, 32, 0, 7, 310, 3, 0, 0],
    ['Steak (portion)', 150, 21, 1, 6, 330, 2.5, 0, 0],
    ['Carnitas (portion)', 210, 23, 0, 12, 450, 4, 0, 0],
    ['Barbacoa (portion)', 170, 24, 2, 7, 530, 2.5, 0, 1],
    ['Sofritas (portion)', 150, 8, 9, 10, 560, 1.5, 5, 3],
    ['White Rice', 210, 4, 40, 4, 350, 1, 0, 1],
    ['Brown Rice', 210, 4, 36, 6, 190, 1, 1, 2],
    ['Black Beans', 130, 8, 22, 1.5, 210, 0, 2, 7],
    ['Flour Tortilla (burrito)', 320, 9, 50, 9, 600, 3.5, 0, 3],
    ['Cheese', 110, 6, 1, 8, 190, 5, 0, 0],
    ['Guacamole', 230, 2, 8, 22, 375, 3.5, 1, 8],
    ['Chips', 540, 7, 73, 25, 390, 3, 1, 7],
  ]},
  { chain: 'Subway', ico: '🥪', items: [
    ['6" Turkey Breast', 270, 18, 41, 4, 760, 1, 7, 2],
    ['6" Italian BMT', 390, 19, 40, 16, 1260, 6, 7, 2],
    ['6" Meatball Marinara', 430, 20, 54, 16, 990, 6, 10, 4],
    ['6" Tuna', 450, 19, 39, 25, 580, 4.5, 5, 2],
    ['6" Veggie Delite', 200, 8, 39, 2, 280, 0.5, 5, 3],
    ['6" Chicken & Bacon Ranch', 570, 35, 42, 28, 1250, 10, 7, 2],
    ['Chocolate Chip Cookie', 210, 2, 30, 10, 150, 5, 18, 1],
  ]},
  { chain: 'KFC', ico: '🍗', items: [
    ['Original Recipe Breast', 390, 39, 11, 21, 1190, 4.5, 0, 0],
    ['Original Recipe Drumstick', 130, 12, 3, 8, 430, 1.5, 0, 0],
    ['Crispy Tender (1 pc)', 140, 11, 8, 7, 480, 1, 0, 0],
    ['Famous Bowl', 720, 26, 79, 34, 2110, 8, 3, 6],
    ['Mashed Potatoes with Gravy', 130, 2, 19, 5, 500, 1, 1, 1],
    ['Biscuit', 180, 4, 23, 8, 530, 6, 2, 1],
    ['Coleslaw', 170, 1, 14, 12, 180, 2, 10, 2],
  ]},
  { chain: 'Popeyes', ico: '🍗', items: [
    ['Classic Chicken Sandwich', 700, 28, 50, 42, 1440, 14, 7, 2],
    ['Spicy Chicken Sandwich', 700, 28, 50, 42, 1470, 14, 7, 2],
    ['Chicken Tenders (3 pc)', 445, 34, 26, 21, 1680, 8, 0, 1],
    ['Cajun Fries (regular)', 270, 4, 33, 14, 590, 6, 0, 3],
    ['Red Beans & Rice (regular)', 240, 8, 22, 14, 590, 5, 1, 6],
    ['Biscuit', 210, 3, 22, 12, 530, 7, 1, 1],
  ]},
  { chain: 'In-N-Out', ico: '🍔', items: [
    ['Hamburger', 390, 16, 39, 19, 650, 5, 10, 3],
    ['Cheeseburger', 480, 22, 39, 27, 1000, 10, 10, 3],
    ['Double-Double', 670, 37, 39, 41, 1440, 18, 10, 3],
    ['Fries', 370, 7, 52, 15, 245, 2, 0, 2],
    ['Chocolate Shake', 590, 9, 62, 36, 350, 24, 57, 0],
  ]},
  { chain: 'Five Guys', ico: '🍔', items: [
    ['Hamburger', 700, 39, 39, 43, 430, 19.5, 8, 2],
    ['Cheeseburger', 840, 47, 40, 55, 1050, 26.5, 9, 2],
    ['Little Hamburger', 480, 23, 39, 26, 380, 11.5, 8, 2],
    ['Fries (little)', 530, 8, 72, 23, 550, 4, 2, 8],
    ['Fries (regular)', 950, 15, 131, 41, 960, 7, 4, 15],
  ]},
  { chain: 'Shake Shack', ico: '🥤', items: [
    ['ShackBurger (single)', 550, 29, 40, 32, 1230, 13, 8, 1],
    ['Double ShackBurger', 850, 51, 40, 55, 1810, 24, 8, 1],
    ['SmokeShack (single)', 700, 37, 41, 44, 1930, 17, 9, 1],
    ['Hamburger', 480, 25, 38, 25, 890, 10, 7, 1],
    ["'Shroom Burger", 510, 21, 46, 27, 1250, 12, 8, 2],
    ['Chicken Shack', 590, 34, 48, 26, 1660, 6, 7, 1],
    ['Crinkle Cut Fries', 470, 6, 63, 22, 1050, 3, 1, 5],
    ['Cheese Fries', 660, 12, 66, 38, 1660, 10, 2, 5],
    ['Hot Dog', 330, 12, 25, 20, 900, 8, 5, 1],
    ['Vanilla Shake', 680, 16, 65, 40, 350, 26, 55, 0],
    ['Chocolate Shake', 730, 16, 76, 42, 380, 27, 66, 1],
  ]},
  { chain: "Domino's", ico: '🍕', items: [
    ['Pepperoni Slice (large, hand tossed)', 300, 12, 34, 12, 680, 5.5, 3, 2],
    ['Cheese Slice (large, hand tossed)', 270, 11, 33, 10, 550, 4.5, 3, 2],
    ['2 Pepperoni Slices (large)', 600, 24, 68, 24, 1360, 11, 6, 4],
    ['Stuffed Cheesy Bread (2 pc)', 250, 9, 25, 12, 470, 5, 2, 1],
  ]},
  { chain: 'Starbucks', ico: '☕', items: [
    ['Caffè Latte (grande, 2%)', 190, 13, 19, 7, 170, 4.5, 18, 0],
    ['Caramel Macchiato (grande)', 250, 10, 35, 7, 150, 4.5, 33, 0],
    ['Cold Brew (black, grande)', 5, 0, 0, 0, 15, 0, 0, 0],
    ['Vanilla Sweet Cream Cold Brew (grande)', 110, 1, 14, 6, 20, 3.5, 14, 0],
    ['Pumpkin Spice Latte (grande)', 390, 14, 52, 14, 230, 8, 50, 0],
    ['Bacon & Gouda Sandwich', 360, 17, 34, 18, 780, 8, 3, 1],
    ['Butter Croissant', 260, 5, 26, 15, 310, 9, 5, 1],
  ]},
  { chain: "Dunkin'", ico: '🍩', items: [
    ['Glazed Donut', 240, 4, 33, 11, 330, 5, 12, 1],
    ['Boston Kreme Donut', 300, 4, 39, 14, 340, 6, 17, 1],
    ['Bacon Egg & Cheese Croissant', 560, 20, 40, 36, 1050, 15, 5, 1],
    ['Iced Coffee (medium, cream & sugar)', 190, 2, 29, 8, 60, 5, 28, 0],
    ['Original Blend Coffee (black)', 5, 0, 1, 0, 5, 0, 0, 0],
  ]},
];
let cheatChain = null;

function ffPrefill(chain, it) {
  const [n, kcal, protein, carbs, fat, sodium, satfat, sugar, fiber] = it;
  const nutrients = { kcal, protein, carbs, fat };
  if (sodium != null) nutrients.sodium = sodium;
  if (satfat != null) nutrients.satfat = satfat;
  if (sugar != null) nutrients.sugar = sugar;
  if (fiber != null) nutrients.fiber = fiber;
  return { name: n, brand: chain.chain, nutrients };
}
function ffRow(chain, it) {
  const row = document.createElement('button');
  row.className = 'entry';
  row.innerHTML = `<span class="thumb">${chain.ico}</span><span class="e-main">
    <span class="e-name">${esc(it[0])}</span><span class="e-sub">${esc(chain.chain)}</span></span>
    <span class="e-kcal">${fmt(it[1], 0)}<small> kcal</small></span>`;
  row.onclick = () => { closeSheet(); openEntryForm(null, ffPrefill(chain, it)); };
  return row;
}
function renderCheat() {
  $('cheatChains').innerHTML = FAST_FOOD.map((c, i) =>
    `<button type="button" data-i="${i}" class="chip ${cheatChain === i ? 'sel' : ''}">${c.ico} ${esc(c.chain)}</button>`).join('');
  for (const b of document.querySelectorAll('#cheatChains .chip'))
    b.onclick = () => { const i = +b.dataset.i; cheatChain = cheatChain === i ? null : i; renderCheat(); };
  const list = $('cheatList');
  list.innerHTML = '';
  if (cheatChain === null) return;
  const chain = FAST_FOOD[cheatChain];
  for (const it of chain.items) list.appendChild(ffRow(chain, it));
}

/* ---------- Add sheet + My Foods library ---------- */
async function renderMyFoods() {
  const q = $('foodSearch').value.trim().toLowerCase();
  const all = await idbGetAll('foods');
  $('basicsBlock').classList.toggle('hidden', !!q);
  const shown = q
    ? all.filter(f => (f.name + ' ' + f.brand).toLowerCase().includes(q))
        .sort((a, b) => (b.uses || 0) - (a.uses || 0)).slice(0, 25)
    : all.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)).slice(0, 8);
  const list = $('recentsList');
  list.innerHTML = '';
  $('cheatBlock').classList.toggle('hidden', !!q);
  const basicMatches = q
    ? BASIC_FOODS.filter(f => (f.n + ' ' + f.l).toLowerCase().includes(q)).slice(0, 12) : [];
  const ffMatches = [];
  if (q) {
    for (const chain of FAST_FOOD)
      for (const it of chain.items)
        if ((chain.chain + ' ' + it[0]).toLowerCase().includes(q)) ffMatches.push([chain, it]);
  }
  const msg = $('foodSearchMsg');
  const nothing = q && shown.length === 0 && basicMatches.length === 0 && ffMatches.length === 0;
  msg.classList.toggle('hidden', !nothing);
  if (nothing) msg.textContent = `Nothing matching “${q}” — try the AI or a barcode.`;
  for (const f of shown) {
    const row = document.createElement('div');
    row.className = 'entry';
    row.innerHTML = `<span class="thumb">${q ? '🍽️' : '🕘'}</span><span class="e-main">
      <span class="e-name">${esc(f.name)}</span>
      <span class="e-sub">${esc(f.brand || '')}${f.brand && f.uses > 1 ? ' · ' : ''}${f.uses > 1 ? 'logged ' + f.uses + '×' : ''}</span></span>
      <span class="e-kcal">${fmt(f.nutrients?.kcal || 0, 0)}<small> kcal</small></span>
      <button class="food-x" aria-label="Remove from my foods">✕</button>`;
    row.onclick = () => { closeSheet(); openEntryForm(null, f); };
    row.querySelector('.food-x').onclick = async (ev) => {
      ev.stopPropagation();
      await idbDelete('foods', f.key);
      renderMyFoods();
    };
    list.appendChild(row);
  }
  for (const f of basicMatches) list.appendChild(basicRow(f));
  for (const [chain, it] of ffMatches.slice(0, 12)) list.appendChild(ffRow(chain, it));
}
function openSheet() {
  $('foodSearch').value = '';
  basicsCat = null;
  cheatChain = null;
  renderMyFoods();
  renderBasics();
  renderCheat();
  $('addSheet').classList.remove('hidden');
}
function closeSheet() { $('addSheet').classList.add('hidden'); }

/* ---------- Water ---------- */
async function changeWater(delta) {
  dayMetrics.water = Math.max(0, (dayMetrics.water || 0) + delta);
  dayMetrics.date = currentDate;
  await idbPut('metrics', dayMetrics);
  renderDiary();
}

/* ---------- Trends ---------- */
const CHART_GREEN_LIGHT = '#16a34a', CHART_GREEN_DARK = '#19a34c';
const chartColor = () =>
  matchMedia('(prefers-color-scheme: dark)').matches ? CHART_GREEN_DARK : CHART_GREEN_LIGHT;

async function renderTrends() {
  // ---- 14-day calories bar chart ----
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    days.push(toDateStr(d));
  }
  const kcals = [];
  for (const ds of days) kcals.push(totalsFor(await entriesForDate(ds)).kcal);

  const goal = targetFor(NUTRIENTS[0]);
  const W = 340, H = 150, padL = 6, padR = 40, padT = 12, padB = 20;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxY = Math.max(goal, ...kcals, 1) * 1.08;
  const barW = Math.floor(plotW / 14) - 2; // 2px surface gap between bars
  const y = v => padT + plotH * (1 - v / maxY);

  let bars = '', labels = '';
  days.forEach((ds, i) => {
    const x = padL + i * (barW + 2);
    const by = y(kcals[i]);
    const h = Math.max(padT + plotH - by, kcals[i] > 0 ? 3 : 0);
    bars += `<rect data-i="${i}" x="${x}" y="${padT + plotH - h}" width="${barW}" height="${h}"
      rx="3" class="c-bar ${ds === todayStr() ? 'today' : ''}"/>`;
    if (i % 2 === 1) {
      const d = new Date(ds + 'T12:00:00');
      labels += `<text x="${x + barW / 2}" y="${H - 6}" class="c-xlabel">${d.getDate()}</text>`;
    }
  });
  const gy = y(goal);
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Daily calories, last 14 days">
    <line x1="${padL}" x2="${W - padR + 4}" y1="${gy}" y2="${gy}" class="c-goal"/>
    <text x="${W - padR + 6}" y="${gy + 3}" class="c-goal-label">goal</text>
    <line x1="${padL}" x2="${W - padR + 4}" y1="${padT + plotH}" y2="${padT + plotH}" class="c-axis"/>
    ${bars}${labels}
  </svg>`;
  $('kcalChart').innerHTML = svg;
  for (const r of $('kcalChart').querySelectorAll('.c-bar')) {
    r.addEventListener('click', () => {
      const i = +r.dataset.i;
      const d = new Date(days[i] + 'T12:00:00');
      $('kcalChartStatus').textContent =
        `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${fmt(kcals[i], 0)} kcal`;
    });
  }

  // ---- averages over days that have data ----
  const logged = days.map((ds, i) => kcals[i]).filter(v => v > 0);
  const avg = logged.length ? logged.reduce((a, b) => a + b, 0) / logged.length : 0;
  $('avgRow').innerHTML =
    `<div><span class="muted">Daily average</span><b>${fmt(avg, 0)} kcal</b></div>
     <div><span class="muted">Days logged</span><b>${logged.length} / 14</b></div>
     <div><span class="muted">Goal</span><b>${fmt(goal, 0)} kcal</b></div>`;

  // ---- weight line chart ----
  $('weightUnitLabel').textContent = settings.unit || 'kg';
  const points = [];
  await new Promise((resolve) => {
    const req = db.transaction('metrics').objectStore('metrics').getAll();
    req.onsuccess = () => {
      for (const m of req.result) if (m.weight) points.push({ date: m.date, w: m.weight });
      resolve();
    };
    req.onerror = resolve;
  });
  points.sort((a, b) => a.date < b.date ? -1 : 1);
  const recent = points.slice(-30);
  const wbox = $('weightChart');
  if (recent.length === 0) {
    wbox.innerHTML = '<p class="search-msg">Log your weight to see the trend.</p>';
    $('weightChartStatus').textContent = '';
    return;
  }
  const ws = recent.map(p => p.w);
  const wMin = Math.min(...ws), wMax = Math.max(...ws);
  const span = Math.max(wMax - wMin, 1);
  const yW = v => padT + (H - padT - padB) * (1 - (v - (wMin - span * 0.15)) / (span * 1.3));
  const xW = i => padL + 6 + (recent.length === 1 ? plotW / 2 : (plotW - 12) * i / (recent.length - 1));
  let path = '', dots = '';
  recent.forEach((p, i) => {
    path += `${i === 0 ? 'M' : 'L'}${xW(i).toFixed(1)},${yW(p.w).toFixed(1)}`;
    dots += `<circle data-i="${i}" cx="${xW(i).toFixed(1)}" cy="${yW(p.w).toFixed(1)}" r="4" class="c-dot"/>`;
  });
  const first = new Date(recent[0].date + 'T12:00:00');
  const last = new Date(recent[recent.length - 1].date + 'T12:00:00');
  const fmtD = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  wbox.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Weight trend">
    <line x1="${padL}" x2="${W - padR + 4}" y1="${padT + plotH}" y2="${padT + plotH}" class="c-axis"/>
    <path d="${path}" class="c-line"/>
    ${dots}
    <text x="${padL + 6}" y="${H - 6}" class="c-xlabel" text-anchor="start">${fmtD(first)}</text>
    <text x="${W - padR}" y="${H - 6}" class="c-xlabel" text-anchor="end">${fmtD(last)}</text>
  </svg>`;
  $('weightChartStatus').textContent =
    `Latest: ${fmt(recent[recent.length - 1].w)} ${settings.unit} (${fmtD(last)})`;
  for (const dot of wbox.querySelectorAll('.c-dot')) {
    dot.addEventListener('click', () => {
      const p = recent[+dot.dataset.i];
      $('weightChartStatus').textContent =
        `${fmtD(new Date(p.date + 'T12:00:00'))}: ${fmt(p.w)} ${settings.unit}`;
    });
  }
}

async function saveWeight() {
  const v = parseFloat($('weightInput').value);
  if (isNaN(v) || v <= 0) return;
  const ds = todayStr();
  const m = (await idbGet('metrics', ds)) || { date: ds, water: 0 };
  m.weight = v;
  await idbPut('metrics', m);
  if (ds === currentDate) dayMetrics = m;
  $('weightInput').value = '';
  toast('Weight saved ✓');
  renderTrends();
}

/* ---------- Settings ---------- */
function openSettings() {
  $('gKcal').value = goals.kcal || '';
  $('gProtein').value = goals.protein || '';
  $('gCarbs').value = goals.carbs || '';
  $('gFat').value = goals.fat || '';
  $('gUnit').value = settings.unit || 'kg';
  $('gApiKey').value = settings.apiKey || '';
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
  settings.unit = $('gUnit').value;
  settings.apiKey = $('gApiKey').value.trim();
  localStorage.setItem('nutrilog-goals', JSON.stringify(goals));
  localStorage.setItem('nutrilog-settings', JSON.stringify(settings));
  $('settingsModal').classList.add('hidden');
  renderDiary();
  toast('Settings saved ✓');
}

/* ---------- Goal wizard (Mifflin–St Jeor) ---------- */
function calcGoals() {
  const age = Number($('wAge').value), hRaw = Number($('wHeight').value), wRaw = Number($('wWeight').value);
  if (!age || !hRaw || !wRaw) { $('wResult').textContent = 'Fill in age, height, and weight first.'; return; }
  const kg = (settings.unit === 'lb') ? wRaw * 0.4536 : wRaw;
  const cm = $('wHUnit').value === 'in' ? hRaw * 2.54 : hRaw;
  const bmr = 10 * kg + 6.25 * cm - 5 * age + ($('wSex').value === 'm' ? 5 : -161);
  const tdee = bmr * Number($('wActivity').value);
  const kcal = Math.max(1200, Math.round((tdee + Number($('wObjective').value)) / 10) * 10);
  const protein = Math.round(kg * 1.6);          // 1.6 g/kg — solid general target
  const fat = Math.round(kcal * 0.30 / 9);       // 30% of calories
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
  $('gKcal').value = kcal; $('gProtein').value = protein; $('gCarbs').value = carbs; $('gFat').value = fat;
  $('wResult').textContent =
    `Suggested: ${fmt(kcal, 0)} kcal, ${protein} g protein, ${carbs} g carbs, ${fat} g fat — filled in above. Tap “Save settings” to apply.`;
}

/* ---------- Backup: export / restore / CSV ---------- */
function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function shareOrDownload(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const file = new File([blob], filename, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function exportBackup() {
  const payload = {
    app: 'nutrilog', format: 1, exported: new Date().toISOString(),
    goals, unit: settings.unit,
    entries: await idbGetAll('entries'),
    metrics: await idbGetAll('metrics'),
    peptides: await idbGetAll('peptides'),
    doses: await idbGetAll('doses'),
    foods: await idbGetAll('foods'),
  };
  await shareOrDownload(JSON.stringify(payload), `nutrilog-backup-${todayStr()}.json`, 'application/json');
  toast('Backup ready ✓');
}
async function exportCsv() {
  const cols = ['date', 'time', 'meal', 'name', 'brand', 'amount'];
  const nutrCols = NUTRIENTS.map(n => n.key);
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const entries = (await idbGetAll('entries')).sort((a, b) => a.date === b.date ? a.id - b.id : (a.date < b.date ? -1 : 1));
  const lines = [[...cols, ...nutrCols.map(k => NUTRIENTS.find(n => n.key === k).label)].map(q).join(',')];
  for (const e of entries)
    lines.push([...cols.map(c => e[c]), ...nutrCols.map(k => e.nutrients?.[k] ?? '')].map(q).join(','));
  await shareOrDownload(lines.join('\n'), `nutrilog-log-${todayStr()}.csv`, 'text/csv');
  toast('CSV ready ✓');
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'nutrilog' || !Array.isArray(data.entries)) throw new Error('not a NutriLog backup');
    for (const e of data.entries) if (e.id && e.date) await idbPut('entries', e);
    for (const m of (data.metrics || [])) if (m.date) await idbPut('metrics', m);
    for (const p of (data.peptides || [])) if (p.id) await idbPut('peptides', p);
    for (const ds of (data.doses || [])) if (ds.key) await idbPut('doses', ds);
    for (const f of (data.foods || [])) if (f.key) await idbPut('foods', f);
    if (data.goals && !Number(goals.kcal)) {
      goals = data.goals;
      localStorage.setItem('nutrilog-goals', JSON.stringify(goals));
    }
    $('settingsModal').classList.add('hidden');
    await loadDay();
    toast(`Restored ${data.entries.length} entries ✓`);
  } catch (e) {
    toast('⚠️ Couldn’t read that backup: ' + e.message);
  }
}

/* ---------- First-run welcome ---------- */
async function maybeShowWelcome() {
  if (localStorage.getItem('nutrilog-welcomed')) return;
  const any = (await idbGetAll('entries')).length > 0;
  if (any) { localStorage.setItem('nutrilog-welcomed', '1'); return; }
  $('welcomeCard').classList.remove('hidden');
}
function dismissWelcome() {
  localStorage.setItem('nutrilog-welcomed', '1');
  $('welcomeCard').classList.add('hidden');
}

/* ---------- Steps ---------- */
async function saveSteps() {
  const v = parseInt($('stepsInput').value, 10);
  if (isNaN(v) || v < 0) return;
  dayMetrics.steps = v;
  dayMetrics.date = currentDate;
  await idbPut('metrics', dayMetrics);
  $('stepsInput').value = '';
  renderDiary();
  toast('Steps saved ✓');
}

/* ---------- Peptide tracker ---------- */
const PEP_TIMES = { morning: '🌅 Morning', midday: '☀️ Midday', evening: '🌆 Evening', bedtime: '🌙 Bedtime' };
const DAY_LETTERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let editingPepId = null;
let pepDaysSel = [0, 1, 2, 3, 4, 5, 6];

const pepDoseKey = (pepId, date) => pepId + '|' + date;
const pepDueToday = p => (p.days || []).includes(new Date().getDay());

function pepScheduleText(p) {
  const days = (p.days || []).length === 7 ? 'Every day'
    : (p.days || []).map(d => DAY_LETTERS[d]).join(' · ') || 'No days set';
  return `${days} · ${PEP_TIMES[p.time] || p.time}`;
}

async function pepStatusToday() {
  const peps = await idbGetAll('peptides');
  const today = todayStr();
  const out = [];
  for (const p of peps) {
    const taken = await idbGet('doses', pepDoseKey(p.id, today));
    out.push({ pep: p, due: pepDueToday(p), taken });
  }
  return out;
}

async function renderPeps() {
  const status = await pepStatusToday();
  const list = $('pepList');
  list.innerHTML = '';
  $('pepEmpty').classList.toggle('hidden', status.length > 0);
  for (const { pep, due, taken } of status) {
    const card = document.createElement('section');
    card.className = 'card pep-card';
    const btnClass = taken ? 'pep-take taken' : (due ? 'pep-take' : 'pep-take offday');
    const btnLabel = taken ? `✓ ${taken.time}` : (due ? 'Take ✓' : 'Take anyway');
    card.innerHTML = `<div class="pep-row">
      <div class="pep-info" data-edit="${pep.id}">
        <div class="pep-name">💉 ${esc(pep.name)}${due && !taken ? ' <span class="pep-due-dot">· due today</span>' : ''}</div>
        <div class="pep-sub">${esc(pep.dose || '')}${pep.dose ? ' · ' : ''}${esc(pepScheduleText(pep))}${pep.notes ? ' · ' + esc(pep.notes) : ''}</div>
      </div>
      <button class="${btnClass}" data-take="${pep.id}">${btnLabel}</button>
    </div>`;
    list.appendChild(card);
  }
  for (const el of list.querySelectorAll('[data-edit]'))
    el.onclick = () => openPepForm(status.find(s => s.pep.id === +el.dataset.edit).pep);
  for (const el of list.querySelectorAll('[data-take]'))
    el.onclick = () => togglePepDose(+el.dataset.take);
}

async function togglePepDose(pepId) {
  const key = pepDoseKey(pepId, todayStr());
  const existing = await idbGet('doses', key);
  if (existing) {
    await idbDelete('doses', key);
  } else {
    await idbPut('doses', { key, pepId, date: todayStr(),
      time: new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) });
    toast('Logged ✓');
  }
  renderPeps();
  updatePepBanner();
}

async function updatePepBanner() {
  const banner = $('pepDueBanner');
  if (currentDate !== todayStr()) { banner.classList.add('hidden'); return; }
  const pending = (await pepStatusToday()).filter(s => s.due && !s.taken);
  banner.classList.toggle('hidden', pending.length === 0);
  if (pending.length)
    banner.innerHTML = `<span>💉</span><span>Due today: ${pending.map(s => esc(s.pep.name)).join(', ')} — tap to log</span>`;
}

function renderPepDays() {
  $('pepDays').innerHTML = DAY_LETTERS.map((d, i) =>
    `<button type="button" data-day="${i}" class="chip ${pepDaysSel.includes(i) ? 'sel' : ''}">${d[0]}</button>`).join('');
  for (const b of document.querySelectorAll('#pepDays .chip'))
    b.onclick = () => {
      const d = +b.dataset.day;
      pepDaysSel = pepDaysSel.includes(d) ? pepDaysSel.filter(x => x !== d) : [...pepDaysSel, d].sort();
      renderPepDays();
    };
}

function openPepForm(pep) {
  editingPepId = pep ? pep.id : null;
  pepDaysSel = pep ? [...(pep.days || [])] : [0, 1, 2, 3, 4, 5, 6];
  $('pepTitle').textContent = pep ? 'Edit peptide' : 'Add peptide';
  $('pName').value = pep?.name || '';
  $('pDose').value = pep?.dose || '';
  $('pTime').value = pep?.time || 'morning';
  $('pNotes').value = pep?.notes || '';
  $('pepDelete').classList.toggle('hidden', !pep);
  renderPepDays();
  $('pepModal').classList.remove('hidden');
}

async function submitPep(ev) {
  ev.preventDefault();
  await idbPut('peptides', {
    id: editingPepId || Date.now(),
    name: $('pName').value.trim(),
    dose: $('pDose').value.trim(),
    days: pepDaysSel,
    time: $('pTime').value,
    notes: $('pNotes').value.trim(),
  });
  $('pepModal').classList.add('hidden');
  renderPeps();
  updatePepBanner();
  toast(editingPepId ? 'Updated ✓' : 'Peptide added ✓');
}

/* ---------- Tabs & navigation ---------- */
function switchTab(id) {
  for (const p of document.querySelectorAll('.tab-page')) p.classList.toggle('hidden', p.id !== id);
  for (const b of document.querySelectorAll('.tab-btn')) b.classList.toggle('active', b.dataset.tab === id);
  if (id === 'tabTrends') renderTrends();
  if (id === 'tabPeps') renderPeps();
}
function shiftDay(delta) {
  const d = new Date(currentDate + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  currentDate = toDateStr(d);
  loadDay();
}

/* ---------- Wire-up ---------- */
async function main() {
  $('verLabel').textContent = 'NutriLog version ' + APP_VERSION;
  await openDB();
  await backfillFoods();
  await loadDay();

  $('prevDay').onclick = () => shiftDay(-1);
  $('nextDay').onclick = () => shiftDay(1);
  $('dateLabel').onclick = () => { currentDate = todayStr(); loadDay(); };
  $('settingsBtn').onclick = openSettings;

  for (const b of document.querySelectorAll('.tab-btn'))
    b.onclick = () => switchTab(b.dataset.tab);

  $('toggleNutrients').onclick = () => {
    showTargets = !showTargets;
    $('nutrientTable').classList.toggle('hidden', !showTargets);
    $('toggleNutrients').textContent = showTargets ? 'Hide nutrient targets ▴' : 'Show nutrient targets ▾';
  };

  $('waterPlus').onclick = () => changeWater(1);
  $('waterMinus').onclick = () => changeWater(-1);
  $('stepsSave').onclick = saveSteps;

  $('pepAdd').onclick = () => openPepForm(null);
  $('pepForm').addEventListener('submit', submitPep);
  document.querySelector('[data-close-pep]').onclick = () => $('pepModal').classList.add('hidden');
  $('pepEveryday').onclick = () => { pepDaysSel = [0, 1, 2, 3, 4, 5, 6]; renderPepDays(); };
  $('pepDelete').onclick = async () => {
    if (editingPepId && confirm('Delete this peptide and its history?')) {
      await idbDelete('peptides', editingPepId);
      $('pepModal').classList.add('hidden');
      renderPeps();
      updatePepBanner();
    }
  };
  $('pepDueBanner').onclick = () => switchTab('tabPeps');

  $('addBtn').onclick = openSheet;
  document.querySelector('#addSheet [data-close]').onclick = closeSheet;
  $('foodSearch').addEventListener('input', renderMyFoods);
  $('optScan').onclick = startScan;
  $('optPhoto').onclick = () => { closeSheet(); openEntryForm(null, {}); setTimeout(pickGallery, 150); };
  $('optSearch').onclick = () => {
    closeSheet();
    $('searchResults').innerHTML = ''; $('searchInput').value = '';
    $('searchModal').classList.remove('hidden');
    setTimeout(() => $('searchInput').focus(), 100);
  };
  $('optManual').onclick = () => { closeSheet(); openEntryForm(null, {}); };

  $('scanCancel').onclick = stopScan;

  document.querySelector('[data-close-search]').onclick = () => $('searchModal').classList.add('hidden');
  $('searchGo').onclick = runSearch;
  $('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });

  document.querySelector('[data-close-entry]').onclick = closeEntryForm;
  $('entryForm').addEventListener('submit', submitEntry);
  $('photoBtn').onclick = pickPhoto;
  $('galleryBtn').onclick = pickGallery;
  $('aiBtn').onclick = aiAnalyze;
  for (const id of ['photoInput', 'galleryInput'])
    $(id).addEventListener('change', e => { if (e.target.files[0]) handlePhoto(e.target.files[0]); e.target.value = ''; });
  $('fAmount').addEventListener('input', applyAmount);
  $('moreNutrients').onclick = () => {
    showAllForm = !showAllForm;
    $('moreNutrients').textContent = showAllForm ? 'Fewer nutrients ▴' : 'More nutrients ▾';
    for (const l of document.querySelectorAll('#nutrientInputs label[data-core="false"]'))
      l.classList.toggle('hidden', !showAllForm);
  };
  $('deleteEntry').onclick = async () => {
    if (editingId && confirm('Delete this entry?')) {
      await idbDelete('entries', editingId);
      closeEntryForm();
      await loadDay();
      toast('Deleted');
    }
  };

  document.querySelector('[data-close-settings]').onclick = () => $('settingsModal').classList.add('hidden');
  $('settingsForm').addEventListener('submit', saveSettings);
  $('weightSave').onclick = saveWeight;

  $('wCalc').onclick = calcGoals;
  $('exportBtn').onclick = exportBackup;
  $('exportCsvBtn').onclick = exportCsv;
  $('importBtn').onclick = () => $('importInput').click();
  $('importInput').addEventListener('change', e => {
    if (e.target.files[0]) importBackup(e.target.files[0]);
    e.target.value = '';
  });

  $('welcomeDismiss').onclick = dismissWelcome;
  $('welcomeGoals').onclick = () => {
    dismissWelcome();
    openSettings();
    $('wizard').open = true;
  };
  maybeShowWelcome();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

main();
