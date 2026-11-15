// Feasibility heatmap overlay: a quadtree of score tiles (pipeline/feasibility_grid.py),
// evaluated for the viewer's date/time in Web Workers and handed to the terrain shader as
// small R8 textures (score 0..100 % -> 0..255), sampled with a UV transform like colour.
import { DataTexture, LinearFilter, RedFormat, UnsignedByteType, ClampToEdgeWrapping, Matrix3, Vector3, type Texture } from 'three';
import type { Ephemeris } from '../ephemeris';
import type { OrientationProvider } from '../orientation';
import { BACK_STEPS, FWD_STEPS, STEP_H, type FeasMsg, type FeasReply } from './feasWorker';

export interface FeasMeta {
  samples: number;
  maxLevel: number;
}

interface Node {
  key: string;
  L: number; f: number; x: number; y: number;
  state: 0 | 1 | 2 | 3; // empty, loading, loaded (in a worker), failed
  childMask: number;
  children: (Node | undefined)[];
  worker: number;
  tex: DataTexture | null;
  texToken: number; // timeline token the texture was computed for
  computing: boolean;
  lastUsed: number;
}

export interface FeasLookup {
  tex: Texture;
  scale: number;
  ou: number;
  ov: number;
}

export class FeasibilityOverlay {
  enabled = false;
  private roots: Node[] = [];
  private nodes = new Map<string, Node>();
  private workers: Worker[] = [];
  private busy: number[] = [];
  private token = 0;
  private timelineReady = false;
  private frame = 0;
  private wantLoad = new Set<Node>();
  private wantCompute = new Set<Node>();
  onChange: () => void = () => {};

  constructor(
    private baseUrl: string, // .../tiles/
    private meta: FeasMeta,
    private ephem: Ephemeris,
    private orientation: OrientationProvider,
  ) {
    for (let f = 0; f < 6; f++) this.roots.push(this.node(0, f, 0, 0));
  }

