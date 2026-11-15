import {
  BufferAttribute, BufferGeometry, DirectionalLight, Euler, GLSL3, Group, HemisphereLight, MathUtils,
  Matrix3, Matrix4, Mesh, PerspectiveCamera, Quaternion, RawShaderMaterial, Scene, Sphere, Texture,
  Vector2, Vector3, Vector4, WebGLRenderer, Raycaster, Ray, Object3D, type Light,
} from 'three';
import { latLonToDir, R_MOON } from './geom';
import type { SurfaceLocation, WalkTerrain } from './walkTerrain';
import { WalkGround, WALK_FAR } from './walkGround';
import { loadSoilMaps } from './lunarSoil';
import { BoulderField } from './boulderField';
import { describeRocks, loadRockAtlas } from './rockAtlas';
import { loadRockSamples } from './lunarRocks';
import type { LandingFrame } from './landingFlight';
import type { GlobeHeadset } from './globePicker';
import type { HelmetAudio } from './helmetAudio';
import { HandSamples } from './handSamples';
import { WristNavigator } from './wristNavigator';
import { bootPulse } from './bootHaptics';
import { WalkSuit } from './walkSuit';
import { WalkFootprints } from './walkFootprints';
import type { BootPose } from './walkFeet';
import { WalkDust } from './walkDust';
import { WalkGait, WalkTurn } from './walkGait';
import { skyFS } from './terrain/shaders';
import { SurfaceSunGlare } from './sunGlare';

interface WalkSite {
  /** Metres above the landing frame at local east (+X) and south (+Z). */
  height: WalkTerrain;
  seed: number;
  landingToBody: Matrix4;
  /** Local direction toward the Sun. */
  sun: Vector3;
  sky?: Texture;
  skyRotation?: Euler;
  starGain?: number;
  sunAngularRadius?: number;
  earth?: { direction: Vector3; angularRadius: number; sunDirection: Vector3; gmst: number; texture?: Texture };
}
export interface WalkOptions extends WalkSite {
  headset?: GlobeHeadset;
  audio: HelmetAudio;
  siteAt:(lat:number,lon:number)=>Promise<WalkSite>;
  onPrepared: (draw: (entry: LandingFrame) => void) => void;
  onArrived: () => void;
  onExit: () => void;
}

const eyeHeight = 1.65;
const worldUp = new Vector3(0, 1, 0);
const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight']);
const walkStyle = `
.walk-scene {position:fixed;inset:0;z-index:1000;background:#020304;color:#f1f2f3;font:500 14px/1.45 system-ui,sans-serif;}
.walk-scene canvas {display:block;width:100%;height:100%;outline:none;touch-action:none;cursor:grab;}
.walk-scene canvas:active {cursor:grabbing;}
.walk-scene .walk-bar {position:absolute;bottom:max(14px,env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);width:max-content;max-width:calc(100% - 24px);box-sizing:border-box;background:rgba(18,20,23,.9);border:1px solid #484b50;border-radius:12px;padding:10px 14px;display:grid;gap:6px;}
.walk-scene .walk-actions {display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.walk-scene button,.walk-scene a {font:inherit;color:inherit;touch-action:manipulation;}
.walk-scene button {border:1px solid #555b63;background:#25282d;border-radius:7px;padding:7px 11px;cursor:pointer;}
.walk-scene button.walk-enter {background:#eceef0;color:#101113;border-color:#eceef0;}
.walk-scene button:disabled {opacity:.55;cursor:default;}
.walk-scene .walk-help,.walk-scene .walk-status {margin:0;color:#c7cacf;font-size:12px;}
.walk-scene .walk-status:empty,.walk-scene .walk-bar[hidden] {display:none;}
.walk-scene .walk-touch {display:none;}
@media (pointer:coarse) {.walk-scene .walk-touch {display:inline-block;touch-action:none;}}
`;

function deadzone(value: number): number {
  const magnitude = Math.abs(value);
  return magnitude < 0.16 ? 0 : Math.sign(value) * (magnitude - 0.16) / 0.84;
}

