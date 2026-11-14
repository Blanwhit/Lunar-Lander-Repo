// Cube-sphere geometry. Mirrors pipeline/moonlod/geom.py -- keep in sync.
//
// Body frame: lunar ME/PA. +X -> (0N, 0E), +Z -> north pole, +Y -> (0N, 90E).
// Equi-angular cube map: face coords a, b in [-1, 1];
//   c = N + tan(pi/4 a) U + tan(pi/4 b) V ; dir = c / |c|
// Tile (L, x, y) of a face covers a in [-1 + 2x/n, -1 + 2(x+1)/n] (n = 2^L), same for b/y.

export const R_MOON = 1737400; // m
export const TILE_N = 256; // cells per tile side (257 vertices)
export const GRID = TILE_N + 3; // 259 stored height samples (1-sample border)
// mesh cells per tile side (power of two <= TILE_N). The vertex shader samples every
// TILE_N/MESH_N-th height texel; lighting always uses the full-resolution normal map.
// Overridable for A/B tests with ?mesh=N (no UI).
const meshParam = typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('mesh')) : 0;
export const MESH_N = [16, 32, 64, 128].includes(meshParam) ? meshParam : 64;
export const H_MIN_GLOBAL = -9200; // lowest point on the Moon (m, vs 1737.4 km) ~ Antoniadi
export const H_MAX_GLOBAL = 10800;

export type Vec3 = [number, number, number];

export const FACES: { n: Vec3; u: Vec3; v: Vec3 }[] = [
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] },
  { n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [0, 1, 0], v: [-1, 0, 0] },
  { n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0] },
];

export function faceDir(face: number, a: number, b: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const F = FACES[face];
  const s = Math.tan((Math.PI / 4) * a);
  const t = Math.tan((Math.PI / 4) * b);
  const x = F.n[0] + s * F.u[0] + t * F.v[0];
  const y = F.n[1] + s * F.u[1] + t * F.v[1];
  const z = F.n[2] + s * F.u[2] + t * F.v[2];
  const l = Math.hypot(x, y, z);
  out[0] = x / l;
  out[1] = y / l;
  out[2] = z / l;
  return out;
}

/** direction -> face + face coords (a, b) */
export function dirToFace(d: Vec3): { face: number; a: number; b: number } {
  let best = 0;
  let bd = -Infinity;
  for (let f = 0; f < 6; f++) {
    const n = FACES[f].n;
    const dd = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
    if (dd > bd) {
      bd = dd;
      best = f;
    }
  }
  const F = FACES[best];
  const s = (d[0] * F.u[0] + d[1] * F.u[1] + d[2] * F.u[2]) / bd;
  const t = (d[0] * F.v[0] + d[1] * F.v[1] + d[2] * F.v[2]) / bd;
  return { face: best, a: (Math.atan(s) * 4) / Math.PI, b: (Math.atan(t) * 4) / Math.PI };
}

export function tileBounds(level: number, x: number, y: number) {
  const n = 1 << level;
  const a0 = -1 + (2 * x) / n;
  const b0 = -1 + (2 * y) / n;
  return { a0, b0, span: 2 / n };
}

/** nominal (face-centre) ground distance between height samples at level L */
export function texelSize(level: number): number {
  return ((Math.PI / 2) * R_MOON) / (TILE_N * (1 << level));
}

export function latLonToDir(latDeg: number, lonDeg: number): Vec3 {
  const la = (latDeg * Math.PI) / 180;
  const lo = (lonDeg * Math.PI) / 180;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}
