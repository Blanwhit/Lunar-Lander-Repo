import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  CubeTexture,
  GLSL3,
  LinearFilter,
  LinearMipmapLinearFilter,
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
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { GlobeControls } from './controls';
import { Compass } from './compass';
import { Ephemeris } from './ephemeris';
import { R_MOON, H_MAX_GLOBAL, latLonToDir } from './geom';
import { Hud } from './hud';
import { moonOrientation } from './orientation';
import { gmst } from './time';
import { skyFS, skyVS } from './terrain/shaders';
import { TileTree, type FrameInfo, type LightParams } from './terrain/TileTree';

interface TileMeta {
  maxLevel: number;
  colourMaxLevel: number;
  stars?: string[]; // cubemap files, low -> high resolution
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
  let timeToken = 0;
  const bodyToJ2000 = new Matrix3();

  const hud = new Hud(document.body, [tMin, tMax], (ms) => void setTime(ms));
  const compass = new Compass(hud.rightSlot, () => controls.resetNorth());

  async function setTime(ms: number) {
    simMs = ms;
    hud.setTime(ms);
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

  const scene = new Scene();
  const dummyCam = new Camera();

  let needsRender = true;
  tree.onChange = () => (needsRender = true);

  // progressive star cubemaps: the small one immediately, larger ones only once the
  // terrain base level is in and the tile queue is idle (keeps the initial load small)
  (async () => {
    const files = meta.stars ?? [];
    for (let i = 0; i < files.length; i++) {
      if (i > 0) {
        while (!tree.roots.every((r) => r.colourState === 2) || tree.isBusy())
          await new Promise((r) => setTimeout(r, 500));
      }
      try {
        const tex = (await ktx2.loadAsync(base + files[i])) as unknown as CubeTexture;
        tex.magFilter = LinearFilter;
        tex.minFilter = tex.mipmaps && tex.mipmaps.length > 1 ? LinearMipmapLinearFilter : LinearFilter;
        tex.needsUpdate = true;
        const old = skyMat.uniforms.uStars.value as Texture | null;
        skyMat.uniforms.uStars.value = tex;
        old?.dispose();
        needsRender = true;
      } catch (e) {
        console.warn('stars', e);
      }
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
  const perf = { frames: 0, renders: 0, fps: 0, lastFpsT: last, frameMs: 0 };
  (window as any).__moon = {
    tree, controls, renderer, perf, LIGHT_PARAMS, LIGHT, sky, skyMat, hud, ephem, setTime,
    get simMs() { return simMs; },
  };

  function render(now: number) {
    requestAnimationFrame(render);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    renderFrame(dt, false);
  }

  /** advance controls by dt and draw if anything changed (or when forced) */
  function renderFrame(dt: number, force: boolean) {
    const moved = controls.update(dt);
    if (!force && !moved && !needsRender && !controls.isAnimating()) return;
    needsRender = false;
    const t0 = performance.now();
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
    const f = 1 / Math.tan(FOV_Y / 2);
    proj.set(
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) / (near - far), (2 * far * near) / (near - far),
      0, 0, -1, 0,
    );

    // LOD is driven by CSS pixels so high-DPI screens don't quadruple the tile count
    // (the extra device pixels still get MSAA + full-resolution normal maps)
    const lodH = h / renderer.getPixelRatio();
    const fi: FrameInfo = { camPos: st.camPos, viewRot: st.viewRot, proj, viewportHeight: lodH, fovY: FOV_Y, frame };
    const tiles = tree.update(fi);
    const P = lodH / (2 * Math.tan(FOV_Y / 2));

    scene.clear();
    (skyMat.uniforms.uInvViewRot.value as Matrix3).copy(st.viewRot).transpose();
    skyMat.uniforms.uTanHalf.value = [Math.tan(FOV_Y / 2) * aspect, Math.tan(FOV_Y / 2)];
    skyMat.uniforms.uPixelAngle.value = (2 * Math.tan(FOV_Y / 2)) / h;
    if (bodiesReady) {
      // directions from the camera (not the Moon's centre): exact parallax near the Moon
      const cam = new Vector3(...st.camPos);
      const toSun = sunKm.clone().multiplyScalar(1000).sub(cam);
      const toEarth = earthKm.clone().multiplyScalar(1000).sub(cam);
      const ds = toSun.length(), de = toEarth.length();
      toSun.divideScalar(ds);
      toEarth.divideScalar(de);
      skyMat.uniforms.uSun.value = [toSun.x, toSun.y, toSun.z, Math.asin((R_SUN_KM * 1000) / ds)];
      skyMat.uniforms.uEarth.value = [toEarth.x, toEarth.y, toEarth.z, Math.asin((R_EARTH_KM * 1000) / de)];
    }
    scene.add(sky);
    // scale bar: ground metres per CSS pixel at the view centre (the pivot)
    const pv = st.pivot;
    const dPivot = Math.hypot(st.camPos[0] - pv[0], st.camPos[1] - pv[1], st.camPos[2] - pv[2]);
    hud.setScale((dPivot * 2 * Math.tan(FOV_Y / 2)) / lodH);
    for (const n of tiles) scene.add(tree.meshFor(n, fi, P, LIGHT, LIGHT_PARAMS));
    renderer.render(scene, dummyCam);
    perf.renders++;
    perf.frameMs = performance.now() - t0;
  }
  hud.setTime(simMs);
  void setTime(simMs);
  onHash();
  requestAnimationFrame(render);
  // debug/measurement hook (no UI): step(dt) renders one frame even when rAF is paused
  (window as any).__moon.step = (dt = 1 / 60) => renderFrame(dt, true);
  // site API (lazy-loaded): (await __moon.siteApi()).query({ lat, lon, time })
  let siteApi: Promise<import('./api/siteApi').SiteApi> | null = null;
  (window as any).__moon.siteApi = () =>
    (siteApi ??= import('./api/siteApi').then((m) => m.createSiteApi({ baseUrl: import.meta.env.BASE_URL })));

  // fps counter (only counts rendered frames; readable via window.__moon.perf)
  setInterval(() => {
    const now = performance.now();
    perf.fps = (perf.renders - perf.frames) / ((now - perf.lastFpsT) / 1000);
    perf.frames = perf.renders;
    perf.lastFpsT = now;
  }, 1000);
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
