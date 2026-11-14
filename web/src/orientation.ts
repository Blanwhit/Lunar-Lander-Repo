import { Matrix3 } from 'three';

// Orientation of the lunar body frame (ME/PA, used by all LOLA/SLDEM products)
// relative to the J2000/ICRF equatorial frame in which the star map is defined.
//
// Static approximation (this stage): IAU WGCCRE 2015 Moon model evaluated at the
// J2000 epoch, without the periodic terms:
//   alpha0 = 269.9949 deg, delta0 = 66.5392 deg, W = 38.3213 deg
// R_body->J2000 = Rz(alpha0 + 90) * Rx(90 - delta0) * Rz(W)
//
// The IAU frame is a "mean axis" frame; the difference to ME/PA (~0.02 deg) is far
// below what the star background can show.
//
// HOOK: replace `moonOrientation` with a time-dependent provider, e.g. evaluate the
// full IAU series for `date`, or fetch the Moon's ME/PA attitude from JPL Horizons /
// SPICE (moon_pa_de440 + moon_080317.tf) and interpolate. Everything downstream only
// consumes the returned matrix.

const DEG = Math.PI / 180;

function rz(a: number): Matrix3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return new Matrix3().set(c, -s, 0, s, c, 0, 0, 0, 1);
}
function rx(a: number): Matrix3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return new Matrix3().set(1, 0, 0, 0, c, -s, 0, s, c);
}

export interface OrientationProvider {
  /** rotation matrix mapping body-frame vectors to J2000 vectors */
  bodyToJ2000(date: Date): Matrix3;
}

export const staticIauOrientation: OrientationProvider = {
  bodyToJ2000(_date: Date) {
    const alpha0 = 269.9949 * DEG;
    const delta0 = 66.5392 * DEG;
    const W = 38.3213 * DEG;
    return rz(alpha0 + Math.PI / 2)
      .multiply(rx(Math.PI / 2 - delta0))
      .multiply(rz(W));
  },
};

export let moonOrientation: OrientationProvider = staticIauOrientation;
export function setOrientationProvider(p: OrientationProvider) {
  moonOrientation = p;
}
