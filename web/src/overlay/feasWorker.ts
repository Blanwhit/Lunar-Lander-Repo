/// <reference lib="webworker" />
// Feasibility overlay worker: holds decoded score tiles (format MLF1, written by
// pipeline/feasibility_grid.py) and evaluates the time-dependent feasibility score of every
// sample for a Sun/Earth timeline sent by the main thread.
import { FACES, R_MOON } from '../geom';
import { DEFAULT_FEASIBILITY, feasibilityScorer, type FeasibilityConfig, type FeasibilityInputs } from '../api/feasibility';
import { albedo, EMISSIVITY, SIGMA } from '../api/thermal';

export const STEP_H = 3; // timeline spacing (h)
export const FWD_STEPS = 112; // 14 days ahead: the 'hours remaining' utilities saturate there
export const BACK_STEPS = 120; // 15 days back: cooling history for the temperature proxy

export type FeasMsg =
  | { type: 'load'; key: string; url: string }
  | { type: 'compute'; key: string; token: number }
  | { type: 'timeline'; token: number; sun: Float64Array; earth: Float64Array }
  | { type: 'config'; config: FeasibilityConfig }
  | { type: 'drop'; key: string };

export type FeasReply =
  | { type: 'loaded'; key: string; ok: boolean; childMask: number; error?: string }
  | { type: 'scores'; key: string; token: number; scores: Uint8Array };

interface Tile {
  S: number;
  naz: number;
  horizon: Int8Array; // 0.25 deg
  hzMin: Float32Array; hzMax: Float32Array; // per sample: lowest / highest horizon bin (deg)
  n: number;
  up: Float64Array; east: Float64Array; north: Float64Array; normal: Float64Array; site: Float64Array;
  slope: Float32Array; prominence: Float32Array;
  annualSun: Float32Array; annualEarth: Float32Array; meanAbs: Float32Array;
}

// Moon-centred unit directions, with a conservative topocentric parallax allowance.
interface Bounds {
  unit: Float64Array;
  blockRadius: Float64Array;
  parallax: number;
  radiusMax: number;
}
const BLOCK = 8;

const tiles = new Map<string, Tile>();
let timeline: { token: number; sun: Float64Array; earth: Float64Array; sunB: Bounds; earthB: Bounds } | null = null;
let slopeLimits = DEFAULT_FEASIBILITY.factors.landing.slopeDeg;
let score = feasibilityScorer(); // same result as feasibility(inp, config).score
// horizon tolerance (deg): Sun / Earth count as visible down to this far below the horizon.
// The mast height is baked into the tiles (their horizons are seen from MAST_H).
let tol = DEFAULT_FEASIBILITY.horizonToleranceDeg;
const inp = {} as FeasibilityInputs; // reused for every sample
const DEG = Math.PI / 180;
const R_SUN_KM = 695700, R_EARTH_KM = 6371, AU_KM = 149597870.7;
const SITE_MAX_KM = (R_MOON + 11000) / 1000; // highest possible observer (km from the centre)
const SAFE = 1e-4; // deg of slack on every proof (float rounding)
const MAST_H = 10; // observer height (m) the tiles' horizons were marched from: pipeline MAST_H

function bounds(v: Float64Array, radiusKm: number): Bounds {
  const unit = new Float64Array(v.length);
  const count = v.length / 3;
  const blockRadius = new Float64Array(Math.ceil((count - 1) / BLOCK));
  let dMin = Infinity;
  for (let i = 0; i < count; i++) {
    const k = 3 * i;
    const d = Math.hypot(v[k], v[k+1], v[k+2]);
    dMin = Math.min(dMin, d);
    for (let j = 0; j < 3; j++) unit[k+j] = v[k+j] / d;
    if (i === 0) continue;
    const block = Math.floor((i - 1) / BLOCK);
    const first = 3 * (1 + block * BLOCK);
    const chord = Math.hypot(unit[k]-unit[first], unit[k+1]-unit[first+1], unit[k+2]-unit[first+2]);
    blockRadius[block] = Math.max(blockRadius[block], chord);
  }
  return { unit, blockRadius, parallax: Math.asin(SITE_MAX_KM / dMin) / DEG,
    radiusMax: Math.asin(Math.min(1, radiusKm / (dMin - SITE_MAX_KM))) / DEG };
}

