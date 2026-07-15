# 🥗 NutriLog

A food & nutrition tracker that lives on your iPhone's home screen. Log everything
you eat with **photos**, **barcode scanning**, and **full nutrient tracking** —
not just calories, but protein, carbs, fat, fiber, sugar, sodium, cholesterol,
potassium, calcium, iron, magnesium, zinc, vitamins A/C/D/E/B12, caffeine, and more.

All of your data stays **on your phone** (nothing is uploaded anywhere).
Barcode scans and food searches look up nutrition facts in the free, open
[Open Food Facts](https://openfoodfacts.org) database.

## ✨ Features

- **Barcode scanner** — point your camera at any packaged food and its full
  nutrition facts fill in automatically
- **AI food analysis** — snap a photo *or just type a description* and AI
  estimates the full nutrition (free with a Google Gemini key, see below)
- **Meals** — entries are grouped into Breakfast / Lunch / Dinner / Snacks with
  per-meal calorie subtotals
- **Nutrient targets** — every nutrient tracked against daily-value targets
  (limits like sodium and sugar turn red when exceeded)
- **Water tracker** — tap to log glasses of water
- **Trends** — 14-day calorie chart with your goal line, plus a weight log
  with a trend chart
- **Recent foods** — one tap to re-log things you eat often
- **Goal wizard** — answers a few body questions and calculates your calorie
  and macro targets (Mifflin–St Jeor)
- **Logging streak** — a 🔥 counter for consecutive days logged
- **Backup & restore** — export your whole log as a file (plus CSV for
  spreadsheets) and restore it on any device
- **Steps** — log your daily step count from WHOOP or any tracker
- **Peptide tracker** — a 💉 tab with your peptide schedule (name, dose,
  days, time of day), one-tap "taken" logging, and a due-today banner on
  the Diary so doses aren't forgotten
- **Food search & manual entry** — for everything without a barcode
- **History** — swipe back through previous days
- **Works offline** — the app itself loads with no connection (lookups need internet)

## ✨ AI food analysis (free)

The AI can estimate full nutrition from a **photo** or from just a **typed
description** ("2 slices pepperoni pizza") — no barcode needed.

**Free setup (recommended):**

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and
   sign in with a Google account — no credit card needed
2. Tap **Create API key** and copy it (starts with `AIza` or `AQ.`)
3. In the app: **⚙ Settings → AI key**, paste it, save
4. Add a food → take a photo (or type a name) → tap the **✨** button

Google's free tier allows hundreds of analyses per day. A paid Claude API key
(`sk-ant-…`, console.anthropic.com) works in the same field. Either way the key
is stored only on your phone, and photos are sent to the AI provider only when
you tap the button. AI estimates are good but not perfect — treat them as a
starting point and adjust what looks off.

## 📱 Install it on your iPhone

1. **Turn on the website** (one-time setup, done on github.com):
   - Go to this repository's **Settings → Pages**
   - Under *Build and deployment*, set **Source** to **Deploy from a branch**,
     pick this branch, folder `/ (root)`, and press **Save**
   - After a minute, the page will show your app's link, like
     `https://<your-username>.github.io/<repo-name>/`
2. **Open that link in Safari on your iPhone**
3. Tap the **Share** button (square with the up arrow)
4. Tap **Add to Home Screen**, then **Add**

That's it — NutriLog now has its own icon and opens full-screen like a real app.
The first time you scan a barcode, allow camera access when asked.

## 🛠 How it's built

Plain HTML/CSS/JavaScript — no build step required.

| File | Purpose |
|---|---|
| `index.html` | App structure and screens |
| `app.js` | All logic: food log, totals, scanning, lookups |
| `style.css` | Mobile-first styling with dark-mode support |
| `sw.js` | Service worker — caches the app for offline use |
| `manifest.webmanifest` | Makes it installable as an app |
| `vendor/zxing.min.js` | [ZXing](https://github.com/zxing-js/library) barcode decoding library |
| `icons/` | App icons |

Food entries (including photos) are stored in your browser's IndexedDB on the
device. Daily goals are stored in localStorage.
