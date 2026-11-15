import {
  BufferGeometry, Float32BufferAttribute, Group, Mesh, ShaderMaterial, Vector3,
} from 'three';
import { dirToFace, FACES, type Vec3 } from '../geom';
import type { FeasibilityOverlay, FeasLookup } from './FeasibilityOverlay';

// A handheld globe uses the first subdivided level (128 samples across each face).
// The same ancestor tile and bilinear sampling are used for the tint and the readout.
export class VrFeasibility {
  readonly level: number;

  constructor(readonly overlay: FeasibilityOverlay, readonly toggle: () => void) {
    this.level = Math.min(1, overlay.meta.maxLevel);
  }

  reading(direction: Vec3) {
    const { face, a, b } = dirToFace(direction);
    const n = 1 << this.level;
    const u = Math.max(0, Math.min(n, (a + 1) * n / 2));
    const v = Math.max(0, Math.min(n, (b + 1) * n / 2));
    const x = Math.min(n - 1, Math.floor(u)), y = Math.min(n - 1, Math.floor(v));
    const tile = this.overlay.lookup(this.level, face, x, y, true);
    this.overlay.endFrame();
    if (!tile) return this.overlay.unavailable(face) ? 'Feasibility unavailable' : 'Loading feasibility…';
    const { data, width } = tile.tex.image;
    const fx = (tile.ou + (u - x) * tile.scale) * (width - 1);
    const fy = (tile.ov + (v - y) * tile.scale) * (width - 1);
    const i = Math.min(width - 2, Math.floor(fx)), j = Math.min(width - 2, Math.floor(fy));
    const offset = j * width + i, dx = fx - i, dy = fy - j;
    const bytes = data as Uint8Array;
    const low = bytes[offset] * (1-dx) + bytes[offset+1] * dx;
    const high = bytes[offset+width] * (1-dx) + bytes[offset+width+1] * dx;
    return 'Feasibility ' + Math.round((low*(1-dy) + high*dy) * 100 / 255) + '%';
  }
}

function patch(face: number, x: number, y: number, count: number, radius: number) {
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const basis = FACES[face], steps = 16;
  const direction = new Vector3(), axisU = new Vector3(...basis.u), axisV = new Vector3(...basis.v);
  for (let j = 0; j <= steps; j++) for (let i = 0; i <= steps; i++) {
    const u = i/steps, v = j/steps;
    const a = Math.tan(((x+u)/count - .5) * Math.PI/2);
    const b = Math.tan(((y+v)/count - .5) * Math.PI/2);
    direction.set(...basis.n).addScaledVector(axisU,a).addScaledVector(axisV,b).setLength(radius);
    positions.push(direction.x, direction.z, -direction.y);
    uvs.push(u, v);
    if (i < steps && j < steps) {
      const k = j*(steps+1)+i;
      indices.push(k,k+1,k+steps+2, k,k+steps+2,k+steps+1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position',new Float32BufferAttribute(positions,3));
  geometry.setAttribute('uv',new Float32BufferAttribute(uvs,2));
  geometry.setIndex(indices);
  return geometry;
}

/** Borrow score textures owned by the desktop overlay, also shared by the wrist display. */
export class VrHeatmap {
  readonly group = new Group();
  private tiles: { face:number; x:number; y:number; mesh:Mesh<BufferGeometry,ShaderMaterial> }[] = [];
  private nextRefresh = 0;
  constructor(private scores: VrFeasibility, radius: number) {
    const n = 1 << scores.level;
    for (let face=0; face<6; face++) for (let y=0; y<n; y++) for (let x=0; x<n; x++) {
      const material = new ShaderMaterial({
        transparent:true, depthWrite:false, toneMapped:false,
        uniforms:{ scores:{value:null}, transform:{value:new Vector3()}, samples:{value:scores.overlay.meta.samples} },
        vertexShader:`varying vec2 coord;
          void main(){coord=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
        fragmentShader:`uniform sampler2D scores; uniform vec3 transform; uniform float samples; varying vec2 coord;
          void main(){
            vec2 uv=((transform.yz + coord*transform.x)*(samples-1.0)+0.5)/samples;
            float s=texture2D(scores,uv).r;
            vec3 red=vec3(.86,.12,.09), yellow=vec3(.98,.84,.16), green=vec3(.13,.70,.27);
            vec3 color=s<.5 ? mix(red,yellow,2.0*s) : mix(yellow,green,2.0*s-1.0);
            gl_FragColor=vec4(pow(color,vec3(2.2)),.72);
            #include <colorspace_fragment>
          }`,
      });
      const mesh = new Mesh(patch(face,x,y,n,radius*1.003),material);
      mesh.visible=false;
      this.group.add(mesh);
      this.tiles.push({face,x,y,mesh});
    }
  }
  update(time: number) {
    this.group.visible=this.scores.overlay.enabled;
    if (!this.group.visible) { this.nextRefresh=0; return; }
    if (time < this.nextRefresh) return;
    this.nextRefresh=time+100;
    for (const {face,x,y,mesh} of this.tiles) {
      const tile: FeasLookup | null = this.scores.overlay.lookup(this.scores.level,face,x,y,true);
      mesh.visible=!!tile;
      if (!tile) continue;
      mesh.material.uniforms.scores.value=tile.tex;
      mesh.material.uniforms.transform.value.set(tile.scale,tile.ou,tile.ov);
    }
    this.scores.overlay.endFrame();
  }
  dispose() {
    for (const {mesh} of this.tiles) { mesh.geometry.dispose(); mesh.material.dispose(); }
  }
}
