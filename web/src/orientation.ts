import { Matrix3 } from 'three';
import { jdTdb } from './time';

// Orientation of the lunar body frame (ME/PA-compatible, used by all LOLA/SLDEM products)
// relative to the ICRF/J2000 frame of the star map and of the JPL Horizons ephemeris.
//
// Default: the full time-dependent IAU WGCCRE 2015 Moon model (Archinal et al. 2018,
// Celest. Mech. Dyn. Astr. 130:22), incl. the 13 periodic E-terms (physical librations).
//   R_body->ICRF = Rz(alpha0 + 90) * Rx(90 - delta0) * Rz(W)
// Validated against JPL Horizons sub-Earth points on the Moon: mean 0.45', max 0.76'
// over 2026 (pipeline/ephemeris.py --validate).
//
// HOOK: setOrientationProvider() can swap in e.g. SPICE moon_pa_de440 attitude.

const DEG = Math.PI / 180;

function rz(a: number): Matrix3 {
  const c = Math.cos(a), s = Math.sin(a);
  return new Matrix3().set(c, -s, 0, s, c, 0, 0, 0, 1);
}
function rx(a: number): Matrix3 {
  const c = Math.cos(a), s = Math.sin(a);
  return new Matrix3().set(1, 0, 0, 0, c, -s, 0, s, c);
}

export interface OrientationProvider {
  /** rotation matrix mapping body-frame vectors to ICRF (J2000) vectors at a UTC time */
  bodyToJ2000(date: Date): Matrix3;
}

/** IAU 2015 Moon model, angles in degrees, for TDB Julian date */
export function iauMoonAngles(jd: number): { a0: number; d0: number; W: number } {
  const d = jd - 2451545.0;
  const T = d / 36525;
  const E = [
    125.045 - 0.0529921 * d, 250.089 - 0.1059842 * d, 260.008 + 13.0120009 * d,
    176.625 + 13.3407154 * d, 357.529 + 0.9856003 * d, 311.589 + 26.4057084 * d,
    134.963 + 13.064993 * d, 276.617 + 0.3287146 * d, 34.226 + 1.7484877 * d,
    15.134 - 0.1589763 * d, 119.743 + 0.0036096 * d, 239.961 + 0.1643573 * d,
    25.053 + 12.9590088 * d,
  ].map((x) => x * DEG);
  const s = E.map(Math.sin), c = E.map(Math.cos);
  const a0 = 269.9949 + 0.0031 * T - 3.8787 * s[0] - 0.1204 * s[1] + 0.07 * s[2] - 0.0172 * s[3]
    + 0.0072 * s[5] - 0.0052 * s[9] + 0.0043 * s[12];
  const d0 = 66.5392 + 0.013 * T + 1.5419 * c[0] + 0.0239 * c[1] - 0.0278 * c[2] + 0.0068 * c[3]
    - 0.0029 * c[5] + 0.0009 * c[6] + 0.0008 * c[9] - 0.0009 * c[12];
  const W = 38.3213 + 13.17635815 * d - 1.4e-12 * d * d + 3.561 * s[0] + 0.1208 * s[1] - 0.0642 * s[2]
    + 0.0158 * s[3] + 0.0252 * s[4] - 0.0066 * s[5] - 0.0047 * s[6] - 0.0046 * s[7]
    + 0.0028 * s[8] + 0.0052 * s[9] + 0.004 * s[10] + 0.0019 * s[11] - 0.0044 * s[12];
  return { a0, d0, W };
}

export const iauOrientation: OrientationProvider = {
  bodyToJ2000(date: Date) {
    const { a0, d0, W } = iauMoonAngles(jdTdb(date.getTime()));
    return rz(a0 * DEG + Math.PI / 2).multiply(rx(Math.PI / 2 - d0 * DEG)).multiply(rz(W * DEG));
  },
};

export let moonOrientation: OrientationProvider = iauOrientation;
export function setOrientationProvider(p: OrientationProvider) {
  moonOrientation = p;
}