function createSky(options: WalkSite, sun: Vector3) {
  const localToJ2000 = new Matrix3();
  if (options.skyRotation) {
    localToJ2000.setFromMatrix4(new Matrix4().makeRotationFromEuler(options.skyRotation)).transpose();
  }
  const earth = options.earth;
  const material = new RawShaderMaterial({
    glslVersion: GLSL3,
    defines: { WALK_SKY: 1 },
    depthTest: false,
    depthWrite: false,
    vertexShader: `
      precision highp float;
      in vec2 position;
      uniform mat4 viewMatrix, projectionMatrix;
      out vec3 vDirB;
      void main() {
        // One triangle per eye. Include the asymmetric optical center of each XR view.
        vec2 xy = (position + projectionMatrix[2].xy) /
                  vec2(projectionMatrix[0][0], projectionMatrix[1][1]);
        vDirB = transpose(mat3(viewMatrix)) * vec3(xy, -1.0);
        gl_Position = vec4(position, 1.0, 1.0);
      }
    `,
    fragmentShader: skyFS,
    uniforms: {
      uStars: { value: options.sky ?? null },
      uStarGain: { value: options.starGain ?? 1 },
      uBodyToJ2000: { value: localToJ2000 },
      uSun: { value: new Vector4(sun.x, sun.y, sun.z, options.sunAngularRadius ?? 0.00465) },
      uEarth: { value: earth ? new Vector4(earth.direction.x, earth.direction.y, earth.direction.z, earth.angularRadius) : new Vector4(0, 1, 0, 0) },
      uEarthSun: { value: earth?.sunDirection ?? sun },
      uEarthTex: { value: earth?.texture ?? null },
      uEarthTexReady: { value: earth?.texture ? 1 : 0 },
      uGmst: { value: earth?.gmst ?? 0 },
      uPixelAngle: { value: 0.001 },
    },
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 3, -1, -1, 3]), 2));
  // The clip-space attribute has two components, so give the render sorter explicit bounds.
  geometry.boundingSphere = new Sphere(new Vector3(), 1);
  const sky = new Mesh(geometry, material);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  sky.onBeforeRender = (renderer, _scene, camera) => {
    const h = renderer.xr.isPresenting
      ? (camera as PerspectiveCamera).viewport?.height ?? renderer.domElement.height
      : renderer.domElement.height;
    material.uniforms.uPixelAngle.value = 2 / (Math.max(1, h) * camera.projectionMatrix.elements[5]);
    material.uniformsNeedUpdate = true;
  };
  return sky;
}

/** Yield to the event loop (not throttled like timers in a background tab). */
function nextTask() {
  return new Promise<void>(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(0);
  });
}

/** Upload the scene's textures one per task: the first render would otherwise upload them all
 *  in one long frame, stalling the orbital landing flight that runs meanwhile. */
async function uploadTextures(renderer: WebGLRenderer, scene: Scene) {
  const textures = new Set<Texture>();
  const add = (value: unknown) => { if (value instanceof Texture) textures.add(value); };
  scene.traverse(object => {
    const material = (object as Mesh).material;
    for (const m of Array.isArray(material) ? material : material ? [material] : []) {
      for (const value of Object.values(m)) add(value);
      const uniforms = (m as RawShaderMaterial).uniforms;
      if (uniforms) for (const uniform of Object.values(uniforms)) add(uniform?.value);
    }
  });
  for (const texture of textures) {
    renderer.initTexture(texture);
    await nextTask();
  }
}

/** Draw the scene a few parts at a time, a task each, so the buffer uploads of the first frame
 *  are spread out too (the surface overlay is still transparent here). Lights stay on, so the
 *  programs compiled by compileAsync are the ones used. */
async function warmUp(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera) {
  const units: Object3D[] = [];
  for (const child of scene.children) {
    if (!child.visible || (child as Light).isLight) continue;
    if (child.children.length > 4) units.push(...child.children.filter(c => c.visible));
    else units.push(child);
  }
  for (const unit of units) unit.visible = false;
  try {
    for (let i = 0; i < units.length; i += 6) {
      const batch = units.slice(i, i + 6);
      for (const unit of batch) unit.visible = true;
      renderer.render(scene, camera);
      for (const unit of batch) unit.visible = false;
      await nextTask();
    }
  } finally {
    for (const unit of units) unit.visible = true;
  }
}

export function preloadSurface() {
  return Promise.all([loadRockSamples(),loadSoilMaps(),loadRockAtlas()]);
}

/** Warm everything a landing needs that doesn't depend on the renderer (assets + suit model). */
export function prefetchWalk() {
  return Promise.all([preloadSurface(), WalkSuit.preload()]);
}

