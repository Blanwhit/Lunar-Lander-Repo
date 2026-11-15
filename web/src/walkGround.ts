import {
  BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, Group,
  IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Object3D, DataTexture, Vector2, Ray, Vector3,
} from 'three';
import { groundMaterial, scanHeight, soilUV, type SoilMaps } from './lunarSoil';
import { BoulderField, boulderBands, maxVisiblePerBand, hash, type PlacedBoulder } from './boulderField';
import { RockCollision } from './rockCollision';
import type { RockModel, RockSample } from './lunarRocks';

// Powers of two keep neighbouring grids exactly aligned, including on negative coordinates.
const CELL = 0.125;
// Two peaks at the DEM's maximum elevation can see one another across ~527 km.
// Fixed landing-centred rings extend well beyond that horizon.
const RINGS = 20;
export const WALK_FAR = CELL * 16 * 2 ** (RINGS - 1) * 1.6;

function noise(x: number, z: number, seed: number): number {
  const i = Math.floor(x), j = Math.floor(z);
  const u = x - i, v = z - j;
  const a = u * u * (3 - 2 * u), b = v * v * (3 - 2 * v);
  const lo = hash(i, j, seed) * (1 - a) + hash(i + 1, j, seed) * a;
  const hi = hash(i, j + 1, seed) * (1 - a) + hash(i + 1, j + 1, seed) * a;
  return lo * (1 - b) + hi * b;
}

interface Bounds { x: number; z: number; half: number }
interface GroundRing {
  halfGrid: number;
  step: number;
  outerStep: number;
  mesh: Mesh<BufferGeometry, MeshStandardMaterial>;
  bounds: Bounds;
  hole?: Bounds;
}

interface Spread {
  cell: number; radius: number; chance: number; min: number; max: number;
}
interface StoneBand {
  spread: Spread;
  batches: InstancedMesh[][];
  viewX: number; viewZ: number;
  cx: number; cz: number;
}

const spreads: Spread[] = [
  { cell: 0.09, radius: 1.55, chance: 0.78, min: 0.0008, max: 0.006 }, // coarse grains
  { cell: 0.34, radius: 6.2, chance: 0.52, min: 0.005, max: 0.045 },
  { cell: 1.7, radius: 22, chance: 0.36, min: 0.045, max: 0.26 },
  { cell: 7.0, radius: 260, chance: 0.30, min: 0.23, max: 1.25 },
  { cell: 17, radius: 850, chance: 0.27, min: 0.85, max: 3.4 },
];

export class WalkGround {
  readonly group = new Group();
  private readonly dust: MeshStandardMaterial;
  private readonly coords = new Float32Array(5);
  private readonly rocks: MeshStandardMaterial;
  private readonly rings: GroundRing[] = [];
  private readonly bands: StoneBand[] = [];
  private readonly stamp = new Object3D();
  private readonly colliders = new Map<string, RockCollision>();
  private localX = Infinity;
  private localZ = Infinity;
  private readonly localRocks: RockCollision[] = [];
  readonly liftedStones = new Set<string>();
  private readonly tint = new Color();
  private readonly originRelief: number;
  private disposed=false;

