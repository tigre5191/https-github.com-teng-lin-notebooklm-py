/* NutriLog — local calorie & nutrient tracker (PWA)
   Food data stays on-device (IndexedDB). Barcode/search lookups use the free
   Open Food Facts database. Optional AI photo analysis calls the Claude API
   with the user's own key. */

'use strict';

const APP_VERSION = '2.5';

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
    if (sq) $('entryForm').dataset.servingQty = sq;
    const chips = [['100 g', 100]];
    if (sq) chips.unshift([`1 serving (${fmt(sq, 0)} g)`, sq]);
    for (const [label, grams] of chips) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label;
      b.onclick = () => { $('fAmount').value = grams; applyAmount(); };
      $('servingBtns').appendChild(b);
    }
  } else {
    delete $('entryForm').dataset.servingQty;
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

/* ---------- Add sheet + My Foods library ---------- */
async function renderMyFoods() {
  const q = $('foodSearch').value.trim().toLowerCase();
  const all = await idbGetAll('foods');
  $('myFoodsBlock').classList.toggle('hidden', all.length === 0);
  const shown = q
    ? all.filter(f => (f.name + ' ' + f.brand).toLowerCase().includes(q))
        .sort((a, b) => (b.uses || 0) - (a.uses || 0)).slice(0, 25)
    : all.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)).slice(0, 8);
  const list = $('recentsList');
  list.innerHTML = '';
  const msg = $('foodSearchMsg');
  msg.classList.toggle('hidden', !(q && shown.length === 0));
  if (q && shown.length === 0) msg.textContent = `Nothing logged matching “${q}” yet.`;
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
}
function openSheet() {
  $('foodSearch').value = '';
  renderMyFoods();
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
