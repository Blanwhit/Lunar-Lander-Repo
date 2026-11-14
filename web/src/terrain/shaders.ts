// Terrain shaders (GLSL ES 3.0, used with THREE.RawShaderMaterial).
//
// Precision strategy (no jitter at 5 m/px close to the surface): positions are never
// formed in absolute body coordinates on the GPU. The CPU (float64) supplies
//   uOrigin = R * dirC - cameraPos   (tile reference point relative to the camera)
// and the shader adds the *small* offset R*(dir - dirC) + h*dir, which is evaluated
// with cancellation-free identities so it keeps full float32 relative precision.

export const terrainVS = /* glsl */ `
precision highp float;
precision highp int;
precision highp usampler2D;

in vec3 grid;               // (i, j, skirt) with i, j in [0, MESH_N]

uniform mat4 uProj;
uniform mat3 uViewRot;      // body frame -> view (camera at origin)
uniform vec3 uN, uU, uV;    // face axes
uniform vec4 uTile;         // (ac, bc, span, meshN) : tile centre in face coords
uniform vec3 uCC;           // N + tan(pi/4 ac) U + tan(pi/4 bc) V   (from float64)
uniform vec3 uDirC;         // normalize(uCC)
uniform vec3 uOrigin;       // R * uDirC - camPos  (float64 on CPU)
uniform vec2 uTanC;         // (tan(pi/4 ac), tan(pi/4 bc))
uniform vec2 uCosC;         // (cos(pi/4 ac), cos(pi/4 bc))
uniform usampler2D uHeight; // R16UI, GRID x GRID
uniform vec2 uHQ;           // (base, step)
uniform vec2 uMorph;        // (start, end) distance
uniform float uSkirt;       // skirt depth (m)
uniform float uR;

out vec2 vUv;               // tile-local [0,1]
out vec3 vDir;              // body-frame unit direction (for the tangent frame)
out vec3 vRel;              // camera-relative position (body frame)
out float vMorph;           // CDLOD morph factor -> texture LOD bias (detail blends with geometry)

const float QPI = 0.78539816339;

float fetchH(ivec2 t) {
  return uHQ.x + float(texelFetch(uHeight, t, 0).r) * uHQ.y;
}

// bilinear height at mesh coordinate g (mesh vertex g <-> height texel g * stride + 1)
float heightAt(vec2 g) {
  vec2 t = g * (256.0 / uTile.w) + 1.0;
  vec2 f = fract(t);
  ivec2 i = ivec2(floor(t));
  float h00 = fetchH(i);
  float h10 = fetchH(i + ivec2(1, 0));
  float h01 = fetchH(i + ivec2(0, 1));
  float h11 = fetchH(i + ivec2(1, 1));
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

// offset of the unit direction at local uv from uDirC, computed without cancellation
vec3 dirOffset(vec2 uv, out vec3 dir) {
  vec2 d = (uv - 0.5) * uTile.z * QPI;              // angle offsets
  vec2 x = vec2(uTile.x, uTile.y) * QPI + d;
  // tan(x) - tan(xc) = sin(x - xc) / (cos x cos xc)
  vec2 ds = sin(d) / (cos(x) * uCosC);
  vec3 dc = ds.x * uU + ds.y * uV;
  vec3 c = uCC + dc;
  float lc = length(c);
  float lcc = length(uCC);
  float num = 2.0 * dot(uCC, dc) + dot(dc, dc);       // |c|^2 - |cc|^2
  vec3 dd = dc / lc - uCC * (num / ((lcc + lc) * lc * lcc));
  dir = uDirC + dd;
  return dd;
}

void main() {
  float M = uTile.w;
  vec2 g = grid.xy;

  // unmorphed position -> distance -> morph factor
  vec3 dir0;
  vec3 dd0 = dirOffset(g / M, dir0);
  float h0 = heightAt(g);
  vec3 rel0 = uOrigin + uR * dd0 + h0 * dir0;
  float morph = clamp((length(rel0) - uMorph.x) / (uMorph.y - uMorph.x), 0.0, 1.0);

  // CDLOD: odd vertices slide onto the parent (even) grid
  vec2 fr = fract(g * 0.5) * 2.0;
  vec2 gm = g - fr * morph;
  vec2 uv = gm / M;

  vec3 dir;
  vec3 dd = dirOffset(uv, dir);
  float h = heightAt(gm) - grid.z * uSkirt;
  vec3 rel = uOrigin + uR * dd + h * dir;

  vUv = uv;
  vMorph = morph;
  vDir = dir;
  vRel = rel;
  gl_Position = uProj * vec4(uViewRot * rel, 1.0);
}
`;

