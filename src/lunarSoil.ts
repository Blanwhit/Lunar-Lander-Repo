import {
  LinearFilter, LinearMipmapLinearFilter, Matrix4, MeshStandardMaterial, RepeatWrapping,
  SRGBColorSpace, Texture, TextureLoader, Vector2,
} from 'three';
import { R_MOON } from './geom';

const tileMetres = 4;
const heightRange = 0.010;
const elevationPixels = 256;

export interface SoilMaps {
  color: Texture;
  normal: Texture;
  globe: Texture;
  elevations: Uint8Array;
}
let maps: Promise<SoilMaps> | undefined;

let grainMaps: Promise<Pick<SoilMaps, 'color' | 'normal'>> | undefined;
const loader = new TextureLoader().setPath(import.meta.env.BASE_URL + 'lunar-soil/');

export function loadGrainMaps() {
  return grainMaps ??= Promise.all(['basecolor.jpg', 'normal.jpg'].map(file => loader.loadAsync(file)))
    .then(([color, normal]) => {
      color.colorSpace = SRGBColorSpace;
      for (const t of [color, normal]) {
        t.wrapS = t.wrapT = RepeatWrapping;
        t.anisotropy = 4;
      }
      return { color, normal };
    }).catch(error => { grainMaps = undefined; throw error; });
}

async function fetchMaps(): Promise<SoilMaps> {
  const [{ color, normal }, globe, heights] = await Promise.all([
    loadGrainMaps(), loader.loadAsync('global-albedo.jpg'), loader.loadAsync('height.png'),
  ]);
  globe.colorSpace = SRGBColorSpace;
  globe.wrapS = RepeatWrapping;
  globe.magFilter = LinearFilter;
  globe.minFilter = LinearMipmapLinearFilter;
  globe.anisotropy = 4;
  // One filtered height sample per 1.56 cm is ample for the finest walking mesh.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = elevationPixels;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(heights.image, 0, 0, canvas.width, canvas.height);
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const elevations = new Uint8Array(elevationPixels ** 2);
  for (let i = 0; i < elevations.length; ++i) elevations[i] = rgba[4 * i];
  heights.dispose();
  return { color, normal, globe, elevations };
}

export function loadSoilMaps(): Promise<SoilMaps> {
  return maps ??= fetchMaps().catch(error => { maps = undefined; throw error; });
}

// Two differently oriented readings of the same scan. Large, soft patches select
// which is visible. The floor, albedo and tangent normals use the same coordinates.
export function soilUV(x: number, z: number, out: Float32Array) {
  const u = x / tileMetres, v = z / tileMetres;
  out[0] = u; out[1] = v;
  out[2] = 0.6*u - 0.8*v + 0.31;
  out[3] = 0.8*u + 0.6*v + 0.17;
  const mix = Math.max(0, Math.min(1, 0.5 + 0.68*Math.sin(x*0.61 + z*0.37) + 0.49*Math.sin(z*0.76 - x*0.29)));
  out[4] = mix*mix*(3-2*mix);
}

export function scanHeight(soil: SoilMaps, coords: Float32Array) {
  const n = elevationPixels, mask = n-1;
  function sample(u: number, v: number) {
    // TextureLoader flips images vertically on upload.
    const x = u*n - 0.5, y = -v*n - 0.5;
    const i = Math.floor(x), j = Math.floor(y), a = x-i, b = y-j;
    const row = (j & mask)*n, next = ((j+1) & mask)*n;
    const lo = i & mask, hi = (i+1) & mask, h = soil.elevations;
    return (h[row+lo]*(1-a)+h[row+hi]*a)*(1-b) + (h[next+lo]*(1-a)+h[next+hi]*a)*b;
  }
  const a = sample(coords[0],coords[1]), b = sample(coords[2],coords[3]);
  return ((a + (b-a)*coords[4])/255 - 0.5)*heightRange;
}

export function groundMaterial(soil: SoilMaps, landingToBody: Matrix4) {
  const material = new MeshStandardMaterial({
    map: soil.color, normalMap: soil.normal, normalScale: new Vector2(1,1),
    roughness: 1, vertexColors: true,
  });
  material.onBeforeCompile = shader => {
    shader.uniforms.landingToBody = {value: landingToBody};
    shader.uniforms.orbitalAlbedo = {value: soil.globe};
    shader.vertexShader = `
      attribute vec3 alternateSoilUV;
      varying vec3 vAlternateSoil;
      varying vec3 vRegionalColor;
      uniform mat4 landingToBody;
      uniform sampler2D orbitalAlbedo;
    ` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vAlternateSoil = alternateSoilUV;
      vec3 direction = normalize(mat3(landingToBody) * vec3(position.x, ${R_MOON.toFixed(1)}+position.y, position.z));
      vec2 location = vec2(atan(direction.y, direction.x) / 6.2831853 + 0.5, asin(clamp(direction.z, -1.0, 1.0)) / 3.14159265 + 0.5);
      vec3 orbit = texture2D(orbitalAlbedo, location).rgb;
      vRegionalColor = clamp(pow(max(orbit, vec3(0.02)) / 0.5128, vec3(0.65)), 0.48, 1.52);
    `);
    shader.fragmentShader = `
      varying vec3 vAlternateSoil;
      varying vec3 vRegionalColor;
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', `
        vec3 a = texture2D(map, vMapUv).rgb;
        vec3 b = texture2D(map, vAlternateSoil.xy).rgb;
        vec3 scan = mix(a, b, vAlternateSoil.z);
        // Take most of the hue from the orbital mosaic. The terrestrial soil
        // simulant supplies the local light/dark structure and a little colour.
        vec3 dust = mix(vec3(dot(scan, vec3(0.2126,0.7152,0.0722))), scan, 0.22);
        // The scan is nearly uniform in diffuse light. Bring out its small brightness variations.
        dust = max(vec3(0.035), vec3(0.212) + 2.2 * (dust - vec3(0.212)));
        diffuseColor.rgb *= dust * vRegionalColor;
      `)
      .replace('#include <normal_fragment_maps>', `
        vec3 nA = texture2D(normalMap, vNormalMapUv).xyz * 2.0 - 1.0;
        vec3 nB = texture2D(normalMap, vAlternateSoil.xy).xyz * 2.0 - 1.0;
        nB.xy = mat2(0.6, -0.8, 0.8, 0.6) * nB.xy;
        vec3 fine = mix(nA, nB, vAlternateSoil.z);
        normal = normalize(tbn * vec3(fine.xy / max(fine.z, 0.3), 1.0));
      `);
  };
  return material;
}
