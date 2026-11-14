import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  FloatType,
  Frustum,
  GLSL3,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix3,
  Matrix4,
  Mesh,
  NearestFilter,
  RawShaderMaterial,
  RedIntegerFormat,
  RGFormat,
  Sphere,
  Texture,
  UnsignedByteType,
  UnsignedShortType,
  Vector3,
  ClampToEdgeWrapping,
  RGBAFormat,
  SRGBColorSpace,
} from 'three';
import type { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { FACES, GRID, H_MAX_GLOBAL, H_MIN_GLOBAL, MESH_N, R_MOON, TILE_N, Vec3, dirToFace, texelSize } from '../geom';
import { terrainFS, terrainVS } from './shaders';
import type { HeightRequest, HeightResult } from './heightWorker';

void FloatType;

export interface TerrainOptions {
  baseUrl: string;            // e.g. "tiles/"
  colourMaxLevel: number;
  maxLevel: number;
  pixelsPerTexel: number;     // LOD threshold: split when a height texel covers > this many px
  gpuBudgetBytes: number;
  maxInflightHeights: number;
  maxInflightColour: number;
}

type State = 0 | 1 | 2 | 3; // empty, loading, ready, failed
const EMPTY = 0, LOADING = 1, READY = 2, FAILED = 3;

const HEIGHT_BYTES = GRID * GRID * 2;
const NORMAL_BYTES = Math.round((TILE_N + 1) * (TILE_N + 1) * 4 * 1.34);
const COLOUR_BYTES = Math.round(256 * 256 * 1 * 1.34);

let geometryCache: BufferGeometry | null = null;

/** shared tile mesh: (MESH_N+1)^2 grid + skirts on all 4 edges */
function tileGeometry(): BufferGeometry {
  if (geometryCache) return geometryCache;
  const M = MESH_N;
  const V = M + 1;
  const verts: number[] = [];
  for (let j = 0; j <= M; j++) for (let i = 0; i <= M; i++) verts.push(i, j, 0);
  const skirtBase = verts.length / 3;
  // skirt vertex order: bottom (j=0), top (j=M), left (i=0), right (i=M)
  for (let i = 0; i <= M; i++) verts.push(i, 0, 1);
  for (let i = 0; i <= M; i++) verts.push(i, M, 1);
  for (let j = 0; j <= M; j++) verts.push(0, j, 1);
  for (let j = 0; j <= M; j++) verts.push(M, j, 1);
  const idx: number[] = [];
  const g = (i: number, j: number) => j * V + i;
  for (let j = 0; j < M; j++)
    for (let i = 0; i < M; i++) {
      idx.push(g(i, j), g(i + 1, j), g(i + 1, j + 1));
      idx.push(g(i, j), g(i + 1, j + 1), g(i, j + 1));
    }
  const sb = (k: number) => skirtBase + k; // bottom
  const st = (k: number) => skirtBase + V + k; // top
  const sl = (k: number) => skirtBase + 2 * V + k; // left
  const sr = (k: number) => skirtBase + 3 * V + k; // right
  for (let k = 0; k < M; k++) {
    // windings derived so every skirt faces away from the tile (see notes in README)
    let A = g(k, 0), B = g(k + 1, 0), As = sb(k), Bs = sb(k + 1);
    idx.push(A, As, B, B, As, Bs);
    A = g(k, M); B = g(k + 1, M); As = st(k); Bs = st(k + 1);
    idx.push(A, B, As, B, Bs, As);
    A = g(0, k); B = g(0, k + 1); As = sl(k); Bs = sl(k + 1);
    idx.push(A, B, As, B, Bs, As);
    A = g(M, k); B = g(M, k + 1); As = sr(k); Bs = sr(k + 1);
    idx.push(A, As, B, B, As, Bs);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('grid', new BufferAttribute(new Float32Array(verts), 3));
  geo.setIndex(new BufferAttribute(new Uint16Array(idx), 1));
  geo.boundingSphere = new Sphere(new Vector3(), 1e12);
  geometryCache = geo;
  return geo;
}

function makeFallbackColour(): Texture {
  const t = new DataTexture(new Uint8Array([150, 145, 140, 255]), 1, 1, RGBAFormat, UnsignedByteType);
  t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

export class TileNode {
  readonly key: string;
  readonly n: number;
  children: TileNode[] | null = null;
  state: State = EMPTY;
  colourState: State = EMPTY;
  lastUsed = 0;
  priority = 0;
  // data
  childMask = 0;
  hmin: number;
  hmax: number;
  base = 0;
  step = 1;
  q: Uint16Array | null = null;
  heightTex: DataTexture | null = null;
  normalTex: DataTexture | null = null;
  colourTex: Texture | null = null;
  mesh: Mesh | null = null;
  // geometry (float64)
  readonly cc: Vec3;
  readonly dirC: Vec3;
  readonly tanC: [number, number];
  readonly cosC: [number, number];
  readonly probes: Vec3[];
  centre: Vec3 = [0, 0, 0];
  radius = 0;
  probeMargin: number;

  constructor(
    readonly level: number,
    readonly face: number,
    readonly x: number,
    readonly y: number,
    readonly parent: TileNode | null,
  ) {
    this.key = `${level}/${face}/${x}/${y}`;
    this.n = 1 << level;
    const span = 2 / this.n;
    const ac = -1 + (x + 0.5) * span;
    const bc = -1 + (y + 0.5) * span;
    const F = FACES[face];
    const tA = Math.tan((Math.PI / 4) * ac), tB = Math.tan((Math.PI / 4) * bc);
    this.tanC = [tA, tB];
    this.cosC = [Math.cos((Math.PI / 4) * ac), Math.cos((Math.PI / 4) * bc)];
    this.cc = [
      F.n[0] + tA * F.u[0] + tB * F.v[0],
      F.n[1] + tA * F.u[1] + tB * F.v[1],
      F.n[2] + tA * F.u[2] + tB * F.v[2],
    ];
    const l = Math.hypot(...this.cc);
    this.dirC = [this.cc[0] / l, this.cc[1] / l, this.cc[2] / l];
    this.probes = [];
    for (let j = 0; j < 3; j++)
      for (let i = 0; i < 3; i++) {
        const a = -1 + (x + i / 2) * span;
        const b = -1 + (y + j / 2) * span;
        const s = Math.tan((Math.PI / 4) * a), t = Math.tan((Math.PI / 4) * b);
        const c: Vec3 = [F.n[0] + s * F.u[0] + t * F.v[0], F.n[1] + s * F.u[1] + t * F.v[1], F.n[2] + s * F.u[2] + t * F.v[2]];
        const cl = Math.hypot(...c);
        this.probes.push([c[0] / cl, c[1] / cl, c[2] / cl]);
      }
    // max angular gap between probes ~ half the tile span in angle -> sphere bulge margin
    const halfAng = (Math.PI / 4) * span * 0.5;
    this.probeMargin = R_MOON * (1 - Math.cos(halfAng)) + 1;
    this.hmin = parent ? parent.hmin : H_MIN_GLOBAL;
    this.hmax = parent ? parent.hmax : H_MAX_GLOBAL;
    this.updateBounds();
  }

  updateBounds() {
    const rLo = R_MOON + this.hmin, rHi = R_MOON + this.hmax;
    let cx = 0, cy = 0, cz = 0;
    for (const p of this.probes) {
      cx += p[0]; cy += p[1]; cz += p[2];
    }
    const k = (rLo + rHi) / 2 / this.probes.length;
    this.centre = [cx * k, cy * k, cz * k];
    let r = 0;
    for (const p of this.probes)
      for (const rr of [rLo, rHi]) {
        r = Math.max(r, Math.hypot(p[0] * rr - this.centre[0], p[1] * rr - this.centre[1], p[2] * rr - this.centre[2]));
      }
    this.radius = r + this.probeMargin;
  }

  gpuBytes(): number {
    let b = 0;
    if (this.state === READY) b += HEIGHT_BYTES + NORMAL_BYTES;
    if (this.colourState === READY) b += COLOUR_BYTES;
    return b;
  }
}

export interface LightParams {
  sun: number;
  ambient: number;
  exposure: number;
  earthDir: Vector3; // body-frame unit vector Moon -> Earth
  earthshine: number;
}

export interface FrameInfo {
  camPos: Vec3;              // body frame, metres (float64)
  viewRot: Matrix3;          // body -> view
  proj: Matrix4;
  viewportHeight: number;
  fovY: number;              // radians
  frame: number;
}

export class TileTree {
  readonly roots: TileNode[];
  private nodes = new Map<string, TileNode>();
  private workers: Worker[] = [];
  private workerBusy: number[] = [];
  private pending = new Map<number, TileNode>();
  private reqId = 1;
  private inflightHeights = 0;
  private inflightColour = 0;
  private wantHeights: TileNode[] = [];
  private wantColour: TileNode[] = [];
  private arrivals: HeightResult[] = [];
  private colourArrivals: [TileNode, Texture][] = [];
  private fallbackColour = makeFallbackColour();
  private frustum = new Frustum();
  private tmpM = new Matrix4();
  private tmpV = new Vector3();
  private sphere = new Sphere();
  gpuBytes = 0;
  private baseReady = false;
  /** optional feasibility overlay lookup (null = overlay off / not available) */
  feasProvider: ((L: number, f: number, x: number, y: number) => { tex: Texture; scale: number; ou: number; ov: number } | null) | null = null;
  bytesDownloaded = 0;
  drawn: TileNode[] = [];
  onChange: () => void = () => {};
  stats = { drawn: 0, triangles: 0, loaded: 0, maxLevelDrawn: 0 };

  constructor(readonly opts: TerrainOptions, private ktx2: KTX2Loader) {
    this.roots = [];
    for (let f = 0; f < 6; f++) {
      const n = new TileNode(0, f, 0, 0, null);
      this.roots.push(n);
      this.nodes.set(n.key, n);
    }
    const nw = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < nw; i++) {
      const w = new Worker(new URL('./heightWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<HeightResult>) => {
        this.workerBusy[i]--;
        this.inflightHeights--; // free the request slot now; GPU promotion is throttled
        this.arrivals.push(ev.data);
        this.onChange();
      };
      this.workers.push(w);
      this.workerBusy.push(0);
    }
  }

  // ------------------------------------------------------------------ queries
  /** terrain height (m, vs 1737.4 km) under a body-frame direction, from loaded tiles */
  heightAt(dir: Vec3): number | null {
    const { face, a, b } = dirToFace(dir);
    let node: TileNode | undefined = this.roots[face];
    if (node.state !== READY) return null;
    let best = node;
    while (node && node.state === READY) {
      best = node;
      if (!node.children) break;
      const span = 2 / (node.n * 2);
      const cx = Math.min(1, Math.max(0, Math.floor((a + 1) / span) - node.x * 2));
      const cy = Math.min(1, Math.max(0, Math.floor((b + 1) / span) - node.y * 2));
      node = node.children[cy * 2 + cx];
    }
    const span = 2 / best.n;
    const fu = ((a + 1) / span - best.x) * TILE_N + 1;
    const fv = ((b + 1) / span - best.y) * TILE_N + 1;
    const i = Math.min(GRID - 2, Math.max(0, Math.floor(fu)));
    const j = Math.min(GRID - 2, Math.max(0, Math.floor(fv)));
    const tx = fu - i, ty = fv - j;
    const q = best.q!;
    const h = (k: number) => best.base + q[k] * best.step;
    const k = j * GRID + i;
    return (h(k) * (1 - tx) + h(k + 1) * tx) * (1 - ty) + (h(k + GRID) * (1 - tx) + h(k + GRID + 1) * tx) * ty;
  }

  // --------------------------------------------------------------- selection
  /** D_L: distance below which a level-L tile splits (CDLOD range) */
  private splitDist(level: number, P: number): number {
    const t = texelSize(level);
    return Math.max((P * t) / this.opts.pixelsPerTexel, 2.5 * TILE_N * Math.SQRT2 * t);
  }

  update(fi: FrameInfo): TileNode[] {
    this.drainArrivals();
    const P = fi.viewportHeight / (2 * Math.tan(fi.fovY / 2));
    this.tmpM.setFromMatrix3(fi.viewRot);
    this.tmpM.premultiply(fi.proj);
    this.frustum.setFromProjectionMatrix(this.tmpM);
    this.drawn = [];
    this.wantHeights = [];
    this.wantColour = [];
    const camR = Math.hypot(...fi.camPos);
    for (const r of this.roots) {
      r.lastUsed = fi.frame;
      if (r.state === EMPTY) {
        r.priority = 1e9;
        this.wantHeights.push(r);
      }
      // the base level is always loaded in full (all 6 faces), even faces that are not
      // visible -- refinement waits for it (see baseReady)
      if (r.colourState === EMPTY) {
        r.priority = 1e9;
        this.wantColour.push(r);
      }
    }
    if (this.roots.some((r) => r.state !== READY)) {
      this.pump();
      return this.drawn;
    }
    // base level first: no refinement requests until every L0 height + colour is in
    this.baseReady = this.roots.every((r) => r.colourState === READY || r.colourState === FAILED);
    for (const r of this.roots) this.visit(r, fi, P, camR);
    this.pump();
    this.evict(fi.frame);
    // stats
    let maxL = 0;
    for (const n of this.drawn) maxL = Math.max(maxL, n.level);
    this.stats.drawn = this.drawn.length;
    this.stats.triangles = this.drawn.length * (MESH_N * MESH_N * 2 + MESH_N * 8);
    this.stats.maxLevelDrawn = maxL;
    return this.drawn;
  }

  private distTo(n: TileNode, cam: Vec3): number {
    return Math.max(0, Math.hypot(n.centre[0] - cam[0], n.centre[1] - cam[1], n.centre[2] - cam[2]) - n.radius);
  }

  private visible(n: TileNode, fi: FrameInfo, camR: number): boolean {
    const c = fi.camPos;
    this.sphere.center.set(n.centre[0] - c[0], n.centre[1] - c[1], n.centre[2] - c[2]);
    this.sphere.radius = n.radius;
    if (!this.frustum.intersectsSphere(this.sphere)) return false;
    if (n.level < 2) return true;
    // horizon culling against the lowest-radius occluding sphere
    const rOcc = R_MOON + H_MIN_GLOBAL;
    if (camR <= rOcc) return true;
    const rTop = R_MOON + n.hmax + n.probeMargin;
    for (const p of n.probes) {
      const px = p[0] * rTop, py = p[1] * rTop, pz = p[2] * rTop;
      // segment camera -> P intersects sphere(rOcc)?
      const dx = px - c[0], dy = py - c[1], dz = pz - c[2];
      const dd = dx * dx + dy * dy + dz * dz;
      let t = -(c[0] * dx + c[1] * dy + c[2] * dz) / dd;
      if (t <= 0 || t >= 1) return true;
      const qx = c[0] + t * dx, qy = c[1] + t * dy, qz = c[2] + t * dz;
      if (qx * qx + qy * qy + qz * qz > rOcc * rOcc) return true;
      t = 0;
    }
    return false;
  }

  private visit(n: TileNode, fi: FrameInfo, P: number, camR: number) {
    n.lastUsed = fi.frame;
    if (!this.visible(n, fi, camR)) return;
    const d = this.distTo(n, fi.camPos);
    const D = this.splitDist(n.level, P);
    this.requestColour(n, fi, d, D);
    const wantSplit = this.baseReady && d < D && n.childMask !== 0 && n.level < this.opts.maxLevel;
    if (wantSplit) {
      if (!n.children) {
        n.children = [];
        for (let cy = 0; cy < 2; cy++)
          for (let cx = 0; cx < 2; cx++) {
            const c = new TileNode(n.level + 1, n.face, n.x * 2 + cx, n.y * 2 + cy, n);
            n.children.push(c);
            this.nodes.set(c.key, c);
          }
      }
      let allReady = true;
      for (const c of n.children) {
        c.lastUsed = fi.frame;
        if (c.state !== READY) {
          allReady = false;
          if (c.state === EMPTY) {
            c.priority = (D / Math.max(d, 1)) * (1 + 1 / (n.level + 1));
            this.wantHeights.push(c);
          }
        }
      }
      if (allReady) {
        for (const c of n.children) this.visit(c, fi, P, camR);
        return;
      }
    }
    this.drawn.push(n);
  }

  private requestColour(n: TileNode, _fi: FrameInfo, d: number, D: number) {
    if (n.level > this.opts.colourMaxLevel || n.colourState !== EMPTY) return;
    if (n.level > 0 && !this.baseReady) return;
    n.priority = Math.max(n.priority, D / Math.max(d, 1));
    this.wantColour.push(n);
  }

  // ------------------------------------------------------------------ loading
  private heightUrl(n: TileNode) {
    return `${this.opts.baseUrl}h/${n.level}/${n.face}/${n.y}/${n.x}.bin`;
  }
  private colourUrl(n: TileNode) {
    return `${this.opts.baseUrl}c/${n.level}/${n.face}/${n.y}/${n.x}.ktx2`;
  }

  private pump() {
    this.wantHeights.sort((a, b) => b.priority - a.priority);
    for (const n of this.wantHeights) {
      if (this.inflightHeights >= this.opts.maxInflightHeights) break;
      if (n.state !== EMPTY) continue;
      n.state = LOADING;
      this.inflightHeights++;
      const id = this.reqId++;
      this.pending.set(id, n);
      let wi = 0;
      for (let i = 1; i < this.workers.length; i++) if (this.workerBusy[i] < this.workerBusy[wi]) wi = i;
      this.workerBusy[wi]++;
      const msg: HeightRequest = { id, url: new URL(this.heightUrl(n), location.href).href };
      this.workers[wi].postMessage(msg);
    }
    this.wantColour.sort((a, b) => b.priority - a.priority);
    for (const n of this.wantColour) {
      if (this.inflightColour >= this.opts.maxInflightColour) break;
      if (n.colourState !== EMPTY) continue;
      n.colourState = LOADING;
      this.inflightColour++;
      this.ktx2
        .loadAsync(this.colourUrl(n))
        .then((tex) => {
          tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
          tex.magFilter = LinearFilter;
          tex.minFilter = tex.mipmaps && tex.mipmaps.length > 1 ? LinearMipmapLinearFilter : LinearFilter;
          tex.anisotropy = 4;
          tex.needsUpdate = true;
          this.colourArrivals.push([n, tex]);
        })
        .catch(() => {
          n.colourState = FAILED;
        })
        .finally(() => {
          this.inflightColour--;
          this.onChange();
        });
    }
  }

  /** promote a few finished downloads per frame (bounded GPU upload work per frame) */
  private drainArrivals() {
    const t0 = performance.now();
    let k = 0;
    while (this.arrivals.length && (k < 2 || performance.now() - t0 < 3) && k < 8) {
      this.onHeight(this.arrivals.shift()!);
      k++;
    }
    k = 0;
    while (this.colourArrivals.length && k < 4) {
      const [n, tex] = this.colourArrivals.shift()!;
      if (n.colourState === LOADING) {
        n.colourTex = tex;
        n.colourState = READY;
        this.gpuBytes += COLOUR_BYTES;
      } else tex.dispose();
      k++;
    }
    if (this.arrivals.length || this.colourArrivals.length) this.onChange();
  }

  private onHeight(r: HeightResult) {
    const n = this.pending.get(r.id);
    this.pending.delete(r.id);
    if (!n) return;
    if (!r.ok) {
      console.warn('height tile failed', n.key, r.error);
      n.state = FAILED;
      this.onChange();
      return;
    }
    if (n.state !== LOADING) return; // evicted meanwhile
    this.bytesDownloaded += r.bytes;
    n.childMask = r.childMask;
    n.hmin = r.hmin;
    n.hmax = r.hmax;
    n.base = r.base;
    n.step = r.step;
    n.q = r.q;
    n.updateBounds();
    const ht = new DataTexture(r.q, GRID, GRID, RedIntegerFormat, UnsignedShortType);
    ht.internalFormat = 'R16UI';
    ht.unpackAlignment = 2; // 259 * 2 bytes per row is not 4-byte aligned
    ht.minFilter = ht.magFilter = NearestFilter;
    ht.generateMipmaps = false;
    ht.needsUpdate = true;
    const nt = new DataTexture(r.normals, TILE_N + 1, TILE_N + 1, RGFormat, HalfFloatType);
    nt.internalFormat = 'RG16F';
    nt.magFilter = LinearFilter;
    nt.minFilter = LinearMipmapLinearFilter;
    nt.generateMipmaps = true;
    nt.wrapS = nt.wrapT = ClampToEdgeWrapping;
    nt.needsUpdate = true;
    n.heightTex = ht;
    n.normalTex = nt;
    n.state = READY;
    this.gpuBytes += HEIGHT_BYTES + NORMAL_BYTES;
    this.stats.loaded++;
    this.onChange();
  }

  // ----------------------------------------------------------------- eviction
  private evict(frame: number) {
    if (this.gpuBytes <= this.opts.gpuBudgetBytes) return;
    const cands: TileNode[] = [];
    for (const n of this.nodes.values()) {
      if (n.level === 0 || n.lastUsed >= frame) continue;
      if (n.state === READY || n.colourState === READY) cands.push(n);
    }
    cands.sort((a, b) => a.lastUsed - b.lastUsed || b.level - a.level);
    for (const n of cands) {
      if (this.gpuBytes <= this.opts.gpuBudgetBytes * 0.9) break;
      this.release(n);
    }
  }

  private release(n: TileNode) {
    this.gpuBytes -= n.gpuBytes();
    n.heightTex?.dispose();
    n.normalTex?.dispose();
    n.colourTex?.dispose();
    n.heightTex = n.normalTex = n.colourTex = null;
    n.q = null;
    if (n.mesh) {
      (n.mesh.material as RawShaderMaterial).dispose();
      n.mesh = null;
    }
    if (n.state === READY || n.state === LOADING) n.state = EMPTY;
    if (n.colourState === READY) n.colourState = EMPTY;
    // drop the (unloaded) subtree structure when it no longer holds data
    if (n.children && n.children.every((c) => c.state !== READY && c.state !== LOADING && !c.children)) {
      for (const c of n.children) this.nodes.delete(c.key);
      n.children = null;
    }
  }

  // ---------------------------------------------------------------- materials
  private colourFor(n: TileNode): { tex: Texture; scale: number; ou: number; ov: number } {
    let a: TileNode | null = n;
    while (a && (a.level > this.opts.colourMaxLevel || a.colourState !== READY)) a = a.parent;
    if (!a) return { tex: this.fallbackColour, scale: 1, ou: 0, ov: 0 };
    const k = n.level - a.level;
    const scale = 1 / (1 << k);
    const m = (1 << k) - 1;
    return { tex: a.colourTex!, scale, ou: (n.x & m) * scale, ov: (n.y & m) * scale };
  }

  meshFor(n: TileNode, fi: FrameInfo, P: number, light: Vector3, lightParams: LightParams): Mesh {
    if (!n.mesh) {
      const F = FACES[n.face];
      const mat = new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: terrainVS,
        fragmentShader: terrainFS,
        uniforms: {
          uProj: { value: new Matrix4() },
          uViewRot: { value: new Matrix3() },
          uN: { value: new Vector3(...F.n) },
          uU: { value: new Vector3(...F.u) },
          uV: { value: new Vector3(...F.v) },
          uTile: { value: [(-1 + (n.x + 0.5) * (2 / n.n)), (-1 + (n.y + 0.5) * (2 / n.n)), 2 / n.n, MESH_N] },
          uCC: { value: new Vector3(...n.cc) },
          uDirC: { value: new Vector3(...n.dirC) },
          uOrigin: { value: new Vector3() },
          uTanC: { value: [...n.tanC] },
          uCosC: { value: [...n.cosC] },
          uHeight: { value: n.heightTex },
          uHQ: { value: [n.base, n.step] },
          uMorph: { value: [1e30, 2e30] },
          uSkirt: { value: texelSize(n.level) * 3 },
          uR: { value: R_MOON },
          uNormal: { value: n.normalTex },
          uColour: { value: this.fallbackColour },
          uColourXf: { value: new Vector3(1, 0, 0) },
          uColourBias: { value: 0 },
          uLight: { value: new Vector3() },
          uSun: { value: 1 },
          uAmbient: { value: 0.02 },
          uExposure: { value: 1 },
          uEarthDir: { value: new Vector3(1, 0, 0) },
          uEarthshine: { value: 0 },
          uFeas: { value: this.fallbackColour },
          uFeasXf: { value: new Vector3(1, 0, 0) },
          uFeasOn: { value: 0 },
          uFeasN: { value: 64 },
        },
      });
      n.mesh = new Mesh(tileGeometry(), mat);
      n.mesh.frustumCulled = false;
      n.mesh.matrixAutoUpdate = false;
    }
    const u = (n.mesh.material as RawShaderMaterial).uniforms;
    u.uProj.value.copy(fi.proj);
    u.uViewRot.value.copy(fi.viewRot);
    // origin relative to camera, float64 subtraction
    (u.uOrigin.value as Vector3).set(
      R_MOON * n.dirC[0] - fi.camPos[0],
      R_MOON * n.dirC[1] - fi.camPos[1],
      R_MOON * n.dirC[2] - fi.camPos[2],
    );
    if (n.level > 0) {
      const Dl = this.splitDist(n.level, P); // = D_{L-1} / 2
      u.uMorph.value = [1.6 * Dl, 2.0 * Dl];
    }
    const c = this.colourFor(n);
    u.uColour.value = c.tex;
    (u.uColourXf.value as Vector3).set(c.scale, c.ou, c.ov);
    // parent and children that share an ancestor's colour texture must sample it identically
    u.uColourBias.value = c.scale === 1 ? 1 : 0;
    (u.uLight.value as Vector3).copy(light);
    u.uSun.value = lightParams.sun;
    u.uAmbient.value = lightParams.ambient;
    u.uExposure.value = lightParams.exposure;
    (u.uEarthDir.value as Vector3).copy(lightParams.earthDir);
    u.uEarthshine.value = lightParams.earthshine;
    const fz = this.feasProvider ? this.feasProvider(n.level, n.face, n.x, n.y) : null;
    u.uFeasOn.value = fz ? 1 : 0;
    if (fz) {
      u.uFeas.value = fz.tex;
      (u.uFeasXf.value as Vector3).set(fz.scale, fz.ou, fz.ov);
    }
    const dist = Math.hypot(n.centre[0] - fi.camPos[0], n.centre[1] - fi.camPos[1], n.centre[2] - fi.camPos[2]);
    n.mesh.renderOrder = 10 + Math.min(1e6, dist / 10); // front to back
    void this.tmpV;
    return n.mesh;
  }

  pixelsPerTexelP(fi: FrameInfo) {
    return fi.viewportHeight / (2 * Math.tan(fi.fovY / 2));
  }

  isBusy(): boolean {
    return this.inflightHeights > 0 || this.inflightColour > 0 || this.arrivals.length > 0 || this.colourArrivals.length > 0;
  }
}
