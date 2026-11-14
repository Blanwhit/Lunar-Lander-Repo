# Moon LOD viewer

A static website that shows only the Moon, in 3D, against the real star sky. Terrain is streamed
level-of-detail from raw NASA elevation data, from the whole globe down to **5 m/px at the lunar
south pole**. The page is a full-screen canvas with no text or UI.

* **Drag**: orbit (inertia). **Right-drag / Shift-drag / two-finger twist**: heading and tilt.
* **Wheel / pinch**: zoom, from the whole Moon down to just above the surface. The view tilts
  towards the horizon automatically near the ground.
* Optional deep link (no UI): `#lat,lon,distance_m[,heading_deg[,tilt_deg]]`. For example,
  Shackleton crater is `#-89.67,129.8,25000,0,55`.

## Run

```bash
make venv          # Python 3.11+ venv with GDAL (rasterio), numpy, OpenEXR …
make download      # ~11 GB of raw NASA data into data/raw (sizes printed first; refuses >5 GB/file)
make basisu        # builds the Basis Universal encoder from source (g++)
make tiles         # overviews -> height tiles -> colour KTX2 -> star cubemaps -> meta -> size report
make web build     # npm install + vite build  -> web/dist (static; tiles copied from web/public)
make serve         # vite preview on :4173
```

Without `make` (e.g. plain Windows), run the commands from the [Makefile](Makefile) directly, for
example `python -I pipeline/build.py heights --max-level 11`. `MAX_LEVEL` caps the quadtree depth.
Each level beyond L6 is generated only where a source DEM is fine enough to justify it.
Development server: `cd web && npm run dev`.

## How it works

### Pipeline (`pipeline/`)
1. **Download** ([download.py](pipeline/download.py)): resumable, multi-connection, multi-mirror
   (PDS Geosciences + MIT) HTTP range downloader.
2. **Sources** ([moonlod/sources.py](pipeline/moonlod/sources.py)): PDS3 labels are parsed for
   scale, offset, unit and projection. Raw `.IMG` rasters are memory-mapped (out of core). Each
   source gets a cached 2×2-mean overview pyramid.
3. **Height tiles** ([moonlod/heights.py](pipeline/moonlod/heights.py)): cube-sphere, 6 faces,
   equi-angular (EAC) mapping, one quadtree per face. Each tile is 257×257 vertices plus a
   1-sample border (259×259) for seamless normals.
   * Sources are composited from coarse to fine, and each finer source is blended in over a
     latitude band inside its coverage edge. That covers the ±60° SLDEM/LOLA seam and the 45°, 60°,
     75°, 80° and 87.5° polar-cap edges.
   * Sampling is **trilinear over the source mip pyramid**, using each sample's analytic EAC
     footprint. Samples on a shared tile edge therefore get bit-identical heights, and no seams
     appear between tiles or faces.
   * Encoding (`MLH1`): 16-bit quantised heights with a per-tile base and step. The step is about
     cell/256: 32 m at L0, 3 cm at L11. A planar predictor (left + up − upleft) is followed by a
     zigzag byte-plane split and zlib. The browser decodes it with the native `DecompressionStream`.
   * A tile at level L exists only if some source covering it has a resolution ≤ 1.5 × the
     cell size of L. Child sets are all-or-nothing.
4. **Colour tiles**: 256² pixel-centred tiles up to L5 (≈333 m/px, matching the ~400 m source),
   encoded as KTX2/Basis ETC1S with mipmaps. Deeper tiles reuse the L5 texture with a UV transform.
5. **Stars**: the SVS Deep Star Map (J2000) is resampled into OpenGL-convention cubemaps. A
   512² cubemap loads first and a 2048² one afterwards.

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
* **One shared grid mesh** for all tiles (65×65 vertices + skirts by default; `?mesh=` to change). The vertex shader displaces it from a R16UI height
  texture. Normals are baked per tile in a Web Worker into an RG16F tangent-space map (with mips).
* **Precision**: positions are never formed in absolute coordinates on the GPU. The CPU (float64)
  supplies the tile origin relative to the camera, and the shader adds the small offset
  R·(dir − dir_c) + h·dir. That offset is computed with cancellation-free identities, so there is
  no jitter at 5 m/px. The near and far planes adapt to the height above the terrain.
* **Streaming**: height tiles are fetched and decoded in a worker pool and prioritised by
  screen-space error. Colour KTX2 files are transcoded in three.js's KTX2Loader workers. An LRU
  evicts GPU textures above the budget (384 MB).
* **Render on demand**: a frame is drawn only when the camera moves, inertia is active, or a tile
  arrives.
* **Lighting**: one fixed directional light (body frame: 1.5° above the south-pole horizon, from
  60°E), a lunar-Lambert (Lommel-Seeliger/Lambert) BRDF, and a little ambient light.
* **Orientation**: the static IAU pole (α₀ = 269.9949°, δ₀ = 66.5392°, W = 38.3213°) rotates the
  J2000 star cubemap into the Moon's ME/PA frame. To add time-dependent orientation later, use the
  `setOrientationProvider()` hook in [orientation.ts](web/src/orientation.ts) (JPL Horizons or
  SPICE).