export const terrainFS = /* glsl */ `
precision highp float;

in vec2 vUv;
in vec3 vDir;
in vec3 vRel;
in float vMorph;

uniform sampler2D uNormal;   // RG16F 257x257 tangent-space normal (e1, e2)
uniform sampler2D uColour;   // sRGB albedo (decoded to linear by the sampler)
uniform vec3 uColourXf;      // (scale, offsetU, offsetV): tile uv -> colour tile uv
uniform float uColourBias;   // 1 if this tile owns its colour texture (bias with morph), else 0
uniform vec3 uU;
uniform vec3 uLight;         // body-frame unit vector towards the light
uniform float uSun;          // light intensity
uniform float uAmbient;
uniform float uExposure;
uniform vec3 uEarthDir;      // body-frame unit vector towards the Earth
uniform float uEarthshine;   // earthshine intensity (scaled by the Earth's phase)
uniform sampler2D uFeas;     // feasibility score (R8, 0..1 = 0..100 %), corner-aligned samples
uniform vec3 uFeasXf;        // (scale, offsetU, offsetV): tile uv -> score tile uv
uniform float uFeasOn;       // 1 = draw the heatmap
uniform float uFeasN;        // samples per score-tile side

out vec4 fragColor;

vec3 toSRGB(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec3 up = normalize(vDir);
  vec3 e1 = normalize(uU - up * dot(uU, up));
  vec3 e2 = cross(up, e1);
  vec2 nuv = (vUv * 256.0 + 0.5) / 257.0;
  // bias by the morph factor: at morph = 1 the tile shows its parent's texel density
  vec2 nt = texture(uNormal, nuv, vMorph).rg;
  float nz = sqrt(max(1.0 - dot(nt, nt), 0.0));
  vec3 n = normalize(nt.x * e1 + nt.y * e2 + nz * up);

  // corner-aligned colour texels: tile uv 0..1 -> texel centres 0.5..255.5
  vec2 cuv = ((uColourXf.yz + vUv * uColourXf.x) * 255.0 + 0.5) / 256.0;
  vec3 albedo = texture(uColour, cuv, vMorph * uColourBias).rgb;

  vec3 V = normalize(-vRel);
  float mu0 = max(dot(n, uLight), 0.0);
  float mu = max(dot(n, V), 0.0);
  // lunar-Lambert with McEwen (1996) phase-dependent weight L(alpha):
  // Lommel-Seeliger near opposition (flat full Moon), Lambert-like towards the Sun
  float ls = 2.0 * mu0 / (mu0 + mu + 1e-4);
  float a = degrees(acos(clamp(dot(uLight, V), -1.0, 1.0)));
  float Lw = clamp(1.0 - 0.019 * a + 2.42e-4 * a * a - 1.46e-6 * a * a * a, 0.0, 1.0);
  float f = mix(mu0, ls, Lw);
  // large-scale terminator from the sphere normal (normal maps cannot light the night side)
  f *= smoothstep(-0.03, 0.06, dot(up, uLight));
  // earthshine: sunlight reflected by the Earth lights the lunar night side (Lambert)
  float fe = max(dot(n, uEarthDir), 0.0) * smoothstep(-0.05, 0.1, dot(up, uEarthDir));
  vec3 c = albedo * (f * uSun + fe * uEarthshine + uAmbient) * uExposure;
  // gentle shoulder to avoid harsh clipping
  c = c / (1.0 + 0.15 * c);
  if (uFeasOn > 0.5) {
    // red (0 %) -> yellow (50 %) -> green (100 %), smooth; view-angle relief keeps the
    // terrain readable on the night side as well
    vec2 fuv = ((uFeasXf.yz + vUv * uFeasXf.x) * (uFeasN - 1.0) + 0.5) / uFeasN;
    float sc = texture(uFeas, fuv).r;
    vec3 red = vec3(0.86, 0.12, 0.09), yellow = vec3(0.98, 0.84, 0.16), green = vec3(0.13, 0.70, 0.27);
    vec3 ramp = sc < 0.5 ? mix(red, yellow, sc * 2.0) : mix(yellow, green, sc * 2.0 - 1.0);
    ramp = pow(ramp, vec3(2.2));
    float relief = 0.55 + 0.45 * max(dot(n, V), 0.0);
    c = mix(c, ramp * relief, 0.72);
  }
  fragColor = vec4(toSRGB(c), 1.0);
}
`;

