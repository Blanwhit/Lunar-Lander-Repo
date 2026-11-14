/// <reference lib="webworker" />
// Fetches + decodes height tiles (format: pipeline/moonlod/heights.py) and bakes a
// tangent-space normal map (RG16F) from the 259x259 samples so the main thread only
// uploads textures.
import { FACES, GRID, R_MOON, TILE_N } from '../geom';
import { decodeHeightTile } from './heightCodec';

export interface HeightRequest {
  id: number;
  url: string;
}

export interface HeightResult {
  id: number;
  ok: boolean;
  error?: string;
  level: number;
  face: number;
  x: number;
  y: number;
  childMask: number;
  hmin: number;
  hmax: number;
  base: number;
  step: number;
  q: Uint16Array; // GRID*GRID quantised heights
  normals: Uint16Array; // (TILE_N+1)^2 * 2 half floats: tangent-space (e1, e2) components
  bytes: number;
}

const V = TILE_N + 1; // 257 vertices

// float32 -> float16 bits
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e <= 0) {
    if (e < -10) return sign;
    m = (m | 0x800000) >> (1 - e);
    return sign | ((m + 0x1000) >> 13);
  }
  if (e >= 31) return sign | 0x7c00;
  const h = sign | (e << 10) | (m >> 13);
  return (m & 0x1000) !== 0 ? h + 1 : h;
}

async function decode(req: HeightRequest): Promise<HeightResult> {
  const res = await fetch(req.url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const compressed = await res.arrayBuffer();
  const t = await decodeHeightTile(compressed);
  const { level, face, childMask, x, y, hmin, hmax, step, base, q } = t;
  const G = GRID;
  const n = G * G;

  // ---- normals (body frame, then projected onto the per-vertex tangent frame)
  const F = FACES[face];
  const nTiles = 1 << level;
  const span = 2 / nTiles;
  const a0 = -1 + x * span;
  const b0 = -1 + y * span;
  const P = new Float64Array(n * 3);
  const D = new Float64Array(n * 3);
  const sArr = new Float64Array(G);
  for (let i = 0; i < G; i++) sArr[i] = Math.tan((Math.PI / 4) * (a0 + ((i - 1) / TILE_N) * span));
  for (let j = 0; j < G; j++) {
    const t = Math.tan((Math.PI / 4) * (b0 + ((j - 1) / TILE_N) * span));
    for (let i = 0; i < G; i++) {
      const s = sArr[i];
      const cx = F.n[0] + s * F.u[0] + t * F.v[0];
      const cy = F.n[1] + s * F.u[1] + t * F.v[1];
      const cz = F.n[2] + s * F.u[2] + t * F.v[2];
      const l = Math.hypot(cx, cy, cz);
      const k = j * G + i;
      const r = R_MOON + base + q[k] * step;
      D[3 * k] = cx / l;
      D[3 * k + 1] = cy / l;
      D[3 * k + 2] = cz / l;
      P[3 * k] = (cx / l) * r;
      P[3 * k + 1] = (cy / l) * r;
      P[3 * k + 2] = (cz / l) * r;
    }
  }
  const normals = new Uint16Array(V * V * 2);
  const U = F.u;
  for (let j = 0; j < V; j++) {
    for (let i = 0; i < V; i++) {
      const k = (j + 1) * G + (i + 1);
      const ax = P[3 * (k + 1)] - P[3 * (k - 1)];
      const ay = P[3 * (k + 1) + 1] - P[3 * (k - 1) + 1];
      const az = P[3 * (k + 1) + 2] - P[3 * (k - 1) + 2];
      const bx = P[3 * (k + G)] - P[3 * (k - G)];
      const by = P[3 * (k + G) + 1] - P[3 * (k - G) + 1];
      const bz = P[3 * (k + G) + 2] - P[3 * (k - G) + 2];
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const nl = Math.hypot(nx, ny, nz);
      nx /= nl;
      ny /= nl;
      nz /= nl;
      // tangent frame: up = dir, e1 = normalize(U - up (U.up)), e2 = up x e1
      const ux = D[3 * k];
      const uy = D[3 * k + 1];
      const uz = D[3 * k + 2];
      const ud = U[0] * ux + U[1] * uy + U[2] * uz;
      let e1x = U[0] - ux * ud;
      let e1y = U[1] - uy * ud;
      let e1z = U[2] - uz * ud;
      const el = Math.hypot(e1x, e1y, e1z);
      e1x /= el;
      e1y /= el;
      e1z /= el;
      const e2x = uy * e1z - uz * e1y;
      const e2y = uz * e1x - ux * e1z;
      const e2z = ux * e1y - uy * e1x;
      const o = 2 * (j * V + i);
      normals[o] = toHalf(nx * e1x + ny * e1y + nz * e1z);
      normals[o + 1] = toHalf(nx * e2x + ny * e2y + nz * e2z);
    }
  }
  return {
    id: req.id, ok: true, level, face, x, y, childMask, hmin, hmax, base, step, q, normals,
    bytes: compressed.byteLength,
  };
}

self.onmessage = async (ev: MessageEvent<HeightRequest>) => {
  const req = ev.data;
  try {
    const r = await decode(req);
    (self as unknown as Worker).postMessage(r, [r.q.buffer, r.normals.buffer]);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id: req.id, ok: false, error: String(e) });
  }
};