  private ensureWorkers() {
    if (this.workers.length) return;
    const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./feasWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<FeasReply>) => this.onReply(ev.data, i);
      this.workers.push(w);
      this.busy.push(0);
    }
  }

  private node(L: number, f: number, x: number, y: number): Node {
    const key = `${L}/${f}/${x}/${y}`;
    let n = this.nodes.get(key);
    if (!n) {
      n = { key, L, f, x, y, state: 0, childMask: 0, children: [], worker: -1, tex: null, texToken: -1, computing: false, lastUsed: 0 };
      this.nodes.set(key, n);
    }
    return n;
  }

  // ------------------------------------------------------------------- time
  /** recompute for a new date/time (UTC ms): builds the shared Sun/Earth timeline */
  async setTime(ms: number) {
    const token = ++this.token;
    const N = 1 + FWD_STEPS + BACK_STEPS;
    const sun = new Float64Array(N * 3), earth = new Float64Array(N * 3);
    const tm = new Matrix3(), v = new Vector3();
    for (let i = 0; i < N; i++) {
      const dt = i === 0 ? 0 : i <= FWD_STEPS ? i * STEP_H : -(i - FWD_STEPS) * STEP_H;
      const t = ms + dt * 3600e3;
      const st = await this.ephem.at(t);
      if (token !== this.token) return; // superseded
      tm.copy(this.orientation.bodyToJ2000(new Date(t))).transpose();
      v.set(...st.sun).applyMatrix3(tm);
      sun.set([v.x, v.y, v.z], i * 3);
      v.set(...st.earth).applyMatrix3(tm);
      earth.set([v.x, v.y, v.z], i * 3);
    }
    this.ensureWorkers();
    for (const w of this.workers) w.postMessage({ type: 'timeline', token, sun, earth } satisfies FeasMsg);
    this.timelineReady = true;
    // every loaded tile is now stale; recompute those in use first
    for (const n of this.nodes.values()) if (n.state === 2) this.wantCompute.add(n);
    this.pump();
  }

  // ------------------------------------------------------------------- lookup
  /** score texture + UV transform for a terrain tile (deepest score tile available) */
  lookup(L: number, f: number, x: number, y: number): FeasLookup | null {
    if (!this.enabled) return null;
    this.ensureWorkers();
    const target = Math.min(L, this.meta.maxLevel);
    let n: Node | undefined = this.roots[f];
    let best: Node | null = null;
    while (n) {
      n.lastUsed = this.frame;
      if (n.state === 0) this.wantLoad.add(n);
      if (n.state === 2 && n.texToken !== this.token && !n.computing) this.wantCompute.add(n);
      if (n.tex) best = n;
      if (n.state !== 2 || n.L >= target || !n.childMask) break;
      const s: number = L - n.L - 1; // (x, y) are terrain-tile coordinates at level L
      const cx: number = (x >> s) & 1, cy: number = (y >> s) & 1;
      const idx: number = (cy << 1) | cx;
      const parent: Node = n;
      n = parent.children[idx] ??= this.node(parent.L + 1, f, parent.x * 2 + cx, parent.y * 2 + cy);
    }
    if (!best) return null;
    const k = L - best.L;
    const scale = 1 / (1 << k);
    const m = (1 << k) - 1;
    return { tex: best.tex!, scale, ou: (x & m) * scale, ov: (y & m) * scale };
  }

  /** call once per rendered frame (after the terrain meshes were built) */
  endFrame() {
    this.frame++;
    this.pump();
  }

  isBusy() {
    return this.busy.some((b) => b > 0) || this.wantLoad.size > 0 || this.wantCompute.size > 0;
  }

  // ------------------------------------------------------------------- workers
  private pump() {
    if (!this.enabled || !this.workers.length) return;
    for (const n of this.wantLoad) {
      if (n.state !== 0) { this.wantLoad.delete(n); continue; }
      const wi = this.leastBusy();
      if (this.busy[wi] >= 4) break;
      n.state = 1;
      n.worker = wi;
      this.busy[wi]++;
      this.workers[wi].postMessage({ type: 'load', key: n.key, url: new URL(`${this.baseUrl}f/${n.L}/${n.f}/${n.y}/${n.x}.bin`, location.href).href } satisfies FeasMsg);
      this.wantLoad.delete(n);
    }
    if (!this.timelineReady) return;
    // compute: most recently used first
    const list = [...this.wantCompute].filter((n) => n.state === 2 && !n.computing && n.texToken !== this.token)
      .sort((a, b) => b.lastUsed - a.lastUsed || a.L - b.L);
    this.wantCompute.clear();
    for (const n of list) {
      if (this.busy[n.worker] >= 2) { this.wantCompute.add(n); continue; }
      n.computing = true;
      this.busy[n.worker]++;
      this.workers[n.worker].postMessage({ type: 'compute', key: n.key, token: this.token } satisfies FeasMsg);
    }
  }

  private leastBusy() {
    let wi = 0;
    for (let i = 1; i < this.busy.length; i++) if (this.busy[i] < this.busy[wi]) wi = i;
    return wi;
  }

  private onReply(r: FeasReply, wi: number) {
    this.busy[wi]--;
    const n = this.nodes.get(r.key);
    if (!n) return;
    if (r.type === 'loaded') {
      n.state = r.ok ? 2 : 3;
      n.childMask = r.childMask;
      if (!r.ok) console.warn('feasibility tile', r.key, r.error);
      if (r.ok) this.wantCompute.add(n);
    } else {
      n.computing = false;
      if (r.token === this.token && r.scores.length) {
        const S = this.meta.samples;
        if (!n.tex) {
          n.tex = new DataTexture(r.scores, S, S, RedFormat, UnsignedByteType);
          n.tex.magFilter = n.tex.minFilter = LinearFilter;
          n.tex.wrapS = n.tex.wrapT = ClampToEdgeWrapping;
          n.tex.generateMipmaps = false;
          n.tex.unpackAlignment = 1;
        } else {
          (n.tex.image as { data: Uint8Array }).data = r.scores;
        }
        n.tex.needsUpdate = true;
        n.texToken = r.token;
      } else if (n.texToken !== this.token) this.wantCompute.add(n);
    }
    this.pump();
    this.onChange();
  }
}
