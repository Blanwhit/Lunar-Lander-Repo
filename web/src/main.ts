import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  Euler,
  GLSL3,
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
  WebGLRenderer, WebGLRenderTarget,
} from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { GlobeControls } from './controls';
import { HelmetAudio } from './helmetAudio';
import { landingFlight, type LandingFrame } from './landingFlight';
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
  let walking = false;
  let advanceFlight: ((dt: number) => void) | undefined;
  let flightFrame: LandingFrame | undefined;
  let drawApproach: ((entry: LandingFrame) => void) | undefined;
  let surfaceStars: Texture | undefined;

  let renderedView: FrameInfo | undefined;
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
  const perf = { frames: 0, renders: 0, fps: 0, lastFpsT: last, frameMs: 0 };
  (window as any).__moon = {
    tree, controls, renderer, perf, LIGHT_PARAMS, LIGHT, sky, skyMat, hud, ephem, setTime,
    get simMs() { return simMs; },
  };

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
    renderedView = fi;
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
      skyMat.uniforms.uSun.value = [toSun.x, toSun.y, toSun.z, Math.asin((R_SUN_KM * 1000) / ds)];
      skyMat.uniforms.uEarth.value = [toEarth.x, toEarth.y, toEarth.z, Math.asin((R_EARTH_KM * 1000) / de)];
    }
    scene.add(sky);
    // scale bar: ground metres per CSS pixel at the view centre (the pivot)
    const pv = st.pivot;
    const dPivot = Math.hypot(st.camPos[0] - pv[0], st.camPos[1] - pv[1], st.camPos[2] - pv[2]);
    hud.setScale((dPivot * 2 * Math.tan(fov / 2)) / lodH);
    for (const n of tiles) scene.add(tree.meshFor(n, fi, P, LIGHT, LIGHT_PARAMS));
    renderer.render(scene, dummyCam);
    perf.renders++;
    perf.frameMs = performance.now() - t0;
  }
  hud.setTime(simMs);
  void setTime(simMs);
  onHash();
  const landing = document.querySelector<HTMLFormElement>('#landing')!;
  const orbitPanel = landing.parentElement!;
  const hint = orbitPanel.querySelector<HTMLElement>('.landing-hint')!;
  const lighting = landing.elements.namedItem('lighting') as HTMLSelectElement;
  const submit = landing.querySelector('button')!;
  const message = landing.querySelector('output')!;
  let selected: [number, number] | undefined;
  let terrainRequest: Promise<import('./walkTerrain').WalkTerrain> | undefined;
  function clearSelection() {
    if (submit.disabled) return;
    selected = undefined;
    terrainRequest = undefined;
    landing.hidden = true;
    hint.hidden = false;
  }
  function offerLanding(lat: number, lon: number, x: number, y: number) {
    selected = [lat, lon];
    void import('./walk').then(walk => walk.preloadSurface()).catch(() => {});
    const terrain = import('./walkTerrain').then(module => module.loadWalkTerrain(lat,lon));
    terrainRequest = terrain;
    void terrain.catch(() => { if (terrainRequest === terrain) terrainRequest = undefined; });
    landing.querySelector('.coordinates')!.textContent =
      Math.abs(lat).toFixed(4) + '°' + (lat < 0 ? 'S' : 'N') + '  ' + Math.abs(lon).toFixed(4) + '°' + (lon < 0 ? 'W' : 'E');
    message.textContent = '';
    hint.hidden = true;
    landing.hidden = false;
    landing.style.left = Math.max(8, Math.min(innerWidth - landing.offsetWidth - 8, x + 10)) + 'px';
    landing.style.top = Math.max(8, Math.min(innerHeight - landing.offsetHeight - 12, y + 10)) + 'px';
    submit.focus({ preventScroll: true });
  }
  submit.disabled = false;
  canvas.addEventListener('pointerdown', clearSelection);
  canvas.addEventListener('wheel', clearSelection, { passive: true });
  landing.addEventListener('keydown', e => { if (e.key === 'Escape') { clearSelection(); canvas.focus(); } });
  // Pick the closest fragment of the same displaced and morphed terrain that was drawn.
  const pickPixel = new WebGLRenderTarget(1,1);
  const rgba = new Uint8Array(4);
  controls.onSurfaceTap = (clientX,clientY) => {
    if (submit.disabled || !renderedView || !tree.drawn.length) return;
    const rect = canvas.getBoundingClientRect(), w=canvas.width, h=canvas.height;
    const x=Math.floor((clientX-rect.left)*w/rect.width), y=h-1-Math.floor((clientY-rect.top)*h/rect.height);
    if (x<0 || y<0 || x>=w || y>=h) return;
    pickPixel.viewport.set(-x,-y,w,h);
    const previous=renderer.getRenderTarget();
    tree.picking.value=true;
    sky.visible=false;
    try {
      renderer.setRenderTarget(pickPixel);
      renderer.render(scene,dummyCam);
      renderer.readRenderTargetPixels(pickPixel,0,0,1,1,rgba);
    } finally {
      renderer.setRenderTarget(previous);
      tree.picking.value=false;
      sky.visible=true;
    }
    // A black cleared pixel is sky. Clear alpha is one, so test the decoded distance explicitly.
    const distance=new DataView(rgba.buffer).getFloat32(0,true);
    if (!(distance>0 && Number.isFinite(distance))) return;
    const projection=renderedView.proj.elements;
    const ray=new Vector3((2*(x+.5)/w-1)/projection[0], (2*(y+.5)/h-1)/projection[5],-1)
      .normalize().applyMatrix3(renderedView.viewRot.clone().transpose());
    const point=new Vector3(...renderedView.camPos).addScaledVector(ray,distance).normalize();
    offerLanding(Math.asin(point.z)/DEG, Math.atan2(point.y,point.x)/DEG, clientX, clientY);
  };
  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !submit.disabled) {
      const rect = canvas.getBoundingClientRect();
      controls.onSurfaceTap?.(rect.left + rect.width/2, rect.top + rect.height/2);
    }
  });
  controls.onSurfaceZoom = () => {
    if (submit.disabled) return;
    offerLanding(Math.asin(controls.tgt.z)/DEG, Math.atan2(controls.tgt.y,controls.tgt.x)/DEG, innerWidth/2, innerHeight/2);
    landing.requestSubmit();
  };
  landing.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled || !selected) return;
    const [lat, lon] = selected;
    const selectedTerrain = terrainRequest;
    terrainRequest = undefined;
    const audio = new HelmetAudio();
    audio.start();
    const daylight = lighting.value === 'day';
    submit.disabled = true;
    message.textContent = 'Preparing lunar surface…';
    const origin = { target: controls.tgt.clone(), forward: controls.fwd.clone(), distance: controls.dist,
      tilt: controls.tiltUser, height: controls.pivotHeight };
    const frameAt = (lat:number, lon:number) => {
      const east=new Vector3(-Math.sin(lon*DEG),Math.cos(lon*DEG),0);
      const up=new Vector3(...latLonToDir(lat,lon));
      return new Matrix4().makeBasis(east,up,east.clone().cross(up));
    };
    const localToBody=frameAt(lat,lon);
    const flight = landingFlight(controls, localToBody);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let elapsed = 0;
    flightFrame = flight.sample(0);
    canvas.inert = true;
    lighting.disabled = true;
    const showOrbit = (visible: boolean) => {
      orbitPanel.style.opacity = hud.root.style.opacity = visible ? '' : '0';
      orbitPanel.inert = hud.root.inert = !visible;
    };
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
      lighting.disabled = false;
      showOrbit(true);
      walking = false;
      needsRender = true;
      submit.disabled = false;
      message.textContent = '';
      submit.focus({ preventScroll: true });
    };
    try {
      const [{ loadWalkTerrain }, { startWalk }] = await Promise.all([import('./walkTerrain'), import('./walk')]);
      async function siteAt(lat:number,lon:number, terrain=loadWalkTerrain(lat,lon)) {
        const frame=frameAt(lat,lon);
        const [height]=await Promise.all([terrain,skyPreview]);
        const bodyToLocal=frame.clone().transpose();
        const localToStars=new Matrix4().setFromMatrix3(bodyToJ2000).multiply(frame);
        const landingKm=new Vector3().setFromMatrixColumn(frame,1).multiplyScalar(R_MOON/1000);
        const toEarth=earthKm.clone().sub(landingKm),toSun=sunKm.clone().sub(landingKm);
        const sun=daylight ? new Vector3(-.8,.45,-.4) : toSun.clone().transformDirection(bodyToLocal);
        const earth=bodiesReady ? {
          angularRadius:Math.asin(R_EARTH_KM/toEarth.length()), direction:toEarth.transformDirection(bodyToLocal),
          sunDirection:sunKm.clone().sub(earthKm).transformDirection(bodyToLocal),
          texture:skyMat.uniforms.uEarthTex.value ?? undefined,gmst:gmst(simMs),
        } : undefined;
        const seed=Math.imul(Math.round(lat*10000),73856093)^Math.imul(Math.round(lon*10000),19349663);
        return {height,seed,sun,earth,landingToBody:frame,
          sunAngularRadius:bodiesReady ? Math.asin(R_SUN_KM/toSun.length()) : undefined,
          skyRotation:new Euler().setFromRotationMatrix(localToStars.transpose()),
          get sky(){return skyMat.uniforms.uStars.value ?? undefined;}};
      }
      const site=await siteAt(lat,lon,selectedTerrain);
      surfaceStars=site.sky;
      await startWalk(document.body, {...site,siteAt,audio,onExit:restore,
        onPrepared(draw) {
          showOrbit(false);
          drawApproach = draw;
          advanceFlight = dt => {
            elapsed = reduced ? 1 : Math.min(1, elapsed + Math.min(dt,1/30)*1000/flight.duration);
            flightFrame = flight.sample(elapsed);
            const height = tree.heightAt([controls.tgt.x, controls.tgt.y, controls.tgt.z]);
            if (height !== null) controls.pivotHeight += (height-controls.pivotHeight)*-Math.expm1(-dt*8);
            walking = flightFrame.opacity >= 1;
          };
        },
        onArrived() {
          advanceFlight = undefined;
          drawApproach = undefined;
          flightFrame = undefined;
          walking = true;
        } });
      message.textContent = '';
    } catch (error) {
      console.error('Landing failed', error);
      restore();
      message.textContent = 'Could not open the surface. Reload or try landing again.';
    }
  });
  requestAnimationFrame(render);
  // debug/measurement hook (no UI): step(dt) renders one frame even when rAF is paused
  (window as any).__moon.step = (dt = 1 / 60) => renderFrame(dt, true);

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
