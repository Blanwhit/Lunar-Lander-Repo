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
import { R_MOON, TILE_N, latLonToDir, texelSize, type Vec3 } from '../geom';
import { moonOrientation, type OrientationProvider } from '../orientation';
import { TileTerrain } from './terrain';
import { createTilePool } from './tilePool';
import { albedo, simulateRegolith, simulateRegolithSeries } from './thermal';
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
  /** abandon the query (rejects with an AbortError) between its stages */
  signal?: AbortSignal;
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
  /** category and feasibility scores over a time window (see timeSeries below) */
  timeSeries(q: SiteSeriesQuery): Promise<SiteSeries>;
}

export interface SiteSeriesQuery {
  lat: number;
  lon: number;
  start: Date | number | string; // UTC
  spanMs: number; // window length (>= 1 h)
  observerHeightM?: number;
  linkMaskDeg?: number;
  signal?: AbortSignal;
}

export interface SiteSeries {
  query: { lat: number; lon: number; startUtc: string; spanMs: number; observerHeightM: number };
  stepMs: number;
  /** sample times (ms since epoch, UTC), start .. start + span inclusive */
  times: number[];
  /** 0-100 % at each sample, as in SiteReport.feasibility */
  power: number[];
  comms: number[];
  landing: number[];
  feasibility: number[];
  temperatureK: number[];
  computeMs: number;
}

export interface SiteApiOptions {
  /** base URL of the static site (the folder containing tiles/ and ephem/) */
  baseUrl: string;
  terrainUrl?: string;
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
const HIST_DAYS = 88.6; // regolith temperature spin-up (~3 lunations)

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
  const terrain = new TileTerrain(opts.terrainUrl ?? base + 'tiles/', fetchImpl);
  // decode height tiles in parallel workers where there are any (a caller's own fetch stays in charge)
  if (!opts.fetch) terrain.loader = createTilePool(terrain.fetchLocal) ?? undefined;
  const ephem = new Ephemeris(base + 'ephem/', fetchImpl);
  const orientation = opts.orientation ?? moonOrientation;
  const thermal = opts.temperatureModel ?? thermophysicalModel;
  const azStep = opts.azimuthStepDeg ?? 1;
  let ephemReady: Promise<void> | null = null;
  const horizonCache = new Map<string, Promise<HorizonProfile>>();
  const refYearCache = new Map<string, { sun: number; earth: number; n: number }>();
  // Moon-centred Sun and Earth in the body frame (km) by timestamp. They don't depend on the
  // site, and the same times are asked for again and again: the rise/set searches of the
  // ground and of the masts step over one grid, a time series evaluates each sample from two
  // heights, and the reference year is the same at every site.
  const bodyCache = new Map<number, number[]>();
  const BODY_CACHE_MAX = 30000; // ~4 MB; the cache is simply emptied when it gets there

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

  const horizonKey = (lat: number, lon: number, h: number) => `${lat.toFixed(7)},${lon.toFixed(7)},${h}`;

  /**
   * Horizon profiles of one site from several heights above the ground (the receiver, a
   * panel mast, an antenna mast). The ones not cached yet are computed together: the rays
   * of every height march over the same terrain samples, so one scan serves them all.
   */
  function horizons(lat: number, lon: number, heights: number[]): Promise<HorizonProfile[]> {
    const todo = [...new Set(heights)].filter((h) => !horizonCache.has(horizonKey(lat, lon, h)));
    if (todo.length) {
      const scan = computeHorizons(lat, lon, todo);
      todo.forEach((h, j) => {
        const k = horizonKey(lat, lon, h);
        const p = scan.then((r) => r[j]);
        horizonCache.set(k, p);
        p.catch(() => horizonCache.delete(k));
      });
    }
    return Promise.all(heights.map((h) => horizonCache.get(horizonKey(lat, lon, h))!));
  }

  async function horizon(lat: number, lon: number, observerHeightM = 2): Promise<HorizonProfile> {
    return (await horizons(lat, lon, [observerHeightM]))[0];
  }

