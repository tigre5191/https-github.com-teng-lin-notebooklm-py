# 🚨 TrapMap — Speed Trap Alerts

A personal, Waze-style speed-trap map that lives on your iPhone's home screen.
Mark where the police are, save known trap spots, load fixed speed cameras from
OpenStreetMap, and get **sound + vibration alerts** when you drive near any of
them — with a big GPS speedometer in Drive mode.

All data stays **on your phone** (nothing is uploaded anywhere).

## ✨ Features

- **👮 Police** — one tap marks a police sighting at your current location.
  Reports automatically expire (default 4 hours — police move!), and fade on
  the map as they get old. Tap a marker → "👍 Still there" to renew it.
- **🪤 Trap spots** — permanently save the places police regularly hide
  (that spot behind the overpass on your commute…)
- **📷 Cameras** — mark fixed speed / red-light cameras, or tap
  **📡 Cameras** to auto-load every publicly-mapped speed camera in the
  visible area from [OpenStreetMap](https://www.openstreetmap.org)
- **🚗 Drive mode** — huge GPS speedometer, screen stays awake, and when you
  approach any saved spot you get a two-tone alarm, vibration, and a flashing
  banner with the distance ("👮 Police reported ahead — 900 ft"). If your
  heading is known, spots clearly *behind* you don't alert.
- **Long-press the map** to add a spot anywhere (not just where you are)
- **Nearby list** — everything saved, sorted by distance from you
- **Share with friends** — export your spots as a file (AirDrop / text it);
  friends import it and your spots appear on their map. Swap files both ways
  for a mini crowd network.
- **Works offline** — the app itself loads with no connection (map tiles and
  camera lookups need internet)

## ⚠️ Honest limitations

- **This is not Waze's live crowd.** Waze alerts work because millions of
  drivers feed it reports in real time. Here, reports come from **you** and
  anyone you swap export files with. The OpenStreetMap camera database is
  real and worldwide, but *mobile* police reports are only as good as what
  you and your friends log.
- **Alerts only fire while the app is open.** iPhone web apps can't watch
  your location in the background — so in the car, start **🚗 Drive** mode
  and keep it on the dash (like you would with Waze).
- It listens to GPS, not police radio — actual scanner audio isn't possible
  in a web app, and encrypted departments can't be listened to anyway.
- Speed-camera alert apps are legal in the US, but a few countries
  (e.g. France, Germany, Switzerland) ban them — check local rules if
  you travel.

## 📱 Install it on your iPhone

1. Open `https://<your-username>.github.io/<repo-name>/trapmap/` in Safari
2. Tap the **Share** button → **Add to Home Screen** → **Add**
3. First launch: tap **Let's go** and allow location access

## 🛠 How it's built

Plain HTML/CSS/JavaScript — no build step, same pattern as NutriLog.

| File | Purpose |
|---|---|
| `index.html` | App structure: map, report bar, drive mode, sheets |
| `app.js` | All logic: spots, GPS, alerts, Overpass lookups, import/export |
| `style.css` | Dark, glanceable driving UI |
| `sw.js` | Service worker — caches the app for offline use |
| `manifest.webmanifest` | Makes it installable as an app |
| `vendor/leaflet.*` | [Leaflet](https://leafletjs.com) map library |
| `icons/` | App icons |

Map tiles by [CARTO](https://carto.com/attributions), data ©
[OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
Spots and settings are stored in your browser's localStorage on the device.
