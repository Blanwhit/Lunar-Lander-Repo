// Sun glare: an additive full-screen pass drawn after the terrain, so the glare spills over
// the lunar limb / horizon like lens glare does. Bright aureole + wide veil + six thin
// diffraction spikes, scaled by how much of the solar disc the camera can actually see
// (one ray marched over the loaded terrain per frame; see sunVisibleFraction).
import { AdditiveBlending, BufferAttribute, BufferGeometry, GLSL3, Matrix3, Mesh, PerspectiveCamera, RawShaderMaterial, Sphere, Vector3 } from 'three';
import { H_MAX_GLOBAL, H_MIN_GLOBAL, R_MOON, type Vec3 } from './geom';

const glareVS = /* glsl */ `
precision highp float;
in vec2 position;
uniform vec2 uTanHalf;      // (tan(fovx/2), tan(fovy/2))
out vec2 vT;                // view-space tangent-plane coordinates (z = -1)
void main() {
  vT = position * uTanHalf;
  gl_Position = vec4(position, 1.0, 1.0);
}
`;

// Surface walk (incl. WebXR stereo): one full-screen triangle per eye; the tangent-plane
// coordinates include the eye's asymmetric projection, and the Sun is moved into view space
// per eye (it is a constant, so it is passed down as flat varyings).
const surfaceGlareVS = /* glsl */ `
precision highp float;
in vec2 position;
uniform mat4 viewMatrix, projectionMatrix;
uniform vec3 uSunW;         // world (landing frame) direction towards the Sun (unit)
out vec2 vT;
flat out vec3 vSunV;
flat out vec2 vSunT;
void main() {
  vT = (position + projectionMatrix[2].xy) / vec2(projectionMatrix[0][0], projectionMatrix[1][1]);
  vSunV = normalize(mat3(viewMatrix) * uSunW);
  vSunT = vSunV.z < -1e-6 ? vSunV.xy / -vSunV.z : vSunV.xy * 1e3;
  gl_Position = vec4(position, 1.0, 1.0);
}
`;

const glareFS = /* glsl */ `
precision highp float;
in vec2 vT;
#ifdef SURFACE_GLARE
flat in vec3 vSunV;
flat in vec2 vSunT;
#define uSunV vSunV
#define uSunT vSunT
#else
uniform vec3 uSunV;         // Sun direction in view space (unit)
uniform vec2 uSunT;         // Sun on the tangent plane: uSunV.xy / -uSunV.z
#endif
uniform float uSunR;        // angular radius (rad)
uniform float uVis;         // visible fraction of the disc, 0..1
uniform float uPix;         // angular size of one pixel (rad)
out vec4 fragColor;

const float TAU = 6.28318531;
const float RAYS = 6.0;

void main() {
  vec3 d = normalize(vec3(vT, -1.0));
  float ang = acos(clamp(dot(d, uSunV), -1.0, 1.0));
  float x = max(ang / uSunR, 1.0);                       // distance in solar radii (>= 1)
  // aureole (bright core, ~1 deg) + veil (scattering in the optics, fades over ~15 deg)
  float g = 0.9 * exp(-(x - 1.0) * 0.3) + 0.6 * pow(x, -1.0);
  // diffraction spikes: perpendicular distance to the nearest of RAYS screen-space rays
  vec2 q = vT - uSunT;
  float r = length(q);
  float a = mod(atan(q.y, q.x) + 0.3, TAU / RAYS) - 0.5 * TAU / RAYS;
  float perp = r * abs(sin(a));
  float w = 0.9 * uPix + r * 0.0025;                     // thin, widening slightly outwards
  float spike = exp(-(perp * perp) / (w * w)) * 0.6 * pow(x, -0.55) * smoothstep(0.35, 0.05, r);
  vec3 c = vec3(1.0, 0.93, 0.83) * g + vec3(1.0, 0.97, 0.92) * spike;
  fragColor = vec4(c * uVis, 1.0);
}
`;

const COS_70 = Math.cos((70 * Math.PI) / 180);

export class SunGlare {
  readonly mesh: Mesh;
  private mat: RawShaderMaterial;
  private vis = 0;

