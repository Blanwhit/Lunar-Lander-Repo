import Lerc from 'lerc';
import { dirToFace, latLonToDir, R_MOON, type Vec3 } from './geom';
import { gridRows } from './terrain/gridCodec';

interface GridFile { file: string; width: number; step: number; offset: number }
interface PatchFile extends GridFile { lat: number; lon: number; spacing: number }
interface Index { faces: GridFile[]; patches: PatchFile[] }
interface RegionIndex { degrees: number; width: number; step: number; offset: number; polar: PatchFile[] }
interface Grid { data: Int16Array | Float32Array; width: number; step: number; offset: number }

export interface SurfaceLocation { lat: number; lon: number; elevation: number; resolution: number }
export interface WalkTerrain {
  (x: number, z: number): number;
  coordinates(x: number, z: number): SurfaceLocation;
  prepare(x: number, z: number): Promise<boolean>;
  globalElevation(bodyDirection: Vec3): number;
}

const base = import.meta.env.BASE_URL + 'walk-terrain/';
const degrees = 180 / Math.PI;
const metresPerDegree = R_MOON / degrees;
const remoteBase = 'https://tiles.arcgis.com/tiles/lqRTrQp2HrfnJt8U/arcgis/rest/services/Lunar_LRO_LOLA_Elevation_GCSMoon2000/ImageServer/tile/6/';
const remoteSpan = 180 / 64;
const cache = new Map<string, Promise<Grid>>();
const wrap = (value: number, period: number) => (value % period + period) % period;
let catalog: Promise<[Index, RegionIndex]> | undefined;

async function fetchJson<T>(name: string): Promise<T> {
  const response = await fetch(base + name);
  if (!response.ok) throw new Error('Could not load lunar terrain: ' + name);
  return response.json();
}

/** Yield to the event loop (no timer clamping or background throttling). */
function nextTask() {
  return new Promise<void>(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(0);
  });
}

async function readGrid(file: GridFile): Promise<Grid> {
  const response = await fetch(base + file.file);
  if (!response.ok) throw new Error('Could not load lunar terrain: ' + file.file);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 4 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'MWG2') {
    throw new Error('Unsupported lunar terrain format: ' + file.file);
  }
  const data = new Int16Array(file.width ** 2);
  let slice = performance.now();
  for (const row of gridRows(bytes.subarray(4), file.width, file.width, data)) {
    // decode in slices of a few ms so a landing flight animating meanwhile keeps its frame rate
    if ((row & 15) === 0 && performance.now() - slice > 6) {
      await nextTask();
      slice = performance.now();
    }
  }
  return { ...file, data };
}

function cached(key: string, read: () => Promise<Grid>) {
  let pending = cache.get(key);
  cache.delete(key);
  if (!pending) pending = read().catch(error => { cache.delete(key); throw error; });
  cache.set(key, pending);
  // A journey across many landing sites should not retain every decoded DEM.
  if (cache.size > 48) cache.delete(cache.keys().next().value!);
  return pending;
}
const loadGrid = (file: GridFile) => cached(file.file, () => readGrid(file));

async function detailedGrid(col: number, row: number): Promise<Grid> {
  const url = remoteBase + row + '/' + col;
  return cached(url, async () => {
    const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error('Detailed LOLA grid unavailable.');
    const raster = Lerc.decode(await response.arrayBuffer());
    const data = raster.pixels[0];
    if (raster.width !== 513 || raster.height !== 513 || !data || raster.mask?.includes(0)) {
      throw new Error('Incomplete detailed LOLA grid.');
    }
    // This service stores LOLA digital numbers. The PDS GDR scale is 0.5 m per DN
    // relative to the 1737.4 km sphere, checked against the local PDS raster.
    return { data, width: 513, step: 0.5, offset: 0 };
  });
}

