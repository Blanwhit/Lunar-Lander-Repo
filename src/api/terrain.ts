// Headless terrain sampler over the MLH1 height-tile pyramid (no WebGL needed).
//
// Lookups are synchronous against already-loaded tiles. A lookup returns the deepest
// loaded tile at or above the requested level and records what it was missing, so callers
// can run a computation, fetch the missing tiles in one batch, and repeat until nothing is
// missing (see TileTerrain.until()). A miss records the whole chain down to the requested
// level, so one fetch round loads every level a lookup needs (not one level per round).
import { GRID, TILE_N, dirToFace, type Vec3 } from '../geom';
import { decodeHeightTile, type DecodedHeightTile } from '../terrain/heightCodec';

export interface TerrainTile extends DecodedHeightTile {
  /** loaded children (index (cy << 1) | cx); undefined = not loaded yet, null = none */
  children: (TerrainTile | null | undefined)[];
}

export interface Sample {
  h: number; // metres vs the 1737.4 km sphere
  level: number; // tile level that served the sample
}

const key = (L: number, f: number, x: number, y: number) => ((L * 6 + f) * 2048 + y) * 2048 + x;

/** a missed lookup: load the tiles under (a, b) on `face` from level `from` down to `to` */
interface Want {
  face: number;
  a: number;
  b: number;
  from: number;
  to: number;
}

/** tile coordinate of face position a (or b) in [-1, 1] at level L */
const tileAt = (a: number, L: number) => Math.min((1 << L) - 1, Math.max(0, Math.floor(((a + 1) / 2) * (1 << L))));

export class TileTerrain {
  private roots: (TerrainTile | undefined)[] = new Array(6);
  private pending = new Map<number, Promise<void>>();
  private wanted = new Map<number, Want>();
  /** how far ahead a miss loads (default: the pyramid's L11); a chain still stops at leaves */
  maxLevel = 11;
  tilesLoaded = 0;
  bytesLoaded = 0;

  /** @param baseUrl URL of the tile pyramid (the folder containing h/, meta.json) */
  constructor(private baseUrl: string, private fetchImpl: typeof fetch = fetch.bind(globalThis)) {}

  // ---------------------------------------------------------------- loading
  private async loadTile(L: number, f: number, x: number, y: number): Promise<void> {
    const r = await this.fetchImpl(`${this.baseUrl}h/${L}/${f}/${y}/${x}.bin`);
    if (!r.ok) throw new Error(`height tile ${L}/${f}/${x}/${y}: HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    this.bytesLoaded += buf.byteLength;
    const t = (await decodeHeightTile(buf)) as TerrainTile;
    t.children = t.childMask ? [undefined, undefined, undefined, undefined] : [null, null, null, null];
    this.tilesLoaded++;
    if (L === 0) {
      this.roots[f] = t;
      return;
    }
    const parent = this.find(L - 1, f, x >> 1, y >> 1);
    if (!parent) throw new Error('parent tile not loaded');
    parent.children[((y & 1) << 1) | (x & 1)] = t;
  }

  private find(L: number, f: number, x: number, y: number): TerrainTile | undefined {
    let t = this.roots[f];
    for (let l = 1; t && l <= L; l++) {
      const s = L - l;
      const c = t.children[(((y >> s) & 1) << 1) | ((x >> s) & 1)];
      t = c ?? undefined;
    }
    return t;
  }

  private ensure(L: number, f: number, x: number, y: number): Promise<void> {
    const k = key(L, f, x, y);
    let p = this.pending.get(k);
    if (!p) {
      p = this.loadTile(L, f, x, y);
      this.pending.set(k, p);
    }
    return p;
  }

  /** load the chain of tiles a missed lookup needs, parent before child, stopping at leaves */
  private async loadChain(w: Want): Promise<number> {
    let n = 0;
    for (let L = w.from; L <= w.to; L++) {
      const x = tileAt(w.a, L), y = tileAt(w.b, L);
      await this.ensure(L, w.face, x, y);
      n++;
      const t = this.find(L, w.face, x, y);
      if (!t || !t.childMask) break; // finest tile here: no deeper level exists
    }
    return n;
  }

  /** fetch every tile chain requested by sync lookups since the last call */
  async fetchWanted(concurrency = 16): Promise<number> {
    const list = [...this.wanted.values()];
    this.wanted.clear();
    let i = 0, n = 0;
    const worker = async () => {
      while (i < list.length) n += await this.loadChain(list[i++]);
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
    return n;
  }

  /** run `fn` repeatedly, loading the tiles it asked for, until it needs nothing new */
  async until<T>(fn: () => T, maxPasses = 20): Promise<T> {
    for (let pass = 0; ; pass++) {
      const r = fn();
      if (this.wanted.size === 0 || pass >= maxPasses) return r;
      await this.fetchWanted();
    }
  }

  // ---------------------------------------------------------------- sampling
  /**
   * Height at a body-frame unit direction from the deepest loaded tile with level <= maxLevel.
   * Missing tiles on the way down are recorded for fetchWanted(). Returns NaN only if the
   * face's root tile is not loaded yet.
   */
  sample(dir: Vec3, maxLevel: number): Sample {
    const { face, a, b } = dirToFace(dir);
    const root = this.roots[face];
    if (!root) {
      this.want(face, a, b, 0, maxLevel);
      return { h: NaN, level: -1 };
    }
    let t: TerrainTile = root;
    while (t.level < maxLevel && t.childMask) {
      const n2 = 2 << t.level; // tiles per side at the child level
      const cx = Math.min(1, Math.max(0, Math.floor(((a + 1) / 2) * n2) - t.x * 2));
      const cy = Math.min(1, Math.max(0, Math.floor(((b + 1) / 2) * n2) - t.y * 2));
      const c: TerrainTile | null | undefined = t.children[(cy << 1) | cx];
      if (c === undefined) {
        this.want(face, a, b, t.level + 1, maxLevel);
        break;
      }
      if (c === null) break;
      t = c;
    }
    return { h: bilinear(t, a, b), level: t.level };
  }

  private want(face: number, a: number, b: number, from: number, maxLevel: number) {
    const to = Math.max(from, Math.min(maxLevel, this.maxLevel));
    // one entry per tile at the target level: lookups that share it share the chain
    const k = key(to, face, tileAt(a, to), tileAt(b, to));
    if (!this.wanted.has(k)) this.wanted.set(k, { face, a, b, from, to });
  }
}

function bilinear(t: TerrainTile, a: number, b: number): number {
  const span = 2 / (1 << t.level);
  const fu = ((a + 1) / span - t.x) * TILE_N + 1;
  const fv = ((b + 1) / span - t.y) * TILE_N + 1;
  const i = Math.min(GRID - 2, Math.max(0, Math.floor(fu)));
  const j = Math.min(GRID - 2, Math.max(0, Math.floor(fv)));
  const tx = Math.min(1, Math.max(0, fu - i)), ty = Math.min(1, Math.max(0, fv - j));
  const q = t.q, k = j * GRID + i;
  const h00 = q[k], h10 = q[k + 1], h01 = q[k + GRID], h11 = q[k + GRID + 1];
  const v = (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
  return t.base + v * t.step;
}
