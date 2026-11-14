# Data sources

Every dataset used by the pipeline, where it came from, and why it was picked.
The machine-readable download list is [pipeline/sources.json](pipeline/sources.json). Run
`make download` (or `python -I pipeline/download.py`) to fetch it. The downloader prints every
file's size before it starts and refuses any file over 5 GB unless you pass `--allow-large`.
The default set is 11.0 GB (24 files, largest 2.83 GB).

## 1. Challenge resources (evaluated first)

Source: NASA Space Apps 2026, *Lunar Landing Site Navigator*, Resources tab (checked 2026-11-14).
The tab links to:

| Resource | What it offers | Use here |
|---|---|---|
| [LROC QuickMap](https://quickmap.lroc.asu.edu/) (ASU) | Interactive viewer with LRO imagery and topography layers. You can export small regions, but there is no bulk raw-DEM download. Its topography layers are the LOLA and SLDEM products below. | Not used directly. Its elevation layers come from the same PDS products we download raw. |
| [NASA Moon Trek](https://trek.nasa.gov/moon/) and its [WMTS API](https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=moon) | WMTS tiles are rendered PNG/JPG (colourised or hillshaded), not elevation values. Some layers have product downloads, which are again the LOLA and SLDEM PDS products. | Not used. Its images can't serve as terrain heights, and its colour layers are no better than the SVS map below. |
| [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) and its [API](https://ssd-api.jpl.nasa.gov/doc/horizons.html) | Ephemerides and orientation | Not needed yet. It's the planned hook for time-dependent Moon orientation and the Sun/Earth direction ([web/src/orientation.ts](web/src/orientation.ts)). |
| [CSA Moon Exploration](https://www.asc-csa.gc.ca/eng/astronomy/moon-exploration/) | Mission and outreach pages. No terrain or imagery datasets. | Not used. |

**Conclusion.** None of the challenge resources gives raw elevation values in bulk. QuickMap and
Moon Trek both show the LOLA and SLDEM2015 products, so we take those products directly from their
PDS archives. That gives us the original 16-bit or float heights, full resolution and a documented
reference frame.

## 2. Elevation

All heights are **metres relative to a 1737.4 km sphere**, in the **Mean-Earth/Polar-Axis (ME/PA)**
body-fixed frame (DE421 realisation). Longitudes are east-positive. Unit and scale handling comes
from each PDS label (`SCALING_FACTOR`, `UNIT`, `OFFSET`). The label parser is
[pipeline/moonlod/sources.py](pipeline/moonlod/sources.py).

| # | Product | Publisher / archive | URL | Version / date | Resolution | Coverage | Encoding | Size |
|---|---|---|---|---|---|---|---|---|
| E1 | **LOLA LDEM_64** (global gridded DEM) | NASA GSFC LOLA team, PDS Geosciences Node (mirror: MIT imbrium) | https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_64.img | V3.1, 2019-03-15 (LRO-L-LOLA-4-GDR-V1.0) | 64 px/deg (473.8 m) | global, equirectangular | int16 LSB, ×0.5 m | 531 MB |
| E2 | **SLDEM2015**, "LOLA + SELENE/Kaguya TC merged DEM" 128 ppd | Barker et al. 2016, NASA GSFC / PGDA, PDS | http://imbrium.mit.edu/DATA/SLDEM2015/GLOBAL/FLOAT_IMG/SLDEM2015_128_60S_60N_000_360_FLOAT.IMG ([PGDA product 54](https://pgda.gsfc.nasa.gov/products/54)) | V2.0, 2015-07-15 | 128 px/deg (236.9 m) | ±60° lat, equirectangular | float32 LSB, **km** | 2.83 GB |
| E3 | **LOLA polar DEM LDEM_45S/45N_200M** | LOLA team, PDS | …/lola_gdr/polar/img/ldem_45s_200m.img, ldem_45n_200m.img | V2.0 (S, 2017-06-15), V2.1 (N, 2016-09-15) | 200 m/px | ≥45° N/S, polar stereographic | int16, ×0.5 m | 2 × 415 MB |
| E4 | **LOLA polar DEM LDEM_60S/60N_120M** | LOLA team, PDS | …/polar/img/ldem_60s_120m.img, ldem_60n_120m.img | V2.0 / V2.1 | 120 m/px | ≥60° | int16, ×0.5 m | 2 × 482 MB |
| E5 | **LOLA polar DEM LDEM_75S/75N_60M** | LOLA team, PDS | …/polar/img/ldem_75s_60m.img, ldem_75n_60m.img | V2.0 / V2.1 | 60 m/px | ≥75° | int16, ×0.5 m | 2 × 465 MB |
| E6 | **LOLA polar DEM LDEM_80S_20M** | LOLA team, PDS | …/polar/img/ldem_80s_20m.img | V2.0, 2017-06-15 | 20 m/px | ≤80°S | int16, ×0.5 m | 1.85 GB |
| E7 | **LOLA polar DEM LDEM_875S_5M** | LOLA team, PDS | …/polar/img/ldem_875s_5m.img | V2.0, 2017-06-15 | **5 m/px** | ≤87.5°S (includes Shackleton, the Artemis III candidate regions, de Gerlache, Shoemaker, Haworth) | int16, ×0.5 m | 1.84 GB |

Licence and attribution: these are NASA/PDS data in the public domain (US Government work). Cite the
LOLA team ([Smith et al. 2010, 2017](https://doi.org/10.1016/j.icarus.2016.06.006)) and, for
SLDEM2015, [Barker et al. 2016, Icarus 273, 346–355](https://doi.org/10.1016/j.icarus.2015.07.039).
"LRO LOLA data courtesy NASA/GSFC/MIT/PDS."

**Why these instead of the challenge resources?** They are the raw elevation values that
QuickMap and Moon Trek display. They have the full native resolution and a single, documented
datum, which the slope and landing analysis planned for later stages needs.

**Why not the 512 ppd SLDEM2015 (59 m)?** It is 45 GB as float tiles, or 5.4 GB as lossy JPEG2000.
The servers delivered about 1.5 to 2.4 MB/s, which is roughly 6 hours for the float tiles. This
build uses the 128 ppd grid for ±60°. To go higher, add the 512 ppd tiles to `sources.json` (all
32 are under 1.5 GB each) and list them as a source in `config.json`. The pipeline handles any
equirectangular PDS product, but the 32 tiles would need multi-tile support.

**Verification.** [pipeline/inspect_data.py](pipeline/inspect_data.py) writes
`data/inspect/report.json`.

- SLDEM2015 compared with LOLA LDEM_64 (20,000 random points within ±59°): RMS 24.7 m, bias −0.01 m.
  The two share a datum. The ~2.5 km offset reported for the Cesium Moon tiles does not appear.
- Polar stereographic orientation was checked for every polar product against LDEM_64. The RMS is
  11–20 m with the label-derived formula. All 3 alternative axis flips give 1.3–4 km.

**Despiking (LOLA polar grids only).** The gridded LOLA polar DEMs contain isolated single-sample
outliers from the gridding. 1,105 samples in `LDEM_875S_5M` and about 19,000 in `LDEM_80S_20M`
deviate from their 4-neighbour mean by more than 25 m, one by −108 m. At the 5 m level they render
as needle-like spikes.

The pipeline (`despike_m` in [config.json](pipeline/config.json)) replaces a sample with its 3×3
median only when it deviates from that median by more than max(15 m, 1.5 × the grid spacing). That
is 15 m for the 5 m grid and 30 m for the 20 m grid, and it touches about 0.0001% of samples.
SLDEM2015 and LDEM_64 are used unmodified. To get the untouched LOLA values for analysis, set
`despike_m` to 0.

**Seam blending.** [pipeline/moonlod/heights.py](pipeline/moonlod/heights.py) composites the
sources from coarse to fine. Each finer source fades in over a latitude band inside its coverage
edge:

- SLDEM: 59° to 60°.
- 45° caps: 45° to 46°.
- 60° caps: 60° to 61°.
- 75° caps: 75° to 75.5°.
- 80°S: 80° to 80.4°.
- 87.5°S: 87.5° to 87.65°.

The 45° polar products overlap SLDEM by 15° of latitude, so the ±60° seam always has two real
datasets to blend between.

## 3. Colour / albedo

| Product | Publisher | URL | Version | Resolution | Frame | Size |
|---|---|---|---|---|---|---|
| **CGI Moon Kit `lroc_color.exr`**, natural-colour map built from the **LROC WAC Hapke-normalised mosaic** (643/566/415 nm), with the poles filled from LOLA albedo | NASA Scientific Visualization Studio, Ernie Wright. Source data: LROC team (ASU) | https://svs.gsfc.nasa.gov/4720 | December 2025 re-processing ("newer version") | 27360 × 13680 px (76 px/deg ≈ 400 m) | equirectangular, centred on 0° lon, ME frame | 989 MB |

Licence and attribution: NASA SVS content is public domain. Credit "NASA's Scientific
Visualization Studio; LROC WAC data courtesy NASA/GSFC/Arizona State University."

**Why this instead of the 100 m LROC WAC global mosaic (USGS)?** The 100 m mosaic is a
*morphologic* mosaic, so its shadows and shading are baked in at one fixed sun angle. Under our own
light that shading would be counted twice, and craters would show two sets of shadows. The Hapke
normalisation removes most of the shading, so what's left is close to albedo. All the sharp relief
in the viewer comes from the DEM normals instead. The 100 m mosaic is also 5.96 GB, and the USGS
server delivered about 160 KB/s (about 10 hours). The Moon Trek colour layers are hillshaded too.
The SVS map is used at its full resolution: colour tiles go up to quadtree level 5 (≈333 m/px), and
deeper tiles reuse that texture.

## 4. Star background

| Product | Publisher | URL | Version | Resolution | Frame | Size |
|---|---|---|---|---|---|---|
| **Deep Star Maps 2020**, stars layer `hiptyc_2020_16k.exr` | NASA Scientific Visualization Studio | https://svs.gsfc.nasa.gov/4851 | 2020 (celestial set) | 16384 × 8192 (45.5 px/deg) | **ICRF/J2000 equatorial**, plate carrée, centred on RA 0h, RA increasing to the left | 71 MB |
| **Deep Star Maps 2020**, Milky Way layer `milkyway_2020_8k.exr` | NASA Scientific Visualization Studio | https://svs.gsfc.nasa.gov/4851 | 2020 (celestial set) | 8192 × 4096 (22.8 px/deg) | same | 137 MB |

The stars layer is Hipparcos-2 + Tycho-2 point sources on an exactly black background; the Milky
Way layer is the diffuse glow built from Gaia DR2 (1.7 billion stars). Until 2026-11-14 the
viewer used the combined `starmap_2020_8k.exr`; the separate layers let the stars stay crisp
points while the Milky Way is graded on its own (its packed copy is still in `data/raw_packed`). Credit: "NASA/Goddard Space
Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC. Constellation boundaries:
IAU." The challenge resources contain no star data.

The pipeline composites the two layers in linear light at 8192 × 4096: the stars layer is
area-averaged down by 2 (faint stars stay single pixels), multiplied by `star_gain`, and only the
part of a star above `bloom_threshold` feeds a small Gaussian bloom, so bright stars stand out
without blurring faint ones. The Milky Way gets its black point at the median sky, is partly
desaturated (`milkyway_saturation`) and kept faint (`milkyway_gain`). All settings are in
`pipeline/config.json` under `stars`. The result is resampled into OpenGL-convention cubemaps:
512² for the first frames and 2048² (about 1 face pixel per source pixel) afterwards, both ETC1S.

## 5. Sun and Earth positions (time-dependent)

| Product | Publisher | URL | Version | Sampling | Frame | Size |
|---|---|---|---|---|---|---|
| **JPL Horizons** state vectors of the Sun (10) and the Earth (399) relative to the Moon's centre (`500@301`), `VEC_CORR='LT'` (light-time corrected), km and km/s | NASA/JPL Solar System Dynamics | API: https://ssd-api.jpl.nasa.gov/doc/horizons.html (endpoint `https://ssd.jpl.nasa.gov/api/horizons.api`) | fetched 2026-11-14 (DE441-based) | every 6 h, 2000-01-01 to 2051-01-01 TDB | ICRF (J2000 equatorial) | 51 × 69 KB = 3.6 MB |

This is the challenge's own Horizons resource. The API sends no CORS headers, so the pipeline
([pipeline/ephemeris.py](pipeline/ephemeris.py)) fetches the data once and the static site ships
it. The viewer cubic-Hermite interpolates positions and velocities. At a 6 h step the
interpolation error is far below the Sun's and Earth's angular sizes.

**Validation** (`python -I pipeline/ephemeris.py --validate`, which writes
`web/public/ephem/validation.json`): the viewer's IAU Moon orientation applied to the Horizons
vectors reproduces Horizons' own sub-Earth point on the Moon (`QUANTITIES='14'`, observer
`500@399`) to **0.45′ mean, 0.76′ max** over 53 dates in 2026. The sub-solar point differs by a
constant 4.3′. That is the Moon's rotation during the 8.3-minute Sun–Moon light time: Horizons
gives the disc centre as the Sun sees it, while lighting at time t uses the Moon's orientation
at t.

## 6. Earth image

| Product | Publisher | URL | Version | Resolution | Size |
|---|---|---|---|---|---|
| **Blue Marble**, seamless true-colour mosaic of the Earth (`bluemarble-2048.png`) | NASA Goddard SVS 2915 (Blue Marble imagery: NASA Earth Observatory, Reto Stöckli et al.) | https://svs.gsfc.nasa.gov/2915 | 2004 | 2048 × 1024, equirectangular, 180°W at the left edge | 1.5 MB |
| **Equirectangular Earth**, with clouds (`flat_earth_Largest_still.0330.jpg`) and without (`earth_noClouds.0330.jpg`) | NASA Goddard SVS 3615 | https://svs.gsfc.nasa.gov/3615 | 2009 | 8192 × 4096 and 2048 × 1024, same layout | 6.0 MB + 0.36 MB |

Public domain (NASA). Seen from the Moon the Earth is about 1.9° wide (~50 px at 1080p), so
1024×512 is plenty. The Blue Marble Next Generation host (`eoimages.gsfc.nasa.gov`, which also
served the Blue Marble cloud layer) wasn't reachable from the build machine, so SVS copies were
used.

Clouds: the SVS 3615 pair is the same render with and without clouds, so per-pixel cloud opacity
is recovered as `a = (with - without) / (white - without)` (minimum over RGB), cleaned of
coastline misregistration and the haze floor, and composited onto the Blue Marble (the SVS 3615
ocean is a light bathymetric blue that looks wrong from space, so only its clouds are used). Its
clouds thin out beyond ±48° latitude; the pipeline extends them to ~70° by mirroring the 26–48°
band (offset 97° in longitude) and fades them out towards the poles. The clouds are baked into
`earth.jpg` (145 KB), so they cost nothing at render time.

## 7. Orientation

The Moon (ME/PA body frame) is rotated into J2000 with the full time-dependent IAU WGCCRE 2015
model: α₀, δ₀ and W including the 13 periodic terms E1–E13
([Archinal et al. 2018](https://doi.org/10.1007/s10569-017-9805-5)). UTC is converted to TDB via
leap seconds. It is validated against JPL Horizons (section 5). SPICE PA attitude can be plugged in
through `setOrientationProvider()` in [web/src/orientation.ts](web/src/orientation.ts).

## 8. Tools

* GDAL 3.12.2 (through rasterio 1.5.2). Used to cross-check the PDS3 labels and CRS (`LDEM_16`). Raw
  IMG files are read with numpy memmaps for windowed, out-of-core access.
* Basis Universal `basisu` v1.50.0, built from [BinomialLLC/basis_universal](https://github.com/BinomialLLC/basis_universal)
  tag `v1_50_0_2`. Encodes the KTX2 colour (ETC1S) and star (UASTC + Zstandard) textures.
* OpenCV 5 to read OpenEXR, numpy, scipy, Pillow.
