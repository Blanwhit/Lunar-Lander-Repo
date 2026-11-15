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

/**
 * direction -> face + face coords (a, b). Every FACES axis is a signed unit axis, so the face
 * is the largest |component| (ties: x, then y, then z, like taking the first face with the
 * largest d . N) and d . U, d . V are single signed components:
 *   +X: U=+y V=+z   -X: U=-y V=+z   +Y: U=-x V=+z   -Y: U=+x V=+z   +Z: U=+y V=-x   -Z: U=+y V=+x
 */
export function dirToFace(d: Vec3): { face: number; a: number; b: number } {
  const x = d[0], y = d[1], z = d[2];
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  // `0 - c` rather than `-c`: a zero component gives +0, like the dot product did
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
  return { face, a: (Math.atan(u / dn) * 4) / Math.PI, b: (Math.atan(v / dn) * 4) / Math.PI };
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
