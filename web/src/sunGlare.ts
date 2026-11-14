// Sun glare: an additive full-screen pass drawn after the terrain, so the glare spills over
// the lunar limb / horizon like lens glare does. Bright aureole + wide veil + six thin
// diffraction spikes, scaled by how much of the solar disc the camera can actually see
// (one ray marched over the loaded terrain per frame; see sunVisibleFraction).
import { AdditiveBlending, BufferGeometry, GLSL3, Matrix3, Mesh, RawShaderMaterial, Vector3 } from 'three';
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

const glareFS = /* glsl */ `
precision highp float;
in vec2 vT;
uniform vec3 uSunV;         // Sun direction in view space (unit)
uniform vec2 uSunT;         // Sun on the tangent plane: uSunV.xy / -uSunV.z
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
   * @param toSun   unit direction camera -> Sun (body frame)
   * @param sunR    angular radius of the Sun (rad)
   * @param target  visible fraction of the disc (0..1)
   */
  update(viewRot: Matrix3, toSun: Vector3, sunR: number, target: number, tanHalf: [number, number], pixAngle: number, dt: number): boolean {
    this.vis += (target - this.vis) * (1 - Math.exp(-dt * 14));
    if (Math.abs(target - this.vis) < 0.004) this.vis = target;
    const v = toSun.clone().applyMatrix3(viewRot);
    const u = this.mat.uniforms;
    (u.uSunV.value as Vector3).copy(v);
    u.uSunT.value = v.z < -1e-6 ? [v.x / -v.z, v.y / -v.z] : [v.x * 1e3, v.y * 1e3];
    u.uSunR.value = sunR;
    u.uVis.value = this.vis;
    u.uTanHalf.value = tanHalf;
    u.uPix.value = pixAngle;
    // skip the pass when nothing would show: hidden, or the Sun > 70 deg off the view axis
    // (the veil is < 1/500 there, below one 8-bit step)
    this.mesh.visible = this.vis > 0.002 && -v.z > COS_70;
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