function sample(grid: Grid, x: number, y: number) {
  const {width, data} = grid;
  x = Math.max(0, Math.min(width-1, x));
  y = Math.max(0, Math.min(width-1, y));
  const col = Math.min(width-2, Math.floor(x)), row = Math.min(width-2, Math.floor(y));
  const fx = x-col, fy = y-row, i = row*width+col;
  const a = data[i] + fx*(data[i+1]-data[i]), b = data[i+width] + fx*(data[i+width+1]-data[i+width]);
  return grid.offset + grid.step*(a + fy*(b-a));
}

function basis(lat: number, lon: number) {
  const up = latLonToDir(lat, lon);
  const east: Vec3 = [-Math.sin(lon/degrees), Math.cos(lon/degrees), 0];
  const south: Vec3 = [east[1]*up[2], -east[0]*up[2], east[0]*up[1]-east[1]*up[0]];
  return {east,south,up};
}

function dot(a: Vec3, b: Vec3) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }

interface Reading { elevation: number; resolution: number }
function blend(out: Reading, value: number, spacing: number, weight: number) {
  const t = Math.min(1,Math.max(0,weight)), w = t*t*(3-2*t);
  out.elevation += w*(value-out.elevation);
  out.resolution += w*(spacing-out.resolution);
}

// A 3×3 neighbourhood per layer keeps downloads bounded. A taper only at the
// *outer* perimeter joins detailed elevations to the global overview on the horizon.
class RegionalLayer {
  readonly columns: number;
  private grids = new Map<number, Grid>();
  private current = -1;
  private pending?: Promise<boolean>;
  private generation = 0;

  constructor(private readonly span: number, private readonly west: number,
    private readonly load: (col: number, row: number) => Promise<Grid>, private readonly optional = false) {
    this.columns = 360/span;
  }
  private key(col: number, row: number) { return row*this.columns + wrap(col,this.columns); }

  async prepare(lat: number, lon: number) {
    const col = Math.floor(wrap(lon-this.west,360)/this.span);
    const row = Math.min(this.columns/2-1, Math.floor((90-lat)/this.span));
    const key = this.key(col,row);
    if (this.current === key) { await this.pending; return false; }
    this.current = key;
    const generation = ++this.generation;
    const grids = new Map<number, Grid>();
    const work = [];
    for (let y = Math.max(0,row-1); y <= Math.min(this.columns/2-1,row+1); y++) {
      for (let x = col-1; x <= col+1; x++) {
        const id = this.key(x,y);
        const loaded = this.grids.get(id);
        if (loaded) grids.set(id,loaded);
        else work.push(this.load(wrap(x,this.columns),y).then(grid => { grids.set(id,grid); })
          .catch(error => { if (!this.optional) throw error; }));
      }
    }
    this.pending = Promise.all(work).then(() => {
      if (generation !== this.generation) return false;
      const changed = grids.size !== this.grids.size || [...grids.keys()].some(id => !this.grids.has(id));
      this.grids = grids;
      return changed;
    }).catch(error => {
      if (generation === this.generation) this.current = -1;
      throw error;
    });
    return this.pending;
  }

  sample(lat: number, lon: number, out: Reading) {
    const u = wrap(lon-this.west,360)/this.span, v = (90-lat)/this.span;
    const x = Math.floor(u), y = Math.min(this.columns/2-1,Math.floor(v));
    const grid = this.grids.get(this.key(x,y));
    if (!grid) return;
    const fx = u-x, fy = v-y;
    let edge = 1;
    if (fx < .1 && !this.grids.has(this.key(x-1,y))) edge = fx/.1;
    if (fx > .9 && !this.grids.has(this.key(x+1,y))) edge = (1-fx)/.1;
    if (fy < .1 && y > 0 && !this.grids.has(this.key(x,y-1))) edge = Math.min(edge,fy/.1);
    if (fy > .9 && y+1 < this.columns/2 && !this.grids.has(this.key(x,y+1))) edge = Math.min(edge,(1-fy)/.1);
    blend(out, sample(grid,fx*(grid.width-1),fy*(grid.width-1)),
      metresPerDegree*this.span/(grid.width-1),edge);
  }
}

