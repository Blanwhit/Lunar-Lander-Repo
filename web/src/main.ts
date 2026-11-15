import {backgroundRenderDue} from './castPresentation';
import { mountCastPanel } from './castPanel';
import { QuestHandoff, receiveQuest, savedComputer, type QuestConnection, type SurfacePoint } from './questHandoff';
import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  Euler,
  GLSL3,
  MathUtils,
  Matrix3,
  Matrix4,
  Mesh,
  RawShaderMaterial,
  Scene,
  Sphere,
  SRGBColorSpace,
  RepeatWrapping,
  Texture,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { OrbitalRocks } from './terrain/orbitalRocks';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { openSurfaceVR, type BrowserGlobe, type GlobeEye, type GlobeHeadset } from './globePicker';
import { GlobeControls } from './controls';
import { HelmetAudio } from './helmetAudio';
import type { LandingFrame } from './landingFlight';
import { Compass } from './compass';
import { Ephemeris } from './ephemeris';
import { R_MOON, H_MAX_GLOBAL, H_MIN_GLOBAL, latLonToDir } from './geom';
import { Hud } from './hud';
import { VrFeasibility } from './overlay/vrFeasibility';
import { FeasibilityOverlay } from './overlay/FeasibilityOverlay';
import { moonOrientation } from './orientation';
import type { SiteReport } from './api/siteApi';
import { InfoPanel } from './infoPanel';
import { SiteGraphs } from './siteGraphs';
import { PoleMarkers } from './poleMarkers';
import { SitePopup, createHint } from './sitePopup';
import { SunGlare, sunVisibleFraction } from './sunGlare';
import { gmst } from './time';
import { skyFS, skyVS } from './terrain/shaders';
import { TileTree, type FrameInfo, type LightParams } from './terrain/TileTree';

interface TileMeta {
  maxLevel: number;
  colourMaxLevel: number;
  stars?: string[]; // cubemap files, low -> high resolution
  feasibility?: { samples: number; maxLevel: number }; // score tiles (pipeline/feasibility_grid.py)
}

const DEG = Math.PI / 180;
const FOV_Y = 45 * DEG;

const R_SUN_KM = 695700;
const R_EARTH_KM = 6371;
const EARTHSHINE = 0.03; // night-side earthshine at full Earth, relative to sunlight (artistic)

// Sun direction (body frame). Until the Horizons ephemeris has loaded, a neutral default.
const LIGHT = new Vector3(...latLonToDir(-1.5, 60)).normalize();
const LIGHT_PARAMS: LightParams = { sun: 1.0, ambient: 0.004, exposure: 1.0, earthDir: new Vector3(1, 0, 0), earthshine: 0 };

