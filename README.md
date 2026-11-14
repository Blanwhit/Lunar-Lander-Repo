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
* **One shared grid mesh** for all tiles. The vertex shader displaces it from a R16UI height
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

MEASUREMENTS_PLACEHOLDER

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
