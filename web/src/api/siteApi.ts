// Site API: given a point on the Moon and a UTC date/time, report Earth connectivity,
// power (solar) availability, surface temperature, elevation, slope and the time until the
// next Earthrise / Earthset -- all accounting for the surrounding terrain.
//
//   import { createSiteApi } from './api/siteApi';
//   const api = createSiteApi({ baseUrl: '/' });             // folder that holds tiles/, ephem/
//   const r = await api.query({ lat: -89.45, lon: 222.7, time: '2026-03-01T12:00Z' });
//
// Data (same as the viewer):
//   * terrain   : height-tile pyramid (SLDEM2015 + LOLA, up to 5 m/px near the south pole)
//   * Sun/Earth : JPL Horizons, Moon-centred, light-time corrected (web/public/ephem)
//   * rotation  : IAU WGCCRE 2015 Moon model (web/src/orientation.ts)
//
// Terrain: every query first builds a 360-azimuth horizon profile by ray-marching the
// tile pyramid outward from the observer (finer tiles near, coarser far, stopping once no
// lunar terrain could still rise above the horizon found so far). Sun and Earth visibility
// are the fraction of their discs above that terrain horizon, so a point inside a crater
// correctly gets no Sun / no Earth when the rim blocks them.
//
// Conventions: latitude planetocentric, longitude east-positive (ME/PA frame, same as LOLA);
// heights in metres relative to the 1737.4 km reference sphere; azimuth in degrees clockwise
// from north; elevation in degrees above the local horizontal plane (normal to the sphere).
import { Matrix3, Vector3 } from 'three';
import { Ephemeris } from '../ephemeris';
import { R_MOON, latLonToDir, texelSize, type Vec3 } from '../geom';
import { moonOrientation, type OrientationProvider } from '../orientation';
import { TileTerrain } from './terrain';
import { albedo, simulateRegolith } from './thermal';
import { DEFAULT_FEASIBILITY, feasibility, type FeasibilityConfig, type FeasibilityInputs, type FeasibilityResult } from './feasibility';

// ------------------------------------------------------------------------------- interface
export interface SiteQuery {
  lat: number; // degrees, -90..90
  lon: number; // degrees east (any range)
  time: Date | number | string; // UTC (Date, ms since epoch, or ISO-8601 string)
  /** height of the receiver / panel above the ground (m); default 2 */
  observerHeightM?: number;
  /** minimum elevation above the terrain horizon for a usable Earth link (deg); default 0 */
  linkMaskDeg?: number;
  /** how far ahead (and back) to search for rise/set events (days); default 30 */
  searchDays?: number;
}

export interface BodyGeometry {
  azimuthDeg: number;
  elevationDeg: number; // above the local horizontal plane
  horizonElevationDeg: number; // terrain horizon in that azimuth
  marginDeg: number; // elevation - horizon (centre of the disc)
  angularRadiusDeg: number;
  visibleFraction: number; // fraction of the disc above the terrain horizon (0..1)
  distanceKm: number;
}

export interface SiteReport {
  query: { lat: number; lon: number; timeUtc: string; observerHeightM: number };

  elevation: {
    heightM: number; // terrain height vs the 1737.4 km sphere
    radiusM: number; // distance from the Moon's centre
    dataResolutionM: number; // grid spacing of the tile level used
  };

  slope: {
    slopeDeg: number;
    aspectDeg: number | null; // downslope direction, clockwise from north (null when flat)
    baselineM: number; // horizontal distance over which the gradient was taken
  };

  earth: BodyGeometry & { oneWayLightTimeS: number };

  earthConnectivity: {
    status: 'clear' | 'partial' | 'blocked'; // whole disc / part / none above horizon + mask
    lineOfSight: boolean; // Earth's centre is above the terrain horizon + mask
    marginDeg: number; // Earth-centre elevation above (horizon + mask)
    visibleFraction: number;
    maskDeg: number;
  };

  earthEvents: {
    visibleNow: boolean; // = earthConnectivity.lineOfSight
    nextEarthrise: string | null; // ISO UTC, null if none within the search window
    nextEarthset: string | null;
    minutesUntilEarthrise: number | null;
    minutesUntilEarthset: number | null;
    searchDays: number;
  };

  sun: BodyGeometry;