function sineElevation(bounds: Bounds, step: number, up: Float64Array, k: number) {
  const u = bounds.unit, i = 3 * step;
  return u[i] * up[k] + u[i+1] * up[k+1] + u[i+2] * up[k+2];
}

async function load(key: string, url: string): Promise<number> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await new Response(
    new Blob([await res.arrayBuffer()]).stream().pipeThrough(new DecompressionStream('deflate')),
  ).arrayBuffer();
  const dv = new DataView(raw);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'MLF1') throw new Error('bad magic');
  const L = dv.getUint8(4), face = dv.getUint8(5), childMask = dv.getUint8(6), S = dv.getUint8(7);
  const x = dv.getUint32(8, true), y = dv.getUint32(12, true), naz = dv.getUint16(16, true);
  const n = S * S;
  let o = 20;
  const horizon = new Int8Array(raw, o, n * naz).slice();
  o += n * naz;
  const i16 = () => { const a = new Int16Array(raw.slice(o, o + 2 * n)); o += 2 * n; return a; };
  const u16 = () => { const a = new Uint16Array(raw.slice(o, o + 2 * n)); o += 2 * n; return a; };
  const height = i16(), slope = u16(), aspect = u16(), prom = i16(), aSun = u16(), aEarth = u16(), mAbs = u16();

  const F = FACES[face];
  const span = 2 / (1 << L);
  const hzMin = new Float32Array(n), hzMax = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let lo = 127, hi = -128;
    for (let a = k * naz; a < (k + 1) * naz; a++) {
      lo = Math.min(lo, horizon[a]);
      hi = Math.max(hi, horizon[a]);
    }
    hzMin[k] = lo / 4;
    hzMax[k] = hi / 4;
  }
  const t: Tile = {
    S, naz, horizon, hzMin, hzMax, n,
    up: new Float64Array(n * 3), east: new Float64Array(n * 3), north: new Float64Array(n * 3),
    normal: new Float64Array(n * 3), site: new Float64Array(n * 3),
    slope: new Float32Array(n), prominence: new Float32Array(n),
    annualSun: new Float32Array(n), annualEarth: new Float32Array(n), meanAbs: new Float32Array(n),
  };
  for (let j = 0; j < S; j++) {
    const tb = Math.tan((Math.PI / 4) * (-1 + y * span + (j / (S - 1)) * span));
    for (let i = 0; i < S; i++) {
      const k = j * S + i, k3 = 3 * k;
      const ta = Math.tan((Math.PI / 4) * (-1 + x * span + (i / (S - 1)) * span));
      let ux = F.n[0] + ta * F.u[0] + tb * F.v[0], uy = F.n[1] + ta * F.u[1] + tb * F.v[1], uz = F.n[2] + ta * F.u[2] + tb * F.v[2];
      const l = Math.hypot(ux, uy, uz);
      ux /= l; uy /= l; uz /= l;
      // east = Z x up (pole fallback +Y), north = up x east
      let ex = -uy, ey = ux, ez = 0;
      const el = Math.hypot(ex, ey);
      if (el < 1e-9) { ex = 0; ey = 1; } else { ex /= el; ey /= el; }
      const nx = uy * ez - uz * ey, ny = uz * ex - ux * ez, nz = ux * ey - uy * ex;
      t.up.set([ux, uy, uz], k3); t.east.set([ex, ey, ez], k3); t.north.set([nx, ny, nz], k3);
      const s = (slope[k] / 100) * DEG;
      const asp = aspect[k] === 65535 ? 0 : (aspect[k] / 100) * DEG;
      // the ground normal leans towards the downslope direction
      const dx = Math.cos(asp) * nx + Math.sin(asp) * ex, dy = Math.cos(asp) * ny + Math.sin(asp) * ey, dz = Math.cos(asp) * nz + Math.sin(asp) * ez;
      const cs = Math.cos(s), sn = aspect[k] === 65535 ? 0 : Math.sin(s);
      t.normal.set([ux * cs + dx * sn, uy * cs + dy * sn, uz * cs + dz * sn], k3);
      const r = (R_MOON + height[k] + MAST_H) / 1000;
      t.site.set([ux * r, uy * r, uz * r], k3);
      t.slope[k] = slope[k] / 100;
      t.prominence[k] = prom[k];
      t.annualSun[k] = aSun[k] / 65535;
      t.annualEarth[k] = aEarth[k] / 65535;
      t.meanAbs[k] = mAbs[k] / 100;
    }
  }
  tiles.set(key, t);
  return childMask;
}

