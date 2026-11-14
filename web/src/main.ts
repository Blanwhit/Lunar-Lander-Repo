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
  Texture,
  Vector3,
  WebGLRenderer,
} from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { GlobeControls } from './controls';
import { R_MOON, H_MAX_GLOBAL, latLonToDir } from './geom';
import { moonOrientation } from './orientation';
import { skyFS, skyVS } from './terrain/shaders';
import { TileTree, type FrameInfo } from './terrain/TileTree';

interface TileMeta {
  maxLevel: number;
  colourMaxLevel: number;
  stars?: string[]; // cubemap files, low -> high resolution
}

const DEG = Math.PI / 180;
const FOV_Y = 45 * DEG;

// fixed directional light (body frame): sun 1.5 deg above the south-pole horizon,
// shining from 60E -- gives grazing relief at the poles and a terminator near 30W.
const LIGHT = new Vector3(...latLonToDir(-1.5, 60)).normalize();
const LIGHT_PARAMS = { sun: 1.0, ambient: 0.012, exposure: 1.0 };

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
  applyHash(controls);
  window.addEventListener('hashchange', () => applyHash(controls));

  // ---- sky
  const skyGeo = new BufferGeometry();
  skyGeo.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 3, -1, -1, 3]), 2));
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
    },
  });
  const sky = new Mesh(skyGeo, skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = 0;
  sky.visible = false;

  const scene = new Scene();
  const dummyCam = new Camera();

  let needsRender = true;
  tree.onChange = () => (needsRender = true);

  // progressive star cubemaps
  (async () => {
    for (const f of meta.stars ?? []) {
      try {
        const tex = (await ktx2.loadAsync(base + f)) as unknown as CubeTexture;
        tex.magFilter = LinearFilter;
        tex.minFilter = tex.mipmaps && tex.mipmaps.length > 1 ? LinearMipmapLinearFilter : LinearFilter;
        tex.needsUpdate = true;
        const old = skyMat.uniforms.uStars.value as Texture | null;
        skyMat.uniforms.uStars.value = tex;
        sky.visible = true;
        old?.dispose();
        needsRender = true;
        // let the terrain base level go first before fetching the big sky
        await new Promise((r) => setTimeout(r, 1500));
      } catch (e) {
        console.warn('stars', e);
      }
    }
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
  (window as any).__moon = { tree, controls, renderer, perf, LIGHT_PARAMS, sky, skyMat };

  function render(now: number) {
    requestAnimationFrame(render);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const moved = controls.update(dt);
    if (!moved && !needsRender && !controls.isAnimating()) return;
    needsRender = false;
    const t0 = performance.now();
    frame++;

    const st = controls.state();
    const w = renderer.domElement.width, h = renderer.domElement.height;
    const aspect = w / h;
    const camR = Math.hypot(...st.camPos);
    // dynamic near/far: near ~ fraction of the height above the highest terrain below us
    const hTerrain = tree.heightAt([st.camPos[0] / camR, st.camPos[1] / camR, st.camPos[2] / camR]) ?? 0;
    const alt = Math.max(1, camR - R_MOON - hTerrain);
    const near = Math.max(0.5, Math.min(alt * 0.4, Math.max(1, camR - R_MOON - H_MAX_GLOBAL) * 0.9));
    const rMax = R_MOON + H_MAX_GLOBAL;
    const far = Math.sqrt(Math.max(0, camR * camR - (R_MOON - 9200) ** 2)) + Math.sqrt(rMax * rMax - (R_MOON - 9200) ** 2) + 1000;
    const f = 1 / Math.tan(FOV_Y / 2);
    proj.set(
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) / (near - far), (2 * far * near) / (near - far),
      0, 0, -1, 0,
    );

    const fi: FrameInfo = { camPos: st.camPos, viewRot: st.viewRot, proj, viewportHeight: h, fovY: FOV_Y, frame };
    const tiles = tree.update(fi);
    const P = h / (2 * Math.tan(FOV_Y / 2));

    scene.clear();
    if (sky.visible) {
      (skyMat.uniforms.uInvViewRot.value as Matrix3).copy(st.viewRot).transpose();
      skyMat.uniforms.uTanHalf.value = [Math.tan(FOV_Y / 2) * aspect, Math.tan(FOV_Y / 2)];
      scene.add(sky);
    }
    for (const n of tiles) scene.add(tree.meshFor(n, fi, P, LIGHT, LIGHT_PARAMS));
    renderer.render(scene, dummyCam);
    perf.renders++;
    perf.frameMs = performance.now() - t0;
  }
  requestAnimationFrame(render);

  // fps counter (only counts rendered frames; readable via window.__moon.perf)
  setInterval(() => {
    const now = performance.now();
    perf.fps = (perf.renders - perf.frames) / ((now - perf.lastFpsT) / 1000);
    perf.frames = perf.renders;
    perf.lastFpsT = now;
  }, 1000);
}

/** optional deep link: #lat,lon,dist_m[,heading_deg[,tilt_deg]] (no UI) */
function applyHash(c: GlobeControls) {
  const m = location.hash.replace('#', '').split(',').map(Number);
  if (m.length >= 3 && m.every((v) => Number.isFinite(v))) c.setView(m[0], m[1], m[2], m[3] ?? 0, m[4]);
}

main();
