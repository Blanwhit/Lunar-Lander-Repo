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

const float QPI = 0.78539816339;

float fetchH(ivec2 t) {
  return uHQ.x + float(texelFetch(uHeight, t, 0).r) * uHQ.y;
}

// bilinear height at mesh coordinate g (mesh vertex g <-> height texel 2g + 1)
float heightAt(vec2 g) {
  vec2 t = g * 2.0 + 1.0;
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

uniform sampler2D uNormal;   // RG16F 257x257 tangent-space normal (e1, e2)
uniform sampler2D uColour;   // sRGB albedo (decoded to linear by the sampler)
uniform vec3 uColourXf;      // (scale, offsetU, offsetV): tile uv -> colour tile uv
uniform vec3 uU;
uniform vec3 uLight;         // body-frame unit vector towards the light
uniform float uSun;          // light intensity
uniform float uAmbient;
uniform float uExposure;

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
  vec2 nt = texture(uNormal, nuv).rg;
  float nz = sqrt(max(1.0 - dot(nt, nt), 0.0));
  vec3 n = normalize(nt.x * e1 + nt.y * e2 + nz * up);

  vec2 cuv = uColourXf.yz + vUv * uColourXf.x;
  vec3 albedo = texture(uColour, cuv).rgb;

  vec3 V = normalize(-vRel);
  float mu0 = max(dot(n, uLight), 0.0);
  float mu = max(dot(n, V), 0.0);
  // lunar-Lambert: mix of Lommel-Seeliger (dominant for the Moon) and Lambert
  float ls = 2.0 * mu0 / (mu0 + mu + 1e-4);
  float f = mix(mu0, ls, 0.55);
  // large-scale terminator from the sphere normal (normal maps cannot light the night side)
  f *= smoothstep(-0.03, 0.06, dot(up, uLight));
  vec3 c = albedo * (f * uSun + uAmbient) * uExposure;
  // gentle shoulder to avoid harsh clipping
  c = c / (1.0 + 0.15 * c);
  fragColor = vec4(toSRGB(c), 1.0);
}
`;

export const skyVS = /* glsl */ `
precision highp float;
in vec2 position;
uniform mat3 uInvViewRot;   // view -> body
uniform mat3 uBodyToJ2000;
uniform vec2 uTanHalf;      // (tan(fovx/2), tan(fovy/2))
out vec3 vDirJ;
void main() {
  vec3 dView = vec3(position * uTanHalf, -1.0);
  vDirJ = uBodyToJ2000 * (uInvViewRot * dView);
  gl_Position = vec4(position, 1.0, 1.0);
}
`;

export const skyFS = /* glsl */ `
precision highp float;
in vec3 vDirJ;
uniform samplerCube uStars;
uniform float uStarGain;
out vec4 fragColor;
void main() {
  vec3 c = texture(uStars, normalize(vDirJ)).rgb * uStarGain;
  fragColor = vec4(c, 1.0);
}
`;