function discFraction(m: number, r: number): number {
  const x = Math.max(-1, Math.min(1, m / r));
  return 1 - (Math.acos(x) - x * Math.sqrt(1 - x * x)) / Math.PI;
}

/** geometry of a body (timeline vector `vi`) from sample k: margin above horizon, radius, dist,
 *  unit vector */
function geo(t: Tile, k: number, body: Float64Array, vi: number, radiusKm: number, out: Float64Array) {
  const k3 = 3 * k, b3 = 3 * vi;
  const vx = body[b3] - t.site[k3], vy = body[b3 + 1] - t.site[k3 + 1], vz = body[b3 + 2] - t.site[k3 + 2];
  const d = Math.hypot(vx, vy, vz);
  const x = vx / d, y = vy / d, z = vz / d;
  const el = Math.asin(Math.max(-1, Math.min(1, x * t.up[k3] + y * t.up[k3 + 1] + z * t.up[k3 + 2]))) / DEG;
  let az = Math.atan2(x * t.east[k3] + y * t.east[k3 + 1] + z * t.east[k3 + 2], x * t.north[k3] + y * t.north[k3 + 1] + z * t.north[k3 + 2]) / DEG;
  if (az < 0) az += 360;
  const fb = az / (360 / t.naz);
  const i0 = Math.floor(fb) % t.naz, i1 = (i0 + 1) % t.naz, w = fb - Math.floor(fb);
  const row = k * t.naz;
  const hz = (t.horizon[row + i0] * (1 - w) + t.horizon[row + i1] * w) / 4;
  out[0] = el - hz;
  out[1] = Math.asin(radiusKm / d) / DEG;
  out[2] = d;
  out[3] = x; out[4] = y; out[5] = z;
}

/** Search for the first crossing. The highest terrain bin bounds every azimuth.
 * The dot product with local up changes by at most the block's maximum chord length.
 * Near the bound, evaluate the original topocentric geometry and interpolate as before. */
function hoursRemaining(t: Tile, k: number, body: Float64Array, radiusKm: number, m0: number,
  tl: number, B: Bounds, g: Float64Array): number {
  let prev = m0, prevS = 0;
  const top = t.hzMax[k] - tl + B.parallax + SAFE;
  const limit = Math.sin(Math.max(-90, Math.min(90, top)) * DEG) + 1e-12;
  for (let s = 1; s <= FWD_STEPS; s++) {
    const sine = sineElevation(B, s, t.up, k * 3);
    if (sine > limit) {
      const block = (s - 1) / BLOCK;
      if (Number.isInteger(block) && sine - B.blockRadius[block] > limit) s += BLOCK - 1;
      continue;
    }
    geo(t, k, body, s, radiusKm, g);
    if (g[0] + tl <= 0) {
      const m = g[0] + tl;
      if (prevS !== s - 1) {
        geo(t, k, body, s - 1, radiusKm, g);
        prev = g[0] + tl;
      }
      return STEP_H * (s - 1 + prev / (prev - m));
    }
    prev = g[0] + tl;
    prevS = s;
  }
  return STEP_H * FWD_STEPS;
}

