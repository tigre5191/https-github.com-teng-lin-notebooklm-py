# CLAUDE.md

Guidance for AI assistants working in this repository.

## What this repo is

Two **independent, installable PWAs** served as static files from one GitHub
Pages site. There is **no build step, no bundler, no package manager, and no
test suite** — the files you edit are the files that ship.

| App | Path | What it is |
|---|---|---|
| **NutriLog** | repo root | Food & nutrient tracker (barcode scanning, AI photo analysis, meals, trends, peptides) |
| **TrapMap** | `trapmap/` | Waze-style speed-trap map with GPS proximity alerts |

They share no code. Each has its own `index.html`, `app.js`, `style.css`,
`sw.js`, `manifest.webmanifest`, `icons/`, `vendor/`, and `README.md`. A change
to one must not require a change to the other.

Both are **local-first and backend-free**: no server, no accounts, no
analytics, no telemetry. All user data lives in the browser (IndexedDB /
localStorage) on the device. The only network calls are to Open Food Facts,
the user's chosen AI provider, OpenStreetMap/Overpass, and CARTO map tiles.
Preserve this — do not introduce a backend, a tracker, or any upload of user
data.

The primary target is **iPhone Safari, added to the Home Screen** (standalone
PWA). Design and test for a phone-sized, touch-first, offline-capable screen.

## File map

### NutriLog (root)

| File | Purpose |
|---|---|
| `index.html` | All markup: three tab pages (Diary / Peptides / Trends), the FAB add-sheet, and five modals (scan, search, entry, settings, peptide). ~330 lines. |
| `app.js` | Every bit of logic, one file, ~1700 lines, organized by `/* ---------- Section ---------- */` banners. |
| `style.css` | Mobile-first CSS with a `:root` token block and a `prefers-color-scheme: dark` override. |
| `sw.js` | Service worker: stale-while-revalidate for same-origin files, network-only for APIs. |
| `manifest.webmanifest` | PWA install metadata. |
| `vendor/zxing.min.js` | ZXing barcode decoder, loaded as a global `ZXing`. |
| `.nojekyll` | Stops GitHub Pages from running Jekyll over the files. |
| `.github/workflows/pages.yml` | Pages deploy — **see the branch caveat below.** |

### TrapMap (`trapmap/`)

Same shape. `trapmap/app.js` (~550 lines) uses `/* ===== section ===== */`
banners, `vendor/leaflet.*` provides the global `L`, and state lives in
localStorage rather than IndexedDB.

## `app.js` section map (NutriLog)

Read the banner comments to navigate; roughly in file order:

Nutrient definitions → IndexedDB helpers → module state → formatting →
diary rendering → streak → toast → entry form → My Foods library → photos →
AI nutrition analysis → Open Food Facts → barcode scanning → search UI →
basic foods → cheat code (fast food) → add sheet → water → trends charts →
settings → goal wizard → backup/export/import → welcome → steps → peptides →
tabs → `main()` wire-up.

## Conventions to follow

**Plain scripts, global scope.** No ES modules, no `import`/`export`, no
`type="module"`. `app.js` starts with `'use strict'` and declares everything
top-level; `index.html` loads vendor libs first, then `app.js`. Vendor
libraries are vendored into `vendor/` — never add a CDN `<script>` or a
runtime dependency fetch (it would break offline install).

**Wire-up lives in `main()`.** Every DOM listener is attached at the bottom of
`app.js` inside `main()`, which runs `openDB()` → `backfillFoods()` →
`loadDay()` → listeners → SW registration. There are no inline `onclick`
attributes in the HTML. Add new handlers to `main()`, grouped with the related
block.

**`$(id)` for element lookup**, `data-*` attributes for the few things queried
by selector (`.tab-btn[data-tab]`, `[data-close-entry]`, `input[data-nkey]`).

**Rendering is `innerHTML` from template literals** for lists and charts, and
`createElement` when a click handler is attached per row. Any user-supplied
string interpolated into HTML **must** go through `esc()`. Numbers go through
`fmt(n, digits)`.

**Show/hide with `classList.toggle('hidden', …)`** — `.hidden` is
`display: none !important` in CSS. Modals and sheets are always in the DOM.

**Feedback is `toast(msg)`**, one line, often with a `✓` or `⚠️`. User-facing
copy is plain-English and non-technical; error strings tell the user what to
*do* next (see `friendlyGeminiError`), never raw status codes alone.

**Charts are hand-rolled inline SVG** in `renderTrends()` — no chart library.
Follow the existing `viewBox`/pad/scale-function pattern if you add one.

**CSS**: single stylesheet, CSS custom properties in `:root`, dark mode by
media query only (there is no theme toggle). Class names are short and
BEM-ish-by-nesting (`.entry .e-name`). Respect `env(safe-area-inset-*)` for
anything pinned to the bottom.

## Data model (NutriLog)

**IndexedDB database `nutrilog`, currently version 4.** Stores:

| Store | Key | Contents |
|---|---|---|
| `entries` | `id` (ms timestamp), index on `date` | one logged food |
| `metrics` | `date` | `{date, water, weight, steps}` |
| `peptides` | `id` | `{id, name, dose, days[0–6], time, notes}` |
| `doses` | `key` = `` `${pepId}|${date}` `` | a taken dose |
| `foods` | `key` = `` `${name}|${brand}`.toLowerCase() `` | My Foods library entry with `uses`/`lastUsed` |

An `entries` record looks like:

```js
{ id, date: 'YYYY-MM-DD', time, name, brand, meal, amount,
  photo,        // data: URL JPEG, downscaled to 1100px @ 0.8
  per100,       // per-100g nutrient map, when known — drives serving scaling
  barcode, servingQty, servingLabel,
  nutrients: { kcal, protein, … }   // absolute values for the logged amount
}
```

**Schema changes:** bump the version in `indexedDB.open('nutrilog', N)` and add
a new `if (ev.oldVersion < N) { … }` block in `onupgradeneeded`. Never edit an
existing block — users upgrade in place and their data must survive. Also add
the new store to `exportBackup()` and `importBackup()` in the backup section.

**localStorage keys:** `nutrilog-goals`, `nutrilog-settings` (includes the AI
`apiKey` and weight `unit`), `nutrilog-welcomed`, `nutrilog-foods-v1`
(one-time backfill flag), `nutrilog-recents` (legacy, read only during
backfill). TrapMap uses `trapmap.spots`, `trapmap.settings`, `trapmap.intro`,
`trapmap.view`.

**Dates are local-time `YYYY-MM-DD` strings** produced by `toDateStr()`. Never
use `toISOString().slice(0,10)` — it shifts the day for users behind UTC. When
parsing one back, use `new Date(ds + 'T12:00:00')` to dodge DST edges.

## The `NUTRIENTS` table is the source of truth

Everything nutrient-related — form inputs, target bars, totals, CSV columns,
Open Food Facts mapping, AI field parsing — iterates over the `NUTRIENTS`
array at the top of `app.js`. To add a nutrient, add one row (`key`, `label`,
`unit`, `off` key, `factor` to convert OFF grams to the display unit, `dv`,
optional `core`/`limit`/`goalKey`). Do not hard-code nutrient keys elsewhere;
`MACRO_KEYS` is the only intentional exception.

Built-in food data follows the same shape but compressed: `BASIC_FOODS` uses
`{n, c, s, l, v}` (name, category, serving grams, serving label, per-100g
values) and `FAST_FOOD` uses fixed-portion tuples
`[name, kcal, protein, carbs, fat, sodium, satfat, sugar, fiber]`. Keep new
entries in those exact shapes and keep the values sourced (USDA-typical for
basics, chain-published for fast food).

## AI analysis

`aiAnalyze()` routes by **API key prefix**: `sk-ant…` → `claudeEstimate()`
(Anthropic Messages API, browser-direct header opt-in), anything else →
`geminiEstimate()` (Google AI Studio, the free path the README recommends).

Gemini calls walk `GEMINI_MODELS` in order, hopping to the next model on
404/429/503/garbled output, then make one second pass after a pause;
`AI_TIMEOUT_MS` bounds each request and `AI_DEADLINE_MS` bounds the whole
analysis. Photos are shrunk by `shrinkForAi()` before upload (the stored photo
keeps full quality). Responses go through `parseAiJson()`, which tolerates
markdown fences and surrounding prose. Every failure path must end at a
`friendlyGeminiError()`-style message the user can act on.

If you touch this area: keep the timeouts, keep the fallbacks, and keep daily-
quota errors distinct from per-minute rate limits (waiting helps for one and
not the other).

## Versioning and cache invalidation

Three things move together when you ship a user-visible change:

1. **`APP_VERSION`** in `app.js` — shown in Settings, used to tell users which
   build they're on. Bump it for any user-visible change.
2. **`CACHE`** in `sw.js` (`nutrilog-v3`, `trapmap-v1`) — bump when the shell
   file list changes or a stale cache would break the app. The SW is
   stale-while-revalidate, so ordinary edits reach users on second launch
   without a bump.
3. **`SHELL`** in `sw.js` — add any new same-origin file that must work
   offline. A file missing from `SHELL` breaks offline launch.

## Deployment

`.github/workflows/pages.yml` uploads the whole repo to GitHub Pages on push.
Its trigger is an **explicit branch allow-list**:

```yaml
on:
  push:
    branches: [main, claude/phone-app-github-questions-43dk9c, …]
```

A push to a branch that is not listed **will not deploy** — if the user needs
to preview work from a new branch on their phone, add that branch to the list
in the same commit. NutriLog is served at the Pages root and TrapMap at
`/trapmap/`.

## Testing

There is no automated test suite, linter, or type checker — do not invent a
`npm test` and do not claim you ran one. Verify changes by:

- `node --check app.js` (and `node --check trapmap/app.js`) for syntax.
- Serving the directory statically (`python3 -m http.server`) and exercising
  the change in a browser, with a narrow mobile viewport.
- Reasoning explicitly about the offline path, the empty-state path (day with
  no entries, no goals set, first run), and the IndexedDB upgrade path for
  an existing user.

Camera, GPS, wake lock, and Web Share require HTTPS or `localhost`, and
several only work on a real iPhone — say so plainly rather than reporting
them as verified.

## Git workflow

- Work on the branch named in the session instructions; create it locally if
  it doesn't exist. Push with `git push -u origin <branch>`.
- Commit subjects are short, imperative, and written from the **user's**
  point of view — the existing log reads like a changelog ("Add daily steps
  card and peptide tracker tab", "Never hang on slow connections during AI
  analysis", "Ride out Gemini demand spikes automatically"). Match that voice.
- Non-trivial commits get a body explaining the user-visible behavior and why,
  wrapped at ~72 columns.
- Update the relevant `README.md` feature list when you add a user-facing
  feature; the READMEs are the app's documentation for a non-technical owner.
- Don't create a pull request unless asked.