  constructor(geometry: BufferGeometry) {
    this.mat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: glareVS,
      fragmentShader: glareFS,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: AdditiveBlending,
      uniforms: {
        uTanHalf: { value: [1, 1] },
        uSunV: { value: new Vector3(0, 0, -1) },
        uSunT: { value: [0, 0] },
        uSunR: { value: 0.00465 },
        uVis: { value: 0 },
        uPix: { value: 0.001 },
      },
    });
    this.mesh = new Mesh(geometry, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1000; // after the terrain
  }

  /**
   * Update for this frame. Returns true while the visibility is still easing (keep rendering).
   * @param toSun      unit direction camera -> Sun (body frame)
   * @param sunR       angular radius of the Sun (rad)
   * @param visibility visible fraction of the disc (0..1); only called (it marches a ray over
   *                   the terrain) when the pass can draw, i.e. the Sun is near the view
   */
  update(viewRot: Matrix3, toSun: Vector3, sunR: number, visibility: () => number, tanHalf: [number, number], pixAngle: number, dt: number): boolean {
    const v = toSun.clone().applyMatrix3(viewRot);
    const inView = -v.z > COS_70;
    const target = inView ? visibility() : 0;
    this.vis += (target - this.vis) * (1 - Math.exp(-dt * 14));
    if (Math.abs(target - this.vis) < 0.004) this.vis = target;
    const u = this.mat.uniforms;
    (u.uSunV.value as Vector3).copy(v);
    u.uSunT.value = v.z < -1e-6 ? [v.x / -v.z, v.y / -v.z] : [v.x * 1e3, v.y * 1e3];
    u.uSunR.value = sunR;
    u.uVis.value = this.vis;
    u.uTanHalf.value = tanHalf;
    u.uPix.value = pixAngle;
    // skip the pass when nothing would show: hidden, or the Sun > 70 deg off the view axis
    // (the veil is < 1/500 there, below one 8-bit step)
    this.mesh.visible = this.vis > 0.002 && inView;
    return this.vis !== target;
  }
}

/** fraction of a disc of angular radius r (rad) above a straight horizon at signed margin m */
function discFraction(m: number, r: number): number {
  const h = Math.max(-1, Math.min(1, m / r));
  return 0.5 + (h * Math.sqrt(1 - h * h) + Math.asin(h)) / Math.PI;
}

/**
 * Visible fraction of the solar disc from `cam` (body frame, m) looking along unit `d`.
 * One ray is marched through the terrain shell; the smallest clearance angle
 * (height above the ground / range) acts as a local horizon for the disc.
 */
export function sunVisibleFraction(cam: Vec3, d: Vector3, sunR: number, heightAt: (dir: Vec3) => number | null): number {
  const o = new Vector3(...cam);
  const b = o.dot(d), oo = o.lengthSq();
  const rOut = R_MOON + H_MAX_GLOBAL, rIn = R_MOON + H_MIN_GLOBAL;
  const discOut = b * b - (oo - rOut * rOut);
  if (discOut <= 0) return 1;
  const tExit = -b + Math.sqrt(discOut);
  if (tExit <= 0) return 1; // shell behind the camera
  const discIn = b * b - (oo - rIn * rIn);
  if (discIn > 0 && -b - Math.sqrt(discIn) > 0) return 0; // straight through the Moon
  const t0 = Math.max(0, -b - Math.sqrt(discOut));
  let margin = Infinity;
  const p = new Vector3();
  const dir: Vec3 = [0, 0, 0];
  for (let t = Math.max(t0, 1); t < tExit; t += Math.max(2, t * 0.01)) {
    p.copy(o).addScaledVector(d, t);
    const r = p.length();
    dir[0] = p.x / r; dir[1] = p.y / r; dir[2] = p.z / r;
    const m = (r - R_MOON - (heightAt(dir) ?? 0)) / t;
    if (m < margin) {
      margin = m;
      if (margin < -sunR) return 0;
    }
  }
  return margin === Infinity ? 1 : discFraction(margin, sunR);
}

const COS_100 = Math.cos((100 * Math.PI) / 180);

