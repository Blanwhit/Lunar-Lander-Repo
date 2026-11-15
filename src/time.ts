// Time scales. The UI works in UTC; JPL Horizons states and the IAU rotation model use
// TDB. TDB - UTC = (TAI - UTC) + 32.184 s (the periodic TDB-TT term, < 2 ms, is ignored).

const JD_UNIX_EPOCH = 2440587.5;

// TAI - UTC leap-second table (valid from the given UTC instant)
const LEAP: [number, number][] = [
  [Date.UTC(1999, 0, 1), 32],
  [Date.UTC(2006, 0, 1), 33],
  [Date.UTC(2009, 0, 1), 34],
  [Date.UTC(2012, 6, 1), 35],
  [Date.UTC(2015, 6, 1), 36],
  [Date.UTC(2017, 0, 1), 37],
];

export function taiMinusUtc(ms: number): number {
  let v = LEAP[0][1];
  for (const [t, s] of LEAP) if (ms >= t) v = s;
  return v;
}

/** Julian date (UTC) of a JS timestamp */
export function jdUtc(ms: number): number {
  return ms / 86400000 + JD_UNIX_EPOCH;
}

/** Julian date (TDB) of a JS (UTC) timestamp */
export function jdTdb(ms: number): number {
  return jdUtc(ms) + (taiMinusUtc(ms) + 32.184) / 86400;
}

/** Greenwich mean sidereal time (rad), IAU 1982 linear form, UT1 ~ UTC */
export function gmst(ms: number): number {
  const d = jdUtc(ms) - 2451545.0;
  const deg = 280.46061837 + 360.98564736629 * d;
  return (((deg % 360) + 360) % 360) * (Math.PI / 180);
}