async function main() {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.autoClear = true;
  renderer.setClearColor(0x000000, 1);
  renderer.sortObjects = true;

  const base = import.meta.env.BASE_URL + 'tiles/';
  const [meta, coverage] = await Promise.all([
    fetch(base + 'meta.json').then(r => r.json() as Promise<TileMeta>),
    fetch(import.meta.env.BASE_URL + 'orbital/status.json', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  const fullCoverage = Number.isInteger(coverage?.maxLevel) && Number.isInteger(coverage?.colourMaxLevel);
  const terrainUrl = fullCoverage ? import.meta.env.BASE_URL + 'orbital/' : base;

  const ktx2 = new KTX2Loader().setTranscoderPath(import.meta.env.BASE_URL + 'basis/').detectSupport(renderer);

  const tree = new TileTree(
    {
      baseUrl: terrainUrl,
      colourMaxLevel: fullCoverage ? coverage.colourMaxLevel : meta.colourMaxLevel,
      maxLevel: fullCoverage ? coverage.maxLevel : meta.maxLevel,
      pixelsPerTexel: 1.25,
      gpuBudgetBytes: 384 * 1024 * 1024,
      maxInflightHeights: 12,
      maxInflightColour: 8,
    },
    ktx2,
  );

  // upload new tile textures while promoting them, inside the per-frame streaming budget
  tree.uploadTexture = (t) => renderer.initTexture(t);
  const controls = new GlobeControls(canvas, (d) => tree.heightAt(d));
  controls.fovY = FOV_Y;
  controls.maxDist = (R_MOON / Math.sin(FOV_Y / 2)) * 1.15;
  controls.setView(0, 0, controls.maxDist);
  // ---- time, ephemeris (JPL Horizons), bottom bar
  const ephem = new Ephemeris(import.meta.env.BASE_URL + 'ephem/');
  await ephem.init();
  const [tMin, tMax] = ephem.range();
  const clampT = (ms: number) => Math.min(tMax, Math.max(tMin, ms));
  let simMs = clampT(Math.floor(Date.now() / 60000) * 60000);
  const sunKm = new Vector3(), earthKm = new Vector3(); // body frame, Moon-centred
  let bodiesReady = false;
  let bodiesMs = NaN; // time the Sun/Earth vectors below were computed for
  let bodiesWaiters: (() => void)[] = [];
  /** resolves once the Sun/Earth positions for the current simulated time are in */
  const bodiesNow = () => bodiesReady && bodiesMs === simMs
    ? Promise.resolve()
    : new Promise<void>((resolve) => bodiesWaiters.push(resolve));
  let timeToken = 0;
  const bodyToJ2000 = new Matrix3();

  const hud = new Hud(document.body, [tMin, tMax], (ms) => void setTime(ms));

  // feasibility heatmap overlay (off by default; nothing is loaded until switched on)
  const overlay = meta.feasibility ? new FeasibilityOverlay(base, meta.feasibility, ephem, moonOrientation) : null;
  let overlayTimer = 0;
  const overlayTime = (ms: number, immediate = false) => {
    if (!overlay?.enabled) return;
    clearTimeout(overlayTimer);
    if (immediate) void overlay.setTime(ms);
    else overlayTimer = window.setTimeout(() => void overlay.setTime(ms), 150);
  };
  if (overlay) overlay.onChange = () => (needsRender = true);
  const applyFeasibility = (on:boolean) => {
    hud.setFeasibility(on);
    if (!overlay) return;
    overlay.setEnabled(on);
    tree.feasProvider = on ? (L, f, x, y) => overlay.lookup(L, f, x, y) : null;
    if (on) overlayTime(simMs, true);
    needsRender = true;
  };
  hud.onFeasibility=on=>{
    applyFeasibility(on);
    if(!openingHeadset && !receivingQuest) pairing.setFeasibility(on);
  };
  const vrScores = overlay ? new VrFeasibility(overlay, () => hud.setFeasibility(!overlay.enabled, true)) : undefined;
  const compass = new Compass(hud.rightSlot, () => controls.resetNorth());

  // ---- right-click site inspector: pan the spot to the centre, popup with its score
  const dismissHint = createHint(document.body);
  const popup = new SitePopup(document.body);
  let site: { pos: Vector3; lat: number; lon: number } | null = null;
  let siteToken = 0;
  let siteTimer = 0;
  let siteQuery: AbortController | null = null; // the running score query (stopped when unneeded)
  // "More info": full site report (power / connectivity / landing) in the top-left corner
  const info = new InfoPanel(document.body);
  // ...and the site's scores over time on the right (opened and closed with it)
  const graphs = new SiteGraphs(document.body);
  let seriesQuery: AbortController | null = null;
  let seriesKey = ''; // site / time / window of the charts shown or being computed
  const loadSeries = async (force = false) => {
    if (!site || !graphs.isOpen) return;
    const key = `${site.lat},${site.lon},${simMs},${graphs.span.ms}`;
    if (!force && key === seriesKey) return;
    seriesKey = key;
    seriesQuery?.abort();
    const abort = (seriesQuery = new AbortController());
    graphs.setLoading();
    try {
      const api = await (window as any).__moon.siteApi();
      const s = await api.timeSeries({ lat: site.lat, lon: site.lon, start: simMs, spanMs: graphs.span.ms, signal: abort.signal });
      if (!abort.signal.aborted) graphs.setSeries(s);
    } catch (e) {
      if (abort.signal.aborted) return;
      console.warn('site time series', e);
      seriesKey = '';
      graphs.setError();
    }
  };
  const stopSeries = () => {
    seriesQuery?.abort();
    seriesQuery = null;
    seriesKey = '';
  };
  graphs.onSpanChange = () => void loadSeries();
  const setInfoOpen = (open: boolean) => {
    if (open) {
      info.show();
      graphs.show();
      void loadSeries();
    } else {
      info.hide();
      graphs.hide();
      stopSeries();
    }
  };
  info.onClose = () => setInfoOpen(false);
  popup.onClose = () => {
    cancelPrep();
    site = null;
    siteToken++;
    siteQuery?.abort();
    siteQuery = null;
    setInfoOpen(false);
    graphs.clear();
    needsRender = true;
  };
  popup.onMoreInfo = () => setInfoOpen(!info.isOpen);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F3' && site) {
      e.preventDefault();
      setInfoOpen(!info.isOpen);
    }
  });
  const scoreSite = async () => {
    if (!site) return;
    const token = ++siteToken;
    siteQuery?.abort();
    const abort = (siteQuery = new AbortController());
    popup.setLoading();
    info.setLoading(site.lat, site.lon);
    if (graphs.isOpen) graphs.setLoading();
    try {
      const api = await (window as any).__moon.siteApi();
      const r: SiteReport = await api.query({ lat: site.lat, lon: site.lon, time: simMs, signal: abort.signal });
      if (token === siteToken) {
        popup.setScore(r.feasibility.score);
        info.setReport(r);
        // the popup's next-month trend, then the panel's graphs: all reuse the site's horizon
        // and annual statistics computed by the report
        const month = api.timeSeries({ lat: r.query.lat, lon: r.query.lon, start: simMs, spanMs: 30 * 86400e3, signal: abort.signal });
        void loadSeries();
        try {
          const s = await month;
          if (token === siteToken) popup.setTrend(s);
        } catch (e) {
          if (abort.signal.aborted) return;
          console.warn('site month trend', e);
          if (token === siteToken) popup.setTrend(null);
        }
      }
    } catch (e) {
      if (abort.signal.aborted) return; // superseded or the popup closed
      console.warn('site query', e);
      if (token === siteToken) {
        popup.setScore(null);
        popup.setTrend(null);
        info.setError();
      }
    }
    needsRender = true;
  };
  // Only a stationary, single-pointer press selects a site; drags and pinches still navigate.
  let press: {id: number; button: number; x: number; y: number} | undefined;
  canvas.addEventListener('pointerdown', e => {
    press = e.isPrimary && (e.button === 0 || e.button === 2) && !e.shiftKey && !e.ctrlKey
      ? {id:e.pointerId, button:e.button, x:e.clientX, y:e.clientY} : undefined;
  });
  canvas.addEventListener('pointermove', e => {
    if (press?.id === e.pointerId && Math.hypot(e.clientX-press.x,e.clientY-press.y)>6) press = undefined;
  });
  canvas.addEventListener('pointercancel', () => { press = undefined; });
  canvas.addEventListener('pointerup', e => {
    const start = press;
    press = undefined;
    if (!start || start.id !== e.pointerId || start.button !== e.button ||
        Math.hypot(e.clientX-start.x,e.clientY-start.y)>6) return;
    const hit = pickSurface(e.clientX, e.clientY);
    if (!hit) return;
    dismissHint();
    const dir = hit.clone().normalize();
    site = {
      pos: hit,
      lat: Math.asin(Math.max(-1, Math.min(1, dir.z))) / DEG,
      lon: Math.atan2(dir.y, dir.x) / DEG,
    };
    controls.flyTo(dir);
    stopSeries();
    graphs.clear();
    popup.show(site.lat, site.lon);
    void scoreSite();
    prefetchWalk(site.lat, site.lon);
    needsRender = true;
  });

  // While the popup is open, prepare the landing scene for
  // that spot is prepared hidden. Closing the popup, picking another spot or changing time discards it.
  interface WalkPrep {
    lat: number; lon: number; ms: number;
    audio: HelmetAudio;
    failed: boolean;
    /** true: start the landing; false: discard the prepared walk */
    go: (start: boolean) => void;
    /** resolves (after go(true)) with the walk's per-frame approach renderer */
    prepared: Promise<((entry: LandingFrame) => void) | null>;
    hooks: { onArrived: () => void; onExit: () => void };
  }
  let prep: WalkPrep | null = null;
  let prefetchTimer = 0;
  function cancelPrep() {
    clearTimeout(prefetchTimer);
    prefetchTimer = 0;
    prep?.go(false);
    prep = null;
  }
  function prefetchWalk(lat: number, lon: number) {
    cancelPrep();
    const t0 = performance.now();
    const begin = () => {
      prefetchTimer = 0;
      if (!site || site.lat !== lat || site.lon !== lon) return;
      // Let any user-initiated camera movement settle before preparing the site.
      if (controls.isAnimating() && performance.now() - t0 < 3000) {
        prefetchTimer = window.setTimeout(begin, 100);
        return;
      }
      prep = prepareWalk(lat, lon);
    };
    prefetchTimer = window.setTimeout(begin, 300);
  }
  // GPU uploads run while the globe is still, including the wait for a selected site.
  let quietWaiters: (() => void)[] = [];
  const isQuiet = () => advanceFlight ? !drawApproach : !controls.isAnimating();
  const whenQuiet = () => (isQuiet() ? Promise.resolve() : new Promise<void>((resolve) => quietWaiters.push(resolve)));
  function releaseQuiet() {
    if (!quietWaiters.length || !isQuiet()) return;
    const waiting = quietWaiters;
    quietWaiters = [];
    for (const resolve of waiting) resolve();
  }
  function prepareWalk(lat: number, lon: number, headset?: GlobeHeadset): WalkPrep {
    let go!: (start: boolean) => void;
    const start = new Promise<boolean>((resolve) => { go = resolve; });
    let ready!: (draw: ((entry: LandingFrame) => void) | null) => void;
    let fail!: (error: unknown) => void;
    const prepared = new Promise<((entry: LandingFrame) => void) | null>((resolve, reject) => { ready = resolve; fail = reject; });
    prepared.catch(() => {}); // a discarded preparation is never awaited
    const p: WalkPrep = { lat, lon, ms: simMs, audio: new HelmetAudio(), failed: false, go, prepared,
      hooks: { onArrived: () => {}, onExit: () => {} } };
    p.audio.prepare();
    void start.then((started) => { if (!started) p.audio.dispose(); });
    void (async () => {
      if (!headset) await whenQuiet();
      const [{ loadWalkTerrain }, walk] = await Promise.all([import('./walkTerrain'), import('./walk')]);
      void walk.prefetchWalk().catch(() => {});
      const walkSite = await siteAt(lat, lon, loadWalkTerrain(lat, lon));
      surfaceStars = walkSite.sky;
      await walk.startWalk(document.body, {
        ...walkSite, audio: p.audio, headset, vrScores, globe: browserGlobe, start, quiet: headset ? undefined : whenQuiet,
        siteAt: (la: number, lo: number) => siteAt(la, lo, loadWalkTerrain(la, lo)),
        onPrepared: ready,
        onArrived: () => {
          p.hooks.onArrived();
          if (headset) ready(null); // The picker has handed its running XR session to the walk.
        },
        onExit: () => p.hooks.onExit(),
      });
    })().catch((error) => { p.failed = true; fail(error); });
    return p;
  }
  /** local landing frame at (lat, lon): x east, y up, z south */
  function frameAt(lat: number, lon: number) {
    const east = new Vector3(-Math.sin(lon * DEG), Math.cos(lon * DEG), 0);
    const up = new Vector3(...latLonToDir(lat, lon));
    return new Matrix4().makeBasis(east, up, east.clone().cross(up));
  }
  /** everything the walk needs about a spot: terrain, true Sun / Earth for the HUD time, sky */
  async function siteAt(lat: number, lon: number, terrain: Promise<import('./walkTerrain').WalkTerrain>) {
    const frame = frameAt(lat, lon);
    const [height] = await Promise.all([terrain, skyPreview, bodiesNow()]);
    const bodyToLocal = frame.clone().transpose();
    const localToStars = new Matrix4().setFromMatrix3(bodyToJ2000).multiply(frame);
    const landingKm = new Vector3().setFromMatrixColumn(frame, 1).multiplyScalar(R_MOON / 1000);
    const toEarth = earthKm.clone().sub(landingKm), toSun = sunKm.clone().sub(landingKm);
    const sun = toSun.clone().transformDirection(bodyToLocal);
    const earth = {
      angularRadius: Math.asin(R_EARTH_KM / toEarth.length()), direction: toEarth.transformDirection(bodyToLocal),
      sunDirection: sunKm.clone().sub(earthKm).transformDirection(bodyToLocal),
      texture: skyMat.uniforms.uEarthTex.value ?? undefined, gmst: gmst(simMs),
    };
    const seed = Math.imul(Math.round(lat * 10000), 73856093) ^ Math.imul(Math.round(lon * 10000), 19349663);
    return { height, seed, sun, earth, landingToBody: frame,
      sunAngularRadius: Math.asin(R_SUN_KM / toSun.length()),
      skyRotation: new Euler().setFromRotationMatrix(localToStars.transpose()),
      get sky() { return skyMat.uniforms.uStars.value ?? undefined; } };
  }

  /** body-frame surface point under a CSS-pixel position (ray-marched against loaded terrain) */
  function pickSurface(px: number, py: number): Vector3 | null {
    const st = controls.state();
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const th = Math.tan(FOV_Y / 2);
    const vd = new Vector3(((2 * px) / w - 1) * th * (w / h), (1 - (2 * py) / h) * th, -1);
    const d = vd.applyMatrix3(st.viewRot.clone().transpose()).normalize();
    return intersectTerrain(new Vector3(...st.camPos), d);
  }

  function intersectTerrain(o: Vector3, d: Vector3): Vector3 | null {
    const b = o.dot(d), oo = o.lengthSq();
    const rOut = R_MOON + H_MAX_GLOBAL, rIn = R_MOON + H_MIN_GLOBAL;
    const discOut = b * b - (oo - rOut * rOut);
    if (discOut < 0) return null;
    const t0 = Math.max(0, -b - Math.sqrt(discOut));
    let t1 = -b + Math.sqrt(discOut);
    const discIn = b * b - (oo - rIn * rIn);
    if (discIn >= 0) t1 = Math.min(t1, -b - Math.sqrt(discIn));
    if (t1 <= t0) return null;
    const p = new Vector3();
    const f = (t: number) => {
      p.copy(o).addScaledVector(d, t);
      const r = p.length();
      return r - (R_MOON + (tree.heightAt([p.x / r, p.y / r, p.z / r]) ?? 0));
    };
    // march with steps growing with range (fine near the camera), then bisect the crossing
    let ta = t0, fa = f(ta);
    if (fa < 0) return p.copy(o).addScaledVector(d, ta).clone();
    while (ta < t1) {
      const tb = Math.min(t1, ta + Math.max(2, (ta - t0 + 50) * 0.004));
      const fb = f(tb);
      if (fb <= 0) {
        let lo = ta, hi = tb;
        for (let i = 0; i < 30; i++) {
          const m = (lo + hi) / 2;
          if (f(m) > 0) lo = m;
          else hi = m;
        }
        return o.clone().addScaledVector(d, hi);
      }
      ta = tb;
    }
    // reached the inner bound without a crossing (terrain not loaded): use the sphere
    return discIn >= 0 ? o.clone().addScaledVector(d, t1) : null;
  }

  async function setTime(ms: number) {
    simMs = ms;
    hud.setTime(ms);
    overlayTime(ms);
    if (site) {
      // the score depends on the time: recompute once the user stops stepping
      clearTimeout(siteTimer);
      popup.setLoading();
      info.setLoading(site.lat, site.lon);
      if (graphs.isOpen) graphs.setLoading();
      siteTimer = window.setTimeout(() => void scoreSite(), 300);
      // the prepared walk is lit for the previous time: prepare it again
      if (prep || prefetchTimer) prefetchWalk(site.lat, site.lon);
    }
    const token = ++timeToken;
    const st = await ephem.at(ms);
    if (token !== timeToken) return; // a newer request superseded this one
    bodyToJ2000.copy(moonOrientation.bodyToJ2000(new Date(ms)));
    const toBody = bodyToJ2000.clone().transpose();
    sunKm.set(...st.sun).applyMatrix3(toBody);
    earthKm.set(...st.earth).applyMatrix3(toBody);
    LIGHT.copy(sunKm).normalize();
    LIGHT_PARAMS.earthDir.copy(earthKm).normalize();
    // Earth's illuminated fraction seen from the Moon drives earthshine
    const eToSun = sunKm.clone().sub(earthKm).normalize();
    const eToMoon = earthKm.clone().negate().normalize();
    LIGHT_PARAMS.earthshine = EARTHSHINE * 0.5 * (1 + eToSun.dot(eToMoon));
    (skyMat.uniforms.uBodyToJ2000.value as Matrix3).copy(bodyToJ2000);
    (skyMat.uniforms.uEarthSun.value as Vector3).copy(eToSun);
    skyMat.uniforms.uGmst.value = gmst(ms);
    bodiesReady = true;
    bodiesMs = ms;
    if (ms === simMs) {
      for (const resolve of bodiesWaiters) resolve();
      bodiesWaiters = [];
    }
    needsRender = true;
  }

  const onHash = () => applyHash(controls, (ms) => void setTime(clampT(ms)));
  window.addEventListener('hashchange', onHash);

  // ---- sky
  const skyGeo = new BufferGeometry();
  skyGeo.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 3, -1, -1, 3]), 2));
  skyGeo.boundingSphere = new Sphere(new Vector3(), 1e30); // 2D clip-space triangle, never culled
  const skyMat = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: skyVS,
    fragmentShader: skyFS,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uInvViewRot: { value: new Matrix3() },
      uBodyToJ2000: { value: moonOrientation.bodyToJ2000(new Date()) },
      uTanHalf: { value: [1, 1] },
      uEyeOffset: { value: [0, 0] },
      uStars: { value: null as Texture | null },
      uStarGain: { value: 1.0 },
      uSun: { value: [0, 0, 1, 0] },
      uEarth: { value: [0, 0, 1, 0] },
      uEarthSun: { value: new Vector3(1, 0, 0) },
      uEarthTex: { value: null as Texture | null },
      uEarthTexReady: { value: 0 },
      uGmst: { value: 0 },
      uPixelAngle: { value: 0.001 },
    },
  });
  const sky = new Mesh(skyGeo, skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = 0;
  const glare = new SunGlare(skyGeo);

  const scene = new Scene();
  const dummyCam = new Camera();
  // N / S rotation-axis lines (desktop globe only: not in the landing flight or the walk)
  const poles = new PoleMarkers(document.body);
  let walking = false;
  let advanceFlight: ((dt: number) => void) | undefined;
  let flightFrame: LandingFrame | undefined;
  let drawApproach: ((entry: LandingFrame) => void) | undefined;
  let surfaceStars: Texture | undefined;

  let rocks: OrbitalRocks | undefined;
  let nextDetailLoad = 0;
  function loadSurfaceDetail() {
    if (performance.now() < nextDetailLoad) return;
    nextDetailLoad = Infinity;
    const retry = (error: unknown) => {
      console.warn('Orbital surface detail', error);
      nextDetailLoad = performance.now() + 15000;
    };
    if (!tree.grainMaps) void import('./lunarSoil').then(m => m.loadGrainMaps()).then(maps => {
      tree.grainMaps = maps;
      needsRender = true;
    }).catch(retry);
    if (!rocks) void Promise.all([
      import('./terrain/orbitalRocks'),
      import('./lunarRocks').then(m => m.loadRockSamples()),
      import('./rockAtlas').then(m => m.loadRockAtlas()),
    ]).then(([{ OrbitalRocks }, samples, atlas]) => {
      rocks = new OrbitalRocks(atlas, samples);
      needsRender = true;
    }).catch(retry);
  }

  let needsRender = true;
  tree.onChange = () => (needsRender = true);

  // Show the small sky first, then upgrade independently of terrain streaming.
  let previewReady!: () => void;
  const skyPreview = new Promise<void>(resolve => { previewReady = resolve; });
  void (async () => {
    const gl = renderer.getContext();
    const maxSize: number = gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE);
    const files = (meta.stars ?? []).filter((file) => {
      const match = /^stars_(\d+)\.ktx2$/.exec(file);
      return !match || Number(match[1]) <= maxSize;
    });
    const preview = files.shift();
    async function loadSky(file: string) {
      try {
        const tex = await ktx2.loadAsync(base + file);
        const old = skyMat.uniforms.uStars.value;
        skyMat.uniforms.uStars.value = tex;
        if (old !== surfaceStars) old?.dispose();
        needsRender = true;
        return true;
      } catch (e) {
        console.warn('stars', file, e);
        return false;
      }
    }
    if (preview) await loadSky(preview);
    previewReady();
    for (const file of files.reverse()) {
      if (await loadSky(file)) break;
    }
  })();

  // Earth texture (NASA Blue Marble), loaded lazily after the terrain base level
  void (async () => {
    while (!tree.roots.every((r) => r.colourState === 2)) await new Promise((r) => setTimeout(r, 200));
    new TextureLoader().load(import.meta.env.BASE_URL + 'sky/earth.jpg', (tex) => {
      tex.colorSpace = SRGBColorSpace;
      tex.wrapS = RepeatWrapping;
      tex.anisotropy = 4;
      skyMat.uniforms.uEarthTex.value = tex;
      skyMat.uniforms.uEarthTexReady.value = 1;
      needsRender = true;
    });
  })();

  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    canvas.style.width = '100vw';
    canvas.style.height = '100vh';
    needsRender = true;
  }
  window.addEventListener('resize', resize);
  resize();

  const proj = new Matrix4();
  let frame = 0;
  let last = performance.now();
  // console / bench hooks (web/bench/bench.js, README "Site API"); step and siteApi are added below
  (window as any).__moon = { tree, controls, renderer };

  let globeImmersive = false;
  const browserGlobe: BrowserGlobe = {
    active(headsetRenderer) {
      globeImmersive = !!headsetRenderer;
      tree.uploadTexture = texture => (headsetRenderer ?? renderer).initTexture(texture);
      needsRender = true;
    },
    navigate: (dt, x, y, zoom) => controls.navigateVR(dt, x, y, zoom),
    pick: intersectTerrain,
    draw: (eye, dt) => renderFrame(dt, true, eye),
  };

  let lastOrbitDraw=-Infinity;
  function render(now: number) {
    requestAnimationFrame(render);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    advanceFlight?.(dt);
    if (!globeImmersive && backgroundRenderDue(now,lastOrbitDraw)){
      const elapsed=Number.isFinite(lastOrbitDraw)?Math.min(.15,(now-lastOrbitDraw)/1000):dt;
      renderFrame(elapsed,false);lastOrbitDraw=now;
    }
    if (flightFrame && drawApproach) drawApproach(flightFrame);
    releaseQuiet();
  }

  /** advance controls by dt and draw if anything changed (or when forced) */
  function renderFrame(dt: number, force: boolean, eye?: GlobeEye) {
    if (walking && !eye) {
      poles.hide();
      return;
    }
    const moved = !eye && !landingBusy && controls.update(dt);
    const fov = eye ? 2 * Math.atan(1 / eye.projection[5]) : FOV_Y;
    if (!force && !moved && !needsRender && !controls.isAnimating()) return;
    needsRender = false;
    if (!eye || eye.firstEye) frame++;

    const st = eye ?? controls.state();
    if (!eye) compass.update(controls.heading());
    const w = eye?.width ?? canvas.width, h = eye?.height ?? canvas.height;
    const aspect = w / h;
    const camR = Math.hypot(...st.camPos);
    // dynamic near/far: near ~ fraction of the height above the highest terrain below us
    const hTerrain = tree.heightAt([st.camPos[0] / camR, st.camPos[1] / camR, st.camPos[2] / camR]) ?? 0;
    const alt = Math.max(1, camR - R_MOON - hTerrain);
    // nearest visible surface is rarely closer than ~1/4 of the height above the ground below
    const near = Math.max(0.5, alt * 0.25);
    const rMax = R_MOON + H_MAX_GLOBAL;
    const far = Math.sqrt(Math.max(0, camR * camR - (R_MOON - 9200) ** 2)) + Math.sqrt(rMax * rMax - (R_MOON - 9200) ** 2) + 1000;
    const f = 1 / Math.tan(fov / 2);
    proj.set(
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) / (near - far), (2 * far * near) / (near - far),
      0, 0, -1, 0,
    );

    if (eye) {
      const depthA = proj.elements[10], depthB = proj.elements[14];
      proj.fromArray(eye.projection);
      proj.elements[10] = depthA;
      proj.elements[14] = depthB;
    }

    // LOD is driven by CSS pixels so high-DPI screens don't quadruple the tile count
    // (the extra device pixels still get MSAA + full-resolution normal maps)
    const lodH = eye ? h : h / renderer.getPixelRatio();
    const fi: FrameInfo = { camPos: st.camPos, viewRot: st.viewRot, proj, viewportHeight: lodH, fovY: fov, frame };
    const tiles = tree.update(fi, !!eye || !!advanceFlight || controls.isAnimating(), !eye || eye.firstEye);
    const P = lodH / (2 * Math.tan(fov / 2));

    scene.clear();
    (skyMat.uniforms.uInvViewRot.value as Matrix3).copy(st.viewRot).transpose();
    skyMat.uniforms.uTanHalf.value = [1 / proj.elements[0], 1 / proj.elements[5]];
    const eyeOffset: [number, number] = [proj.elements[8], proj.elements[9]];
    skyMat.uniforms.uEyeOffset.value = eyeOffset;
    skyMat.uniforms.uPixelAngle.value = (2 * Math.tan(fov / 2)) / h;
    if (bodiesReady) {
      // directions from the camera (not the Moon's centre): exact parallax near the Moon
      const cam = new Vector3(...st.camPos);
      const toSun = sunKm.clone().multiplyScalar(1000).sub(cam);
      const toEarth = earthKm.clone().multiplyScalar(1000).sub(cam);
      const ds = toSun.length(), de = toEarth.length();
      toSun.divideScalar(ds);
      toEarth.divideScalar(de);
      const sunR = Math.asin((R_SUN_KM * 1000) / ds);
      skyMat.uniforms.uSun.value = [toSun.x, toSun.y, toSun.z, sunR];
      skyMat.uniforms.uEarth.value = [toEarth.x, toEarth.y, toEarth.z, Math.asin((R_EARTH_KM * 1000) / de)];
      // glare, faded by how much of the disc the terrain / limb leaves visible
      const vis = () => sunVisibleFraction(st.camPos, toSun, sunR, (d) => tree.heightAt(d));
      const tanHalf: [number, number] = [1 / proj.elements[0], 1 / proj.elements[5]];
      if (glare.update(st.viewRot, toSun, sunR, vis, tanHalf, (2 * Math.tan(fov / 2)) / h, dt, eyeOffset)) needsRender = true;
    }
    // Draw the far-depth sky after opaque ground in the expanded spectator view.
    skyMat.depthTest=!!eye?.expandedCast;
    sky.renderOrder=eye?.expandedCast?2e6:0;
    scene.add(sky);
    // scale bar: ground metres per CSS pixel at the view centre (the pivot)
    const pv = st.pivot;
    const dPivot = Math.hypot(st.camPos[0] - pv[0], st.camPos[1] - pv[1], st.camPos[2] - pv[2]);
    if (!eye) hud.setScale((dPivot * 2 * Math.tan(fov / 2)) / lodH);
    // Orbital relief at this distance is carried primarily by the measured normal maps.
    // Spend the spectator budget on their screen samples while preserving close terrain.
    const castGrid=eye?.expandedCast && alt>90000?(alt>700000?16:32):undefined;
    for (const n of tiles) scene.add(tree.meshFor(n, fi, P, LIGHT, LIGHT_PARAMS, eye ? .55 : .72,castGrid));
    if (dPivot < 6500 && !flightFrame) {
      loadSurfaceDetail();
      if (rocks && !overlay?.enabled) {
        dummyCam.projectionMatrix.copy(proj);
        rocks.update(tiles, fi, LIGHT, LIGHT_PARAMS, alt, aspect);
        scene.add(rocks.group);
      }
    }
    if (eye || flightFrame) poles.hide();
    else poles.update(st.camPos, st.viewRot, proj, canvas.clientWidth, canvas.clientHeight,
      (sign) => tree.heightAt([0, 0, sign]) ?? 0);
    if (bodiesReady && glare.mesh.visible) scene.add(glare.mesh);
    overlay?.endFrame();
    (eye?.renderer ?? renderer).render(scene, dummyCam);
    if (eye) return;
    // keep the site popup attached to its surface point
    if (site) {
      const v = site.pos.clone().sub(new Vector3(...st.camPos)).applyMatrix3(st.viewRot);
      const facing = site.pos.clone().normalize().dot(new Vector3(...st.camPos).sub(site.pos)) > 0;
      if (v.z < 0 && facing) {
        const cw = canvas.clientWidth, ch = canvas.clientHeight;
        const x = ((v.x / -v.z / (Math.tan(FOV_Y / 2) * aspect)) + 1) * 0.5 * cw;
        const y = (1 - v.y / -v.z / Math.tan(FOV_Y / 2)) * 0.5 * ch;
        popup.place(x >= 0 && x <= cw && y >= 0 && y <= ch ? { x, y } : null);
      } else popup.place(null);
    } else popup.place(null);
  }
  hud.setTime(simMs);
  void setTime(simMs);
  onHash();
  // Land uses the inspected point for the browser and the Quest handoff.
  let landingBusy = false;
  const showOrbit = (visible: boolean) => {
    hud.root.style.opacity = visible ? '' : '0';
    hud.root.inert = !visible;
  };
  const pickerButton = document.createElement('button');
  pickerButton.type = 'button';
  pickerButton.className = 'moon-feas';
  const switchComputer=pickerButton.cloneNode() as HTMLButtonElement;
  switchComputer.textContent='Pair another computer';
  let openingHeadset=false, headsetBrowser=false, receivingQuest=false;
  const castPanel=/OculusBrowser|Quest/i.test(navigator.userAgent)||new URLSearchParams(location.search).has('quest')?undefined:mountCastPanel({
    renderer,
    globe:{...browserGlobe,draw:(eye,dt)=>{browserGlobe.draw(eye,dt);needsRender=true;}},
    scores:vrScores,
    siteAt:async(lat,lon)=>{
      const {loadWalkTerrain}=await import('./walkTerrain');
      return siteAt(lat,lon,loadWalkTerrain(lat,lon));
    }
  });
  const pairing=new QuestHandoff(connection=>openHeadset(undefined,connection));
  pickerButton.onclick=()=>void pairing.resumeOrPair();
  switchComputer.onclick=()=>pairing.pair();
  popup.onLand=()=>{
    if (!site || openingHeadset || landingBusy) return;
    const point={lat:site.lat,lon:site.lon};
    if(headsetBrowser && (/OculusBrowser|Quest/i.test(navigator.userAgent) || new URLSearchParams(location.search).has('quest'))) void openHeadset(point).catch(error=>{
      popup.vrMessage.textContent=error.message;
      popup.vrMessage.hidden=false;
    });
    else {
      void pairing.send(point,()=>overlay?.enabled??false).catch(error=>console.warn('Quest handoff',error));
      void startLanding(point.lat,point.lon);
    }
  };
  async function updateHeadset() {
    try {headsetBrowser=!!await navigator.xr?.isSessionSupported('immersive-vr');}
    catch {headsetBrowser=false;}
    pickerButton.textContent=savedComputer()?'Resume VR':'Connect to computer';
    if(headsetBrowser){
      const centre=hud.root.querySelector('.moon-centre');
      centre?.append(pickerButton);
      if(savedComputer())centre?.append(switchComputer);else switchComputer.remove();
    }else{pickerButton.remove();switchComputer.remove();}
  }
  void updateHeadset();
  navigator.xr?.addEventListener('devicechange',updateHeadset);

  async function openHeadset(selected?:SurfacePoint, paired?:QuestConnection) {
    if(openingHeadset || landingBusy) throw new Error('A VR session is already open.');
    if(!navigator.xr)throw new Error('Open Moon in the Quest browser to enter VR.');
    openingHeadset=true;
    popup.vrMessage.hidden=true;
    let session:XRSession|undefined;
    const connection=new AbortController();
    try {
      session=await navigator.xr.requestSession('immersive-vr',{optionalFeatures:['local-floor']});
      castPanel?.hide();
      receivingQuest=!!paired;
      session.addEventListener('end',()=>{castPanel?.show();receivingQuest=false;connection.abort();},{once:true});
      cancelPrep();
      await openSurfaceVR(session,async headset=>{
        if(paired){
          await receiveQuest(paired,connection.signal,(point,listen)=>startLanding(point.lat,point.lon,{...headset,listen}),applyFeasibility);
        }else if(selected) await startLanding(selected.lat,selected.lon,headset);
      });
    } catch(error){
      connection.abort();
      await session?.end().catch(()=>{});
      throw error;
    } finally {openingHeadset=false;void updateHeadset();}
  }
  async function startLanding(lat: number, lon: number, headset?: GlobeHeadset) {
    landingBusy = true;
    clearTimeout(prefetchTimer);
    prefetchTimer = 0;
    // the walk prepared behind the popup, if it is for this spot and time; otherwise a new one
    let p = !headset && prep && prep.lat === lat && prep.lon === lon && prep.ms === simMs && !prep.failed ? prep : null;
    if (!p) {
      prep?.go(false);
      p = prepareWalk(lat, lon, headset);
    }
    prep = null; // taken: closing the popup must not discard it
    const walk = p;
    popup.close();
    walk.audio.start(); // inside the click, so the browser lets the helmet audio play
    walk.go(true);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let opacity = 0;
    advanceFlight = dt => {
      if (!drawApproach) return;
      opacity = reduced ? 1 : Math.min(1, opacity + dt/.24);
      flightFrame = { opacity, arrived: opacity === 1 };
      walking = flightFrame.arrived;
    };
    showOrbit(false);
    canvas.inert = true;
    const restore = () => {
      walk.audio.dispose();
      if (surfaceStars !== skyMat.uniforms.uStars.value) surfaceStars?.dispose();
      surfaceStars = undefined;
      advanceFlight = undefined;
      drawApproach = undefined;
      flightFrame = undefined;
      canvas.inert = false;
      showOrbit(true);
      walking = false;
      landingBusy = false;
      needsRender = true;
      canvas.focus({ preventScroll: true });
    };
    walk.hooks.onExit = restore;
    walk.hooks.onArrived = () => {
      advanceFlight = undefined;
      drawApproach = undefined;
      flightFrame = undefined;
      walking = true;
    };
    try {
      const draw = await walk.prepared;
      if (draw) drawApproach = draw;
    } catch (error) {
      console.error('Landing failed', error);
      restore();
      if (headset) throw error;
    }
  }
  requestAnimationFrame(render);
  // debug/measurement hook (no UI): step(dt) renders one frame even when rAF is paused
  (window as any).__moon.step = (dt = 1 / 60) => renderFrame(dt, true);
  // site API (lazy-loaded): (await __moon.siteApi()).query({ lat, lon, time })
  let siteApi: Promise<import('./api/siteApi').SiteApi> | null = null;
  (window as any).__moon.siteApi = () =>
    (siteApi ??= import('./api/siteApi')
      .then((m) => m.createSiteApi({
        baseUrl: import.meta.env.BASE_URL, terrainUrl, loadedHeightTile: tree.decodedHeight.bind(tree),
      }))
      .catch((e) => {
        siteApi = null; // a failed load may be tried again
        throw e;
      }));
  // fetch its code once the page is idle, so the first right-click doesn't wait for it
  const whenIdle: (f: () => void) => void = (window as any).requestIdleCallback
    ? (f) => (window as any).requestIdleCallback(f, { timeout: 5000 })
    : (f) => setTimeout(f, 2000);
  whenIdle(() => void (window as any).__moon.siteApi().catch(() => {}));
}

/** optional deep link: #lat,lon,dist_m[,heading_deg[,tilt_deg[,ISO-8601 UTC time]]] */
function applyHash(c: GlobeControls, setTime: (ms: number) => void) {
  const parts = location.hash.replace('#', '').split(',');
  const m = parts.slice(0, 5).filter((x) => x !== '').map(Number);
  if (m.length >= 3 && m.every((v) => Number.isFinite(v))) c.setView(m[0], m[1], m[2], m[3] ?? 0, m[4]);
  const t = parts[5] ? Date.parse(parts[5]) : NaN;
  if (Number.isFinite(t)) setTime(Math.floor(t / 60000) * 60000);
}

main();
