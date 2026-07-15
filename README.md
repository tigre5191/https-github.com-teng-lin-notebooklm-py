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
- **Photo logging** — snap a picture of any meal so you remember what it was
- **Food search** — find products by name when there's no barcode
- **Manual entry** — type in anything else
- **Automatic totals** — every nutrient is summed for the day, with a calorie
  ring and progress bars against your personal goals
- **History** — swipe back through previous days
- **Works offline** — the app itself loads with no connection (lookups need internet)

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