  power: {
    status: 'sunlit' | 'partial' | 'shadow';
    sunVisibleFraction: number;
    solarConstantWm2: number; // solar flux at the Moon's current distance from the Sun
    irradianceWm2: {
      tracking: number; // panel always facing the Sun
      horizontal: number; // flat panel
      terrain: number; // on the local ground slope (what the regolith receives)
    };
    nextSunrise: string | null; // centre of the Sun crossing the terrain horizon
    nextSunset: string | null;
    minutesUntilSunrise: number | null;
    minutesUntilSunset: number | null;
    /** illumination statistics for the next 365 days (6-hour samples) */
    illuminationNextYear: {
      meanDiscFraction: number; // time-average of the visible fraction of the solar disc
      anyPartFraction: number; // fraction of time any part of the Sun is above the terrain
      centreFraction: number; // fraction of time the Sun's centre is above the terrain
    };
  };

  temperature: {
    surfaceK: number;
    surfaceC: number;
    /** ~0.5 m below the surface (close to the long-term mean); null if the model has none */
    subsurfaceK: number | null;
    regime: 'sunlit' | 'shadow' | 'night' | 'permanent-shadow';
    hoursSinceSunlight: number | null; // null while sunlit or if not within the history window
    uncertaintyK: number;
    method: string;
  };

  /** 0-100 % landing-site feasibility (see feasibility.ts and README) */
  feasibility: FeasibilityResult & { inputs: FeasibilityInputs; referenceYear: number };

  meta: {
    horizonAzimuthStepDeg: number;
    horizonMaxDistanceKm: number;
    tilesLoaded: number;
    computeMs: number;
    sources: string[];
  };
}

export interface HorizonProfile {
  lat: number;
  lon: number;
  observerHeightM: number;
  azimuthStepDeg: number;
  /** terrain horizon elevation (deg) for azimuth i * azimuthStepDeg */
  elevationDeg: Float32Array;
  maxDistanceKm: number;
}

export interface TemperatureInput {
  latDeg: number;
  sunVisibleFraction: number; // now
  cosIncidence: number; // now: Sun direction . terrain normal (<= 0 when facing away)
  solarFluxWm2: number; // now
  /** absorbed solar flux on the local ground facet, oldest first, ending at the query time */
  absorbedHistoryWm2: Float64Array;
  historyStepS: number;
  hoursSinceSunlight: number | null;
  anyPartFractionYear: number;
}

export interface TemperatureModel {
  estimate(i: TemperatureInput): SiteReport['temperature'];
}

export interface SiteApi {
  query(q: SiteQuery): Promise<SiteReport>;
  horizon(lat: number, lon: number, observerHeightM?: number): Promise<HorizonProfile>;
}

export interface SiteApiOptions {
  /** base URL of the static site (the folder containing tiles/ and ephem/) */
  baseUrl: string;
  fetch?: typeof fetch;
  orientation?: OrientationProvider;
  temperatureModel?: TemperatureModel;
  /** horizon azimuth resolution (deg); default 1 */
  azimuthStepDeg?: number;
  feasibilityConfig?: FeasibilityConfig;
}

/** fixed window for the "annual" feasibility statistics (shared with the overlay pipeline) */
export const FEAS_REF_YEAR = 2026;
/** radius of the ring used for local prominence (m) */
export const PROMINENCE_RING_M = 3000;

// --------------------------------------------------------------------- temperature model
/**
 * Default temperature model: 1-D regolith heat conduction with Diviner-calibrated
 * properties (Hayne et al. 2017; see thermal.ts), driven by the absorbed-flux history of
 * the site over the preceding ~3 lunations (terrain shadowing, slope and incidence-dependent
 * albedo included). Scattered light and thermal IR from surrounding terrain are not
 * modelled, so shadowed crater interiors are lower bounds.
 */