## Tile pyramid and numbers

### Tile pyramid (output of `make stats`)

| level | ~m/px | height tiles | height size | colour tiles | colour size | where |
|---:|---:|---:|---:|---:|---:|---|
| 0 | 10 661 | 6 | 262 KB | 6 | 147 KB | global |
| 1 | 5 330 | 24 | 1.1 MB | 24 | 569 KB | global |
| 2 | 2 665 | 96 | 4.3 MB | 96 | 6.0 MB | global |
| 3 | 1 333 | 384 | 17.2 MB | 384 | 22.6 MB | global |
| 4 | 666 | 1 536 | 67.8 MB | 1 536 | 85.3 MB | global |
| 5 | 333 | 6 144 | 264.6 MB | 6 144 | 315.5 MB | global (colour stops here: ~400 m source) |
| 6 | 167 | 12 896 | 522.1 MB | | | global (SLDEM2015 128 ppd / LOLA 200 m) |
| 7 | 83 | 7 520 | 281.1 MB | | | ≥ 60° N/S (LOLA 120 m) |
| 8 | 42 | 12 288 | 440.3 MB | | | ≥ 75° N/S (LOLA 60 m) |
| 9 | 21 | 10 704 | 444.1 MB | | | ≤ 80° S (LOLA 20 m) |
| 10 | 10 | 2 800 | 127.0 MB | | | ≤ 87.5° S |
| 11 | **5.2** | 10 672 | 424.9 MB | | | ≤ 87.5° S (LOLA 5 m) |
| **total** | | **65 070** | **2.5 GB** | **8 190** | **430 MB** | **3.0 GB** on disk |

* **Maximum resolution reached**: 5.2 m/px (L11) inside 87.5°S, which includes Shackleton, de Gerlache,
  Shoemaker and the Artemis candidate regions. It is 20.8 m to 80°S, 41.6 m at both caps beyond
  75°, 83 m beyond 60°, and 167 m elsewhere. That last figure is limited by the 237 m SLDEM2015 grid
  used here. With the 512 ppd SLDEM grid (45 GB) the same pipeline would reach about 42 m at L8.
* Each tile has 257×257 vertices plus a border (259² samples). Heights average 37–46 KB per tile,
  and colour tiles are UASTC from L2 (~51 KB) and ETC1S at L0–L1 (~24 KB).
* Build time on a 32-thread laptop: overviews ~14 min (despiking the 5 m and 20 m grids takes most of
  it), heights 15 min with 24 processes, colour ~17 min.

### Performance (Chrome 156, measured)

Measured on an RTX 4070 Laptop GPU (ANGLE/D3D11) with a 1920×1080 canvas at DPR 1 and
MSAA on, using [web/bench/bench.js](web/bench/bench.js). Each frame is forced with `gl.finish()` while
the camera turns, so the time includes CPU LOD selection and GPU work. The vsync-limited real
frame rate is 60 fps in every case.

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
* Streaming: finished tiles are promoted to the GPU at most 2–8 per frame, within a 3 ms budget.
  Before this throttle, frames during fast flights spiked to 87–132 ms p95. With it they stay at
  5–6 ms.

### Initial payload (production build, measured)

Everything fetched until the first frame that has all six L0 terrain tiles, their colour and the
star background:

| item | size |
|---|---:|
| `index.html` + JS bundle (three.js + app, gzip) | 182 KB |
| Basis transcoder wasm | 515 KB (248 KB gzip) |
| L0 heights (6 tiles) | 262 KB |
| L0 colour (6 tiles, ETC1S) | 147 KB |
| 512² star cubemap | 293 KB |
| **total** | **1.40 MB** (1.13 MB with gzipped wasm) |

On localhost the first full frame appears 0.35 s after the app starts. Refinement requests are held
back until the base level is complete. The 4.3 MB 2048² star cubemap is fetched only once the tile
queue is idle.

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

The site stays text-free; credits live here and in [DATA_SOURCES.md](DATA_SOURCES.md).

* **Elevation**: LRO LOLA gridded and polar DEMs (LOLA team, NASA GSFC / MIT, PDS Geosciences
  Node). SLDEM2015 LOLA + SELENE/Kaguya TC merged DEM (Barker et al. 2016; NASA GSFC PGDA / JAXA).
* **Colour**: NASA Scientific Visualization Studio, CGI Moon Kit (2025 colour map). Based on the
  LROC WAC Hapke-normalised mosaic (NASA/GSFC/Arizona State University).
* **Stars**: NASA Scientific Visualization Studio, Deep Star Maps 2020 (Hipparcos-2, Tycho-2,
  Gaia DR2 / ESA/Gaia/DPAC).
* Challenge: NASA Space Apps 2026, *Lunar Landing Site Navigator*. The resources it lists
  (QuickMap, Moon Trek, Horizons, CSA) were evaluated; see DATA_SOURCES.md for why the raw PDS
  products were used instead.
