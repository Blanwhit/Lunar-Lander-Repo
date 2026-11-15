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
import { pickLandingInVR, type GlobeHeadset } from './globePicker';
import { GlobeControls } from './controls';
import { HelmetAudio } from './helmetAudio';
import { landingFlight, type LandingFrame } from './landingFlight';
import { Compass } from './compass';
import { Ephemeris } from './ephemeris';
import { R_MOON, H_MAX_GLOBAL, H_MIN_GLOBAL, latLonToDir } from './geom';
import { Hud } from './hud';
import { VrFeasibility } from './overlay/vrFeasibility';
import { FeasibilityOverlay } from './overlay/FeasibilityOverlay';
import { moonOrientation } from './orientation';
import type { SiteReport } from './api/siteApi';
import { InfoPanel } from './infoPanel';
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
  const meta: TileMeta = await fetch(base + 'meta.json').then((r) => r.json());

  const ktx2 = new KTX2Loader().setTranscoderPath(import.meta.env.BASE_URL + 'basis/').detectSupport(renderer);

  const tree = new TileTree(
    {
      baseUrl: base,
      colourMaxLevel: meta.colourMaxLevel,
      maxLevel: meta.maxLevel,
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
    overlayTimer = window.setTimeout(() => void overlay.setTime(ms), immediate ? 0 : 150);
  };
  if (overlay) overlay.onChange = () => (needsRender = true);
  hud.onFeasibility = (on) => {
    if (!overlay) return;
    overlay.enabled = on;
    tree.feasProvider = on ? (L, f, x, y) => overlay.lookup(L, f, x, y) : null;
    if (on) overlayTime(simMs, true);
    needsRender = true;
  };
  const vrScores = overlay ? new VrFeasibility(overlay, () => hud.setFeasibility(!overlay.enabled, true)) : undefined;
  const compass = new Compass(hud.rightSlot, () => controls.resetNorth());

  // ---- right-click site inspector: pan the spot to the centre, popup with its score
  const dismissHint = createHint(document.body);
  const popup = new SitePopup(document.body);
  let site: { pos: Vector3; lat: number; lon: number } | null = null;
  let siteToken = 0;
  let siteTimer = 0;
  // "More info": full site report (power / connectivity / landing) in the top-left corner
  const info = new InfoPanel(document.body);
  popup.onClose = () => {
    site = null;
    siteToken++;
    info.hide();
    needsRender = true;
  };
  popup.onMoreInfo = () => (info.isOpen ? info.hide() : info.show());
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F3' && site) {
      e.preventDefault();
      if (info.isOpen) info.hide();
      else info.show();
    }
  });
  const scoreSite = async () => {
    if (!site) return;
    const token = ++siteToken;
    popup.setLoading();
    info.setLoading(site.lat, site.lon);
    try {
      const api = await (window as any).__moon.siteApi();
      const r: SiteReport = await api.query({ lat: site.lat, lon: site.lon, time: simMs });
      if (token === siteToken) {
        popup.setScore(r.feasibility.score);
        info.setReport(r);
      }
    } catch (e) {
      console.warn('site query', e);
      if (token === siteToken) {
        popup.setScore(null);
        info.setError();
      }
    }
    needsRender = true;
  };
  // the right button only inspects (the globe controls ignore it): every right click
  // on the canvas picks the spot under the cursor at release
  let rDown = false;
  canvas.addEventListener('pointerdown', (e) => {
    rDown = e.button === 2;
  });
  canvas.addEventListener('pointerup', (e) => {
    if (e.button !== 2 || !rDown) return;
    rDown = false;
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
    popup.show(site.lat, site.lon);
    void scoreSite();
    prefetchWalk(site.lat, site.lon);
    needsRender = true;
  });

  // "Enter VR" is the popup's main action: warm the walk while the popup is read, so the
  // landing only has to build the scene. Deferred a little so the fly-to stays smooth, and
  // skipped if the popup was closed or moved on in the meantime.
  let prefetched: { lat: number; lon: number; terrain: Promise<import('./walkTerrain').WalkTerrain> } | null = null;
  let prefetchTimer = 0;
  function prefetchWalk(lat: number, lon: number) {
    clearTimeout(prefetchTimer);
    prefetchTimer = window.setTimeout(() => {
      if (!site || site.lat !== lat || site.lon !== lon) return;
      void import('./walk').then((walk) => walk.prefetchWalk()).catch(() => {});
      const terrain = import('./walkTerrain').then((module) => module.loadWalkTerrain(lat, lon));
      terrain.catch(() => { if (prefetched?.terrain === terrain) prefetched = null; });
      prefetched = { lat, lon, terrain };
    }, 300);
  }

  /** body-frame surface point under a CSS-pixel position (ray-marched against loaded terrain) */
  function pickSurface(px: number, py: number): Vector3 | null {
    const st = controls.state();
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const th = Math.tan(FOV_Y / 2);
    const vd = new Vector3(((2 * px) / w - 1) * th * (w / h), (1 - (2 * py) / h) * th, -1);
    const d = vd.applyMatrix3(st.viewRot.clone().transpose()).normalize();
    const o = new Vector3(...st.camPos);
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
      siteTimer = window.setTimeout(() => void scoreSite(), 300);
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

  function render(now: number) {
    requestAnimationFrame(render);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    advanceFlight?.(dt);
    renderFrame(dt, false);
    if (flightFrame && drawApproach) drawApproach(flightFrame);
  }

  /** advance controls by dt and draw if anything changed (or when forced) */
  function renderFrame(dt: number, force: boolean) {
    if (walking) return;
    const moved = flightFrame ? !!advanceFlight : controls.update(dt);
    const fov = (flightFrame?.fov ?? 45) * DEG;
    if (!force && !moved && !needsRender && !controls.isAnimating()) return;
    needsRender = false;
    frame++;

    const st = controls.state();
    compass.update(controls.heading());
    const w = renderer.domElement.width, h = renderer.domElement.height;
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

    // LOD is driven by CSS pixels so high-DPI screens don't quadruple the tile count
    // (the extra device pixels still get MSAA + full-resolution normal maps)
    const lodH = h / renderer.getPixelRatio();
    const fi: FrameInfo = { camPos: st.camPos, viewRot: st.viewRot, proj, viewportHeight: lodH, fovY: fov, frame };
    const tiles = tree.update(fi,!!advanceFlight || controls.isAnimating());
    const P = lodH / (2 * Math.tan(fov / 2));

    scene.clear();
    (skyMat.uniforms.uInvViewRot.value as Matrix3).copy(st.viewRot).transpose();
    skyMat.uniforms.uTanHalf.value = [Math.tan(fov / 2) * aspect, Math.tan(fov / 2)];
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
      const tanHalf: [number, number] = [Math.tan(fov / 2) * aspect, Math.tan(fov / 2)];
      if (glare.update(st.viewRot, toSun, sunR, vis, tanHalf, (2 * Math.tan(fov / 2)) / h, dt)) needsRender = true;
    }
    scene.add(sky);
    // scale bar: ground metres per CSS pixel at the view centre (the pivot)
    const pv = st.pivot;
    const dPivot = Math.hypot(st.camPos[0] - pv[0], st.camPos[1] - pv[1], st.camPos[2] - pv[2]);
    hud.setScale((dPivot * 2 * Math.tan(fov / 2)) / lodH);
    for (const n of tiles) scene.add(tree.meshFor(n, fi, P, LIGHT, LIGHT_PARAMS));
    if (dPivot < 6500 && !flightFrame) {
      loadSurfaceDetail();
      if (rocks && !overlay?.enabled) {
        dummyCam.projectionMatrix.copy(proj);
        rocks.update(tiles, fi, LIGHT, LIGHT_PARAMS, alt, aspect);
        scene.add(rocks.group);
      }
    }
    if (bodiesReady && glare.mesh.visible) scene.add(glare.mesh);
    overlay?.endFrame();
    renderer.render(scene, dummyCam);
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
  // ---- "Enter VR" (site popup): fly down to the inspected spot and open the surface walk
  // (desktop preview first; the headset session is requested from inside the walk)
  let landingBusy = false;
  const showOrbit = (visible: boolean) => {
    hud.root.style.opacity = visible ? '' : '0';
    hud.root.inert = !visible;
  };
  popup.onEnterVR = () => {
    if (!site || landingBusy) return;
    void enterVR(site.lat, site.lon);
  };
  const pickerButton = document.createElement('button');
  pickerButton.type = 'button';
  pickerButton.className = 'moon-feas';
  pickerButton.textContent = 'Choose landing in VR';
  if (navigator.xr) {
    const updatePicker = async () => {
      try {
        if (await navigator.xr!.isSessionSupported('immersive-vr')) {
          hud.root.querySelector('.moon-centre')?.append(pickerButton);
        } else pickerButton.remove();
      } catch { pickerButton.remove(); }
    };
    void updatePicker();
    navigator.xr.addEventListener('devicechange', updatePicker);
    pickerButton.onclick = async () => {
      if (landingBusy || pickerButton.disabled) return;
      pickerButton.disabled = true;
      let session: XRSession | undefined;
      try {
        session = await navigator.xr!.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
        const direction = controls.tgt;
        await pickLandingInVR(session, Math.asin(MathUtils.clamp(direction.z, -1, 1)) / DEG,
          Math.atan2(direction.y, direction.x) / DEG, enterVR, vrScores);
        pickerButton.textContent = 'Choose landing in VR';
      } catch (error) {
        await session?.end().catch(() => {});
        pickerButton.textContent = 'Try VR landing again';
        console.warn('VR landing picker', error);
      } finally { pickerButton.disabled = false; }
    };
  }
  async function enterVR(lat: number, lon: number, headset?: GlobeHeadset) {
    landingBusy = true;
    clearTimeout(prefetchTimer);
    // reuse the popup's prefetch for this spot, otherwise start loading now
    const selectedTerrain = prefetched && prefetched.lat === lat && prefetched.lon === lon
      ? prefetched.terrain
      : import('./walkTerrain').then((module) => module.loadWalkTerrain(lat, lon));
    prefetched = null;
    void selectedTerrain.catch(() => {});
    void import('./walk').then((walk) => walk.prefetchWalk()).catch(() => {});
    popup.close();
    const audio = new HelmetAudio();
    audio.start();
    const origin = { target: controls.tgt.clone(), forward: controls.fwd.clone(), distance: controls.dist,
      tilt: controls.tiltUser, height: controls.pivotHeight };
    const frameAt = (lat: number, lon: number) => {
      const east = new Vector3(-Math.sin(lon * DEG), Math.cos(lon * DEG), 0);
      const up = new Vector3(...latLonToDir(lat, lon));
      return new Matrix4().makeBasis(east, up, east.clone().cross(up));
    };
    // the flight starts from the current view (the popup's fly-to need not have finished)
    const flight = landingFlight(controls, frameAt(lat, lon));
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let elapsed = 0;
    // The descent starts on the click; the walk scene is built while it flies. If it is not
    // ready by the time the surface should fade in, the flight eases into a hold just before
    // that point and picks up again (speed eased both ways) once the walk is prepared.
    let ready = false;
    let speed = 1;
    const hold = flight.dissolveStart - 0.005;
    flightFrame = flight.sample(0);
    advanceFlight = (dt) => {
      const step = Math.min(dt, 1 / 30);
      if (reduced) elapsed = ready ? 1 : 0;
      else {
        const target = ready ? 1 : Math.min(1, Math.max(0, (hold - elapsed) / 0.06));
        speed += (target - speed) * -Math.expm1(-step * (ready ? 4 : 12));
        elapsed = Math.min(ready ? 1 : hold, elapsed + speed * step * 1000 / flight.duration);
      }
      flightFrame = flight.sample(elapsed);
      const height = tree.heightAt([controls.tgt.x, controls.tgt.y, controls.tgt.z]);
      if (height !== null) controls.pivotHeight += (height - controls.pivotHeight) * -Math.expm1(-dt * 8);
      walking = ready && flightFrame.opacity >= 1;
    };
    showOrbit(false);
    canvas.inert = true;
    const restore = () => {
      audio.dispose();
      if (surfaceStars !== skyMat.uniforms.uStars.value) surfaceStars?.dispose();
      surfaceStars = undefined;
      advanceFlight = undefined;
      drawApproach = undefined;
      flightFrame = undefined;
      controls.setView(lat, lon, origin.distance);
      controls.tgt.copy(origin.target);
      controls.fwd.copy(origin.forward);
      controls.tiltGoal = controls.tiltUser = origin.tilt;
      controls.pivotHeight = origin.height;
      canvas.inert = false;
      showOrbit(true);
      walking = false;
      landingBusy = false;
      needsRender = true;
      canvas.focus({ preventScroll: true });
    };
    try {
      const [{ loadWalkTerrain }, { startWalk }] = await Promise.all([import('./walkTerrain'), import('./walk')]);
      async function siteAt(lat: number, lon: number, terrain = loadWalkTerrain(lat, lon)) {
        const frame = frameAt(lat, lon);
        // true Sun and Earth for the selected UTC time (the HUD's), as seen from this spot
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
      const walkSite = await siteAt(lat, lon, selectedTerrain);
      surfaceStars = walkSite.sky;
      await startWalk(document.body, { ...walkSite, siteAt, audio, headset, vrScores, onExit: restore,
        onPrepared(draw) {
          drawApproach = draw;
          ready = true;
        },
        onArrived() {
          advanceFlight = undefined;
          drawApproach = undefined;
          flightFrame = undefined;
          walking = true;
        } });
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
    (siteApi ??= import('./api/siteApi').then((m) => m.createSiteApi({ baseUrl: import.meta.env.BASE_URL })));
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
