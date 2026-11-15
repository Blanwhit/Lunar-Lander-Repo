# Moon LOD viewer

A static website that shows only the Moon, in 3D, against the real star sky. Terrain is streamed
level-of-detail from raw NASA elevation data, from the whole globe down to **5 m/px at the lunar
south pole**. The Sun and the Earth sit at their real positions in the sky for any date and time
from 2000 to 2050 (JPL Horizons), and the Moon is lit by the Sun. The only interface is a slim
bar along the bottom:

* **Scale bar** (bottom-left): ground distance at the centre of the view in metric units
  (1/2/5 × 10ⁿ m or km, about 60–120 px wide).
* **Date and time** (bottom-centre, UTC): ▲/▼ above and below each field (day, month, year,
  hour, minute). Click to step, hold to repeat (it accelerates). The mouse wheel or the ↑/↓ and
  PgUp/PgDn keys work on a focused field. The date order follows the browser's locale. Changing
  the date to the 31st and then the month clamps to the month's length. The range is limited to
  the ephemeris (2000-01-01 to 2050-12-31). It starts at the current time.
* **Feasibility Overlay** (right of the date/time box): an ON/OFF switch. When it's on, every
  point of the Moon is coloured by its landing-site feasibility at the selected date and time,
  on a smooth red (0 %) → yellow (50 %) → green (100 %) scale (see
  [Feasibility score](#feasibility-score)).
* **Compass** (bottom-right, Google-Earth style): the red needle points to lunar north on
  screen; click it to turn the view back to north-up (position, zoom and tilt are kept).
* **Drag**: orbit (inertia). **Shift-drag / Ctrl-drag / two-finger twist**: heading and tilt.
* **Right-click** a spot: the view pans it to the centre and a popup shows its coordinates and
  colour-coded feasibility score. **More info** (or F3 while a spot is selected) opens a panel
  with the full site report: Sun, Earth and landing factors with the power, connectivity and
  landing scores. Escape closes both.
* **Wheel / pinch**: zoom, from the whole Moon down to just above the surface. The view tilts
  towards the horizon automatically near the ground.
* Point analysis (Earth link, power, temperature, slope, Earthrise/-set): see the
  [Site API](#site-api-websrcapi).
* Optional deep link: `#lat,lon,distance_m[,heading_deg[,tilt_deg[,UTC time]]]`. For example,
  Shackleton crater is `#-89.67,129.8,25000,0,55`, and an earthrise over the east limb is
  `#2,84,40000,270,82,2026-01-10T12:00Z`.

## Surface walking in VR

On the hosted Moon site, select a point on the computer and click **Land**. Open Moon in the Quest browser, choose **Connect to computer**, and enter the three-digit code shown on the computer. Choose **Resume VR** on subsequent visits. Once the Quest connects, click **Cast** on the computer. **Resize** expands the view. On the lunar surface, the expanded cast uses the headset’s rendered eye image and buffers about a second of motion when both browsers support it.

Drag the globe to see the far side. Physical steps move the viewpoint. On Quest 2 the left stick steers, the right stick turns, the left grip runs with stick input, and A jumps. Hold the right index trigger to sprint forward, or steer the sprint with the left stick. Releasing the trigger preserves airborne momentum and lets foot contact slow the astronaut toward the selected walking pace or a stop. A running jump carries your horizontal velocity through flight. The suit follows your head and controller positions. On desktop, click terrain to travel, drag to look, move with WASD or the arrow keys, hold Shift to run, and press Space to jump.

In a Quest session, aim the right controller at terrain and hold **B** to point at a spot. Crouch and hold the **right grip** against a loose rock to lift it. Turn your hand to inspect the scan and release the grip while moving to toss it. The helmet soundscape models ventilation, breathing and transmitted boot impacts. Each boot contact pulses its corresponding controller when haptics are available.

The surface view reports east-positive longitude, latitude, elevation above the 1,737.4 km lunar reference sphere, and approximate elevation-grid spacing. It uses measured topography at its geographic location, including lunar curvature. The terrain around a landing can load a roughly 167 m LOLA grid. A bundled 948 m grid covers the whole Moon, with finer local and polar data where available. The surface readout shows regional rock cover from Diviner and the surveyed density of boulders at least 4.5 m across where LROC imagery provides counts. Elsewhere it labels the estimate. Individual rock positions, grains and footprints are simulated. The Sun and the Earth in the walk are at their true positions for the UTC time selected in the bottom bar, seen from the landing spot (JPL Horizons ephemeris, the same as the orbital view), so a night-side or shadowed polar site is dark and lit only by earthshine. Direct sunlight and the Sun's glare (the same pass as in the orbital view) fade with how much of the disc the walk terrain leaves visible from the eye, so standing below a crater rim that hides the Sun puts you in shadow.

To regenerate the walking grids from the full local tile build, run `.venv/bin/python pipeline/export_walk_terrain.py` and `.venv/bin/python pipeline/export_walk_regions.py` from the repository root. The hosted headset test includes orbital tile levels 0–2 and the full walking grids. The local build includes the complete orbital tile pyramid.

Pairing and casting use the same-origin `/api/quest/` routes in `web/worker/quest.mjs`. For a hosted build, run `npm run build:site` in `web/` and serve the generated Worker with its `BUCKET` storage and `ASSETS` static bindings. The existing `make build` target produces the standalone static viewer.

## Build and run

### Just run the viewer

If `web/public/tiles/` is already there (copied from another machine or a release archive; it
isn't in git, see [Repository layout and size](#repository-layout-and-size)):

```bash
cd web
npm install
npm run dev        # http://localhost:5173
```

Without the tiles the page stays black. Everything below builds them from the NASA data.

### Build everything from scratch

#### 1. Prerequisites

| what | version | used for |
|---|---|---|
| Python | 3.11+ (built with 3.12) | the data pipeline (`pipeline/`) |
| Node.js + npm | 18, 20 or 22+ (Vite 6; built with 22.1) | the viewer (`web/`) |
| gcc / g++ and `sh` | any recent; on Windows MSYS2 MinGW-w64 + Git Bash | compiling the Basis Universal texture encoder once |
| GNU make | optional | shortcuts; every target is a one-liner, see [Without make](#without-make-windows) |
| disk | ~25 GB free at the peak | 11 GB raw data + up to 7 GB cache + 3.2 GB tiles + 3.2 GB `web/dist` |
| network | | NASA PDS / MIT / SVS servers (raw data), GitHub (encoder sources), JPL Horizons API (ephemeris) |

Run everything from the repository root. On macOS/Linux the venv Python is `.venv/bin/python`
instead of `.venv/Scripts/python` (the Makefile picks the right one).

#### 2. Steps

| # | command | what it does | output | time (32 threads) |
|---|---|---|---|---|
| 1 | `make venv` | creates `.venv` and installs [requirements.txt](pipeline/requirements.txt) (numpy, scipy, rasterio/GDAL, OpenEXR, opencv, zstandard, ...) | `.venv/` | a few min |
| 2 | `make web` | `npm install` in `web/` | `web/node_modules/` | ~1 min |
| 3 | `make download` | downloads every file in [sources.json](pipeline/sources.json): DEMs, colour map, star map, Earth images. Sizes are printed first; files over 5 GB are refused unless `--allow-large`. Resumable: after an interruption just run it again, finished files are skipped | `data/raw/` (11.0 GB) | ~65 min |
| 4 | `make basisu` | fetches Basis Universal v1_50_0_2 from GitHub and compiles it with g++ | `tools/basisu(.exe)` | a few min |
| 5 | `make tiles` | overviews → heights → colour → stars → meta → stats → ephem → earth (see below) | `web/public/tiles/` (2.7 GB), `web/public/ephem/`, `web/public/sky/earth.jpg` | ~50 min |
| 6 | `make feasibility` | static inputs of the feasibility overlay (terrain horizons, slope, annual Sun/Earth statistics); adds the `feasibility` entry to `tiles/meta.json` | `web/public/tiles/f/` (~135 MB) | ~40 min |
| 7 | `make build` | type-check + `vite build`; copies `web/public` including the tiles | `web/dist/` (~2.7 GB static site) | ~1 min |
| 8 | `make serve` | serves `web/dist` | http://localhost:4173 | |
| | `make pack` | optional: losslessly packs `data/raw` (10.9 → 5.1 GB, SHA-256 verified); `make unpack` restores it bit-exact | `data/raw_packed/` | |

`make tiles` runs these pipeline steps, each also available on its own:

| target | step | needs |
|---|---|---|
| `overviews` | cached 2×2-mean pyramids of every source DEM | the DEMs in `data/raw` |
| `heights` | cube-sphere height tiles L0–L11 (`MAX_LEVEL`, default 11) with `WORKERS` processes (default 24) | `overviews` |
| `colour` | KTX2 colour tiles L0–L5 | `data/raw/lroc_color.exr`, `tools/basisu` |
| `stars` | star cubemaps (512², 2048² and 4096²) from the 16K celestial star map | `starmap_2020_16k.exr`, `tools/basisu` |
| `meta` | writes `tiles/meta.json` (levels, star files) | the steps above |
| `stats` | prints the table in [Tile pyramid](#tile-pyramid-output-of-make-stats) | `heights`, `colour` |
| `ephem` | Sun/Earth state vectors 2000–2050 from the JPL Horizons API, validated against Horizons' sub-solar and sub-Earth points | network |
| `earth` | Earth texture with baked-in clouds | the Earth images (downloads them if missing) |

`ephem` and `earth` refresh files that are already committed, so a build that only needs the
tiles can leave them out by running the other targets directly.

#### Without make (Windows)

The same steps as plain commands (Git Bash, from the repository root):

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r pipeline/requirements.txt
(cd web && npm install)
.venv/Scripts/python -I pipeline/download.py --workers 16
sh pipeline/build_basisu.sh                      # needs MinGW g++ on PATH
.venv/Scripts/python -I pipeline/build.py overviews
.venv/Scripts/python -I pipeline/build.py heights --max-level 11 --workers 24
.venv/Scripts/python -I pipeline/build.py colour
.venv/Scripts/python -I pipeline/build.py stars
.venv/Scripts/python -I pipeline/build.py meta
.venv/Scripts/python -I pipeline/build.py stats
.venv/Scripts/python -I pipeline/ephemeris.py --start 2000 --end 2050 --validate
.venv/Scripts/python -I pipeline/build.py earth
.venv/Scripts/python -I pipeline/feasibility_grid.py --workers 24
(cd web && npm run build && npm run preview)     # http://localhost:4173
```

#### Check the result

`web/public/tiles/meta.json` should end up like this (the `feasibility` block appears only after
step 6):

```json
{
 "format": "MLH2",
 "maxLevel": 11,
 "colourMaxLevel": 5,
 "tileN": 256,
 "grid": 259,
 "radius": 1737400.0,
 "stars": ["stars_512.ktx2", "stars_2048.ktx2", "stars_4096.ktx2"],
 "feasibility": {"format": "MLF1", "samples": 64, "azimuths": 64, "maxLevel": 6,
                 "globalLevel": 3, "polarLat": 84.0, "referenceYear": 2026}
}
```

With the default settings `make stats` reports the numbers in
[Tile pyramid](#tile-pyramid-output-of-make-stats). The viewer's Feasibility Overlay switch only
does something when the `feasibility` block is present.

#### Order and re-runs

* **Feasibility comes last.** It reads the finished height tiles and the 2026 ephemeris, then adds
  its entry to `meta.json`. Re-running `make meta` (or `make tiles`) later keeps that entry as long
  as `tiles/f/` exists, so the ~40 min step never has to be repeated just to restore it. Rerun
  `make feasibility` only when its inputs change: new height tiles (another `MAX_LEVEL`, other
  DEM sources or settings) or different feasibility options. Deleting `tiles/f/` and running
  `make meta` removes the entry.
* **Packed raw data.** If `data/raw` has been packed (`make pack`), run `make unpack` before
  rebuilding any tiles. The pipeline reads the original files.
* **Smaller or faster builds.** `make heights MAX_LEVEL=9` stops the quadtree earlier (about 20 m
  instead of 5 m at the south pole; each level beyond L6 is built only where a source DEM is fine
  enough). `WORKERS=8` uses fewer processes on smaller machines, at the cost of time.
* **Rebuilding one part.** Each target runs on its own once its inputs exist, e.g. `make stars meta`
  after changing the star settings in [config.json](pipeline/config.json).
* **Starting over.** `make clean-tiles` deletes `web/public/tiles/`. `data/cache/` can be deleted
  as well; `overviews` and `colour` rebuild it.

## Site API (`web/src/api/`)

A headless TypeScript API. Give it a point and a UTC date/time, and it reports Earth
connectivity, power availability, temperature, elevation, slope and the time until the next
Earthrise or Earthset. **The surrounding terrain is taken into account** for every
line-of-sight quantity. It reads the same data as the viewer: the height-tile pyramid, the JPL
Horizons ephemeris and the IAU orientation. It needs no WebGL and has been tested in the
browser. It should also run in Node 18+ (it only needs `fetch`
pointed at a server hosting the site), but that hasn't been tested.

```ts
import { createSiteApi } from './api/siteApi';
const api = createSiteApi({ baseUrl: '/' }); // folder that contains tiles/ and ephem/
const r = await api.query({ lat: -89.475, lon: 222.69, time: '2026-03-01T12:00Z' });
// options: observerHeightM (default 2), linkMaskDeg (default 0), searchDays (default 30)
```

From the viewer's console: `const api = await __moon.siteApi()`.

**How terrain is handled.** Each query first builds a 360° **terrain horizon profile**.
For every azimuth (1° steps) it ray-marches the tile pyramid outward from the observer, using
finer tiles nearby and coarser ones far away for about 0.15° angular resolution. A ray stops
once even the highest lunar terrain (+10.8 km) could no longer rise above the horizon found so
far, typically 40–280 km out. The Sun and Earth count as visible by the fraction of their
discs above that horizon, so a crater floor whose rim hides the Sun gets no power, and a site
behind a ridge loses its Earth link.

| field | meaning |
|---|---|
| `elevation.heightM`, `radiusM`, `dataResolutionM` | terrain height (vs the 1737.4 km sphere), radius, and grid spacing of the data used (5 m near the south pole, 167–333 m elsewhere) |
| `slope.slopeDeg`, `aspectDeg`, `baselineM` | local slope and downslope direction (clockwise from north), from central differences over 2 grid cells |
| `earth.*`, `sun.*` | azimuth, elevation, terrain-horizon elevation in that azimuth, margin, angular radius, visible disc fraction, distance |
| `earthConnectivity` | `clear` / `partial` / `blocked` (whole disc / part / none above the horizon plus `linkMaskDeg`), `lineOfSight`, margin |
| `earthEvents` | next Earthrise / Earthset (UTC) and minutes until each, within `searchDays` (the Earth's centre crossing the terrain horizon plus mask; libration drives these); `null` if none |
| `power` | `sunlit` / `partial` / `shadow`; solar constant at the Moon's distance; irradiance for a sun-tracking panel, a horizontal panel and the local ground slope; next sunrise / sunset; illumination statistics for the next 365 days (mean disc fraction, any part, centre) |
| `temperature` | surface and ~0.5 m subsurface temperature, regime (`sunlit` / `shadow` / `night` / `permanent-shadow`), hours since sunlight, uncertainty, method |
| `meta` | horizon step and reach, tiles loaded, compute time, data sources |

**Temperature model.** The default ([thermal.ts](web/src/api/thermal.ts)) is a 1-D regolith
heat-conduction model using Hayne et al. (2017) Diviner-calibrated properties: density and
conductivity profiles, temperature-dependent heat capacity, radiative conductivity, and
incidence-dependent albedo. It's driven by the terrain-shadowed, slope-aware absorbed sunlight
at the point over the preceding three lunations (30-minute steps). Pass
`temperatureModel` to `createSiteApi` to swap it, for example for LRO Diviner data.

**Validation** (2026-03-01 12:00 UTC):

| site | result | reference |
|---|---|---|
| Apollo 11 (0.67°N, 23.47°E) | Earth at 70°, never sets; sunlit; 386 K surface, 247 K at 0.5 m | Diviner equatorial noon ~390 K, ~250 K at depth |
| far side (0°, 180°E) | Earth never visible; 104 K five days after sunset | Diviner ~100 K |
| east limb (0°, 90°E) | Earth sets 8 Mar, rises 25 Mar (libration) | expected monthly cycle |
| Shackleton floor (89.67°S, 129.8°E) | rim horizon 21°; never sunlit in the next year; Earth blocked | permanently shadowed region |
| Shackleton connecting ridge (89.475°S, 222.69°E) | 83% of the year with some Sun; points 1 km away 14–56% | published ~80–90% for the ridge |
| 33°N, 16°W (Mare Imbrium) | inside a ~9 km fresh crater: 21° rim horizon, 1.3 km below the mare | crater confirmed in the independent LROC colour map |

**Limitations.**
- **Terrain resolution:** follows the tile pyramid. Away from the poles the data is 167–333 m
  (SLDEM2015 128 ppd), so small rocks and boulders aren't resolved.
- **Lighting:** temperatures leave out light scattered by, and infrared emitted from,
  surrounding terrain. Values in permanently shadowed regions (19 K on Shackleton's floor) are
  therefore lower bounds; measured values are ~25–70 K.
- **Earth link:** this is line-of-sight geometry only. There is no RF link budget and no
  diffraction model.
- **Range and speed:** times are limited to the ephemeris range (2000–2050). The first query at
  a site takes ~0.3–1.5 s, mostly loading height tiles (~40 KB each) for its horizon; a missing
  tile is loaded together with every level below it that the lookup needs, so the horizon is
  ready after 2–3 fetch rounds. Further queries at the same site (another date or time) take
  ~50–100 ms: the horizon and the reference-year statistics are cached per site.

## Feasibility score

A 0–100 % landing-site score with three categories: **power generation**, **Earth
connectivity** and **landing**. It's built from every quantity the Site API reports and
combined in three tiers ([feasibility.ts](web/src/api/feasibility.ts)). The overlay and the
API share this module, so they combine their inputs identically.

1. **Utility curves.** Each raw sub-factor is mapped to 0–100 by a piecewise-linear curve.
   A curve can declare a *knockout*, a value at which the site is impossible.
2. **Category scores.** Sub-factors combine into category scores, and categories into an
   overall score, with a weighted power mean M_p = (Σ wᵢ sᵢᵖ)^(1/p). The default is the
   geometric mean (p = 0): the score leans toward the weakest factor without that factor
   erasing everything else. Scores are floored at 1 so that the mean stays finite.
3. **Gates.** Critical categories have a gate: gᵢ = 1 if sᵢ ≥ τᵢ, else (sᵢ/τᵢ)^k. The final
   score is clamp(G·M, 1, 100), where G = Πgᵢ, and G = 0 on any knockout. Power and Comms
   gates are soft (τ = 10, k = 1): they only bite when a category is nearly absent, so a weak
   category is penalised once (by the mean), not three times (mean + p < 0 + hard gate).

**Grazing geometry.** Near the poles the Sun and the Earth skim the horizon, so two choices
make the score usable there:
- **Mast height.** Power is scored for a panel 10 m above the ground and Comms for an antenna
  10 m up (`panelHeightM`, `antennaHeightM`; the brief allowed 2–10 m for the panel). Published
  polar illumination studies show ridges gaining several percentage points of sunlight going
  from 2 m to 10 m. The landing temperature still uses the ground (the query's
  `observerHeightM`, default 2 m).
- **Horizon tolerance δ = 0.4°** (`horizonToleranceDeg`). A body counts as visible while its
  margin above the terrain horizon is > −δ. This covers DEM error at the 20 m polar grid and
  diffraction at grazing angles. It applies to the Sun and the Earth in every Power/Comms input
  (visible now, hours remaining, link margin, annual statistics), on top of the API's
  `linkMaskDeg`. The reported geometry (`earth`, `sun`, `earthConnectivity`, rise/set events)
  stays physical: observer height, no tolerance.

The overlay bakes both into its tiles (`MAST_H`, `HORIZON_TOL` in
[feasibility_grid.py](pipeline/feasibility_grid.py)); keep them equal to the config.

Defaults. **All of these are placeholders; replace them with your lander's tolerances** in
`DEFAULT_FEASIBILITY`:

| category (weight) | sub-factor (weight) | utility curve (value → score) |
|---|---|---|
| **Power** (0.25), gate τ = 10, k = 1 | Sun visible now (0.35) | visible fraction of the solar disc 0 → 0, 1 → 100 |
| | sunlight remaining (0.35) | 0 h → 0, 24 h → 40, 7 d → 80, 14 d → 100 |
| | annual illumination (0.30) | mean visible-disc fraction over 2026: 0 → 0, 0.3 → 40, 0.6 → 80, 0.9 → 100 |
| **Earth connectivity** (0.25), gate τ = 10, k = 1 | Earth visible now (0.30) | 0 → 0, 1 → 100 |
| | link margin above the terrain (0.20) | 0° → 0, 2° → 60, 10° → 100 |
| | Earth contact remaining (0.25) | 0 h → 0, 24 h → 40, 7 d → 80, 14 d → 100 |
| | annual Earth visibility (0.25) | fraction of 2026: 0 → 0, 0.5 → 70, 1 → 100 |
| **Landing** (0.50), gate τ = 40, k = 2 | slope (0.60) | 0–5° → 100, 10° → 50, 15° → 0, **> 15° knockout** |
| | surface temperature (0.30) | 40 K → 10, 100 K → 70, 130–360 K → 100, 420 K → 30 |
| | elevation, as local prominence (0.10) | height above the mean of a 3 km ring: −500 m → 40, 0 → 80, +300 m → 100 |

Any sub-score near 0 dominates its category no matter how small its weight. That's
why the non-critical curves (temperature and prominence) keep a non-zero floor. The method
reproduces the worked example: categories of 27 / 56 / 70 with weights 0.25 / 0.25 / 0.5 give
56 (p = 1), 52 (geometric), 44 (p = −2) and 27 (minimum).

**API.** Every `query()` returns `feasibility` with the final score, the category scores, the
sub-scores, the raw inputs, the gate and any knockouts.

**Overlay.** The static inputs are precomputed per grid point by
[feasibility_grid.py](pipeline/feasibility_grid.py) (`make feasibility`). Those are height,
slope, prominence, a 64-azimuth terrain horizon, and the 2026 sun, Earth and absorbed-flux
statistics. They're stored as a separate quadtree of score tiles (`tiles/f/`, format `MLF1`):
- levels 0–3 cover the whole Moon at 64 × 64 samples per tile, about 5.3 km apart at level 3;
- levels 4–6 cover |latitude| ≥ 84° at about 670 m spacing.

When the overlay is on, Web Workers evaluate the time-dependent part for the selected date and
time, then score it with the same rules as `feasibility()` (`feasibilityScorer()`: identical
scores, without building the breakdown). That part is the Sun and Earth now, hours of sunlight and
Earth contact remaining (3-hour steps), and temperature. The time scans skip steps whose outcome
is certain: a body's elevation changes by at most the angle it moves on the sky (plus parallax),
so while it stays above a sample's highest horizon bin it can't have set (and while it stays a
full disc below the lowest bin it can't have been up), and those steps aren't evaluated. The score is uploaded as a
small texture per tile, and the terrain shader turns it into the colour ramp. Changing the date
re-evaluates the visible tiles, on-screen ones first, and keeps the previous colours until new
ones arrive.

**Where the overlay differs from the API at the same point:**
- **Horizon resolution:** 64 azimuths instead of 360.
- **Mast height:** the overlay's horizons are marched once, from 10 m, for the Sun, the Earth
  and the temperature proxy; the API uses the config's panel and antenna heights for the score
  and the query height for the temperature.
- **Terrain detail:** the overlay uses height tiles up to level 6 (167 m) globally and level 9
  (20 m) near the poles, while the API uses everything down to 5 m. Slopes therefore differ
  where the terrain is rough at small scales.
- **Temperature:** the overlay uses a fast proxy, not the API's 1-D model. When sunlit it's the
  instantaneous radiative equilibrium; in shadow it's exponential cooling from 0.6 × T_deep
  toward 0.4 × T_deep, where T_deep comes from the point's annual mean absorbed flux.

**Numbers.**

| item | value |
|---|---|
| score tiles | 830: levels 0–3 global (510), levels 4–6 polar (320); 3.40 M samples |
| size | 146 MB in `web/public/tiles/f/` |
| precompute | 38 min on a 32-thread laptop (24 workers; the first version took 2.6 h, and the rebuild is byte-identical to it for all 830 tiles), plus 5 min to build the decoded height store (`data/cache`, 4.1 GB, regenerable). The horizon rays are marched in cache-sized blocks of 16 384 (`FEAS_CHUNK`), which matters most when all workers share the memory bandwidth |
| overlay update after a date change | scoring is 3× faster than the first version (~19 ms per 64 × 64 tile instead of ~56 ms, one thread); the whole-Moon view was fully coloured 0.8 s after switching the overlay on (3 workers, tiles loading included). A new region also waits for its score tiles to load. The previous colours stay until the new ones arrive |
| overlay vs API, same point and time | equatorial and mid-latitude samples within 0.2 points. Polar samples are typically within 0–4 points, up to ~20 where the 5 m and 20 m terrain give different slopes |

**Reading the map.**
- **The score is for the selected moment.** The night side is red (no power), and a yellow band
  just ahead of the terminator marks sites with little sunlight left.
- **Steep slopes.** Crater walls and rims steeper than 15° are knocked out, so they show red.
- **South pole.** Only crater rims and ridges score, such as Shackleton's rim and the connecting
  ridge towards de Gerlache. Floors are permanently dark.

## Repository layout and size

The git repository is **4.5 MB** (95 tracked files). The full working folder is **8.9 GB**
after lossless compaction:

| path | size | in git | what it is / how to get it back |
|---|---:|:---:|---|
| `pipeline/`, `web/src/`, docs, config | ~0.25 MB | yes | source code and documentation |
| `web/public/ephem/` | 3.6 MB | yes | Sun/Earth ephemeris 2000–2050 from JPL Horizons (`make ephem`) |
| `web/public/sky/earth.jpg`, `web/public/basis/` | 0.7 MB | yes | Earth texture, Basis transcoder |
| `web/public/tiles/` | 2.77 GB (74,093 files) | no | generated tile pyramid (`make tiles`) and feasibility tiles (`make feasibility`) |
| `data/raw_packed/` | 5.12 GB | no | NASA source data, losslessly packed (`make pack`) |
| `data/raw/` | 10.93 GB when unpacked | no | `make unpack` (bit-exact, SHA-256 checked) or `make download` |
| `data/cache/` | ~7 GB when present | no | intermediates, regenerated by `make overviews` / `make colour` |
| `web/dist/` | ~2.7 GB when present | no | `npm run build` output (copies `public/` incl. tiles) |
| `.venv/`, `web/node_modules/`, `tools/` | 0.57 GB | no | environments and the compiled encoder (`make venv`, `npm install`, `make basisu`) |

* **What a clone contains.** A plain `git clone` has the code, the ephemeris and the Earth
  texture, but not the tiles. Either rebuild them (see
  [Build everything from scratch](#build-everything-from-scratch)) or copy
  `web/public/tiles/` across separately. On GitHub, the code and tiles together are about
  3.2 GB. Every tile is under 75 KB (the largest files are the star cubemaps), but GitHub
  caps a single push at 2 GB, so committing
  the tiles would take several pushes. Attaching them to a GitHub Release as archives keeps the
  repository small. The raw data shouldn't go to GitHub: it's public NASA data (`make download`),
  and several packed files are over GitHub's 100 MB per-file limit.
* **Lossless packing.** `make pack` compresses `data/raw` with a per-sample delta (int16 DEMs)
  or an XOR filter (float DEM), then a byte shuffle and zstd: 10.93 GB becomes 5.12 GB. Every
  file is verified bit-exact by SHA-256 after a full decompression before its original is
  removed. `make unpack` restores the originals, which the tile pipeline needs.
* **Lossless limits.** The height tiles use a dedicated lossless codec (`MLH2`, see
  [Pipeline](#pipeline-pipeline) step 3). It is 21% smaller than the earlier planar + zlib
  encoding (2.59 → 2.04 GB), and the walk-terrain grids are 23% smaller (40.5 → 31.2 MB).
  General-purpose coders would save less: zstd-19 on the same residuals saves 11%. The KTX2
  colour tiles already use zstd (1.3% more is possible at the maximum level). The EXR sources
  are already compressed. Shrinking further would need lossy changes, such as coarser height
  quantisation or ETC1S colour; neither is applied.

## How it works

### Pipeline (`pipeline/`)
1. **Download** ([download.py](pipeline/download.py)): resumable, multi-connection, multi-mirror
   (PDS Geosciences + MIT) HTTP range downloader.
2. **Sources** ([moonlod/sources.py](pipeline/moonlod/sources.py)): PDS3 labels are parsed for
   scale, offset, unit and projection. Raw `.IMG` rasters are memory-mapped (out of core). Each
   source gets a cached 2×2-mean overview pyramid.
   * Isolated gridding outliers in the LOLA polar DEMs are despiked: a sample is replaced by its
     3×3 median only if it deviates by more than max(15 m, 1.5 × the grid spacing), which
     touches about 0.0001% of samples. Set `despike_m` to 0 in
     [config.json](pipeline/config.json) to use the untouched values.
3. **Height tiles** ([moonlod/heights.py](pipeline/moonlod/heights.py)): cube-sphere, 6 faces,
   equi-angular (EAC) mapping, one quadtree per face. Each tile is 257×257 vertices plus a
   1-sample border (259×259) for seamless normals.
   * Sources are composited from coarse to fine, and each finer source is blended in over a
     latitude band inside its coverage edge. That covers the ±60° SLDEM/LOLA seam and the 45°, 60°,
     75°, 80° and 87.5° polar-cap edges.
   * Sampling is **trilinear over the source mip pyramid**, using each sample's analytic EAC
     footprint. Samples on a shared tile edge therefore get bit-identical heights, and no seams
     appear between tiles or faces.
   * Encoding (`MLH2`, [moonlod/gridcodec.py](pipeline/moonlod/gridcodec.py)): 16-bit quantised
     heights with a per-tile base and step. The step is about cell/256: 32 m at L0, 3 cm at L11.
     The grid is stored losslessly in three steps. A lattice step divides out a common value
     spacing, which appears when a grid was resampled from coarser quantised data. Prediction uses
     either a planar predictor (left + up − upleft) or an 11-neighbour least-squares predictor
     fitted to each tile, whichever codes smaller. Static rANS then codes the residual tokens,
     with one frequency table per local-activity context. The browser decodes it with
     [gridCodec.ts](web/src/terrain/gridCodec.ts), about 3–4 ms per tile in a worker, with no
     library. A pyramid built in the older zlib format (`MLH1`) is converted in place, bit-exact,
     by `make transcode-heights`.
   * A tile at level L exists only if some source covering it has a resolution ≤ 1.5 × the
     cell size of L. Child sets are all-or-nothing.
4. **Colour tiles**: 256² tiles up to L5 (≈333 m/px, matching the ~400 m source). Texels are
   corner-aligned, so edge texels sit on the tile boundary and neighbours match. They're sampled
   trilinearly like the heights and stored as KTX2 with mipmaps: ETC1S for L0–L1 (small initial
   load) and UASTC + zstd for L2–L5 (no chroma blocking when magnified). Deeper tiles reuse the L5
   texture with a UV transform.
5. **Stars** use NASA’s 16K celestial map. A 512² cubemap covers the first frames while the
   viewer loads the 4096² sky independently of terrain. A 2048² version serves smaller GPUs.
6. **Ephemeris** ([ephemeris.py](pipeline/ephemeris.py)): the Horizons API sends no CORS
   headers, so the browser can't query it live. The pipeline fetches Moon-centred (`500@301`),
   light-time-corrected ICRF state vectors (position + velocity) of the Sun and the Earth every
   6 h for 2000–2050. It stores them as one ~69 KB file per year in `web/public/ephem/` (3.6 MB in
   total). `--validate` checks the viewer's Moon orientation against Horizons' own sub-Earth and
   sub-solar points (see below).
7. **Earth texture**: NASA Blue Marble (SVS 2915) with clouds baked in (opacity recovered from
   the SVS 3615 with/without-clouds pair), a 1024×512 JPEG (145 KB) in `web/public/sky/`.
8. **Packing** ([pack_raw.py](pipeline/pack_raw.py)): optional, lossless, verified compression of
   the raw downloads (see above).

### Viewer (`web/`)
* **Quadtree LOD** ([TileTree.ts](web/src/terrain/TileTree.ts)): each level L has a split distance
  D_L = max(P·texel_L / threshold, 2.5·tile diagonal), where P is the projection scale in pixels.
  This makes the selection screen-space-error driven (about 1.25 px per height texel) and keeps
  neighbouring tiles at most one level apart.
  * **Frustum culling** uses bounding spheres. **Horizon culling** tests the tile's probe points
    against the lowest-radius occluding sphere.
  * Children replace their parent only when all 4 are loaded.
* **Geomorphing (CDLOD)**: odd vertices slide onto the parent grid over [0.8·D_{L-1}, D_{L-1}]
  using per-vertex camera distance. **Skirts** hide residual T-junction cracks.
* **One shared grid mesh** for all tiles: 65×65 vertices plus skirts by default (`?mesh=32|64|128`
  to change). The vertex shader displaces it from a R16UI height texture (259² samples). Normals
  are baked per tile in a Web Worker into an RG16F tangent-space map with mips, so lighting always
  uses the full height resolution.
* **Precision**: positions are never formed in absolute coordinates on the GPU. The CPU (float64)
  supplies the tile origin relative to the camera, and the shader adds the small offset
  R·(dir − dir_c) + h·dir. That offset is computed with cancellation-free identities, so there is
  no jitter at 5 m/px. The near and far planes adapt to the height above the terrain.
* **Streaming**: height tiles are fetched and decoded in a worker pool and prioritised by
  screen-space error. Colour KTX2 files are transcoded in three.js's KTX2Loader workers. An LRU
  evicts GPU textures above the budget (384 MB). The worker's normal-map bake takes ~2 ms per
  tile (reused scratch buffers, `sqrt(1 + s² + t²)` for the cube-sphere direction length, native
  `Float16Array` conversion where available), so a new 3 km view refines about twice as fast as
  before (a fresh mare site: 104 tiles in 0.35 s instead of 1.04 s, local dev server).
* **Render on demand**: a frame is drawn only when the camera moves, inertia is active, or a tile
  arrives.
* **Time and sky bodies** ([ephemeris.ts](web/src/ephemeris.ts), [time.ts](web/src/time.ts)): UTC
  is converted to TDB using leap seconds plus 32.184 s. The yearly Horizons file is
  cubic-Hermite interpolated from positions and velocities, then rotated into the Moon's body frame.
  * **Sun**: drawn as a limb-darkened 0.53° disc. Its glare (bright aureole, wide veil and six
    thin diffraction spikes) is a separate additive pass after the terrain
    ([sunGlare.ts](web/src/sunGlare.ts)), so it spills over the lunar limb and horizon. It is
    scaled by the visible fraction of the solar disc: one ray per frame is marched from the
    camera towards the Sun over the loaded terrain, and the smallest clearance angle acts as the
    horizon for the disc (≈0.5 ms at the surface, ≈0 in orbit), so the glare fades as the Sun
    sinks behind a rim or the limb. The pass is skipped when the Sun is hidden or more than 70°
    off the view axis.
  * **Earth**: drawn as a sphere impostor. The Blue Marble texture (clouds baked in) is rotated by Greenwich
    sidereal time and lit by the Sun, so it shows its real phase and the face turned towards the
    Moon. It also has a thin atmosphere rim.
  * Both directions are computed from the camera position rather than the Moon's centre, so the
    parallax is exact when you're close to the Moon. Terrain naturally hides both below the
    horizon.
* **Lighting**: the Sun's direction comes from the ephemeris. The BRDF is lunar-Lambert with the
  phase-dependent weight L(α) from McEwen (1996), so the surface is flat near full Moon and darker
  looking into the Sun. Earthshine lights the night side, scaled by the Earth's phase as seen from
  the Moon, and a very small ambient term is added.
* **Bottom bar** ([hud.ts](web/src/hud.ts), [compass.ts](web/src/compass.ts)): plain DOM over the
  canvas. It writes to the DOM only when a value changes, and on narrow screens it stacks: the
  date/time box on top, the scale bar and compass below. Pointer and wheel events on the bar
  don't reach the globe controls.
* **Orientation**: the full time-dependent IAU WGCCRE 2015 Moon model, including the 13 periodic
  libration terms ([orientation.ts](web/src/orientation.ts)). It rotates the J2000 star cubemap
  and the Horizons vectors into the Moon's ME/PA frame. Against Horizons over 2026, the sub-Earth
  point agrees to 0.45′ mean and 0.76′ max. The sub-solar point differs by a constant 4.3′.
  Horizons reports the Moon as the Sun sees it, 8.3 minutes earlier, while lighting at time t
  needs the Moon's orientation at t, which the viewer uses. `setOrientationProvider()` can swap in
  SPICE PA attitude.

## Tile pyramid and numbers

### Tile pyramid (output of `make stats`)

| level | ~m/px | height tiles | height size | colour tiles | colour size | where |
|---:|---:|---:|---:|---:|---:|---|
| 0 | 10 661 | 6 | 218 KB | 6 | 147 KB | global |
| 1 | 5 330 | 24 | 910 KB | 24 | 569 KB | global |
| 2 | 2 665 | 96 | 3.6 MB | 96 | 6.0 MB | global |
| 3 | 1 333 | 384 | 14.3 MB | 384 | 22.6 MB | global |
| 4 | 666 | 1 536 | 54.8 MB | 1 536 | 85.3 MB | global |
| 5 | 333 | 6 144 | 206.7 MB | 6 144 | 315.5 MB | global (colour stops here: ~400 m source) |
| 6 | 167 | 12 896 | 391.4 MB | | | global (SLDEM2015 128 ppd / LOLA 200 m) |
| 7 | 83 | 7 520 | 206.5 MB | | | ≥ 60° N/S (LOLA 120 m) |
| 8 | 42 | 12 288 | 327.1 MB | | | ≥ 75° N/S (LOLA 60 m) |
| 9 | 21 | 10 704 | 361.4 MB | | | ≤ 80° S (LOLA 20 m) |
| 10 | 10 | 2 800 | 106.5 MB | | | ≤ 87.5° S |
| 11 | **5.2** | 10 672 | 364.4 MB | | | ≤ 87.5° S (LOLA 5 m) |
| **total** | | **65 070** | **2.04 GB** | **8 190** | **430 MB** | **2.5 GB** on disk |

* **Maximum resolution reached**: 5.2 m/px (L11) inside 87.5°S, which includes Shackleton, de Gerlache,
  Shoemaker and the Artemis candidate regions. It is 20.8 m to 80°S, 41.6 m at both caps beyond
  75°, 83 m beyond 60°, and 167 m elsewhere. That last figure is limited by the 237 m SLDEM2015 grid
  used here. With the 512 ppd SLDEM grid (45 GB) the same pipeline would reach about 42 m at L8.
* Each height tile has 257×257 samples plus a 1-sample border (259²) and averages 27–38 KB.
  Colour tiles are ETC1S at L0–L1 (~24 KB) and UASTC from L2 (~51 KB). With the star cubemaps
  (4.6 MB), `meta.json` and the 830 feasibility tiles (146 MB), `web/public/tiles/` holds
  74,093 files and 2.77 GB.
* Build time on a 32-thread laptop: overviews ~14 min (despiking the 5 m and 20 m grids takes most of
  it), heights 15 min with 24 processes, colour ~17 min, ephemeris ~2 min (102 Horizons requests).

### Performance (Chrome 156, measured)

Measured on an RTX 4070 Laptop GPU (ANGLE/D3D11) with a 1920×1080 canvas at DPR 1 and
MSAA on, using [web/bench/bench.js](web/bench/bench.js). Each frame is forced with `gl.finish()` while
the camera turns, so the time includes CPU LOD selection and GPU work. The vsync-limited real
frame rate is 60 fps in every case.

These numbers were measured before the Sun/Earth sky and the bottom bar were added. The sky adds
one full-screen pass with a few trigonometric operations per pixel, and the bar is plain DOM,
so the terrain cost dominates. They haven't been re-measured.

| view | tiles | triangles | tex. memory | frame (avg / p95) | GPU time | ≈ fps (uncapped) |
|---|---:|---:|---:|---:|---:|---:|
| whole Moon | 56 | 0.49 M | 43 MB | 0.74 / 1.5 ms | 0.15 ms | 1 350 |
| 200 km orbit | 23 | 0.20 M | 137 MB | 0.71 / 1.7 ms | 0.31 ms | 1 400 |
| Shackleton, 25 km, tilted | 250 | 2.18 M | 357 MB | 3.2 / 5.2 ms | 1.1 ms | 310 |
| Shackleton rim, 3 km (L11, 5 m) | 317 | 2.76 M | 365 MB | 4.0 / 6.2 ms | 0.9 ms | 250 |

* Texture memory is the LRU cache. It is capped by `gpuBudgetBytes` (384 MB) and includes off-screen
  tiles. My estimate for the working set of the 3 km view is ~155 MB: 317 drawn tiles × 488 KB
  (R16UI heights + mipmapped RG16F normals) plus their ancestors and colour. Geometry is one shared
  65×65 grid with skirts (~110 KB).
* For a mid-range laptop (an Iris Xe class iGPU has roughly 1/10 of this GPU's throughput),
  1–1.5 ms of GPU time leaves about 10 ms of headroom inside a 16.7 ms frame. To tune it, use
  `pixelsPerTexel` (LOD threshold) in [main.ts](web/src/main.ts), `?mesh=32|64|128` (mesh density),
  and `gpuBudgetBytes`. We have not measured it on such hardware. Run `moonBench()` from
  [bench.js](web/bench/bench.js) in the console to get your own numbers.
* Streaming: finished tiles are promoted to the GPU at least 1 and at most 8 per frame, within a
  3 ms budget that includes the texture uploads (`renderer.initTexture` while promoting, not later
  inside `render`). Before this throttle, frames during fast flights spiked to 87–132 ms p95. With
  it they stay at 5–6 ms (a fresh 3 km polar view: 284 tiles, p95 3.1 ms, worst 5.4 ms). After the 512²
  preview, the largest star cubemap the GPU supports is loaded right away, independently of the
  terrain streaming.

### Initial payload (original browser build, measured)

Everything fetched until the first frame that has all six L0 terrain tiles, their colour, the
star background and the Sun/Earth positions. The 145 KB Earth texture loads right after:

| item | size |
|---|---:|
| `index.html` + JS bundle (three.js + app, gzip) | 182 KB |
| Basis transcoder wasm | 515 KB (248 KB gzip) |
| L0 heights (6 tiles) | 218 KB |
| L0 colour (6 tiles, ETC1S) | 147 KB |
| 512² star cubemap | 285 KB |
| Sun/Earth ephemeris for the current year (JPL Horizons) | 69 KB |
| **total** | **1.43 MB** (1.16 MB with gzipped wasm) |

On localhost the first full frame, including the Sun and Earth, appears about 0.13–0.35 s after
the app starts. Refinement requests are held back until the base level is complete. These measurements predate the VR branch’s higher-resolution sky.

### Visual verification (automated captures)

* **Shackleton**: the rim is sharp at L11 (5 m). The floor is in permanent shadow and the far wall
  is lit by the grazing sun. Isolated LOLA gridding spikes were removed (see DATA_SOURCES.md). The
  remaining faint radial striations follow LOLA ground tracks and are in the source DEM.
* **Seams**: shared tile and face edges are bit-identical in the pipeline (max difference 0.0000 m,
  tested). Grazing-light captures at a cube-face edge (30°N, 135°E), a cube corner (35.26°S, 45°E)
  and the ±60° SLDEM/LOLA boundary show no visible seam. Colour tiles use corner-aligned texels
  so that adjacent tiles also match.
* **Popping**: during a continuous zoom from 25 to 6 km over Shackleton (200 frames, 142 LOD
  switches), each switch was rendered twice from the same camera, once with the old tile set and
  once with the new. The mean image change per switch was 0.011 grey levels. The worst switch
  changed 0.47% of pixels by more than 16/255. Frame-to-frame change from the camera motion itself
  is ~13 grey levels, so LOD changes are about 1000× below motion. At a 3× coarser LOD threshold,
  geomorphing lowers the worst switch from 0.49% to 0.38% of pixels.

## Data credits

Credits live here and in [DATA_SOURCES.md](DATA_SOURCES.md); the page itself only shows the scale,
date/time and compass.

* **Elevation**: LRO LOLA gridded and polar DEMs (LOLA team, NASA GSFC / MIT, PDS Geosciences
  Node). SLDEM2015 LOLA + SELENE/Kaguya TC merged DEM (Barker et al. 2016; NASA GSFC PGDA / JAXA).
* **Colour**: NASA Scientific Visualization Studio, CGI Moon Kit (2025 colour map). Based on the
  LROC WAC Hapke-normalised mosaic (NASA/GSFC/Arizona State University).
* **Sun and Earth positions**: JPL Horizons (Solar System Dynamics group, NASA/JPL-Caltech),
  DE441-based ephemerides via the Horizons API.
* **Earth image**: NASA Blue Marble (NASA Earth Observatory / SVS 2915, Reto Stöckli et al.);
  clouds from NASA Goddard SVS 3615.
* **Stars**: NASA Scientific Visualization Studio, Deep Star Maps 2020, 16K celestial map
  (Hipparcos-2, Tycho-2, Gaia DR2 / ESA/Gaia/DPAC).
* Challenge: NASA Space Apps 2026, *Lunar Landing Site Navigator*. The resources it lists
  (QuickMap, Moon Trek, Horizons, CSA) were evaluated; see DATA_SOURCES.md for why the raw PDS
  products were used instead.
