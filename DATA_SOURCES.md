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
| **Deep Star Maps 2020**, `starmap_2020_16k.exr` | NASA Scientific Visualization Studio | https://svs.gsfc.nasa.gov/4851 | 2020 (galactic set updated 2021-01-04; we use the celestial set) | 16384 × 8192 (45.5 px/deg) | **ICRF/J2000 equatorial**, plate carrée, centred on RA 0h, RA increasing to the left | 443 MB |

Built from Hipparcos-2, Tycho-2 and Gaia DR2 (1.7 billion stars). Credit: "NASA/Goddard Space
Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC. Constellation boundaries:
IAU." The challenge resources contain no star data.

The VR build resamples the celestial map into OpenGL cubemaps with 4096, 2048, and 512 pixels per face. The viewer loads the highest resolution supported by the GPU and uses the encoded mipmaps as stars get smaller on screen. The 16K source has about one quarter of the 8K source’s median pixel intensity, so the display gain is four times higher.

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
| **Blue Marble**, seamless true-colour mosaic of the Earth (`bluemarble-2048.png`) | NASA Goddard SVS 2915 (Blue Marble imagery: NASA Earth Observatory, Reto Stöckli et al.) | https://svs.gsfc.nasa.gov/2915 | 2004 | 2048 × 1024, equirectangular, 180°W at the left edge | 1.5 MB → 82 KB JPEG (1024×512) |

Public domain (NASA). Seen from the Moon the Earth is about 1.9° wide (~50 px at 1080p), so
1024×512 is plenty. The Blue Marble Next Generation host (`eoimages.gsfc.nasa.gov`) wasn't
reachable from the build machine, so the SVS copy was used.

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

## 9. Rocks in the VR surface walk

The walk uses NASA Astromaterials 3D scans and photographic textures of Apollo specimens 15016,0 (basalt), 14316,0 (regolith breccia), and 60025,241 (anorthosite). The models have three levels of detail for stereo rendering. The simulation varies their size, orientation, and burial depth and generates their locations across the Moon. [Sample links and NASA credit](web/public/lunar-rocks/CREDITS.txt)

The walking field queries the landing coordinates and surrounding terrain tiles. The LRO Diviner V6 nighttime rock abundance mosaic estimates fractional surface cover by thermally detectable rocks. Our bundled 8-samples/degree grid retains measured cells across 98.23% of the lunar surface. Its north–south spacing is about 3.8 km. Two 2° patches around Apollo 17 and Tycho retain the native 237 m spacing. A valid zero is retained. A missing native cell falls back to its regional value, and an unmapped area uses the labeled mapped-area mean of 0.343%. [PDS product and calibration](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_gdr_l3/cylindrical/jp2/dgdr_ra_avg_cyl_128_jp2.lbl)

For nominal diameters from 0.3 m, the walker estimates a size distribution using the Li–Wu lunar relationship. It solves for total cover such that modeled cover above 1 m matches Diviner. The instrument's effective size threshold varies with the rock population. For each size interval the walker divides modeled cover by the mean exposed plan area of its scanned shapes, estimated at 0.53 times nominal diameter squared. Sub-30 cm fragments and the close-up dust are illustrative. [Li & Wu (2018)](https://doi.org/10.1029/2017JE005496) · [Diviner size-threshold comparison](https://doi.org/10.1029/2024JE008769)

Where LROC Narrow Angle Camera counts are available between 60°S and 60°N, they determine the expected numbers of 4.5–10 m, 10–30 m and larger boulders per square kilometre. Within each observed size class, diameters are drawn from the survey’s global cumulative diameter distribution. The density maps report detections and can miss rocks obscured by illumination or image resolution. The derived grids preserve measured zeros and missing cells separately. Rock centres are simulated reproducibly within a landing. Distant instances are limited in dense fields to preserve foreground detail on the headset. Size-bin maps and diameter curve by Ben Aussel (2025), converted to a compact logarithmic encoding under CC BY 4.0. [Dataset](https://doi.org/10.5281/zenodo.15520275) · [Study](https://doi.org/10.1029/2025JE008981) · [License](https://creativecommons.org/licenses/by/4.0/)

## 10. Soil in the surface walk

The VR ground combines NASA LROC regional reflectance and the viewer’s measured elevation grids with representative close-range detail. The photographed 4 m soil tile comes from a terrestrial lunar-regolith simulant at Spaceport Rostock. It supplies color, surface normals, and fine height variation at the scan’s physical scale. Crater walls and mountains in the walk mesh follow the elevation grid. Fine grains, rock placements and boot-scale soil deformation are simulated. [Soil material credits](web/public/lunar-soil/CREDITS.txt)


The first-person suit uses NASA’s Extravehicular Mobility Unit model, adapted for a helmet view with articulated knees, ankles and controller-tracked arms. [Suit credits](web/public/astronaut/CREDITS.txt)

The deformable walking surface uses a local pressure–sinkage approximation. Its nominal 2 cm sinkage near 7 kPa and 4.6 mm transverse tread relief are based on the Apollo 14 crew’s bootprint observations. Soil stiffness, loading time and the division between compaction and displaced grains are simulation parameters. [Apollo 14 Preliminary Science Report, soil mechanics](https://www.nasa.gov/wp-content/uploads/static/history/alsj/a14/as14psr.pdf)

For arbitrary landings, the viewer bundles regional tiles sampled from the PDS LOLA LDEM_64 product at 32 samples per degree (about 948 m north–south), plus measured polar and local grids. It also requests numeric LOLA elevation tiles from a public image service at approximately 167 m north–south posting. The loader converts the service’s half-metre digital numbers to metres and uses the bundled data if the service is unavailable. The location readout reports the approximate spacing in use. [LOLA archive](https://pds-geosciences.wustl.edu/missions/lro/lola.htm) · [LOLA elevation tile service](https://www.arcgis.com/home/item.html?id=4b6494b2c8214f4088fe63a86063750a)
