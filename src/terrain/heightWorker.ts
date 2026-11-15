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

// scratch buffers reused across tiles (positions and unit directions, GRID^2 x 3)
const P = new Float64Array(GRID * GRID * 3);
const D = new Float64Array(GRID * GRID * 3);
const sArr = new Float64Array(GRID);
// native float -> half conversion where available (round to nearest even); toHalf otherwise
const HAS_F16 = typeof (globalThis as { Float16Array?: unknown }).Float16Array === 'function';

/** tangent-space (e1, e2) components of the surface normal at each of the 257^2 vertices */
export function bakeNormals(face: number, level: number, x: number, y: number, base: number, step: number, q: Uint16Array): Uint16Array {
  const G = GRID;
  const F = FACES[face];
  const [Nx, Ny, Nz] = F.n, [Ux, Uy, Uz] = F.u, [Vx, Vy, Vz] = F.v;
  const span = 2 / (1 << level);
  const a0 = -1 + x * span;
  const b0 = -1 + y * span;
  // positions on the terrain; N, U, V are orthonormal, so |N + sU + tV| = sqrt(1 + s^2 + t^2)
  for (let i = 0; i < G; i++) sArr[i] = Math.tan((Math.PI / 4) * (a0 + ((i - 1) / TILE_N) * span));
  for (let j = 0; j < G; j++) {
    const t = Math.tan((Math.PI / 4) * (b0 + ((j - 1) / TILE_N) * span));
    const tt = 1 + t * t;
    for (let i = 0, k = j * G, k3 = 3 * k; i < G; i++, k++, k3 += 3) {
      const s = sArr[i];
      const inv = 1 / Math.sqrt(tt + s * s);
      const dx = (Nx + s * Ux + t * Vx) * inv, dy = (Ny + s * Uy + t * Vy) * inv, dz = (Nz + s * Uz + t * Vz) * inv;
      const r = R_MOON + base + q[k] * step;
      D[k3] = dx; D[k3 + 1] = dy; D[k3 + 2] = dz;
      P[k3] = dx * r; P[k3 + 1] = dy * r; P[k3 + 2] = dz * r;
    }
  }
  const out = HAS_F16 ? new (globalThis as unknown as { Float16Array: Float32ArrayConstructor }).Float16Array(V * V * 2) : null;
  const normals = out ? new Uint16Array(out.buffer) : new Uint16Array(V * V * 2);
  const G3 = 3 * G;
  for (let j = 0; j < V; j++) {
    for (let i = 0, k3 = 3 * ((j + 1) * G + 1), o = 2 * j * V; i < V; i++, k3 += 3, o += 2) {
      // central differences along the grid, normal = (dP/da) x (dP/db)
      const ax = P[k3 + 3] - P[k3 - 3], ay = P[k3 + 4] - P[k3 - 2], az = P[k3 + 5] - P[k3 - 1];
      const bx = P[k3 + G3] - P[k3 - G3], by = P[k3 + G3 + 1] - P[k3 - G3 + 1], bz = P[k3 + G3 + 2] - P[k3 - G3 + 2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const ni = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      // tangent frame: up = dir, e1 = normalize(U - up (U.up)), e2 = up x e1
      const ux = D[k3], uy = D[k3 + 1], uz = D[k3 + 2];
      const ud = Ux * ux + Uy * uy + Uz * uz;
      const e1x = Ux - ux * ud, e1y = Uy - uy * ud, e1z = Uz - uz * ud;
      const ei = 1 / Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z);
      const e2x = uy * e1z - uz * e1y, e2y = uz * e1x - ux * e1z, e2z = ux * e1y - uy * e1x;
      const c1 = (nx * e1x + ny * e1y + nz * e1z) * ni * ei;
      const c2 = (nx * e2x + ny * e2y + nz * e2z) * ni * ei;
      if (out) {
        out[o] = c1;
        out[o + 1] = c2;
      } else {
        normals[o] = toHalf(c1);
        normals[o + 1] = toHalf(c2);
      }
    }
  }
  return normals;
}

export async function decode(req: HeightRequest): Promise<HeightResult> {
  const res = await fetch(req.url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const compressed = await res.arrayBuffer();
  const t = await decodeHeightTile(compressed);
  const { level, face, childMask, x, y, hmin, hmax, step, base, q } = t;
  const normals = bakeNormals(face, level, x, y, base, step, q);
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
