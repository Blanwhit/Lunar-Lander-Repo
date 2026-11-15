import { BufferGeometry, Mesh, MeshStandardMaterial } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface RockModel {
  geometry: BufferGeometry;
  material: MeshStandardMaterial;
}

export interface RockSample {
  key: string;
  near: RockModel;
  mid: RockModel;
  far: RockModel;
}

let samples: Promise<RockSample[]> | undefined;

function prepareMaterial(material: MeshStandardMaterial) {
  material.roughness = 0.98;
  material.metalness = 0;
  material.flatShading = false;
  if (material.map) material.map.anisotropy = 4;
  // The lowest exposed part carries more soil. Keep the photographed mineral
  // structure visible on the sides and the upper fracture faces.
  material.onBeforeCompile = shader => {
    shader.vertexShader = 'varying float vRockHeight;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      vec3 oriented = mat3(instanceMatrix) * transformed;
      vRockHeight = oriented.y / max(length(instanceMatrix[1].xyz), 0.00001);
    `);
    shader.fragmentShader = 'varying float vRockHeight;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      float dust = 0.58 * (1.0 - smoothstep(-0.22, 0.48, vRockHeight));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.219, 0.209, 0.197), dust);
    `);
  };
}

async function readSamples(): Promise<RockSample[]> {
  const gltf = await new GLTFLoader().loadAsync(import.meta.env.BASE_URL + 'lunar-rocks/samples.glb');
  const rocks = new Map<string, Partial<RockSample>>();
  const prepared = new Set<MeshStandardMaterial>();
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(node => {
    if (!(node instanceof Mesh)) return;
    const match = /^(.*)_(near|mid|far)$/.exec(node.name);
    if (!match) return;
    const material = node.material;
    if (!(material instanceof MeshStandardMaterial)) throw new Error('Unexpected lunar sample material');
    if (!prepared.has(material)) {
      prepareMaterial(material);
      prepared.add(material);
    }
    node.geometry.applyMatrix4(node.matrixWorld);
    node.geometry.computeBoundingBox();
    const sample = rocks.get(match[1]) ?? { key: match[1] };
    sample[match[2] as 'near' | 'mid' | 'far'] = { geometry: node.geometry, material };
    rocks.set(match[1], sample);
  });
  const result = [...rocks.values()];
  if (!result.length || result.some(r => !r.near || !r.mid || !r.far)) throw new Error('Incomplete lunar sample library');
  return result as RockSample[];
}

/** Keep the decoded specimen library for subsequent landings on this page. */
export function loadRockSamples(): Promise<RockSample[]> {
  return samples ??= readSamples().catch(error => { samples = undefined; throw error; });
}