  constructor(private readonly height: (x: number, z: number) => number,
    private readonly seed: number, private readonly rocky = 1, private readonly samples: RockSample[] = [],
    private readonly soil?: SoilMaps, landingToBody = new Matrix4(), deferBuild = false,
    private readonly field?: BoulderField) {
    soilUV(0, 0, this.coords);
    this.originRelief = soil ? scanHeight(soil, this.coords) : 0;
    this.dust = soil ? groundMaterial(soil, landingToBody) : new MeshStandardMaterial({ vertexColors: true, roughness: 1 });
    this.rocks = new MeshStandardMaterial({ roughness: 1 });
    for (let level = 0; level < RINGS; level++) {
      // More samples per ring at landscape scale keep distant ridgelines resolved.
      // Keep a detailed walking area around each landing. Finer soil relief is
      // sampled in the material at every location, independent of this spacing.
      const halfGrid = level < 3 ? 32 : 64;
      const step = CELL * 16 * 2 ** level / halfGrid;
      const mesh = new Mesh(new BufferGeometry(), this.dust);
      mesh.receiveShadow = true;
      mesh.castShadow = level <= 5;
      this.group.add(mesh);
      if (level) this.rings[level - 1].outerStep = step;
      const bounds = { x: 0, z: 0, half: halfGrid * step };
      this.rings.push({ halfGrid, step, outerStep: step, mesh, bounds, hole: this.rings[level - 1]?.bounds });
    }
    const distribution = this.field
      ? [...spreads.slice(0, 3), ...boulderBands.map(b => ({ ...b, chance: 1 }))]
      : spreads;
    for (const [i, spread] of distribution.entries()) {
      // Individual grains occupy fractions of a pixel at standing height.
      // Stones share scanned geometry, textures and instance buffers by specimen and LOD.
      const grit = i === 0 || !this.samples.length;
      const variants: RockModel[][] = grit
        ? [[{ geometry: new IcosahedronGeometry(1, 0), material: this.rocks }]]
        : this.samples.map(sample => [sample.near, sample.mid, sample.far]);
      const width = 2 * Math.ceil(spread.radius / spread.cell) + 1;
      const batches = variants.map(levels => levels.map((model, lod) => {
        const mesh = new InstancedMesh(model.geometry, model.material, this.field && i >= 3 ? maxVisiblePerBand : width * width);
        mesh.instanceMatrix.setUsage(DynamicDrawUsage);
        mesh.castShadow = mesh.receiveShadow = i >= 2 && lod !== 2;
        mesh.count = 0;
        this.group.add(mesh);
        return mesh;
      }));
      this.bands.push({ spread, batches, cx: Infinity, cz: Infinity, viewX: Infinity, viewZ: Infinity });
    }
    if (!deferBuild) {
      for (const ring of this.rings) ring.mesh.geometry=this.buildRing(ring);
      this.update(0, 0);
    }
  }

  private surface(x: number, z: number): number {
    soilUV(x, z, this.coords);
    return this.height(x, z) - this.originRelief + (this.soil ? scanHeight(this.soil, this.coords) : 0);
  }

  update(x: number, z: number): void {
    for (let i = 0; i < this.bands.length; i++) {
      const band = this.bands[i];
      const cx = Math.floor(x / band.spread.cell), cz = Math.floor(z / band.spread.cell);
      // Re-evaluate apparent size while approaching a boulder inside its large placement cell.
      const interval = Math.min(3, band.spread.cell);
      if (cx === band.cx && cz === band.cz &&
          Math.abs(x - band.viewX) < interval && Math.abs(z - band.viewZ) < interval) continue;
      band.viewX = x; band.viewZ = z;
      band.cx = cx; band.cz = cz;
      this.scatter(band, i);
    }
  }

  /** Build off-screen and swap together, keeping coarse grid vertices anchored in world coordinates. */
  async prepareLanding(x=0,z=0, resample=false) {
    const next: GroundRing[]=[];
    for (const ring of this.rings) {
      const snap=ring.outerStep;
      const bounds={x:Math.round(x/snap)*snap,z:Math.round(z/snap)*snap,half:ring.bounds.half};
      next.push({...ring,bounds,hole:next.at(-1)?.bounds});
    }
    const geometries=new Map<number,BufferGeometry>();
    const same=(a?:Bounds,b?:Bounds)=>a?.x===b?.x && a?.z===b?.z;
    try {
      for (const [i,ring] of next.entries()) {
        if(this.disposed)break;
        const previous=this.rings[i];
        if(!resample && previous.mesh.geometry.index && same(previous.bounds,ring.bounds) && same(previous.hole,ring.hole))continue;
        geometries.set(i,this.buildRing(ring));
        await new Promise<void>(resolve=>setTimeout(resolve,0));
      }
    } catch(error) {
      for(const g of geometries.values()) g.dispose();
      throw error;
    }
    if(this.disposed){for(const g of geometries.values())g.dispose();return;}
    for(const [i,geometry] of geometries) {
      const r=this.rings[i];
      r.bounds=next[i].bounds;r.hole=next[i].hole;
      r.mesh.geometry.dispose();r.mesh.geometry=geometry;
    }
    this.localX = Infinity;
    this.localRocks.length = 0;
    this.colliders.clear();
    for (const band of this.bands) band.cx=Infinity;
    this.update(x,z);
  }

