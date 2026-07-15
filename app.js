/* NutriLog — local calorie & nutrient tracker (PWA)
   Food data stays on-device (IndexedDB). Barcode/search lookups use the free
   Open Food Facts database. Optional AI photo analysis calls the Claude API
   with the user's own key. */

'use strict';

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
    const req = indexedDB.open('nutrilog', 2);
    req.onupgradeneeded = (ev) => {
      const d = req.result;
      if (ev.oldVersion < 1) {
        d.createObjectStore('entries', { keyPath: 'id' }).createIndex('date', 'date');
      }
      if (ev.oldVersion < 2) {
        d.createObjectStore('metrics', { keyPath: 'date' }); // {date, water, weight}
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
let recents = JSON.parse(localStorage.getItem('nutrilog-recents') || '[]');

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

  // Calories ring
  $('kcalTotal').textContent = fmt(totals.kcal, 0);
  const goal = targetFor(NUTRIENTS[0]);
  $('kcalGoalText').textContent = `of ${fmt(goal, 0)} kcal goal`;
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
  $('photoBtn').textContent = formPhoto ? '📷 Change photo' : '📷 Add photo';
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

function rememberRecent(entry) {
  const keyOf = e => (e.name + '|' + (e.brand || '')).toLowerCase();
  recents = [
    { name: entry.name, brand: entry.brand, per100: entry.per100, servingQty: entry.servingQty,
      amount: entry.amount, nutrients: entry.nutrients, barcode: entry.barcode },
    ...recents.filter(r => keyOf(r) !== keyOf(entry)),
  ].slice(0, 10);
  localStorage.setItem('nutrilog-recents', JSON.stringify(recents));
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
  rememberRecent(entry);
  closeEntryForm();
  await loadDay();
  toast(wasEdit ? 'Updated ✓' : 'Added to your log ✓');
}

/* ---------- Photos ---------- */
function pickPhoto() { $('photoInput').click(); }
function handlePhoto(file) {
  const img = new Image();
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
    $('photoBtn').textContent = '📷 Change photo';
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
    p += 'Estimate the nutrition of the food in this photo, judging the portion size from ' +
         'visual cues (plate size, utensils, packaging). ';
    if (desc) p += `The user describes it as: "${desc}". `;
  } else {
    p += `Estimate the nutrition of this food: "${desc}". ` +
         'Assume one typical serving unless the description states a quantity. ';
  }
  p += 'Give totals for the whole portion (not per 100 g).';
  return p;
}

function parseAiJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Could not read the AI answer — try again');
  return JSON.parse(m[0]);
}

async function geminiEstimate(key, desc) {
  const parts = [];
  if (formPhoto)
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: formPhoto.split(',')[1] } });
  parts.push({ text: aiPrompt(desc) +
    ` Respond with ONLY a JSON object with exactly these keys: ${AI_FIELDS}.` });
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini API error ${res.status}`);
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!text) throw new Error('No answer returned — try again');
  return parseAiJson(text);
}

async function claudeEstimate(key, desc) {
  const content = [];
  if (formPhoto)
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: formPhoto.split(',')[1] } });
  content.push({ type: 'text', text: aiPrompt(desc) });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
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
  status.textContent = formPhoto ? '✨ Analyzing photo…' : '✨ Estimating from description…';
  $('aiBtn').disabled = true;
  try {
    const est = key.startsWith('AIza')
      ? await geminiEstimate(key, desc)
      : await claudeEstimate(key, desc);
    if (!$('fName').value.trim()) $('fName').value = est.name || '';
    for (const inp of document.querySelectorAll('#nutrientInputs input')) {
      const v = est[inp.dataset.nkey];
      if (typeof v === 'number' && isFinite(v)) inp.value = +v.toFixed(1);
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

/* ---------- Add sheet + recents ---------- */
function openSheet() {
  const block = $('recentsBlock');
  const list = $('recentsList');
  list.innerHTML = '';
  block.classList.toggle('hidden', recents.length === 0);
  for (const r of recents.slice(0, 6)) {
    const b = document.createElement('button');
    b.className = 'entry';
    b.innerHTML = `<span class="thumb">🕘</span><span class="e-main">
      <span class="e-name">${esc(r.name)}</span>
      <span class="e-sub">${esc(r.brand || '')}</span></span>
      <span class="e-kcal">${fmt(r.nutrients?.kcal || 0, 0)}<small> kcal</small></span>`;
    b.onclick = () => { closeSheet(); openEntryForm(null, r); };
    list.appendChild(b);
  }
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

/* ---------- Tabs & navigation ---------- */
function switchTab(id) {
  for (const p of document.querySelectorAll('.tab-page')) p.classList.toggle('hidden', p.id !== id);
  for (const b of document.querySelectorAll('.tab-btn')) b.classList.toggle('active', b.dataset.tab === id);
  if (id === 'tabTrends') renderTrends();
}
function shiftDay(delta) {
  const d = new Date(currentDate + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  currentDate = toDateStr(d);
  loadDay();
}

/* ---------- Wire-up ---------- */
async function main() {
  await openDB();
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

  $('addBtn').onclick = openSheet;
  document.querySelector('#addSheet [data-close]').onclick = closeSheet;
  $('optScan').onclick = startScan;
  $('optPhoto').onclick = () => { closeSheet(); openEntryForm(null, {}); setTimeout(pickPhoto, 150); };
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
  $('aiBtn').onclick = aiAnalyze;
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
      await idbDelete('entries', editingId);
      closeEntryForm();
      await loadDay();
      toast('Deleted');
    }
  };

  document.querySelector('[data-close-settings]').onclick = () => $('settingsModal').classList.add('hidden');
  $('settingsForm').addEventListener('submit', saveSettings);
  $('weightSave').onclick = saveWeight;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

main();