export const thermophysicalModel: TemperatureModel = {
  estimate(t) {
    const r = simulateRegolith(t.absorbedHistoryWm2, t.historyStepS);
    let lit = false;
    for (let i = 0; i < t.absorbedHistoryWm2.length && !lit; i++) lit = t.absorbedHistoryWm2[i] > 0;
    const regime: SiteReport['temperature']['regime'] =
      t.sunVisibleFraction > 0 && t.cosIncidence > 0 ? 'sunlit'
        : !lit && t.anyPartFractionYear === 0 ? 'permanent-shadow'
          : t.sunVisibleFraction > 0 ? 'shadow' : 'night';
    const hrs = t.hoursSinceSunlight;
    return {
      surfaceK: Math.round(r.surfaceK * 10) / 10,
      surfaceC: Math.round((r.surfaceK - 273.15) * 10) / 10,
      subsurfaceK: Math.round(r.deepK * 10) / 10,
      regime,
      hoursSinceSunlight: hrs === null || !isFinite(hrs) ? null : Math.round(hrs * 10) / 10,
      uncertaintyK: regime === 'sunlit' ? 15 : regime === 'permanent-shadow' ? 30 : 20,
      method: '1-D regolith heat conduction (Hayne et al. 2017 Diviner-calibrated properties), driven by terrain-shadowed insolation over the last ~3 lunations; no scattered/IR heating from surrounding terrain',
    };
  },
};

// ------------------------------------------------------------------------- implementation
const DEG = Math.PI / 180;
const R_SUN_KM = 695700;
const R_EARTH_KM = 6371;
const AU_KM = 149597870.7;
const SOLAR_CONSTANT_1AU = 1361; // W/m^2
const H_MAX = 10800; // highest lunar terrain (m vs 1737.4 km)
const C_KM_S = 299792.458;

const toMs = (t: Date | number | string) => (t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t));
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString().replace('.000Z', 'Z'));

/** fraction of a disc (angular radius r) above a straight horizon with the centre at margin m */
export function discFractionAbove(m: number, r: number): number {
  if (r <= 0) return m > 0 ? 1 : 0;
  const x = Math.max(-1, Math.min(1, m / r));
  return 1 - (Math.acos(x) - x * Math.sqrt(1 - x * x)) / Math.PI;
}

interface Frame {
  up: Vector3;
  east: Vector3;
  north: Vector3;
}

function localFrame(lat: number, lon: number): Frame {
  const up = new Vector3(...latLonToDir(lat, lon));
  const east = new Vector3(0, 0, 1).cross(up);
  if (east.lengthSq() < 1e-12) east.set(0, 1, 0); // exactly at a pole: azimuth 0 = towards lon 180/0
  east.normalize();
  const north = up.clone().cross(east).normalize();
  return { up, east, north };
}

