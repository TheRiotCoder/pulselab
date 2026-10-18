# PulseLab

**Live app: https://pulselab-3bi.pages.dev/**  ·  Source: https://github.com/TheRiotCoder/pulselab

A private, offline-first web app (PWA) that analyses your **Garmin data export** and shows more than Garmin Connect does: a transparent readiness score, sleep consistency and debt, HRV/resting-HR baselines with normal-range flags, training load (acute:chronic), HR zones, per-activity charts, and plain-language insights with sample sizes and confidence levels.

Vanilla JS/HTML/CSS. No build step. No CDN. No analytics. No accounts. **Your data never leaves your device.**

> PulseLab is **not a medical device** and gives **no medical advice**. Scores are simple, documented formulas and insights are statistical associations in your own data.

## Getting your Garmin export

Garmin does not offer an open API for personal use, so PulseLab reads the data export Garmin will give you. No Garmin login is ever entered into PulseLab.

1. Sign in at **garmin.com/account** (your Garmin Account, in a web browser).
2. Go to **Data Management → Export Your Data → Request Data Export**.
3. Confirm the request from the email Garmin sends you.
4. Garmin emails a download link when ready (minutes to a couple of days). Download the **.zip** to your phone or computer. **Do not unzip it.**
5. In PulseLab open the **Data** tab → **Choose files…** → pick the zip. (Loose `.json`, `.fit` and `.csv` files work too. You can import several times; data is merged.)

An import summary lists exactly what was found (sleep nights, daily summaries, HRV, activities, FIT files…). Account/profile/support folders inside the zip are deliberately never read.

## Views

| Tab | What you get |
|---|---|
| **Overview** | Readiness score (0–100) from *your own transparent formula*, each factor expandable with the exact numbers; trend; weekly deltas; load ratio; top suggestions |
| **Sleep** | Duration, stages, bedtime consistency (SD), sleep debt (7 nights vs your need), duration trend, bedtime/wake chart |
| **Heart** | Resting HR and overnight HRV with a personal baseline band (7-day average vs 60-day mean ± 1.5 SD) and flags for readings outside it; overnight HR |
| **Stress** | Daily stress, Body Battery high/low, charge vs drain |
| **Activity** | Weekly volume by sport, training load (TRIMP + EWMA acute/chronic and the ratio), HR zones, running pace and cycling power trends, activity list; per-activity detail with HR / pace / power / cadence / elevation charts and a GPS route (drawn offline, no map tiles) |
| **Insights** | Weekly summary, correlations (sleep ↔ HRV, sleep ↔ resting HR, sleep ↔ run/ride efficiency, stress ↔ sleep, bedtime regularity ↔ HRV), recovery after hard days, 14-day anomalies (z-scores), trends, rule-based suggestions. Every item shows **n** and a confidence label; items without enough data are withheld |
| **Data** | Import, demo data, delete-all, CSV export, JSON backup/restore, settings |

All charts are hand-written SVG, tappable/draggable (a readout shows exact values), and sized for phones. Date range: 7 / 30 / 90 / 365 days / all (relative to your latest data).

### The formulas (also explained in-app)

* **Baselines** are a rolling 60-day mean and SD. **HRV is handled as ln(HRV)** (baseline, SD and z-scores all on the log scale; the band on the chart is shown back in ms), because HRV is right-skewed. The SD has a floor so a very steady stretch doesn't make every reading look extreme.
* **Readiness** = weighted mean of the factors that are available (re-normalised): Sleep 35% (75% duration vs need + 25% deep+REM share; wrist-device deep/REM stages are only roughly accurate), HRV 25% (70 + 22·z, scoring the **7-night average** vs baseline, not a single night), resting HR 20% (70 − 22·z), yesterday's stress 10% (scored against **your own** 60-day stress baseline, not a fixed scale), training-load balance 10% (acute:chronic ratio; full marks 0.8–1.3, the same 1.3 threshold the advice uses). At least two factors are required.
* **Training load (approximate)** = Banister TRIMP per workout from average HR (workouts without HR are estimated at a moderate effort and flagged); acute = 7-day EWMA, chronic = 28-day EWMA; ratio shown after 4 weeks. Load that rose quickly is associated with more fatigue; it is not an injury predictor.
* **Max HR** is estimated as the 99th percentile of heart rate across your activities (your highest *sustained* HR) when data exists. Data → Settings shows the estimate and asks you to confirm it or enter your own (blank = automatic). Without any HR data a 190 bpm placeholder is used.
* **Single-night flags** (HRV z ≤ −1.5 *and* resting HR z ≥ 1.5) are "worth watching" only. The stronger "strain pattern" warning requires the pattern on **2+ consecutive days**. Neither is a diagnosis; seek care for fever, chest pain, shortness of breath or fainting.
* **Recovery after hard days**: Garmin dates sleep/HRV by wake date, so the HRV on a session's date is from the night *before* it. That day is shown only as a baseline check ("Morning of (before the session)"); the effect starts at +1 day.
* **Insights** use Pearson correlation with p-values on paired days (HRV as ln-deviation, RHR as absolute deviation from the trailing 60-day baseline). *Higher* confidence needs p<0.01, n≥30 and |r|≥0.45; *moderate* p<0.05 and |r|≥0.3; weaker is reported as "no reliable link". Minimum 14 paired days. With several comparisons, one may look significant by chance. Association ≠ cause.

## Privacy model

