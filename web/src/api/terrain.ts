// Headless terrain sampler over the MLH1 height-tile pyramid (no WebGL needed).
//
// Lookups are synchronous against already-loaded tiles. A lookup returns the deepest
// loaded tile at or above the requested level and records what it was missing, so callers
// can run a computation, fetch the missing tiles in one batch, and repeat until nothing is
// missing (see TileTerrain.until()). A miss records the whole chain down to the requested
// level, so one fetch round loads every level a lookup needs (not one level per round).
import { GRID, TILE_N, type Vec3 } from '../geom';
import { readHeightTile, type DecodedHeightTile } from '../terrain/heightCodec';
import type { LoadedTile, TileLoader } from './tilePool';

export type LoadedHeightTile = (level: number, face: number, x: number, y: number) => DecodedHeightTile | undefined;

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
  /** lookups that found a tile missing so far (unchanged across a computation = it is final) */
  misses = 0;
  /** level of the tile that served the last sampleAt() (-1: the face's root is not loaded) */
  hitLevel = -1;
  /** the tile that served the last lookup: the next one usually falls in it too */
  private last: TerrainTile | undefined;
  /** fetches + decodes a tile elsewhere (a worker pool); unset: on this thread (fetchLocal) */
  loader: TileLoader | undefined;

  /** @param baseUrl URL of the tile pyramid (the folder containing h/, meta.json) */
  constructor(private baseUrl: string, private fetchImpl: typeof fetch = fetch.bind(globalThis),
    private loadedHeightTile?: LoadedHeightTile) {}

  // ---------------------------------------------------------------- loading
  /** fetch a tile file on this thread; its grid is decoded when a lookup first reads it */
  readonly fetchLocal: TileLoader = async (url): Promise<LoadedTile> => {
    const r = await this.fetchImpl(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    return { tile: await readHeightTile(buf), bytes: buf.byteLength };
  };

  private async loadTile(L: number, f: number, x: number, y: number): Promise<void> {
    // a grid the viewer already holds needs no fetch
    const resident = this.loadedHeightTile?.(L, f, x, y);
    let t: TerrainTile;
    if (resident) t = { ...resident } as TerrainTile;
    else {
      const url = `${this.baseUrl}h/${L}/${f}/${y}/${x}.bin`;
      const loaded = await (this.loader ?? this.fetchLocal)(url).catch((e) => {
        throw new Error(`height tile ${L}/${f}/${x}/${y}: ${e instanceof Error ? e.message : e}`);
      });
      this.bytesLoaded += loaded.bytes;
      t = loaded.tile as TerrainTile;
    }
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
      // a failed load (a network hiccup) may be tried again by a later lookup
      p.catch(() => this.pending.delete(k));
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
  async fetchWanted(concurrency = 32): Promise<number> {
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
   * Missing tiles on the way down are recorded for fetchWanted(). Returns NaN if the root
   * is missing or the tile cannot reach the optional minimum height.
   */
  sample(dir: Vec3, maxLevel: number, minHeight = -Infinity): Sample {
    const h = this.sampleAt(dir[0], dir[1], dir[2], maxLevel, minHeight);
    return { h, level: this.hitLevel };
  }

  /**
   * sample() for inner loops (the horizon scan takes ~10^5 samples): the direction as three
   * numbers, the height returned and the serving tile's level left in `hitLevel`, so a
   * lookup allocates nothing. Same result as sample().
   */
  sampleAt(x: number, y: number, z: number, maxLevel: number, minHeight = -Infinity): number {
    // direction -> face + face coords: geom.dirToFace, inlined (keep the two in sync)
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    let face: number, dn: number, u: number, v: number;
    if (ax >= ay && ax >= az) {
      if (x >= 0) { face = 0; dn = x; u = y; } else { face = 1; dn = -x; u = 0 - y; }
      v = z;
    } else if (ay >= az) {
      if (y >= 0) { face = 2; dn = y; u = 0 - x; } else { face = 3; dn = -y; u = x; }
      v = z;
    } else {
      if (z >= 0) { face = 4; dn = z; v = 0 - x; } else { face = 5; dn = -z; v = x; }
      u = y;
    }
    const a = (Math.atan(u / dn) * 4) / Math.PI, b = (Math.atan(v / dn) * 4) / Math.PI;

    const root = this.roots[face];
    if (!root) {
      this.want(face, a, b, 0, maxLevel);
      this.hitLevel = -1;
      return NaN;
    }
    let t: TerrainTile = root;
    // Consecutive lookups mostly fall in the same tile. The walk down from the root passes
    // through tile (tileAt(a, L), tileAt(b, L)) at every level L it reaches, so when the last
    // tile contains this point and is no deeper than wanted, the walk can resume from it.
    const l = this.last;
    if (l !== undefined && l.face === face && l.level <= maxLevel && l.level > 0
      && tileAt(a, l.level) === l.x && tileAt(b, l.level) === l.y) t = l;
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
    this.last = t;
    this.hitLevel = t.level;
    // The header bounds the interior before quantisation. One quantum of slack
    // also covers rounding. The caller only uses heights above its cutoff.
    return t.hmax + t.step < minHeight ? NaN : bilinear(t, a, b);
  }

  private want(face: number, a: number, b: number, from: number, maxLevel: number) {
    this.misses++;
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