  private buildRing(ring: GroundRing):BufferGeometry {
    const { x: cx, z: cz, half } = ring.bounds;
    const { step, hole, mesh } = ring;
    const size = 2 * ring.halfGrid + 1;
    const position = new Float32Array(size * size * 3);
    const uv = new Float32Array(size * size * 2);
    const color = new Float32Array(size * size * 3);
    const alternate = new Float32Array(size * size * 3);
    const indices: number[] = [];
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
      const x = cx - half + col * step, z = cz - half + row * step, i = row * size + col;
      let y = this.surface(x, z);
      // Match every outer edge sample to the triangle edge on the next coarser ring.
      if (ring.outerStep > step && (col === 0 || col === size - 1) && row % 2) {
        y = (this.surface(x, z - step) + this.surface(x, z + step)) / 2;
      } else if (ring.outerStep > step && (row === 0 || row === size - 1) && col % 2) {
        y = (this.surface(x - step, z) + this.surface(x + step, z)) / 2;
      }
      position.set([x, y, z], 3 * i);
      soilUV(x, z, this.coords);
      uv[2*i] = this.coords[0]; uv[2*i+1] = this.coords[1];
      alternate[3*i] = this.coords[2]; alternate[3*i+1] = this.coords[3]; alternate[3*i+2] = this.coords[4];
      const shade = 0.57 + 0.13 * noise(x / 6, z / 6, this.seed + 71)
        + 0.17 * noise(x / 41, z / 41, this.seed + 8);
      color.set([shade, shade, shade], 3 * i);
      if (row === size - 1 || col === size - 1) continue;
      // A separate finer mesh fills the entire cutout.
      if (hole && Math.abs(x + step / 2 - hole.x) < hole.half &&
          Math.abs(z + step / 2 - hole.z) < hole.half) continue;
      indices.push(i, i + size, i + 1, i + 1, i + size, i + size + 1);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(position, 3));
    geo.setAttribute('uv', new BufferAttribute(uv, 2));
    geo.setAttribute('alternateSoilUV', new BufferAttribute(alternate, 3));
    geo.setAttribute('color', new BufferAttribute(color, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  /** Traverse the height grid front to back, testing the exact two visible triangles per cell. */
  intersect(ray: Ray):Vector3 | undefined {
    const {origin:o,direction:d}=ray;
    const a=new Vector3(), b=new Vector3(), c=new Vector3(), e=new Vector3(), hit=new Vector3();
    let nearest=Infinity;
    for (const ring of this.rings) {
      const {bounds,step,halfGrid,hole}=ring, n=halfGrid*2;
      const west=bounds.x-bounds.half,north=bounds.z-bounds.half;
      let entry=0, exit=nearest;
      for(const [position,velocity,low] of [[o.x,d.x,west],[o.z,d.z,north]]) {
        if(Math.abs(velocity)<1e-12) {
          if(position<low || position>low+n*step){exit=-1;break;}
        } else {
          const t0=(low-position)/velocity,t1=(low+n*step-position)/velocity;
          entry=Math.max(entry,Math.min(t0,t1));exit=Math.min(exit,Math.max(t0,t1));
        }
      }
      if(entry>exit)continue;
      const index=(v:number)=>Math.min(n-1,Math.max(0,Math.floor(v/step)));
      let i=index(o.x+d.x*entry-west),j=index(o.z+d.z*entry-north);
      const sx=Math.sign(d.x),sz=Math.sign(d.z),tx=step/Math.abs(d.x),tz=step/Math.abs(d.z);
      let crossX=sx ? (west+(i+Number(sx>0))*step-o.x)/d.x : Infinity;
      let crossZ=sz ? (north+(j+Number(sz>0))*step-o.z)/d.z : Infinity;
      const p=ring.mesh.geometry.getAttribute('position');
      while(i>=0 && j>=0 && i<n && j<n && entry<=exit && entry<nearest) {
        const cx=west+(i+.5)*step,cz=north+(j+.5)*step;
        if(!hole || Math.abs(cx-hole.x)>=hole.half || Math.abs(cz-hole.z)>=hole.half) {
          const k=j*(n+1)+i;
          a.fromBufferAttribute(p,k);b.fromBufferAttribute(p,k+n+1);
          c.fromBufferAttribute(p,k+1);e.fromBufferAttribute(p,k+n+2);
          if(ray.intersectTriangle(a,b,c,true,hit))nearest=Math.min(nearest,o.distanceTo(hit));
          if(ray.intersectTriangle(c,b,e,true,hit))nearest=Math.min(nearest,o.distanceTo(hit));
        }
        entry=Math.min(crossX,crossZ);
        if(!Number.isFinite(entry))break;
        if(crossX<=entry){i+=sx;crossX+=tx;}
        if(crossZ<=entry){j+=sz;crossZ+=tz;}
      }
    }
    if(Number.isFinite(nearest))return ray.at(nearest,new Vector3());
  }

  /** Preserve the original material and interpolated lighting at the edge of a fine soil tile. */
  soilMaterial(mask: DataTexture, origin: Vector2, tileSize: number, span: number) {
    const fine = this.dust.clone();
    fine.onBeforeCompile = this.dust.onBeforeCompile;
    fine.customProgramCacheKey = () => 'lunar-soil-detail';
    const original = this.dust.onBeforeCompile;
    this.dust.onBeforeCompile = (shader, renderer) => {
      original.call(this.dust, shader, renderer);
      shader.uniforms.soilTiles = {value: mask};
      shader.uniforms.soilOrigin = {value: origin};
      shader.vertexShader = 'varying vec2 soilPosition;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>', '#include <begin_vertex>\nsoilPosition=position.xz;');
      shader.fragmentShader = 'uniform sampler2D soilTiles; uniform vec2 soilOrigin; varying vec2 soilPosition;\n'
        + shader.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          vec2 tile = soilPosition/${tileSize.toFixed(4)} - soilOrigin;
          vec2 edge = min(vec2(.2),1.5*fwidth(tile));
          ivec2 lo = ivec2(floor(tile-edge)), hi = ivec2(floor(tile+edge));
          // Cover all MSAA samples at the external edge of a replacement tile.
          if(all(greaterThanEqual(lo,ivec2(0))) && all(lessThan(hi,ivec2(${span})))) {
            if(texelFetch(soilTiles,lo,0).r>.5 && texelFetch(soilTiles,hi,0).r>.5 &&
               texelFetch(soilTiles,ivec2(lo.x,hi.y),0).r>.5 && texelFetch(soilTiles,ivec2(hi.x,lo.y),0).r>.5) discard;
          }`);
    };
    this.dust.customProgramCacheKey = () => 'lunar-soil-cutout';
    this.dust.needsUpdate = true;
    return fine;
  }

  floorAt(x: number, z: number, appearance?: Float32Array): number {
    // Intersect the same grid triangles that are drawn, including their stitched edges.
    for (const ring of this.rings) {
      const bounds = ring.bounds;
      if (!bounds || Math.abs(x - bounds.x) >= bounds.half || Math.abs(z - bounds.z) >= bounds.half) continue;
      const col = (x - bounds.x + bounds.half) / ring.step, row = (z - bounds.z + bounds.half) / ring.step;
      const width = 2 * ring.halfGrid + 1;
      const i = Math.floor(row) * width + Math.floor(col);
      const u = col % 1, v = row % 1;
      const p = ring.mesh.geometry.getAttribute('position'), next = i + width;
      const lower = u+v < 1;
      const a = lower ? i : next+1, b = i+1, c = next;
      const wa = lower ? 1-u-v : u+v-1, wb = lower ? u : 1-v, wc = 1-wa-wb;
      if (appearance) {
        const geometry = ring.mesh.geometry;
        const n = geometry.getAttribute('normal'), color = geometry.getAttribute('color'), alt = geometry.getAttribute('alternateSoilUV');
        appearance[0] = wa*n.getX(a)+wb*n.getX(b)+wc*n.getX(c);
        appearance[1] = wa*n.getY(a)+wb*n.getY(b)+wc*n.getY(c);
        appearance[2] = wa*n.getZ(a)+wb*n.getZ(b)+wc*n.getZ(c);
        appearance[3] = wa*color.getX(a)+wb*color.getX(b)+wc*color.getX(c);
        appearance[4] = wa*alt.getX(a)+wb*alt.getX(b)+wc*alt.getX(c);
        appearance[5] = wa*alt.getY(a)+wb*alt.getY(b)+wc*alt.getY(c);
        appearance[6] = wa*alt.getZ(a)+wb*alt.getZ(b)+wc*alt.getZ(c);
      }
      return wa*p.getY(a)+wb*p.getY(b)+wc*p.getY(c);
    }
    return this.surface(x, z);
  }

  private seedFor(layer: number): number { return (this.seed + layer * 72391) | 0; }

  private rockAt(i: number, j: number, layer: number, spread: Spread) {
    const seed = this.seedFor(layer);
    const field = layer < 2 ? 1 : 0.35 + 1.35 * noise(i * spread.cell / 39, j * spread.cell / 39, this.seed + 411);
    const chance = Math.min(0.95, spread.chance * field * Math.max(0, this.rocky));
    if (hash(i, j, seed + 1) >= chance) return;
    const x = (i + hash(i, j, seed + 2)) * spread.cell;
    const z = (j + hash(i, j, seed + 3)) * spread.cell;
    const diameter = spread.min + (spread.max - spread.min) * hash(i, j, seed + 4) ** 2;
    if (diameter > 0.25 && x*x + z*z < (2 + diameter) ** 2) return;
    return { x, z, diameter };
  }

  private placeRock(i: number, j: number, seed: number, rock: { x: number; z: number; diameter: number }, mesh: InstancedMesh) {
    const { x, z, diameter } = rock;
    const halfHeight = mesh.material === this.rocks ? 1 : mesh.geometry.boundingBox!.max.y;
    const scale = diameter * 0.5;
    this.stamp.scale.set(scale * (0.92 + 0.16 * hash(i, j, seed + 5)),
      scale * (0.86 + 0.22 * hash(i, j, seed + 11)), scale);
    const exposedCenter = -0.14 + 0.48 * hash(i, j, seed + 32);
    this.stamp.position.set(x, this.floorAt(x, z) + this.stamp.scale.y * halfHeight * exposedCenter, z);
    // Half the fragments expose the reverse side of the same scan.
    this.stamp.rotation.set((hash(i, j, seed + 17) < 0.5 ? Math.PI : 0) + 0.52 * (hash(i, j, seed + 6) - 0.5),
      2 * Math.PI * hash(i, j, seed + 7), 0.52 * (hash(i, j, seed + 8) - 0.5), 'YXZ');
    this.stamp.updateMatrix();
  }

  /** Lift the closest exposed, hand-sized scan from its actual scatter cell. */
  takeStone(hand: Vector3) {
    let best = .105;
    let found: { layer: number; key: string; matrix: Matrix4; sample: RockSample; diameter: number } | undefined;
    if (!this.samples.length) return;
    for (const layer of [1, 2]) {
      const band = this.bands[layer], spread = band.spread, seed = this.seedFor(layer);
      const cx = Math.floor(hand.x / spread.cell), cz = Math.floor(hand.z / spread.cell);
      for (let j = cz - 1; j <= cz + 1; j++) for (let i = cx - 1; i <= cx + 1; i++) {
        const r = this.rockAt(i, j, layer, spread);
        if (!r || r.diameter < .022) continue;
        const key = layer + '/' + i + '/' + j;
        if (this.liftedStones.has(key)) continue;
        const specimen = Math.floor(hash(i, j, seed + 74) * band.batches.length);
        this.placeRock(i, j, seed, r, band.batches[specimen][0]);
        const distance = hand.distanceTo(this.stamp.position) - r.diameter * .40;
        if (distance < best) {
          best = distance;
          found = { layer, key, matrix: this.stamp.matrix.clone(), sample: this.samples[specimen], diameter: r.diameter };
        }
      }
    }
    if (found) {
      this.liftedStones.add(found.key);
      this.scatter(this.bands[found.layer], found.layer);
    }
    return found;
  }

  private scatter(band: StoneBand, layer: number): void {
    const { spread, batches, cx, cz, viewX, viewZ } = band;
    const seed = this.seedFor(layer);
    for (const levels of batches) for (const mesh of levels) mesh.count = 0;
    const draw = (rock: { x: number; z: number; diameter: number }, i: number, j: number) => {
      if ((layer === 1 || layer === 2) && this.liftedStones.size && this.liftedStones.has(layer + '/' + i + '/' + j)) return;
      const { x, z, diameter } = rock;
      const range = Math.hypot(x - viewX, z - viewZ);
      const apparent = diameter / Math.max(0.1, range);
      if (range > spread.radius || (layer >= 3 && apparent < 0.0016)) return;
      const specimen = Math.floor(hash(i, j, seed + 74) * batches.length);
      const levels = batches[specimen];
      const mesh = levels.length === 1 ? levels[0] : levels[apparent > 0.055 ? 0 : apparent > 0.009 ? 1 : 2];
      this.placeRock(i, j, seed, rock, levels[0]);
      const index = mesh.count++;
      mesh.setMatrixAt(index, this.stamp.matrix);
      const grey = (levels.length === 1 ? 0.28 : 0.88) + 0.15 * hash(i, j, seed + 20);
      mesh.setColorAt(index, this.tint.setScalar(grey));
    };
    if (this.field && layer >= 3) {
      const candidates = this.field.nearby(layer - 3, viewX, viewZ, spread.radius);
      // In exceptionally rocky regions spend the headset instance budget on the nearest rocks.
      if (candidates.length > maxVisiblePerBand) {
        const distanceSq = (r: PlacedBoulder) => (r.x - viewX)**2 + (r.z - viewZ)**2;
        candidates.sort((a, b) => distanceSq(a) - distanceSq(b));
        candidates.length = maxVisiblePerBand;
      }
      for (const r of candidates) draw(r, r.i, r.j);
    } else {
      const radius = Math.ceil(spread.radius / spread.cell);
      for (let j = cz - radius; j <= cz + radius; j++) for (let i = cx - radius; i <= cx + radius; i++) {
        const rock = this.rockAt(i, j, layer, spread);
        if (rock) draw(rock, i, j);
      }
    }
    for (const levels of batches) for (const mesh of levels) {
      mesh.visible = mesh.count > 0;
      if (!mesh.visible) continue;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  private collectRock(rock: { x: number; z: number; diameter: number }, i: number, j: number, layer: number,
    x: number, z: number, radius: number) {
    const seed = this.seedFor(layer), batches = this.bands[layer].batches;
    const mesh = batches[Math.floor(hash(i, j, seed + 74) * batches.length)][0];
    const geometry = mesh.geometry;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere!;
    // Conservative rejection only. The scan may be off-centre and tilted.
    const reach = 0.54 * rock.diameter * (sphere.center.length() + sphere.radius) + radius;
    if ((x - rock.x) ** 2 + (z - rock.z) ** 2 > reach ** 2) return;
    const key = `${layer}/${i}/${j}`;
    let collider = this.colliders.get(key);
    if (!collider) {
      this.placeRock(i, j, seed, rock, mesh);
      collider = new RockCollision(geometry, this.stamp.matrix, (u, v) => this.floorAt(u, v));
      if (this.colliders.size >= 12) this.colliders.delete(this.colliders.keys().next().value!);
      this.colliders.set(key, collider);
    }
    this.localRocks.push(collider);
  }

  private nearbyColliders(x: number, z: number) {
    if (Math.hypot(x - this.localX, z - this.localZ) <= 1) return this.localRocks;
    const radius = 1.5;
    this.localX = x; this.localZ = z;
    this.localRocks.length = 0;
    for (let layer = 3; layer < this.bands.length; layer++) {
      const spread = this.bands[layer].spread;
      if (this.field) {
        // Normalized scans fit within one nominal diameter of their centre in any orientation.
        const candidates = this.field.nearby(layer - 3, x, z, spread.max + radius);
        for (const r of candidates) {
          if (r.diameter >= .30) this.collectRock(r, r.i, r.j, layer, x, z, radius);
        }
      } else {
        const cx = Math.floor(x / spread.cell), cz = Math.floor(z / spread.cell);
        for (let j = cz - 1; j <= cz + 1; j++) for (let i = cx - 1; i <= cx + 1; i++) {
          const r = this.rockAt(i, j, layer, spread);
          if (r && r.diameter >= .30) this.collectRock(r, i, j, layer, x, z, radius);
        }
      }
    }
    return this.localRocks;
  }

  /** Support under a boot, or under the width of the player's stance during a locomotion step. */
  surfaceAt(x: number, z: number, radius = 0, soilHeight = this.floorAt(x,z)): number {
    let top = soilHeight;
    for (const rock of this.nearbyColliders(x, z)) {
      top = Math.max(top, rock.topAt(x, z));
      if (radius > 0) top = Math.max(top, rock.topAt(x-radius, z), rock.topAt(x+radius, z),
        rock.topAt(x, z-radius), rock.topAt(x, z+radius));
    }
    return top;
  }

  blockedAt(x: number, z: number, radius = .15): boolean {
    return this.nearbyColliders(x, z).some(rock => rock.touches(x, z, radius));
  }

  dispose(): void {
    this.disposed=true;
    this.localX = Infinity;
    this.localRocks.length = 0;
    this.colliders.clear();
    for (const { mesh } of this.rings) mesh.geometry.dispose();
    for (const { batches } of this.bands) for (const levels of batches) for (const mesh of levels) {
      if (mesh.material === this.rocks) mesh.geometry.dispose();
      mesh.dispose();
    }
    this.dust.dispose();
    this.rocks.dispose();
    this.group.clear();
  }
}