export const skyVS = /* glsl */ `
precision highp float;
in vec2 position;
uniform mat3 uInvViewRot;   // view -> body
uniform vec2 uTanHalf;      // (tan(fovx/2), tan(fovy/2))
out vec3 vDirB;
void main() {
  vec3 dView = vec3(position * uTanHalf, -1.0);
  vDirB = uInvViewRot * dView;
  gl_Position = vec4(position, 1.0, 1.0);
}
`;

// Background sky in the lunar body frame: star cubemap (ICRF), the Sun (limb-darkened
// disc; its glare is a separate pass, sunGlare.ts) and the Earth (sphere impostor: Blue Marble texture rotated by sidereal
// time, lit by the Sun -> correct phase, thin atmosphere rim). Directions are given
// relative to the camera, so parallax near the Moon is exact.
export const skyFS = /* glsl */ `
precision highp float;
in vec3 vDirB;
uniform samplerCube uStars;
uniform mat3 uBodyToJ2000;
uniform float uStarGain;
uniform vec4 uSun;          // xyz: direction (body), w: angular radius (rad); w = 0 -> hidden
uniform vec4 uEarth;        // xyz: direction (body), w: angular radius (rad); w = 0 -> hidden
uniform vec3 uEarthSun;     // body-frame direction from the Earth to the Sun
uniform sampler2D uEarthTex;
uniform float uEarthTexReady;
uniform float uGmst;        // Greenwich sidereal angle (rad)
uniform float uPixelAngle;  // angular size of one pixel (rad), for anti-aliased edges
out vec4 fragColor;

const float PI = 3.14159265359;

vec3 toSRGB(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec3 d = normalize(vDirB);
  vec3 c = texture(uStars, uBodyToJ2000 * d).rgb * uStarGain;   // display-referred

  // ---- Sun
  if (uSun.w > 0.0) {
    float ang = acos(clamp(dot(d, uSun.xyz), -1.0, 1.0));
    float r = ang / uSun.w;
    float edge = clamp((uSun.w - ang) / uPixelAngle + 0.5, 0.0, 1.0);
    float mu = sqrt(max(1.0 - r * r, 0.0));
    vec3 disc = vec3(1.0, 0.97, 0.92) * (0.6 + 0.4 * mu);            // limb darkening
    c = mix(c, disc, edge);   // glare: separate additive pass after the terrain (sunGlare.ts)
  }

  // ---- Earth
  if (uEarth.w > 0.0) {
    float ce = dot(d, uEarth.xyz);
    float ang = acos(clamp(ce, -1.0, 1.0));
    float r = ang / uEarth.w;
    if (r < 1.08) {
      vec3 q = (d - uEarth.xyz * ce) / sin(uEarth.w);                 // |q| = r
      float rr = min(dot(q, q), 1.0);
      vec3 n = q - uEarth.xyz * sqrt(1.0 - rr);                       // sphere normal (body)
      float sunDot = dot(normalize(n), uEarthSun);
      vec3 nj = uBodyToJ2000 * normalize(n);                          // ICRF ~ Earth equatorial
      float lon = atan(nj.y, nj.x) - uGmst;
      float lat = asin(clamp(nj.z, -1.0, 1.0));
      vec2 uv = vec2(fract(lon / (2.0 * PI) + 0.5), 0.5 + lat / PI);
      vec3 alb = uEarthTexReady > 0.5 ? texture(uEarthTex, uv).rgb : vec3(0.12, 0.2, 0.35);
      float day = smoothstep(-0.08, 0.12, sunDot);
      vec3 lit = alb * (max(sunDot, 0.0) * 1.15 + 0.004) * day;
      // atmosphere: bluish brightening towards the lit limb + thin halo outside the disc
      float limb = pow(1.0 - sqrt(1.0 - rr), 2.0);
      lit += vec3(0.25, 0.45, 1.0) * limb * 0.35 * day;
      vec3 earth = toSRGB(lit);
      float edge = clamp((uEarth.w - ang) / uPixelAngle + 0.5, 0.0, 1.0);
      float halo = smoothstep(1.08, 1.0, r) * step(1.0, r) * 0.35 * smoothstep(-0.2, 0.3, dot(normalize(d - uEarth.xyz * ce), uEarthSun));
      c = mix(c + vec3(0.3, 0.5, 1.0) * halo, earth, edge);
    }
  }
  fragColor = vec4(c, 1.0);
}
`;