export function createSiteApi(opts: SiteApiOptions): SiteApi {
  const base = opts.baseUrl.endsWith('/') ? opts.baseUrl : opts.baseUrl + '/';
  const fetchImpl = opts.fetch ?? fetch.bind(globalThis);
  const terrain = new TileTerrain(base + 'tiles/', fetchImpl);
  const ephem = new Ephemeris(base + 'ephem/', fetchImpl);
  const orientation = opts.orientation ?? moonOrientation;
  const thermal = opts.temperatureModel ?? thermophysicalModel;
  const azStep = opts.azimuthStepDeg ?? 1;
  let ephemReady: Promise<void> | null = null;
  const horizonCache = new Map<string, Promise<HorizonProfile>>();
  const refYearCache = new Map<string, { sun: number; earth: number; n: number }>();

  const initEphem = () => (ephemReady ??= ephem.init());

  // ---- terrain helpers ----------------------------------------------------------------
  const dirAt = (f: Frame, azDeg: number, distM: number): Vec3 => {
    const th = distM / R_MOON, a = azDeg * DEG;
    const c = Math.cos(th), s = Math.sin(th);
    const hx = Math.cos(a) * f.north.x + Math.sin(a) * f.east.x;
    const hy = Math.cos(a) * f.north.y + Math.sin(a) * f.east.y;
    const hz = Math.cos(a) * f.north.z + Math.sin(a) * f.east.z;
    return [f.up.x * c + hx * s, f.up.y * c + hy * s, f.up.z * c + hz * s];
  };

  const siteHeight = async (lat: number, lon: number) =>
    terrain.until(() => terrain.sample(latLonToDir(lat, lon), 99));

  async function horizon(lat: number, lon: number, observerHeightM = 2): Promise<HorizonProfile> {
    const k = `${lat.toFixed(7)},${lon.toFixed(7)},${observerHeightM}`;
    let p = horizonCache.get(k);
    if (!p) {
      p = computeHorizon(lat, lon, observerHeightM);
      horizonCache.set(k, p);
      p.catch(() => horizonCache.delete(k));
    }
    return p;
  }

  async function computeHorizon(lat: number, lon: number, hObs: number): Promise<HorizonProfile> {
    const f = localFrame(lat, lon);
    const site = await siteHeight(lat, lon);
    const r0 = R_MOON + site.h + hObs;
    const rTop = R_MOON + H_MAX;
    const n = Math.round(360 / azStep);
    const elev = new Float32Array(n);
    let maxDist = 0;
    const d0 = Math.max(2, texelSize(site.level) * 0.5);
    const ANG = 0.0026; // target angular resolution of the terrain grid (~0.15 deg)
    await terrain.until(() => {
      maxDist = 0;
      for (let i = 0; i < n; i++) {
        const az = i * azStep;
        // elevation atan2(r1 cos th - r0, r1 sin th) with r1 sin th > 0 is monotonic in the
        // tangent (r1 cos th - r0) / (r1 sin th): compare tangents, one atan at the end
        let best = -Infinity;
        let d = d0;
        while (d < 800e3) {
          const th = d / R_MOON;
          const c = Math.cos(th), s = Math.sin(th);
          // nothing on the Moon is higher than H_MAX: stop when even that would be lower
          if ((rTop * c - r0) / (rTop * s) < best) break;
          const cellMax = Math.max(d * ANG, 1);
          const L = Math.max(0, Math.ceil(Math.log2(texelSize(0) / cellMax)));
          const smp = terrain.sample(dirAt(f, az, d), L);
          if (!isNaN(smp.h)) {
            const r1 = R_MOON + smp.h;
            const e = (r1 * c - r0) / (r1 * s);
            if (e > best) best = e;
          }
          d += Math.max(0.75 * texelSize(Math.max(smp.level, 0)), d * 0.01);
        }
        elev[i] = Math.atan(best) / DEG;
        if (d > maxDist) maxDist = d;
      }
      return 0;
    });
    return { lat, lon, observerHeightM: hObs, azimuthStepDeg: azStep, elevationDeg: elev, maxDistanceKm: maxDist / 1000 };
  }

  const horizonAt = (hp: HorizonProfile, azDeg: number) => {
    const n = hp.elevationDeg.length;
    const x = (((azDeg % 360) + 360) % 360) / hp.azimuthStepDeg;
    const i = Math.floor(x) % n, j = (i + 1) % n, t = x - Math.floor(x);
    return hp.elevationDeg[i] * (1 - t) + hp.elevationDeg[j] * t;
  };

  // ---- ephemeris helpers ---------------------------------------------------------------
  const clampT = (ms: number) => {
    const [a, b] = ephem.range();
    return Math.min(b, Math.max(a, ms));
  };

  /** Sun and Earth positions relative to the site (body frame, km) */
  async function bodiesFrom(ms: number, sitePosKm: Vector3) {
    const st = await ephem.at(ms);
    const m: Matrix3 = orientation.bodyToJ2000(new Date(ms)).transpose();
    const sun = new Vector3(...st.sun).applyMatrix3(m).sub(sitePosKm);
    const earth = new Vector3(...st.earth).applyMatrix3(m).sub(sitePosKm);
    return { sun, earth };
  }

  function geometry(v: Vector3, radiusKm: number, f: Frame, hp: HorizonProfile): BodyGeometry {
    const dist = v.length();
    const u = v.clone().divideScalar(dist);
    const el = Math.asin(Math.max(-1, Math.min(1, u.dot(f.up)))) / DEG;
    let az = Math.atan2(u.dot(f.east), u.dot(f.north)) / DEG;
    if (az < 0) az += 360;
    const hz = horizonAt(hp, az);
    const rad = Math.asin(radiusKm / dist) / DEG;
    return {
      azimuthDeg: az,
      elevationDeg: el,
      horizonElevationDeg: hz,
      marginDeg: el - hz,
      angularRadiusDeg: rad,
      visibleFraction: discFractionAbove(el - hz, rad),
      distanceKm: dist,
    };
  }

  /**
   * First time within (t0, t0 + dir * days] at which g changes sign relative to g(t0);
   * coarse scan + bisection to ~30 s. Returns null when nothing is found.
   */
  async function findCrossing(g: (ms: number) => Promise<number>, t0: number, days: number, dir: 1 | -1, stepMin = 20) {
    const end = clampT(t0 + dir * days * 86400e3);
    const s0 = Math.sign(await g(t0)) || 1;
    let a = t0;
    for (let t = t0 + dir * stepMin * 60e3; dir > 0 ? t <= end : t >= end; t += dir * stepMin * 60e3) {
      if ((Math.sign(await g(t)) || 1) !== s0) {
        let lo = a, hi = t;
        for (let k = 0; k < 12; k++) {
          const mid = (lo + hi) / 2;
          if ((Math.sign(await g(mid)) || 1) === s0) lo = mid;
          else hi = mid;
        }
        return Math.round(hi / 1000) * 1000;
      }
      a = t;
    }
    return null;
  }

  // ---- the query ------------------------------------------------------------------------
  async function query(q: SiteQuery): Promise<SiteReport> {
    const t0 = performance.now();
    await initEphem();
    const ms = clampT(Math.floor(toMs(q.time) / 1000) * 1000);
    if (!Number.isFinite(ms)) throw new Error('invalid time');
    const lat = Math.max(-90, Math.min(90, q.lat));
    const lon = q.lon;
    const hObs = q.observerHeightM ?? 2;
    const mask = q.linkMaskDeg ?? 0;
    const days = q.searchDays ?? 30;
    const f = localFrame(lat, lon);

    // elevation + slope (finest available tile)
    const site = await siteHeight(lat, lon);
    const cell = texelSize(site.level);
    const b = 2 * cell;
    const hs = await terrain.until(() => [0, 90, 180, 270].map((az) => terrain.sample(dirAt(f, az, b), site.level).h));
    const dzdn = (hs[0] - hs[2]) / (2 * b);
    const dzde = (hs[1] - hs[3]) / (2 * b);
    const grad = Math.hypot(dzdn, dzde);
    const slopeDeg = Math.atan(grad) / DEG;
    let aspect: number | null = (Math.atan2(-dzde, -dzdn) / DEG + 360) % 360;
    if (slopeDeg < 0.05) aspect = null;
    const normal = f.up.clone().addScaledVector(f.east, -dzde).addScaledVector(f.north, -dzdn).normalize();
    // local prominence: height above the mean of 8 points on a 3 km ring
    const ring = await terrain.until(() =>
      [0, 45, 90, 135, 180, 225, 270, 315].map((az) => terrain.sample(dirAt(f, az, PROMINENCE_RING_M), site.level).h));
    const prominence = site.h - ring.reduce((a, b2) => a + b2, 0) / ring.length;

    // horizon + bodies
    const hp = await horizon(lat, lon, hObs);
    const siteKm = f.up.clone().multiplyScalar((R_MOON + site.h + hObs) / 1000);
    const geo = async (t: number) => {
      const bodies = await bodiesFrom(t, siteKm);
      return { sun: geometry(bodies.sun, R_SUN_KM, f, hp), earth: geometry(bodies.earth, R_EARTH_KM, f, hp), raw: bodies };
    };
    // one body only (the rise/set searches evaluate thousands of times)
    const sunGeo = async (t: number) => geometry((await bodiesFrom(t, siteKm)).sun, R_SUN_KM, f, hp);
    const earthGeo = async (t: number) => geometry((await bodiesFrom(t, siteKm)).earth, R_EARTH_KM, f, hp);
    const now = await geo(ms);
    const { sun, earth } = now;

    // Earth link + events (centre above terrain horizon + mask)
    const earthMargin = async (t: number) => (await earthGeo(t)).marginDeg - mask;
    const visibleNow = earth.marginDeg - mask > 0;
    const nextEarthEvent = await findCrossing(earthMargin, ms, days, 1);
    const earthFrac = discFractionAbove(earth.marginDeg - mask, earth.angularRadiusDeg);
    const nextRise = !visibleNow ? nextEarthEvent : null;
    const nextSet = visibleNow ? nextEarthEvent : null;
    // also report the event after next (e.g. the rise following a set) for convenience
    let followRise: number | null = null, followSet: number | null = null;
    if (nextEarthEvent !== null) {
      const after = await findCrossing(earthMargin, nextEarthEvent + 60e3, Math.max(0, days - (nextEarthEvent - ms) / 86400e3), 1);
      if (visibleNow) followRise = after;
      else followSet = after;
    }
    const mins = (t: number | null) => (t === null ? null : Math.round((t - ms) / 6e3) / 10);
    const earthRise = nextRise ?? followRise, earthSet = nextSet ?? followSet;
    const earthSetT = nextSet;

    // power
    const sunMargin = async (t: number) => (await sunGeo(t)).marginDeg;
    const sunUp = sun.marginDeg > 0;
    const nextSunEvent = await findCrossing(sunMargin, ms, days, 1);
    let sunRise = !sunUp ? nextSunEvent : null, sunSet = sunUp ? nextSunEvent : null;
    if (nextSunEvent !== null) {
      const after = await findCrossing(sunMargin, nextSunEvent + 60e3, Math.max(0, days - (nextSunEvent - ms) / 86400e3), 1);
      if (sunUp) sunRise = after;
      else sunSet = after;
    }
    const sunDist = now.raw.sun.length();
    const flux = SOLAR_CONSTANT_1AU * (AU_KM / sunDist) ** 2;
    const sunDir = now.raw.sun.clone().normalize();
    const vf = sun.visibleFraction;
    const tracking = flux * vf;
    const horizontal = flux * vf * Math.max(0, sunDir.dot(f.up));
    const cosInc = sunDir.dot(normal);
    const onTerrain = flux * vf * Math.max(0, cosInc);

    // illumination over the next year (6 h samples)
    let anyPart = 0, centre = 0, meanFrac = 0, total = 0;
    for (let t = ms; t < clampT(ms + 365 * 86400e3); t += 6 * 3600e3) {
      const g = await sunGeo(t);
      total++;
      meanFrac += g.visibleFraction;
      if (g.visibleFraction > 0) anyPart++;
      if (g.marginDeg > 0) centre++;
    }
    const illum = {
      meanDiscFraction: total ? meanFrac / total : 0,
      anyPartFraction: total ? anyPart / total : 0,
      centreFraction: total ? centre / total : 0,
    };

    // feasibility "annual" statistics over the fixed reference year (6 h samples); they don't
    // depend on the query time, so they are cached per site like the horizon
    const refKey = `${lat.toFixed(7)},${lon.toFixed(7)},${hObs},${mask}`;
    let ref = refYearCache.get(refKey);
    if (!ref) {
      let s = 0, e = 0, n = 0;
      for (let t = Date.UTC(FEAS_REF_YEAR, 0, 1); t < Date.UTC(FEAS_REF_YEAR + 1, 0, 1); t += 6 * 3600e3) {
        const g = await geo(t);
        n++;
        s += g.sun.visibleFraction;
        if (g.earth.marginDeg - mask > 0) e++;
      }
      ref = { sun: s, earth: e, n };
      refYearCache.set(refKey, ref);
    }
    const { sun: refSun, earth: refEarth, n: refN } = ref;

    // absorbed-flux history on the local ground facet (30 min steps, ~3 lunations back)
    const HIST_STEP = 1800, HIST_DAYS = 88.6;
    const t0h = clampT(ms - HIST_DAYS * 86400e3);
    const nh = Math.max(2, Math.round((ms - t0h) / (HIST_STEP * 1000)) + 1);
    const hist = new Float64Array(nh);
    let lastLit: number | null = null;
    for (let k = 0; k < nh; k++) {
      const t = ms - (nh - 1 - k) * HIST_STEP * 1000;
      const g = await geo(t);
      const sd = g.raw.sun.clone().normalize();
      const ci = sd.dot(normal);
      const fluxT = SOLAR_CONSTANT_1AU * (AU_KM / g.raw.sun.length()) ** 2;
      if (ci > 0 && g.sun.visibleFraction > 0) {
        const iDeg = Math.acos(Math.min(1, ci)) / DEG;
        hist[k] = (1 - albedo(iDeg)) * fluxT * ci * g.sun.visibleFraction;
        lastLit = t;
      }
    }
    const lit = vf > 0 && cosInc > 0;
    const hoursSince = lit ? null : lastLit === null ? Infinity : (ms - lastLit) / 3600e3;
    const temperature = thermal.estimate({
      latDeg: lat,
      sunVisibleFraction: vf,
      cosIncidence: cosInc,
      solarFluxWm2: flux,
      absorbedHistoryWm2: hist,
      historyStepS: HIST_STEP,
      hoursSinceSunlight: hoursSince,
      anyPartFractionYear: illum.anyPartFraction,
    });

    const windowH = days * 24;
    const feasInputs: FeasibilityInputs = {
      sunVisibleNow: vf,
      sunHoursRemaining: sunUp ? (sunSet === null ? windowH : (sunSet - ms) / 3600e3) : 0,
      annualIllumination: refN ? refSun / refN : 0,
      earthVisibleNow: earthFrac,
      linkMarginDeg: Math.max(0, earth.marginDeg - mask),
      earthHoursRemaining: visibleNow ? (earthSetT === null ? windowH : (earthSetT - ms) / 3600e3) : 0,
      annualEarthVisibility: refN ? refEarth / refN : 0,
      slopeDeg,
      temperatureK: temperature.surfaceK,
      prominenceM: prominence,
    };
    const feas = feasibility(feasInputs, opts.feasibilityConfig ?? DEFAULT_FEASIBILITY);

    const r2 = (x: number) => Math.round(x * 100) / 100;
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    const round = (g: BodyGeometry): BodyGeometry => ({
      azimuthDeg: r2(g.azimuthDeg), elevationDeg: r3(g.elevationDeg), horizonElevationDeg: r3(g.horizonElevationDeg),
      marginDeg: r3(g.marginDeg), angularRadiusDeg: r3(g.angularRadiusDeg), visibleFraction: r3(g.visibleFraction),
      distanceKm: Math.round(g.distanceKm),
    });

    return {
      query: { lat, lon, timeUtc: iso(ms)!, observerHeightM: hObs },
      elevation: { heightM: r2(site.h), radiusM: r2(R_MOON + site.h), dataResolutionM: r2(cell) },
      slope: { slopeDeg: r2(slopeDeg), aspectDeg: aspect === null ? null : r2(aspect), baselineM: r2(b) },
      earth: { ...round(earth), oneWayLightTimeS: r3(earth.distanceKm / C_KM_S) },
      earthConnectivity: {
        status: earthFrac >= 0.999 ? 'clear' : earthFrac > 0 ? 'partial' : 'blocked',
        lineOfSight: visibleNow,
        marginDeg: r3(earth.marginDeg - mask),
        visibleFraction: r3(earthFrac),
        maskDeg: mask,
      },
      earthEvents: {
        visibleNow,
        nextEarthrise: iso(earthRise),
        nextEarthset: iso(earthSet),
        minutesUntilEarthrise: mins(earthRise),
        minutesUntilEarthset: mins(earthSet),
        searchDays: days,
      },
      sun: round(sun),
      power: {
        status: vf >= 0.999 ? 'sunlit' : vf > 0 ? 'partial' : 'shadow',
        sunVisibleFraction: r3(vf),
        solarConstantWm2: r2(flux),
        irradianceWm2: { tracking: r2(tracking), horizontal: r2(horizontal), terrain: r2(onTerrain) },
        nextSunrise: iso(sunRise),
        nextSunset: iso(sunSet),
        minutesUntilSunrise: mins(sunRise),
        minutesUntilSunset: mins(sunSet),
        illuminationNextYear: {
          meanDiscFraction: r3(illum.meanDiscFraction),
          anyPartFraction: r3(illum.anyPartFraction),
          centreFraction: r3(illum.centreFraction),
        },
      },
      temperature,
      feasibility: {
        ...feas,
        score: r2(feas.score),
        combined: r2(feas.combined),
        gate: r3(feas.gate),
        categories: { power: r2(feas.categories.power), comms: r2(feas.categories.comms), landing: r2(feas.categories.landing) },
        subScores: Object.fromEntries(Object.entries(feas.subScores).map(([k, v]) => [k, r2(v)])) as FeasibilityResult['subScores'],
        inputs: Object.fromEntries(Object.entries(feasInputs).map(([k, v]) => [k, r3(v)])) as FeasibilityInputs,
        referenceYear: FEAS_REF_YEAR,
      },
      meta: {
        horizonAzimuthStepDeg: azStep,
        horizonMaxDistanceKm: Math.round(hp.maxDistanceKm),
        tilesLoaded: terrain.tilesLoaded,
        computeMs: Math.round(performance.now() - t0),
        sources: [
          'terrain: SLDEM2015 + LOLA polar DEMs (tile pyramid)',
          'Sun/Earth: JPL Horizons (Moon-centred, light-time corrected)',
          'orientation: IAU WGCCRE 2015 Moon model',
        ],
      },
    };
  }

  return { query, horizon };
}