function compute(t: Tile, sun: Float64Array, earth: Float64Array, sunB: Bounds, earthB: Bounds): Uint8Array {
  const out = new Uint8Array(t.n);
  const g = new Float64Array(6);
  for (let k = 0; k < t.n; k++) {
    const k3 = 3 * k;
    if ((slopeLimits.knockoutAbove !== undefined && t.slope[k] > slopeLimits.knockoutAbove) ||
        (slopeLimits.knockoutBelow !== undefined && t.slope[k] < slopeLimits.knockoutBelow)) {
      out[k] = Math.round(2.55);
      continue;
    }
    // Sun now
    geo(t, k, sun, 0, R_SUN_KM, g);
    // vf: physical (drives the temperature); sm / svf: with the tolerance (drive the Power score)
    const sm = g[0] + tol, vf = discFraction(g[0], g[1]), svf = discFraction(sm, g[1]);
    const ci = g[3] * t.normal[k3] + g[4] * t.normal[k3 + 1] + g[5] * t.normal[k3 + 2];
    const flux = 1361 * (AU_KM / g[2]) ** 2;
    const sunH = sm > 0 ? hoursRemaining(t, k, sun, R_SUN_KM, sm, tol, sunB, g) : 0;
    // Earth now
    geo(t, k, earth, 0, R_EARTH_KM, g);
    const em = g[0] + tol, evf = discFraction(em, g[1]);
    const earthH = em > 0 ? hoursRemaining(t, k, earth, R_EARTH_KM, em, tol, earthB, g) : 0;
    // temperature proxy (calibrated against the 1-D model, see README)
    const tDeep = Math.max(20, 0.86 * Math.pow(t.meanAbs[k] / (EMISSIVITY * SIGMA), 0.25));
    const floor = Math.max(20, 0.4 * tDeep), tSet = Math.max(floor, 0.6 * tDeep);
    let temp: number;
    if (vf > 0 && ci > 0) {
      const absorbed = (1 - albedo(Math.acos(Math.min(1, ci)) / DEG)) * flux * ci * vf;
      temp = Math.max(Math.pow(absorbed / (EMISSIVITY * SIGMA), 0.25), floor);
    } else {
      // last time any part of the Sun was up and facing the slope; skip steps where even the
      // highest possible Sun stays a full radius below the lowest horizon bin (margin <= -radius)
      let hrs = Infinity;
      const low = t.hzMin[k] - sunB.parallax - sunB.radiusMax - SAFE;
      const limit = Math.sin(Math.max(-90, Math.min(90, low)) * DEG) - 1e-12;
      for (let s = 1; s <= BACK_STEPS; s++) {
        const index = FWD_STEPS + s;
        const sine = sineElevation(sunB, index, t.up, k3);
        if (sine < limit) {
          const block = (index - 1) / BLOCK;
          if (Number.isInteger(block) && sine + sunB.blockRadius[block] < limit) s += BLOCK - 1;
          continue;
        }
        geo(t, k, sun, FWD_STEPS + s, R_SUN_KM, g);
        const c2 = g[3] * t.normal[k3] + g[4] * t.normal[k3 + 1] + g[5] * t.normal[k3 + 2];
        if (g[0] > -g[1] && c2 > 0) { hrs = s * STEP_H; break; }
      }
      temp = isFinite(hrs) ? floor + (tSet - floor) * Math.exp(-hrs / 60) : floor;
    }
    inp.sunVisibleNow = svf;
    inp.sunHoursRemaining = sunH;
    inp.annualIllumination = t.annualSun[k];
    inp.earthVisibleNow = evf;
    inp.linkMarginDeg = Math.max(0, em);
    inp.earthHoursRemaining = earthH;
    inp.annualEarthVisibility = t.annualEarth[k];
    inp.slopeDeg = t.slope[k];
    inp.temperatureK = temp;
    inp.prominenceM = t.prominence[k];
    out[k] = Math.round(score(inp) * 2.55);
  }
  return out;
}

const post = (m: FeasReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async (ev: MessageEvent<FeasMsg>) => {
  const m = ev.data;
  if (m.type === 'load') {
    try {
      const childMask = await load(m.key, m.url);
      post({ type: 'loaded', key: m.key, ok: true, childMask });
    } catch (e) {
      post({ type: 'loaded', key: m.key, ok: false, childMask: 0, error: String(e) });
    }
  } else if (m.type === 'timeline') {
    timeline = { token: m.token, sun: m.sun, earth: m.earth, sunB: bounds(m.sun, R_SUN_KM), earthB: bounds(m.earth, R_EARTH_KM) };
  } else if (m.type === 'config') {
    slopeLimits = m.config.factors.landing.slopeDeg;
    score = feasibilityScorer(m.config);
    tol = m.config.horizonToleranceDeg;
  } else if (m.type === 'drop') {
    tiles.delete(m.key);
  } else if (m.type === 'compute') {
    const t = tiles.get(m.key);
    if (!t || !timeline || timeline.token !== m.token) return post({ type: 'scores', key: m.key, token: -1, scores: new Uint8Array(0) });
    const scores = compute(t, timeline.sun, timeline.earth, timeline.sunB, timeline.earthB);
    post({ type: 'scores', key: m.key, token: m.token, scores }, [scores.buffer]);
  }
};