* Everything is parsed and stored **on-device in IndexedDB**. Nothing is uploaded; there is no server component.
* The page ships a strict Content-Security-Policy (`script-src 'self'`, `connect-src 'self'`, no inline script or style, `form-action 'none'`, `frame-ancestors 'none'` via headers) so the app *cannot* contact other origins. The only requests it makes are for its own static files.
* PulseLab has **no Web Worker**: unzipping and parsing run on the page's main thread (so there is no separate worker script to police). The only worker is the service worker `sw.js`, covered by `worker-src 'self'`. The `/*` rule in `_headers` sends the CSP (and the other security headers) on **every** response, including `/js/*.js`, `/sw.js` and the vendored library; this is verified with `curl` after each deploy.
* No Garmin credentials are requested or stored. Hosting headers also set `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, a restrictive `Permissions-Policy`, and no-cache for `index.html`/`sw.js` (see `_headers`).
* **Backups are unencrypted JSON** containing all your health data; store them privately.
* The only third-party code is [fflate](https://github.com/101arrowz/fflate) (MIT, vendored in `vendor/`) for unzipping.

## Install

* **Android (Chrome):** open the live link → *Install* banner (or ⋮ → Install app).
* **iPhone/iPad (Safari):** open the link → Share → **Add to Home Screen** → Add. Installing helps protect your stored data from Safari's storage clean-up, but it can still be cleared, so take a **backup** (Data tab) now and then. PulseLab shows this hint on iPhone/iPad Safari when it isn't installed.
* **Desktop:** Chrome/Edge install icon in the address bar.

After the first load it works fully offline. Updates show an "Update available" banner (Data → *Check for update*).

> **Moving addresses:** browser storage is per-address. If you used PulseLab at another URL, use **Backup** there and **Restore** here.

## Limitations (honest list)

* **Tested only with synthetic exports.** The importer follows the layout of Garmin's export as documented/seen in community tools (`DI-Connect-Wellness` sleep + health status, `DI-Connect-Aggregator` UDSFile, `DI-Connect-Fitness` summarizedActivities, `DI-Connect-Metrics`, FIT files), but Garmin changes formats between devices and years. Unknown files are skipped, never fatal; the import summary shows what was recognised.
* **Unit handling is heuristic** for summarized activities (duration ms vs s, distance cm vs m, elevation); the importer picks the interpretation that gives a plausible speed. FIT files are unambiguous and preferred when present.
* **Garmin's HRV data in exports is limited** to what is included in health-status files; not every device/export has overnight HRV. Views and insights adapt to what exists.
* Sleep/bedtime clock times are converted from Garmin's GMT timestamps into *this device's* time zone (if you travelled, times can be off; durations are right).
* Garmin's "Activities" CSV has no distance unit, so km is assumed.
* Readiness is **not** Garmin's Training Readiness (that algorithm is private; if it is in your export it is shown for comparison only).
* Heart-rate zones/TRIMP need your max HR: it is estimated from your data (usually a few bpm under your true max) until you confirm or set it in Data → Settings. TRIMP is approximate in any case (average-HR based; without HR, load is an estimate).
* Wrist-device sleep stages (deep/REM) are only roughly accurate; the sleep score leans mostly on duration.
* Insights are correlations on one person's data: they can be confounded (e.g. long runs happen on rested weekends) and are not medical advice. Anomaly flags will fire by chance about 1 day in 20.
* Very large exports (hundreds of MB) are processed in the main thread on your phone; it may take a minute and use a lot of memory. If the browser kills the tab, import the files (e.g. just the Wellness + Aggregator + Fitness JSON) instead of the full zip.
* Browsers may evict site storage under pressure; make backups.

## Development

No build step: serve the folder with any static server (service workers need `localhost` or HTTPS), e.g. `python3 -m http.server 8080`.

```
js/            app.js (router, PWA), views.js, dataview.js, charts.js, analysis.js, insights.js,
               import.js (zip/json/csv/fit routing), fit.js (FIT parser), demo.js, db.js, state.js, util.js
vendor/        fflate (MIT)
tests/         unit.mjs (node), e2e.mjs (headless Chrome at 390px), fixtures.mjs (synthetic Garmin export + FIT builder)
build-dist.sh  copies only app files for deployment
```

Tests: `node tests/unit.mjs` and `PULSELAB_NODE_MODULES=/path/to/node_modules node tests/e2e.mjs` (needs `puppeteer-core` and Chrome at `/usr/bin/google-chrome`; `SHOTS=dir` for screenshots).

Deploy (Cloudflare Pages): `./build-dist.sh dist && wrangler pages deploy dist --project-name pulselab --branch main`.

*Demo data* (Data tab → "Load demo data") is fully synthetic, generated on-device from a fixed seed, and clearly bannered; importing real data removes it.

## Changelog

* **1.1.1** – Importer fixes: stress read from nested `allDayStress.aggregatorList` (TOTAL/ASLEEP) and `totalAverageStressLevel`; later duplicate/zero daily records can no longer overwrite earlier steps/calories/intensity (or resting HR); explicit "No HRV found in this export" notes (import summary, Overview, Heart); HRV fallbacks (sleep-file `avgOvernightHrv` fills gaps; coarse weekly `hrvWeeklyAverage` from Training Readiness only when no nightly HRV, clearly labelled, no single-night flags); sleep SpO₂ / respiration read and charted on the Sleep view; iPhone install hint mentions backups.
* **1.1.0** – Physiology/wording review: ln(HRV) baselines; HRV readiness factor scores the 7-night average; stress scored vs your own baseline; recovery timing fixed (effect starts +1 day; "Morning of" is a baseline check); illness-like flag needs 2+ consecutive days (single night = worth watching) with care advice; load wording/thresholds aligned (1.3); TRIMP labelled approximate; max HR estimated from data with confirm/override; sleep-stage accuracy note; multiple-comparison caveat; softer 48 h wording.
* **1.0.0** – Initial release.