  async function computeHorizons(lat: number, lon: number, heights: number[]): Promise<HorizonProfile[]> {
    const f = localFrame(lat, lon);
    const { up, east, north } = f;
    const n = Math.round(360 / azStep);
    const ANG = 0.0026; // target angular resolution of the terrain grid (~0.15 deg)
    const tex0 = texelSize(0);
    /** tile level a ray reads at distance d: cells no larger than d * ANG */
    const levelAt = (d: number) => Math.max(0, Math.ceil(Math.log2(tex0 / Math.max(d * ANG, 1))));

    // Loading the tiles is most of the work, and which tiles the rays read hardly depends on
    // the terrain: at distance d a ray reads level levelAt(d), until it stops. So before
    // anything can be measured (the site's own tiles are still on their way), ask for the
    // tiles along every ray out to EARLY_M, stepping a quarter tile at a time. Rays seldom
    // stop sooner (that takes a horizon ~10 deg high all around); what lies beyond, and
    // any tile these coarse steps skipped, the scan below asks for itself.
    const EARLY_M = 60e3;
    const siteTiles = siteHeight(lat, lon); // first, so the site's chain is requested first
    for (let i = 0; i < n; i++) {
      const az = i * azStep * DEG;
      const ca = Math.cos(az), sa = Math.sin(az);
      const hx = ca * north.x + sa * east.x, hy = ca * north.y + sa * east.y, hz = ca * north.z + sa * east.z;
      for (let d = 2; d < EARLY_M;) {
        const th = d / R_MOON;
        const c = Math.cos(th), s = Math.sin(th);
        const L = levelAt(d);
        terrain.sampleAt(up.x * c + hx * s, up.y * c + hy * s, up.z * c + hz * s, L);
        d += Math.max((TILE_N / 4) * texelSize(L), d * 0.01);
      }
    }
    // a failed load is reported by the scan, which asks for the same tile again
    const earlyTiles = terrain.fetchWanted().catch(() => 0);
    const site = await siteTiles;
    await earlyTiles;

    const m = heights.length;
    const r0 = heights.map((h) => R_MOON + site.h + h);
    const rTop = R_MOON + H_MAX;
    const elev = heights.map(() => new Float32Array(n));
    const reach = heights.map(() => new Float64Array(n)); // where each ray stopped (m)
    const best = new Float64Array(m); // per height: highest tangent so far on this ray
    const open = new Uint8Array(m); // per height: the ray is still marching
    const d0 = Math.max(2, texelSize(site.level) * 0.5);
    // The scan is repeated until it misses no tile. Everything a ray did before its first
    // miss is final (those samples came from the tiles it asked for, and tiles never
    // change), so a pass saves the ray's state there and the next pass resumes from it; a
    // ray that marched to its end without a miss is done. Only the first pass is a full one.
    const done = new Uint8Array(n);
    const rayD = new Float64Array(n).fill(d0); // where the ray resumes
    const rayBest = new Float64Array(n * m).fill(-Infinity);
    const rayOpen = new Uint8Array(n * m).fill(1);
    await terrain.until(() => {
      for (let i = 0; i < n; i++) {
        if (done[i]) continue;
        // unit vector along the ray's azimuth in the local horizontal plane (as in dirAt)
        const az = i * azStep * DEG;
        const ca = Math.cos(az), sa = Math.sin(az);
        const hx = ca * north.x + sa * east.x, hy = ca * north.y + sa * east.y, hz = ca * north.z + sa * east.z;
        // elevation atan2(r1 cos th - r0, r1 sin th) with r1 sin th > 0 is monotonic in the
        // tangent (r1 cos th - r0) / (r1 sin th): compare tangents, one atan at the end
        let nOpen = 0;
        for (let j = 0; j < m; j++) {
          best[j] = rayBest[i * m + j];
          nOpen += open[j] = rayOpen[i * m + j];
        }
        let d = rayD[i];
        let clean = true; // no tile missed on this ray in this pass
        while (d < 800e3) {
          const th = d / R_MOON;
          const c = Math.cos(th), s = Math.sin(th);
          // nothing on the Moon is higher than H_MAX: a height's ray stops when even that
          // would be lower than its horizon so far
          for (let j = 0; j < m; j++) {
            if (open[j] && (rTop * c - r0[j]) / (rTop * s) < best[j]) {
              open[j] = 0;
              reach[j][i] = d;
              nOpen--;
            }
          }
          if (nOpen === 0) break;
          const L = levelAt(d);
          const misses = terrain.misses;
          const h = terrain.sampleAt(up.x * c + hx * s, up.y * c + hy * s, up.z * c + hz * s, L);
          if (clean && terrain.misses !== misses) {
            // first miss: resume here (the stops above are final, this sample is not);
            // the rest of this pass only finds out which other tiles the ray needs
            clean = false;
            rayD[i] = d;
            for (let j = 0; j < m; j++) {
              rayBest[i * m + j] = best[j];
              rayOpen[i * m + j] = open[j];
            }
          }
          if (!isNaN(h)) {
            const r1 = R_MOON + h;
            for (let j = 0; j < m; j++) {
              if (!open[j]) continue;
              const e = (r1 * c - r0[j]) / (r1 * s);
              if (e > best[j]) best[j] = e;
            }
          }
          d += Math.max(0.75 * texelSize(Math.max(terrain.hitLevel, 0)), d * 0.01);
        }
        for (let j = 0; j < m; j++) {
          if (open[j]) reach[j][i] = d; // marched to the limit
          elev[j][i] = Math.atan(best[j]) / DEG;
        }
        if (clean) done[i] = 1;
      }
      return 0;
    });
    return heights.map((h, j) => ({
      lat, lon, observerHeightM: h, azimuthStepDeg: azStep, elevationDeg: elev[j],
      maxDistanceKm: reach[j].reduce((a, b) => Math.max(a, b), 0) / 1000,
    }));
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
    let b = bodyCache.get(ms);
    if (!b) {
      const st = await ephem.at(ms);
      const m: Matrix3 = orientation.bodyToJ2000(new Date(ms)).transpose();
      const sun = new Vector3(...st.sun).applyMatrix3(m);
      const earth = new Vector3(...st.earth).applyMatrix3(m);
      b = [sun.x, sun.y, sun.z, earth.x, earth.y, earth.z];
      if (bodyCache.size >= BODY_CACHE_MAX) bodyCache.clear();
      bodyCache.set(ms, b);
    }
    return {
      sun: new Vector3(b[0], b[1], b[2]).sub(sitePosKm),
      earth: new Vector3(b[3], b[4], b[5]).sub(sitePosKm),
    };
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

  // ---- per-site setup shared by query() and timeSeries() -------------------------------
  /** terrain at the site: elevation, slope (finest tile), local prominence and horizon */
  async function prepare(lat: number, lon: number, hObs: number, check: () => void, cfg: FeasibilityConfig) {
    const f = localFrame(lat, lon);
    const ringAt = (maxLevel: number) => terrain.until(() =>
      [0, 45, 90, 135, 180, 225, 270, 315].map((az) => terrain.sample(dirAt(f, az, PROMINENCE_RING_M), maxLevel).h));
    // Loading tiles is the slow part, so every load starts now and they overlap: the site's
    // own chain and the horizon's tiles (computeHorizons; the mast heights the score needs
    // later, see atHeight, are scanned along with the query's), and the prominence ring's
    // (the site's level isn't known yet, so down to the finest there is).
    const horizonScan = horizons(lat, lon, [hObs, cfg.panelHeightM, cfg.antennaHeightM]);
    horizonScan.catch(() => {});
    const siteTiles = siteHeight(lat, lon);
    const ringTiles = ringAt(99);
    ringTiles.catch(() => {});
    const site = await siteTiles;
    check();
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
    await ringTiles;
    const ring = await ringAt(site.level);
    const prominence = site.h - ring.reduce((a, b2) => a + b2, 0) / ring.length;

    check();
    const [hp] = await horizonScan;
    check();
    const siteKm = f.up.clone().multiplyScalar((R_MOON + site.h + hObs) / 1000);
    return { f, site, cell, baseline: b, slopeDeg, aspect, normal, prominence, hp, siteKm };
  }
  type SiteCtx = Awaited<ReturnType<typeof prepare>>;

  function geoFns({ f, hp, siteKm }: SiteCtx) {
    return {
      geo: async (t: number) => {
        const bodies = await bodiesFrom(t, siteKm);
        return { sun: geometry(bodies.sun, R_SUN_KM, f, hp), earth: geometry(bodies.earth, R_EARTH_KM, f, hp), raw: bodies };
      },
      // one body only (the rise/set searches evaluate thousands of times)
      sunGeo: async (t: number) => geometry((await bodiesFrom(t, siteKm)).sun, R_SUN_KM, f, hp),
      earthGeo: async (t: number) => geometry((await bodiesFrom(t, siteKm)).earth, R_EARTH_KM, f, hp),
    };
  }
  type Geo = Awaited<ReturnType<ReturnType<typeof geoFns>['geo']>>;

  /** solar flux absorbed by the local ground facet (W/m^2) */
  function absorbedFlux(g: Geo, normal: Vector3): number {
    const ci = g.raw.sun.clone().normalize().dot(normal);
    if (!(ci > 0 && g.sun.visibleFraction > 0)) return 0;
    const fluxT = SOLAR_CONSTANT_1AU * (AU_KM / g.raw.sun.length()) ** 2;
    const iDeg = Math.acos(Math.min(1, ci)) / DEG;
    return (1 - albedo(iDeg)) * fluxT * ci * g.sun.visibleFraction;
  }

  /**
   * Feasibility "annual" statistics over the fixed reference year (6 h samples): mean visible
   * solar-disc fraction with the Sun's margin raised by `sunTol`, and the fraction of time the
   * Earth's centre is above the horizon + `earthMask`. They don't depend on the query time,
   * so they are cached per site like the horizon.
   */
  async function refYear(lat: number, lon: number, hObs: number, sunTol: number, earthMask: number,
    geo: (t: number) => Promise<Geo>) {
    const refKey = `${lat.toFixed(7)},${lon.toFixed(7)},${hObs},${sunTol},${earthMask}`;
    let ref = refYearCache.get(refKey);
    if (!ref) {
      let s = 0, e = 0, n = 0;
      for (let t = Date.UTC(FEAS_REF_YEAR, 0, 1); t < Date.UTC(FEAS_REF_YEAR + 1, 0, 1); t += 6 * 3600e3) {
        const g = await geo(t);
        n++;
        s += discFractionAbove(g.sun.marginDeg + sunTol, g.sun.angularRadiusDeg);
        if (g.earth.marginDeg - earthMask > 0) e++;
      }
      ref = { sun: s, earth: e, n };
      refYearCache.set(refKey, ref);
    }
    return ref;
  }

  /** the same site seen from another height above the ground (a panel or antenna mast) */
  async function atHeight(ctx: SiteCtx, lat: number, lon: number, h: number, check: () => void): Promise<SiteCtx> {
    check();
    const hp = await horizon(lat, lon, h);
    check();
    return { ...ctx, hp, siteKm: ctx.f.up.clone().multiplyScalar((R_MOON + ctx.site.h + h) / 1000) };
  }

  /**
   * Power and Comms feasibility inputs at time ms: the Sun as seen from the panel, the Earth
   * from the antenna (heights from the config), each counted visible while its margin is
   * above -horizonToleranceDeg (the Earth's also minus the query's link mask).
   */
  async function mastInputs(ctx: SiteCtx, lat: number, lon: number, ms: number, mask: number, days: number,
    cfg: FeasibilityConfig, check: () => void) {
    const tol = cfg.horizonToleranceDeg;
    const ctxP = await atHeight(ctx, lat, lon, cfg.panelHeightM, check);
    const ctxA = cfg.antennaHeightM === cfg.panelHeightM ? ctxP : await atHeight(ctx, lat, lon, cfg.antennaHeightM, check);
    const gP = geoFns(ctxP), gA = geoFns(ctxA);
    const windowH = days * 24;
    const sunMargin = async (t: number) => (await gP.sunGeo(t)).marginDeg + tol;
    const earthMargin = async (t: number) => (await gA.earthGeo(t)).marginDeg - mask + tol;
    const sun = await gP.sunGeo(ms), earth = await gA.earthGeo(ms);
    const sm = sun.marginDeg + tol, em = earth.marginDeg - mask + tol;
    check();
    const sunSet = sm > 0 ? await findCrossing(sunMargin, ms, days, 1) : null;
    check();
    const earthSet = em > 0 ? await findCrossing(earthMargin, ms, days, 1) : null;
    check();
    const refP = await refYear(lat, lon, cfg.panelHeightM, tol, mask - tol, gP.geo);
    const refA = ctxA === ctxP ? refP : await refYear(lat, lon, cfg.antennaHeightM, tol, mask - tol, gA.geo);
    return {
      sunVisibleNow: discFractionAbove(sm, sun.angularRadiusDeg),
      sunHoursRemaining: sm > 0 ? (sunSet === null ? windowH : (sunSet - ms) / 3600e3) : 0,
      annualIllumination: refP.n ? refP.sun / refP.n : 0,
      earthVisibleNow: discFractionAbove(em, earth.angularRadiusDeg),
      linkMarginDeg: Math.max(0, em),
      earthHoursRemaining: em > 0 ? (earthSet === null ? windowH : (earthSet - ms) / 3600e3) : 0,
      annualEarthVisibility: refA.n ? refA.earth / refA.n : 0,
    };
  }

  // ---- the query ------------------------------------------------------------------------
  async function query(q: SiteQuery): Promise<SiteReport> {
    const t0 = performance.now();
    const check = () => q.signal?.throwIfAborted();
    check();
    await initEphem();
    check();
    const ms = clampT(Math.floor(toMs(q.time) / 1000) * 1000);
    if (!Number.isFinite(ms)) throw new Error('invalid time');
    const lat = Math.max(-90, Math.min(90, q.lat));
    const lon = q.lon;
    const hObs = q.observerHeightM ?? 2;
    const mask = q.linkMaskDeg ?? 0;
    const days = q.searchDays ?? 30;
    const cfg = opts.feasibilityConfig ?? DEFAULT_FEASIBILITY;
    const ctx = await prepare(lat, lon, hObs, check, cfg);
    const { f, site, cell, baseline: b, slopeDeg, aspect, normal, prominence, hp } = ctx;
    const { geo, sunGeo, earthGeo } = geoFns(ctx);
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

    // power
    const sunMargin = async (t: number) => (await sunGeo(t)).marginDeg;
    const sunUp = sun.marginDeg > 0;
    check();
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

    check();
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

    // absorbed-flux history on the local ground facet (30 min steps, ~3 lunations back)
    const HIST_STEP = 1800;
    const t0h = clampT(ms - HIST_DAYS * 86400e3);
    const nh = Math.max(2, Math.round((ms - t0h) / (HIST_STEP * 1000)) + 1);
    const hist = new Float64Array(nh);
    let lastLit: number | null = null;
    for (let k = 0; k < nh; k++) {
      const t = ms - (nh - 1 - k) * HIST_STEP * 1000;
      const g = await geo(t);
      hist[k] = absorbedFlux(g, normal);
      if (hist[k] > 0) lastLit = t;
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

    // the score sees the Sun / Earth from the panel / antenna mast, with the horizon tolerance
    const feasInputs: FeasibilityInputs = {
      ...(await mastInputs(ctx, lat, lon, ms, mask, days, cfg, check)),
      slopeDeg,
      temperatureK: temperature.surfaceK,
      prominenceM: prominence,
    };
    const feas = feasibility(feasInputs, cfg);

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

  // ---- time series ------------------------------------------------------------------------
  /**
   * Power / connectivity / landing / feasibility scores sampled over [start, start + span],
   * with the same inputs and scoring as query() at each sample. Everything is evaluated on
   * one uniform grid (30 min .. 3 h, ~400 steps over the span): ~3 lunations of spin-up
   * before the start for the regolith temperature, and 15 days past the end for the
   * "hours of Sun / Earth remaining" inputs (their utility saturates at 14 days). Rise/set
   * times are interpolated linearly between grid samples.
   */
  async function timeSeries(q: SiteSeriesQuery): Promise<SiteSeries> {
    const t0c = performance.now();
    const check = () => q.signal?.throwIfAborted();
    check();
    await initEphem();
    check();
    const t0 = clampT(Math.floor(toMs(q.start) / 1000) * 1000);
    if (!Number.isFinite(t0)) throw new Error('invalid time');
    const span = Math.max(3600e3, q.spanMs);
    const lat = Math.max(-90, Math.min(90, q.lat));
    const lon = q.lon;
    const hObs = q.observerHeightM ?? 2;
    const mask = q.linkMaskDeg ?? 0;
    const SEARCH_DAYS = 30; // query()'s default rise/set window (the "remaining" inputs are capped by it)
    const LOOKAHEAD_DAYS = 15;

    const cfg = opts.feasibilityConfig ?? DEFAULT_FEASIBILITY;
    const tol = cfg.horizonToleranceDeg;
    const ctx = await prepare(lat, lon, hObs, check, cfg);
    const { geo } = geoFns(ctx);
    // the score sees the Sun / Earth from the panel / antenna mast, with the horizon tolerance
    const ctxP = await atHeight(ctx, lat, lon, cfg.panelHeightM, check);
    const ctxA = cfg.antennaHeightM === cfg.panelHeightM ? ctxP : await atHeight(ctx, lat, lon, cfg.antennaHeightM, check);
    const geoP = geoFns(ctxP).geo, geoA = ctxA === ctxP ? geoP : geoFns(ctxA).geo;
    const refP = await refYear(lat, lon, cfg.panelHeightM, tol, mask - tol, geoP);
    const refA = ctxA === ctxP ? refP : await refYear(lat, lon, cfg.antennaHeightM, tol, mask - tol, geoA);
    check();

    // grid step: a multiple of the thermal model's 120 s time step
    const stepS = Math.min(10800, Math.max(1800, Math.round(span / 1000 / 400 / 120) * 120));
    const step = stepS * 1000;
    const nWarm = Math.round((HIST_DAYS * 86400e3) / step);
    const nSpan = Math.ceil(span / step);
    const nLook = Math.ceil((LOOKAHEAD_DAYS * 86400e3) / step);
    const n = nWarm + nSpan + 1 + nLook;
    const sunM = new Float64Array(n), sunF = new Float64Array(n), earthM = new Float64Array(n), earthF = new Float64Array(n);
    const absorbed = new Float64Array(nWarm + nSpan + 1);
    const tAt = (k: number) => t0 + (k - nWarm) * step;
    for (let k = 0; k < n; k++) {
      if ((k & 255) === 0) check();
      const t = clampT(tAt(k));
      const gp = await geoP(t), ga = geoA === geoP ? gp : await geoA(t);
      sunM[k] = gp.sun.marginDeg + tol;
      sunF[k] = discFractionAbove(sunM[k], gp.sun.angularRadiusDeg);
      earthM[k] = ga.earth.marginDeg - mask + tol;
      earthF[k] = discFractionAbove(earthM[k], ga.earth.angularRadiusDeg);
      // the ground's own sunlight (temperature) is seen from the query height, without tolerance
      if (k < absorbed.length) absorbed[k] = absorbedFlux(await geo(t), ctx.normal);
    }
    check();
    const temps = simulateRegolithSeries(absorbed, stepS, nWarm);

    /** hours until margin m turns non-positive, for each plotted sample (0 while it already is) */
    const remaining = (m: Float64Array) => {
      const out = new Float64Array(nSpan + 1);
      let next = -1; // index k of the next crossing (between k and k + 1), scanning backwards
      for (let k = n - 2; k >= nWarm; k--) {
        if ((m[k] > 0) !== (m[k + 1] > 0)) next = k;
        if (k > nWarm + nSpan) continue;
        if (!(m[k] > 0)) continue; // not visible: 0
        let h: number;
        if (next < 0) h = SEARCH_DAYS * 24;
        else {
          const tc = tAt(next) + (step * m[next]) / (m[next] - m[next + 1]);
          h = Math.min(SEARCH_DAYS * 24, Math.max(0, (tc - tAt(k)) / 3600e3));
        }
        out[k - nWarm] = h;
      }
      return out;
    };
    const sunRem = remaining(sunM), earthRem = remaining(earthM);

    const out: SiteSeries = {
      query: { lat, lon, startUtc: iso(t0)!, spanMs: span, observerHeightM: hObs },
      stepMs: step,
      times: [], power: [], comms: [], landing: [], feasibility: [], temperatureK: [],
      computeMs: 0,
    };
    const r2 = (x: number) => Math.round(x * 100) / 100;
    for (let i = 0; i <= nSpan; i++) {
      const k = nWarm + i;
      const tK = Math.round(temps[i] * 10) / 10;
      const r = feasibility({
        sunVisibleNow: sunF[k],
        sunHoursRemaining: sunRem[i],
        annualIllumination: refP.n ? refP.sun / refP.n : 0,
        earthVisibleNow: earthF[k],
        linkMarginDeg: Math.max(0, earthM[k]),
        earthHoursRemaining: earthRem[i],
        annualEarthVisibility: refA.n ? refA.earth / refA.n : 0,
        slopeDeg: ctx.slopeDeg,
        temperatureK: tK,
        prominenceM: ctx.prominence,
      }, cfg);
      out.times.push(tAt(k));
      out.power.push(r2(r.categories.power));
      out.comms.push(r2(r.categories.comms));
      out.landing.push(r2(r.categories.landing));
      out.feasibility.push(r2(r.score));
      out.temperatureK.push(tK);
    }
    out.computeMs = Math.round(performance.now() - t0c);
    return out;
  }

  return { query, horizon, timeSeries };
}