/**
 * The same glare for the surface walk (desktop preview and WebXR). The visible fraction of
 * the disc comes from a ray marched over the walk terrain towards the Sun's azimuth: the
 * highest terrain elevation angle along it is the local horizon (crater rims, massifs, and
 * the curvature drop, which the walk heights already include).
 */
export class SurfaceSunGlare {
  readonly mesh: Mesh;
  private mat: RawShaderMaterial;
  private vis = 0;
  private target = 0;
  private sinceCheck = Infinity;
  private readonly checkedAt = new Vector3(Infinity, 0, 0);
  private readonly checkedSun = new Vector3();
  private readonly look = new Vector3();

  constructor() {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 3, -1, -1, 3]), 2));
    geometry.boundingSphere = new Sphere(new Vector3(), 1);
    this.mat = new RawShaderMaterial({
      glslVersion: GLSL3,
      defines: { SURFACE_GLARE: 1 },
      vertexShader: surfaceGlareVS,
      fragmentShader: glareFS,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: AdditiveBlending,
      uniforms: {
        uSunW: { value: new Vector3(0, 1, 0) },
        uSunR: { value: 0.00465 },
        uVis: { value: 0 },
        uPix: { value: 0.001 },
      },
    });
    this.mesh = new Mesh(geometry, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1000; // after the ground, rocks and suit
    this.mesh.visible = false;
    this.mesh.onBeforeRender = (renderer, _scene, camera) => {
      const h = renderer.xr.isPresenting
        ? (camera as PerspectiveCamera).viewport?.w ?? renderer.domElement.height
        : renderer.domElement.height;
      this.mat.uniforms.uPix.value = 2 / (Math.max(1, h) * camera.projectionMatrix.elements[5]);
      this.mat.uniformsNeedUpdate = true;
    };
  }

  /**
   * @param eye     eye position in the landing frame (m)
   * @param sun     unit direction towards the Sun in the landing frame
   * @param sunR    angular radius of the Sun (rad)
   * @param heightAt walk terrain height (m, landing frame) at local (x, z)
   * @param forward current view direction (for skipping the pass when the Sun is far behind)
   */
  update(eye: Vector3, sun: Vector3, sunR: number, heightAt: (x: number, z: number) => number, forward: Vector3, dt: number) {
    // the march is cheap but not free: redo it when the eye or the Sun moved, or 4x a second
    this.sinceCheck += dt;
    if (this.sinceCheck > 0.25 || this.checkedAt.distanceToSquared(eye) > 0.25 || this.checkedSun.dot(sun) < 0.999999) {
      this.sinceCheck = 0;
      this.checkedAt.copy(eye);
      this.checkedSun.copy(sun);
      this.target = surfaceSunVisibleFraction(eye, sun, sunR, heightAt);
    }
    this.vis += (this.target - this.vis) * (1 - Math.exp(-dt * 14));
    if (Math.abs(this.target - this.vis) < 0.004) this.vis = this.target;
    const u = this.mat.uniforms;
    (u.uSunW.value as Vector3).copy(sun);
    u.uSunR.value = sunR;
    u.uVis.value = this.vis;
    this.look.copy(forward).normalize();
    this.mesh.visible = this.vis > 0.002 && this.look.dot(sun) > COS_100;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

/** visible fraction of the solar disc from `eye` over the walk terrain (see SurfaceSunGlare) */
export function surfaceSunVisibleFraction(eye: Vector3, sun: Vector3, sunR: number, heightAt: (x: number, z: number) => number): number {
  const horiz = Math.hypot(sun.x, sun.z);
  const elev = Math.atan2(sun.y, horiz);
  if (horiz < 1e-6) return elev > 0 ? 1 : 0;
  const ux = sun.x / horiz, uz = sun.z / horiz;
  let margin = Infinity;
  for (let t = 2; t < 60000; t += Math.max(2, t * 0.04)) {
    const m = elev - Math.atan2(heightAt(eye.x + ux * t, eye.z + uz * t) - eye.y, t);
    if (m < margin) {
      margin = m;
      if (margin < -sunR) return 0;
    }
  }
  return discFraction(margin, sunR);
}