export async function loadWalkTerrain(lat: number, lon: number): Promise<WalkTerrain> {
  catalog ??= Promise.all([fetchJson<Index>('index.json'),fetchJson<RegionIndex>('regions/index.json')])
    .catch(error => { catalog=undefined; throw error; });
  const [files,regions] = await catalog, origin = basis(lat,lon);
  const regional = new RegionalLayer(regions.degrees, 0, (x,y) => loadGrid({
    file: 'regions/'+y+'-'+x+'.bin', width: regions.width, offset: regions.offset, step: regions.step,
  }));
  const detailed = new RegionalLayer(remoteSpan, -180, detailedGrid, true);
  async function prepareAt(lat: number, lon: number) {
    const [a,b] = await Promise.all([regional.prepare(lat,lon),
      // The bundled polar grids have finer physical sampling at these latitudes.
      Math.abs(lat)<87 ? detailed.prepare(lat,lon) : false]);
    return a || b;
  }
  const [faces,patches] = await Promise.all([
    Promise.all(files.faces.map(loadGrid)),
    Promise.all([...files.patches,...regions.polar].map(async file => ({
      ...basis(file.lat,file.lon), grid: await loadGrid(file), spacing: file.spacing,
    }))),
    prepareAt(lat,lon),
  ]);
  patches.sort((a,b)=> b.spacing-a.spacing);
  const direction: Vec3 = [0,0,0];
  const out: SurfaceLocation = {lat,lon,elevation:0,resolution:0};
  function globalElevation(bodyDirection: Vec3) {
    const {face,a,b} = dirToFace(bodyDirection);
    const globe = faces[face], half = (globe.width-1)/2;
    return sample(globe,(1+a)*half,(1+b)*half);
  }
  function radial() {
    out.elevation = globalElevation(direction);
    out.resolution = 90*metresPerDegree/(faces[0].width-1);
    out.lat = Math.atan2(direction[2],Math.hypot(direction[0],direction[1]))*degrees;
    out.lon = Math.atan2(direction[1],direction[0])*degrees;
    regional.sample(out.lat,out.lon,out);
    detailed.sample(out.lat,out.lon,out);
    for (const p of patches) {
      if (p.spacing >= out.resolution) continue;
      const normal = dot(direction,p.up);
      if (normal <= 0) continue;
      const scale = R_MOON/(normal*p.spacing);
      const px = dot(direction,p.east)*scale, py = dot(direction,p.south)*scale;
      const radius = (p.grid.width-1)/2, edge = radius - Math.max(Math.abs(px),Math.abs(py));
      if (edge > 0) blend(out,sample(p.grid,px+radius,py+radius),p.spacing,edge/(radius*.15));
    }
  }
  for (let k=0; k<3; k++) direction[k] = origin.up[k];
  radial();
  const landingElevation = out.elevation, landingRadius = R_MOON+landingElevation;

  function solve(x: number,z: number) {
    const planeSquared = x*x+z*z;
    let radius = landingRadius, vertical = 0;
    for (let i=0;i<8;i++) {
      vertical = Math.sqrt(Math.max(0,radius*radius-planeSquared));
      for(let k=0;k<3;k++) direction[k] = vertical*origin.up[k]+x*origin.east[k]+z*origin.south[k];
      radial();
      const nextRadius = R_MOON+out.elevation;
      // Horizontal reprojection error is roughly |deltaRadius| * tan(angular distance).
      if (Math.abs(radius-nextRadius)*Math.sqrt(planeSquared) <= .01*vertical) {
        return Math.sqrt(Math.max(0,nextRadius*nextRadius-planeSquared))-landingRadius;
      }
      radius = nextRadius;
    }
    return Math.sqrt(Math.max(0,radius*radius-planeSquared))-landingRadius;
  }

  const terrain = solve as WalkTerrain;
  terrain.coordinates = (x,z) => { solve(x,z); return {...out}; };
  terrain.globalElevation = globalElevation;
  terrain.prepare = (x,z) => { const point = terrain.coordinates(x,z); return prepareAt(point.lat,point.lon); };
  return terrain;
}