/** Open an eye-level desktop preview. Headset permission is requested by Enter headset. */
export async function startWalk(container: HTMLElement, options: WalkOptions): Promise<void> {
  const renderer = options.headset?.renderer ?? new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  if (!options.headset) renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
  renderer.xr.enabled = true;
  renderer.xr.setFoveation(0);
  const camera = new PerspectiveCamera(70, 1, 0.10, WALK_FAR);
  camera.rotation.order = 'YXZ';
  const rig = new Group();
  rig.add(camera);
  const scene = new Scene();
  scene.add(rig);

  // Earthshine fills terrain shadows enough to navigate a landing on the night side.
  // The Sun is the real one for the selected time; direct sunlight also fades out while the
  // disc is hidden from the eye by terrain (crater rims, massifs; see SurfaceSunGlare).
  let site:WalkSite=options;
  const sun = options.sun.clone().normalize();
  const fill=new HemisphereLight(0xc7cddc,0x878991,sun.y>0?.28:.55);
  scene.add(fill);
  const sunlight = new DirectionalLight(0xfff5e6, sun.y > -0.005 ? 2.5 : 0);
  sunlight.position.copy(sun);
  renderer.shadowMap.enabled = sunlight.intensity > 0;
  sunlight.castShadow = renderer.shadowMap.enabled;
  sunlight.shadow.mapSize.set(1024, 1024);
  Object.assign(sunlight.shadow.camera, { left: -22, right: 22, bottom: -22, top: 22, near: 0.1, far: 100 });
  sunlight.shadow.camera.updateProjectionMatrix();
  sunlight.shadow.bias = -0.00025;
  sunlight.shadow.normalBias = 0.012;
  sunlight.shadow.autoUpdate = false;
  scene.add(sunlight, sunlight.target);
  let sky = createSky(options, sun);
  scene.add(sky);
  // Sun glare (same pass as the orbital view), drawn over the ground, rocks and suit
  const glare = new SurfaceSunGlare();
  scene.add(glare.mesh);
  const glareEye = new Vector3(), glareLook = new Vector3();
  /** direct sunlight and fill from the Sun's elevation and how much of it the eye can see */
  function applySunlight() {
    const lit = sun.y > -0.005 ? glare.visibility : 0;
    sunlight.intensity = 2.5 * lit;
    fill.intensity = .55 - .27 * lit;
  }
  glare.prime(new Vector3(0, site.height(0, 0) + eyeHeight, 0), sun, site.sunAngularRadius ?? 0.00465, site.height);
  applySunlight();
  let ground: WalkGround;
  let suit: WalkSuit;
  async function groundFor(at:WalkSite,x:number,z:number) {
    const [rocks,soil,atlas]=await preloadSurface();
    const field = new BoulderField(atlas, at.seed, at.height.coordinates);
    const next=new WalkGround(at.height,at.seed,1,rocks,soil,at.landingToBody,true,field);
    try {await next.prepareLanding(x,z);return next;}
    catch(error){next.dispose();throw error;}
  }
  try {
    [ground,suit]=await Promise.all([groundFor(site,0,0),WalkSuit.load()]);
  } catch (err) {
    sky.geometry.dispose();
    sky.material.dispose();
    glare.dispose();
    if (!options.headset) { renderer.dispose(); renderer.forceContextLoss(); }
    throw err;
  }
  const rockAtlas = await loadRockAtlas();
  const samples = new HandSamples(), wrist = new WristNavigator();
  scene.add(samples.group,wrist.group);
  const audio = options.audio;
  let prints = new WalkFootprints(ground,suit.outsoles);
  let dust = new WalkDust(prints);
  const sampleBed = {
    floorAt: (x:number,z:number) => prints.floorAt(x,z),
    impact: (x:number,z:number,diameter:number,speed:number,slide:Vector3) =>
      prints.impact(x,z,diameter,speed,slide.x,slide.z,dust),
  };
  scene.add(ground.group, dust.mesh, prints.group, suit.group);
  const overlay = document.createElement('section');
  overlay.className = 'walk-scene';
  overlay.setAttribute('aria-label', 'Lunar surface walk');
  const style = document.createElement('style');
  style.textContent = walkStyle;
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Lunar surface, first-person view');
  const bar = document.createElement('div');
  bar.className = 'walk-bar';
  bar.innerHTML = `<div class="walk-actions"><button type="button" class="walk-enter">Enter headset</button><button type="button" class="walk-touch">Hold to walk</button><button type="button" class="walk-exit">Exit VR</button></div><p class="walk-help walk-position"></p><p class="walk-help walk-controls"></p><p class="walk-status" role="status"></p>`;
  overlay.append(style, canvas, bar);
  overlay.style.opacity = '0';
  overlay.inert = true;
  bar.hidden = true;
  container.appendChild(overlay);
  const enter = bar.querySelector<HTMLButtonElement>('.walk-enter')!;
  const forward = bar.querySelector<HTMLButtonElement>('.walk-touch')!;
  const exit = bar.querySelector<HTMLButtonElement>('.walk-exit')!;
  const status = bar.querySelector<HTMLElement>('.walk-status')!;
  const help = bar.querySelector<HTMLElement>('.walk-controls')!;
  const positionLabel=bar.querySelector<HTMLElement>('.walk-position')!;
  const desktopControls = matchMedia('(pointer: coarse)').matches
    ? 'Drag to look around. Hold to walk forward.'
    : 'Drag to look around. Walk with WASD or the arrow keys. Hold Shift to run. Press Space to jump.';
  help.textContent = desktopControls+' Click or tap terrain to travel there.';
  const abort = new AbortController();
  const listener = { signal: abort.signal };
  let activeSession: XRSession | null = null;
  let pendingSession = false;
  let arriving = true;
  let closed = false;
  let touchForward = false;
  let activePointer: number | null = null;
  let pointerX = 0, pointerY = 0,downX=0,downY=0,dragged=false;
  const keys = new Set<string>();
  const stick = new Vector2();
  const gait = new WalkGait();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const forwardDir = new Vector3();
  const headOffset = new Vector3();
  const headOrientation = new Quaternion();
  const head = new Vector3();
  let trackingOriginPending = false;
  const turning = new WalkTurn();
  let floorOffset = 0;
  let targetX = 0, targetZ = 0;
  let desktopYaw = 0, desktopPitch = -0.12;
  let prevTime = 0;
  let supportCheck = 0;
  let shadowX = Infinity, shadowZ = Infinity;

  let jumpHeld = false;
  const gripPoints = [new Vector3(),new Vector3()];
  const grips: (Vector3 | undefined)[] = [undefined,undefined];
  const gripRotations = [new Quaternion(), new Quaternion()];
  const pads: (Gamepad | undefined)[] = [undefined,undefined];
  const eye = new Vector3(), gaze = new Vector3(), aimRay = new Ray();
  const floorAt = (x:number,z:number) => {
    const surface = ground.surfaceAt(x,z);
    return surface <= gait.supportY + gait.lift + .20 ? surface : ground.floorAt(x,z);
  };
  const bedAt = (boot:BootPose,scale:number) => {
    const {x,z} = boot.center;
    return floorAt(x,z) > ground.floorAt(x,z) + .015 ? null : prints.supportOffset(boot,scale);
  };
  let contactDt = 0;
  function loadSoil(boot:BootPose, scale:number) {
    if (boot.contact) {
      audio.step(boot.onStone,boot.impactSpeed);
      bootPulse(pads[boot.side < 0 ? 1 : 0],boot.onStone,boot.impactSpeed);
    }
    if (!boot.onStone) prints.press(boot,scale,contactDt,dust);
  }

  let anchorX=0,anchorZ=0,relocating=false,refreshing=false;
  let queuedHit:Vector3|undefined;
  let lastLocationTime=-Infinity;
  const regions: {origin:SurfaceLocation; frame:Matrix4; trail:ReturnType<WalkFootprints['takeTrail']>}[]=[];
  const latLon=(p:SurfaceLocation) => `${Math.abs(p.lat).toFixed(5)}°${p.lat<0?'S':'N'}  ${Math.abs(p.lon).toFixed(5)}°${p.lon<0?'W':'E'}`;
  const formatPosition=(p:SurfaceLocation) => `${latLon(p)} · ${Math.round(p.elevation).toLocaleString()} m elevation · ~${Math.round(p.resolution).toLocaleString()} m grid`;
  function localPoint(frame:Matrix4,point:SurfaceLocation) {
    const dir=new Vector3(...latLonToDir(point.lat,point.lon)).applyMatrix4(frame.clone().transpose());
    if(dir.y<=0)return;
    return new Vector2((R_MOON+point.elevation)*dir.x,(R_MOON+point.elevation)*dir.z);
  }
  function updateLighting(at:WalkSite) {
    sky.removeFromParent();sky.geometry.dispose();sky.material.dispose();
    sun.copy(at.sun).normalize();sky=createSky(at,sun);scene.add(sky);
    sunlight.castShadow=renderer.shadowMap.enabled=sun.y>-.005;
    applySunlight();
    shadowX=shadowZ=Infinity;
  }
  async function travelTo(hit:Vector3) {
    if(relocating || closed)return;
    if(refreshing){queuedHit=hit;return;}
    relocating=true;
    const destination=site.height.coordinates(hit.x,hit.z);
    status.textContent='Preparing terrain at '+formatPosition(destination);
    resetControls();
    let x=hit.x,z=hit.z;
    try {
      if(Math.hypot(x,z)>3500) {
        // Re-establish true local vertical on long journeys. Restore regolith if this is a return visit.
        const prior=regions.find(r=>{const v=localPoint(r.frame,destination);return v && v.length()<3000;});
        const origin=prior?.origin ?? destination;
        const next=await options.siteAt(origin.lat,origin.lon);
        if(closed)return;
        const coord=prior ? localPoint(next.landingToBody,destination)! : new Vector2();
        x=coord.x;z=coord.y;
        if(prior)await next.height.prepare(x,z);
        const newGround=await groundFor(next,x,z);
        if(closed){newGround.dispose();return;}
        const trail=prints.takeTrail();
        regions.push({origin:site.height.coordinates(0,0),frame:site.landingToBody,trail});
        // Transport the viewing direction between the two east/north frames.
        const entryForward=new Vector3(0,0,-1).applyAxisAngle(worldUp,activeSession?rig.rotation.y:desktopYaw)
          .transformDirection(site.landingToBody).transformDirection(next.landingToBody.clone().transpose());
        const yaw=Math.atan2(-entryForward.x,-entryForward.z);
        if(activeSession)rig.rotation.y=yaw;else desktopYaw=yaw;
        scene.remove(ground.group,prints.group,dust.mesh);
        samples.rebase();
        prints.dispose();dust.dispose();ground.dispose();
        site=next;ground=newGround;prints=new WalkFootprints(ground,suit.outsoles);dust=new WalkDust(prints);
        if(prior){prints.restoreTrail(prior.trail);regions.splice(regions.indexOf(prior),1);}
        scene.add(ground.group,prints.group,dust.mesh);updateLighting(site);
        anchorX=x;anchorZ=z;
      } else {
        const improved=await site.height.prepare(x,z);
        if(closed)return;
        if(improved || Math.hypot(x-anchorX,z-anchorZ)>80) {
          await ground.prepareLanding(x,z,improved);
          if(closed)return;
          prints.rebuildSurface();anchorX=x;anchorZ=z;
        }
      }
      targetX=x;targetZ=z;
      trackingOriginPending=!!activeSession;
      if(!activeSession)resetDesktop();
      suit.resetFeet();gait.reset();lastLocationTime=-Infinity;
      status.textContent='';
    } catch(error) {
      console.error('Surface travel failed',error);
      if(!closed)status.textContent='Terrain could not load. Try selecting the location again.';
    } finally {relocating=false;}
  }

  function resize() {
    if (renderer.xr.isPresenting || closed) return;
    const width = overlay.clientWidth || innerWidth;
    const height = overlay.clientHeight || innerHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (canvas.width !== Math.floor(width*renderer.getPixelRatio()) || canvas.height !== Math.floor(height*renderer.getPixelRatio())) {
      renderer.setSize(width, height, false);
    }
  }
  function resetControls() {
    keys.clear();
    gait.reset();
    jumpHeld = false;
    wrist.hide();
    turning.reset();
    suit.resetFeet();
    touchForward = false;
    activePointer = null;
  }
  function resetDesktop() {
    rig.position.set(targetX, ground.surfaceAt(targetX, targetZ, .12), targetZ);
    rig.rotation.set(0, 0, 0);
    camera.position.set(0, eyeHeight, 0);
    camera.rotation.set(desktopPitch, desktopYaw, 0, 'YXZ');
    resize();
  }
  window.addEventListener('resize', resize, listener);
  function suspendTools() {
    audio.pause(); samples.release(); wrist.hide(); pads.fill(undefined); resetControls();
  }
  function visibilityChanged() {
    if (activeSession ? activeSession.visibilityState !== 'visible' : document.hidden) suspendTools();
    else audio.start();
  }
  window.addEventListener('blur', suspendTools, listener);
  window.addEventListener('focus', visibilityChanged, listener);
  document.addEventListener('visibilitychange', visibilityChanged, listener);
  overlay.addEventListener('pointerdown', () => audio.start(), listener);
  canvas.addEventListener('pointerdown', e => {
    if (arriving || activeSession || activePointer !== null || e.button !== 0) return;
    activePointer = e.pointerId;
    pointerX = downX = e.clientX;
    pointerY = downY = e.clientY;
    dragged=false;
    canvas.setPointerCapture(e.pointerId);
    canvas.focus();
  }, listener);
  canvas.addEventListener('pointermove', e => {
    if (e.pointerId !== activePointer || activeSession) return;
    if(!dragged && Math.hypot(e.clientX-downX,e.clientY-downY)<=5)return;
    dragged=true;
    desktopYaw -= (e.clientX - pointerX) * 0.004;
    desktopPitch = MathUtils.clamp(desktopPitch - (e.clientY - pointerY) * 0.004, -1.5, 1.5);
    pointerX = e.clientX;
    pointerY = e.clientY;
    camera.rotation.set(desktopPitch, desktopYaw, 0, 'YXZ');
  }, listener);
  const pointerRay=new Raycaster();
  function terrainAtPixel(x:number,y:number) {
    const rect=canvas.getBoundingClientRect();
    pointerRay.setFromCamera(new Vector2(2*(x-rect.left)/rect.width-1,1-2*(y-rect.top)/rect.height),camera);
    return ground.intersect(pointerRay.ray);
  }
  canvas.addEventListener('pointerup',e=>{
    if(activePointer!==e.pointerId || dragged || Math.hypot(e.clientX-downX,e.clientY-downY)>5 || activeSession || relocating)return;
    const hit=terrainAtPixel(e.clientX,e.clientY);
    if(hit)void travelTo(hit);
  },listener);
  canvas.addEventListener('pointercancel',()=>{activePointer=null;},listener);
  canvas.addEventListener('lostpointercapture', () => { activePointer = null; }, listener);
  forward.addEventListener('pointerdown', e => {
    forward.setPointerCapture(e.pointerId);
    touchForward = true;
  }, listener);
  forward.addEventListener('lostpointercapture', () => { touchForward = false; }, listener);
  window.addEventListener('keydown', e => {
    if (!document.hidden) audio.start();
    if (e.metaKey || e.ctrlKey || e.altKey || activeSession) return;
    if (e.code === 'Escape') { void leave(); return; }
    if (arriving) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) gait.requestJump();
      return;
    }
    if (!movementKeys.has(e.code) && e.code !== 'ShiftLeft' && e.code !== 'ShiftRight') return;
    e.preventDefault();
    keys.add(e.code);
  }, listener);
  window.addEventListener('keyup', e => { keys.delete(e.code); }, listener);

  function showHeadsetHint() {
    status.textContent = 'For VR, open this site directly in a WebXR headset browser, such as Meta Quest Browser.';
    if (self !== top) {
      const open = document.createElement('a');
      open.href = location.href;
      open.target = '_blank';
      open.rel = 'noopener';
      open.textContent = 'Open standalone';
      status.append(' ', open);
    }
  }
  async function checkSupport() {
    const check = ++supportCheck;
    enter.disabled = true;
    let supported = false;
    try { supported = !!await navigator.xr?.isSessionSupported('immersive-vr'); } catch { /* Embedded or blocked. */ }
    if (closed || check !== supportCheck || pendingSession || activeSession) return;
    enter.disabled = !supported;
    if (supported) {
      status.textContent = 'Quest 2 · Left stick moves, left grip runs, right stick turns, A jumps and right trigger sprints. Right grip holds a loose rock. Hold B to aim, release to mark. Raise your left wrist to read it.';
    } else {
      showHeadsetHint();
    }
  }
  function sessionEnded() {
    activeSession?.removeEventListener('visibilitychange',visibilityChanged);
    activeSession = null;
    pendingSession = false;
    samples.release(); pads.fill(undefined);
    resetControls();
    if (closed) return;
    enter.textContent = 'Enter headset';
    help.textContent = desktopControls+' Click or tap terrain to travel there.';
    resetDesktop();
    void checkSupport();
  }
  async function toggleXR() {
    if (pendingSession || closed) return;
    if (activeSession) {
      pendingSession = true;
      enter.disabled = true;
      try {
        await activeSession.end();
      } catch {
        pendingSession = false;
        enter.disabled = false;
        status.textContent = 'Use the headset menu to leave VR, or try Exit headset again.';
      }
      return;
    }
    if (!navigator.xr) return;
    audio.start();
    pendingSession = true;
    enter.disabled = true;
    status.textContent = 'Opening headset session…';
    let session: XRSession | undefined;
    try {
      // Keep requestSession directly inside this click's user activation.
      session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
      if (closed) { await session.end(); return; }
      activeSession = session;
      session.addEventListener('visibilitychange',visibilityChanged);
      let reference: XRReferenceSpaceType = 'local-floor';
      try { await session.requestReferenceSpace(reference); }
      catch { reference = 'local'; }
      if (closed || activeSession !== session) { await session.end().catch(() => {}); return; }
      renderer.xr.setReferenceSpaceType(reference);
      floorOffset = reference === 'local-floor' ? 0 : eyeHeight;
      resetControls();
      rig.rotation.y = desktopYaw;
      trackingOriginPending = true;
      await renderer.xr.setSession(session);
      if (closed || activeSession !== session) return;
      enter.disabled = false;
      enter.textContent = 'Exit headset';
      visibilityChanged();
      status.textContent = '';
      help.textContent = 'Left stick moves. Hold left grip to run. A jumps. Right stick turns. Hold the right trigger to sprint. Right grip picks up a rock within reach. Hold B and release to mark a ridge. Raise your left wrist to check it.';
    } catch (error) {
      await session?.end().catch(() => {});
      if (!closed) {
        activeSession = null;
        enter.textContent = 'Enter headset';
        enter.disabled = false;
        status.textContent = error instanceof DOMException && error.name === 'SecurityError'
          ? 'Open this site directly in your headset browser and allow immersive VR.'
          : 'VR could not start. Check headset permissions and try Enter headset again.';
        resetDesktop();
      }
    } finally {
      pendingSession = false;
    }
  }
  async function leave() {
    if (closed) return;
    closed = true;
    abort.abort();
    renderer.setAnimationLoop(null);
    if (activeSession) await activeSession.end().catch(() => {});
    renderer.xr.removeEventListener('sessionend', sessionEnded);
    regions.length=0;
    sky.geometry.dispose();
    sky.material.dispose();
    glare.dispose();
    sunlight.dispose();
    samples.dispose(); wrist.dispose();
    suit.dispose();
    prints.dispose();
    dust.dispose();
    ground.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    overlay.remove();
    options.onExit();
  }
  renderer.xr.addEventListener('sessionend', sessionEnded);
  navigator.xr?.addEventListener('devicechange', checkSupport, listener);
  exit.addEventListener('click', leave, listener);
  enter.addEventListener('click', toggleXR, listener);
  resetDesktop();
  // The globe picker keeps drawing while the surface loads. Take over its session
  // and frame loop together so the wearer arrives without a second permission prompt.
  const headset = options.headset;
  if (headset && renderer.xr.getSession() === headset.session && renderer.xr.isPresenting) {
    activeSession = headset.session;
    activeSession.addEventListener('visibilitychange', visibilityChanged);
    floorOffset = headset.reference === 'local-floor' ? 0 : eyeHeight;
    trackingOriginPending = true;
    enter.textContent = 'Exit headset';
    enter.disabled = false;
    overlay.style.opacity = '1';
    overlay.inert = false;
    bar.hidden = false;
    arriving = false;
    options.onArrived();
    visibilityChanged();
    renderer.setAnimationLoop(walkFrame);
    return;
  }
  // Upload the walking scene behind the globe before starting the dissolve.
  // (textures, programs and buffers in separate tasks, so the flight keeps animating)
  await uploadTextures(renderer, scene);
  await renderer.compileAsync(scene,camera);
  await warmUp(renderer, scene, camera);
  renderer.render(scene, camera);
  options.onPrepared(entry => {
    if (closed || entry.opacity <= 0) return;
    const z = entry.distance * Math.sin(entry.tilt) * (1-entry.approach);
    const y = entry.distance * Math.cos(entry.tilt) * (1-entry.approach)
      + (ground.floorAt(0,0) + eyeHeight) * entry.approach;
    rig.position.set(0,0,0);
    camera.position.set(0, Math.max(ground.floorAt(0,z)+eyeHeight, y), z);
    camera.rotation.set(entry.tilt-Math.PI/2,0,0,'YXZ');
    camera.fov = entry.fov;
    camera.updateProjectionMatrix();
    renderer.render(scene,camera);
    overlay.style.opacity = String(entry.opacity);
    if (entry.arrived) {
      arriving = false;
      options.onArrived();
      resetDesktop();
      overlay.inert = false;
      bar.hidden = false;
      canvas.focus({preventScroll:true});
      void checkSupport();
      renderer.setAnimationLoop(walkFrame);
    }
  });

  function walkFrame(time:number, frame?:XRFrame) {
    if (closed) return;
    const dt = prevTime ? MathUtils.clamp((time - prevTime) / 1000, 0, 0.1) : 0;
    prevTime = time;
    stick.set(0, 0);
    let turn = 0, trackedHeight = eyeHeight;
    let running = keys.has('ShiftLeft') || keys.has('ShiftRight');
    let jumpDown = false, sprint = 0, grab = false, mark = false, gotRay = false;
    pads.fill(undefined);
    grips.fill(undefined);
    if (frame && activeSession) {
      const space = renderer.xr.getReferenceSpace();
      const pose = space && frame.getViewerPose(space);
      if (!pose || activeSession.visibilityState !== 'visible') {
        samples.release(); wrist.hide(); suit.resetFeet();
        return;
      }
      const { position, orientation } = pose.transform;
      trackedHeight = position.y + floorOffset;
      headOffset.set(position.x, 0, position.z).applyAxisAngle(worldUp, rig.rotation.y);
      if (trackingOriginPending) {
        rig.position.x = targetX - headOffset.x;
        rig.position.z = targetZ - headOffset.z;
        trackingOriginPending = false;
      }
      headOrientation.set(orientation.x, orientation.y, orientation.z, orientation.w);
      forwardDir.set(0, 0, -1).applyQuaternion(headOrientation).applyAxisAngle(worldUp, rig.rotation.y);
      if (forwardDir.y < -.78 || Math.hypot(forwardDir.x,forwardDir.z) < .12) {
        // Looking straight at the soles still has a well-defined heading from the headset's right axis.
        forwardDir.set(1,0,0).applyQuaternion(headOrientation).applyAxisAngle(worldUp,rig.rotation.y);
        forwardDir.set(forwardDir.z,0,-forwardDir.x);
      }
      for (const input of activeSession.inputSources) {
        const pad = input.gamepad;
        if (input.handedness !== 'none') pads[input.handedness === 'right' ? 1 : 0] = pad ?? undefined;
        if (pad?.mapping === 'xr-standard') {
          if (input.handedness === 'right') {
            jumpDown = !!pad.buttons[4]?.pressed;
            mark = !!pad.buttons[5]?.pressed;
            grab = !!pad.buttons[1]?.pressed;
            const trigger = pad.buttons[0];
            const pressure = trigger?.value ?? (trigger?.pressed ? 1 : 0);
            sprint = Math.max(0, (pressure - .12) / .88);
          }
          if (input.handedness === 'left') running = !!pad.buttons[1]?.pressed;
        }
        const gripPose = input.gripSpace && space && frame.getPose(input.gripSpace, space);
        if (gripPose && input.handedness !== 'none') {
          const index = input.handedness === 'right' ? 1 : 0;
          const p = gripPose.transform.position;
          grips[index] = gripPoints[index].set(p.x,p.y,p.z);
          gripRotations[index].copy(gripPose.transform.orientation);
        }
        if (input.handedness === 'right' && space && input.targetRaySpace) {
          const aim = frame.getPose(input.targetRaySpace,space);
          if (aim) {
            gotRay = true; aimRay.origin.copy(aim.transform.position);
            aimRay.direction.set(0,0,-1).applyQuaternion(aim.transform.orientation);
          }
        }
        const axes = pad?.axes;
        if (!axes || axes.length < 2) continue;
        const offset = axes.length >= 4 ? 2 : 0;
        if (input.handedness === 'right') turn = axes[offset];
        else stick.set(deadzone(axes[offset]), -deadzone(axes[offset + 1]));
      }
      if (sprint > 0 && stick.lengthSq() === 0) stick.y = 1;
      if (jumpDown && !jumpHeld) gait.requestJump();
      jumpHeld = jumpDown;
      const radians = turning.advance(deadzone(turn), dt);
      if (radians) {
        // Rotate about the wearer's current position, including physical travel from the origin.
        rig.position.add(headOffset);
        headOffset.applyAxisAngle(worldUp, radians);
        rig.position.sub(headOffset);
        rig.rotation.y += radians;
        forwardDir.applyAxisAngle(worldUp, radians);
      }
    } else {
      if (activeSession) return;
      headOffset.set(0, 0, 0);
      camera.getWorldDirection(forwardDir);
      const left = keys.has('KeyA') || keys.has('ArrowLeft');
      const right = keys.has('KeyD') || keys.has('ArrowRight');
      const up = keys.has('KeyW') || keys.has('ArrowUp') || touchForward;
      const down = keys.has('KeyS') || keys.has('ArrowDown');
      stick.set(Number(right) - Number(left), Number(up) - Number(down));
    }

    forwardDir.y = 0;
    if (forwardDir.lengthSq() > 1e-6) forwardDir.normalize();
    else forwardDir.set(0, 0, -1).applyAxisAngle(worldUp, rig.rotation.y);
    if (stick.lengthSq() > 1) stick.normalize();
    head.copy(rig.position).add(headOffset);
    const east = forwardDir.x * stick.y - forwardDir.z * stick.x;
    const south = forwardDir.z * stick.y + forwardDir.x * stick.x;
    if(relocating){renderer.render(scene,camera);return;}
    // Short substeps resolve the surface crossing even when the render cadence varies.
    const steps = Math.ceil(dt * 120);
    if (!steps) gait.supportY = ground.surfaceAt(head.x, head.z, .12);
    let landedJump = false;
    for (let i = 0; i < steps; i++) {
      if (gait.step(head, east, south, dt / steps, ground, running, sprint) === 'landing') landedJump = true;
    }
    contactDt = dt;
    const travelX = head.x-targetX, travelZ = head.z-targetZ;
    targetX = head.x;
    targetZ = head.z;
    rig.position.x = targetX - headOffset.x;
    rig.position.z = targetZ - headOffset.z;
    ground.update(targetX, targetZ);
    const lift = reducedMotion.matches && !gait.jumping && gait.lift < .10 ? 0 : gait.lift;
    const compression = reducedMotion.matches ? 0 : gait.compression;
    rig.position.y = gait.supportY + lift - compression + (activeSession ? floorOffset : 0);
    for (let i=0;i<grips.length;i++) {
      if (grips[i]) {
        grips[i]!.applyQuaternion(rig.quaternion).add(rig.position);
        gripRotations[i].premultiply(rig.quaternion);
      }
    }
    if (activeSession) {
      eye.set(targetX,rig.position.y+trackedHeight-floorOffset,targetZ);
      gaze.set(0,0,-1).applyQuaternion(headOrientation).applyQuaternion(rig.quaternion);
      if (gotRay) {
        aimRay.origin.applyQuaternion(rig.quaternion).add(rig.position);
        aimRay.direction.applyQuaternion(rig.quaternion);
      }
      samples.hand(ground,grips[1],gripRotations[1],grab,dt);
      wrist.aim(mark,gotRay ? aimRay : undefined,eye,ground,site.height,targetX,targetZ,time);
      wrist.wrist(grips[0],gripRotations[0],eye,gaze,site.height,targetX,targetZ,samples.inspection,time);
    }
    samples.advance(ground,dt,sampleBed);
    audio.update(Math.hypot(travelX,travelZ)/Math.max(.001,dt),dt);
    suit.update(targetX,gait.supportY+gait.lift,targetZ,forwardDir,trackedHeight,
      travelX,travelZ,dt,gait.inFlight,gait.lift,gait.jumping || landedJump,floorAt,grips,loadSoil,gait.touchdownSpeed,bedAt);
    dust.update(dt);
    prints.update(targetX,targetZ);
    // The static rocks need a new shadow map only when the nearby patch changes.
    if (sunlight.castShadow && (Math.abs(targetX - shadowX) > 2 || Math.abs(targetZ - shadowZ) > 2)) {
      shadowX = targetX; shadowZ = targetZ;
      sunlight.target.position.set(targetX, ground.floorAt(targetX, targetZ), targetZ);
      sunlight.position.copy(sunlight.target.position).addScaledVector(sun, 50);
      sunlight.shadow.needsUpdate = true;
    }
    if(time-lastLocationTime>300) {
      const position = site.height.coordinates(targetX,targetZ);
      positionLabel.textContent = formatPosition(position) + ' · ' + describeRocks(rockAtlas.read(position.lat, position.lon));
      lastLocationTime=time;
    }
    if(!relocating && !refreshing && Math.hypot(targetX-anchorX,targetZ-anchorZ)>160) {
      if(Math.hypot(targetX,targetZ)>3500)void travelTo(new Vector3(targetX,0,targetZ));
      else {
        refreshing=true;
        const x=targetX,z=targetZ;
        void (async()=>{
          try {
            const improved=await site.height.prepare(x,z);
            if(closed)return;
            await ground.prepareLanding(x,z,improved);
            if(!closed){prints.rebuildSurface();anchorX=x;anchorZ=z;shadowX=Infinity;}
          } finally {
            refreshing=false;
            if(queuedHit){const hit=queuedHit;queuedHit=undefined;void travelTo(hit);}
          }
        })().catch(error=>console.warn('Could not refine walk terrain',error));
      }
    }
    sky.material.uniforms.uStars.value = options.sky ?? null;
    camera.getWorldPosition(glareEye);
    camera.getWorldDirection(glareLook);
    glare.update(glareEye, sun, site.sunAngularRadius ?? 0.00465, site.height, glareLook, dt);
    applySunlight();
    renderer.render(scene, camera);
  }
}
