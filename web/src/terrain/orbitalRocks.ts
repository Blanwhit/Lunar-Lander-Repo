import {
  AmbientLight, DirectionalLight, DynamicDrawUsage, Group, InstancedMesh, MathUtils, Matrix4,
  Matrix3, Object3D, PlaneGeometry, Quaternion, ShaderMaterial, Sphere, Vector3,
} from 'three';
import { BoulderField, boulderBands, hash, type RockAtlas } from '../boulderField';
import { FACES, GRID, MESH_N, R_MOON, TILE_N } from '../geom';
import type { RockSample } from '../lunarRocks';
import type { FrameInfo, LightParams, TileNode } from './TileTree';

const halfFace = Math.PI * R_MOON / 4;
const capacity = 900;
const axisY = new Vector3(0, 1, 0);
const axes = FACES.map(f => ({ n: new Vector3(...f.n), u: new Vector3(...f.u), v: new Vector3(...f.v) }));

// Equi-angular cube coordinates in metres give each scatter cell a permanent address.
function direction(face: number, x: number, y: number, out: Vector3) {
  const f = axes[face];
  return out.copy(f.n).addScaledVector(f.u, Math.tan(x / R_MOON))
    .addScaledVector(f.v, Math.tan(y / R_MOON)).normalize();
}

// Seat the rock on the triangle actually drawn. Between DEM samples the visible
// mesh can differ by several metres from a bilinear query, especially on slopes.
function groundPlane(tile: TileNode, col: number, row: number, upper: boolean, left: number, bottom: number, step: number) {
  const vertex = (i: number, j: number) => {
    const stride = TILE_N / MESH_N;
    const height = tile.base + tile.step * tile.q![(j * stride + 1) * GRID + i * stride + 1];
    return direction(tile.face, left + i * step, bottom + j * step, new Vector3()).multiplyScalar(R_MOON + height);
  };
  const p = vertex(col, row);
  const a = upper ? vertex(col + 1, row + 1) : vertex(col + 1, row);
  const b = upper ? vertex(col, row + 1) : vertex(col + 1, row + 1);
  const normal = a.sub(p).cross(b.sub(p)).normalize();
  return { normal, distance: normal.dot(p) };
}

// Enclose a block of scatter cells on the rendered DEM. The corner heights bound
// both triangles of every overlapping quad, including blocks that cross a ridge.
const cellsPerBlock = 4;
function blockBounds(tile: TileNode, left: number, bottom: number, step: number,
  blockX: number, blockY: number, width: number) {
  const x0 = Math.max(left, blockX * width), x1 = Math.min(left + step * MESH_N, (blockX + 1) * width);
  const y0 = Math.max(bottom, blockY * width), y1 = Math.min(bottom + step * MESH_N, (blockY + 1) * width);
  const stride = TILE_N / MESH_N;
  let low = Infinity, high = -Infinity;
  for (let j = MathUtils.clamp(Math.floor((y0-bottom)/step), 0, MESH_N); j <= Math.min(MESH_N, Math.ceil((y1-bottom)/step)); j++) {
    for (let i = MathUtils.clamp(Math.floor((x0-left)/step), 0, MESH_N); i <= Math.min(MESH_N, Math.ceil((x1-left)/step)); i++) {
      const h = tile.q![(j * stride + 1) * GRID + i * stride + 1];
      low = Math.min(low, h);
      high = Math.max(high, h);
    }
  }
  // tan's derivative is at most 2 across a cube face. Normalizing the face
  // vector cannot stretch it. Also allow for the chord sag of a flat DEM triangle.
  const maxRadius = R_MOON + tile.base + high * tile.step;
  const angle = Math.min(Math.PI, 2 * Math.SQRT2 * step / R_MOON);
  const minRadius = (R_MOON + tile.base + low * tile.step) * Math.cos(angle);
  const center = direction(tile.face, (x0+x1)/2, (y0+y1)/2, new Vector3()).multiplyScalar((minRadius+maxRadius)/2);
  return new Sphere(center, (maxRadius-minRadius)/2 + Math.hypot(x1-x0, y1-y0) * maxRadius/R_MOON + .01);
}

export class OrbitalRocks {
  readonly group = new Group();
  private readonly fields: BoulderField[];
  private readonly batches: InstancedMesh[][];
  private readonly bounds = new WeakMap<NonNullable<TileNode['q']>, Map<string, Sphere>>();
  private readonly shadow: InstancedMesh;
  private readonly sun = new DirectionalLight(0xffffff);
  private readonly earth = new DirectionalLight(0xc6d6ff);
  private readonly ambient = new AmbientLight(0xffffff);
  private readonly stamp = new Object3D();
  private readonly orient = new Quaternion();
  private readonly origin = new Vector3(Infinity, 0, 0);
  private readonly viewForward = new Vector3();
  private readonly previousSun = new Vector3();
  private previousScale = 0;
  private previousAspect = 0;
  private previousTiles: TileNode[] = [];

  constructor(atlas: RockAtlas, samples: RockSample[]) {
    this.fields = axes.map((_, face) => new BoulderField(atlas, 9271 + face * 9829, (x, y) => {
      const d = direction(face, x, y, new Vector3());
      return { lat: Math.asin(d.z) * 180 / Math.PI, lon: Math.atan2(d.y, d.x) * 180 / Math.PI };
    }));
    this.batches = samples.map(sample => [sample.near, sample.mid, sample.far].map(model => {
      const mesh = new InstancedMesh(model.geometry, model.material, capacity);
      mesh.name = 'Orbital Apollo rocks';
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return mesh;
    }));
    const shade = new ShaderMaterial({
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      uniforms: { strength: { value: 0.4 } },
      vertexShader: 'varying vec2 p; void main(){ p=uv*2.0-1.0; gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0); }',
      fragmentShader: `varying vec2 p; uniform float strength;
        void main() {
          float angle = atan(p.y, p.x);
          float edge = 0.86 + 0.08 * cos(3.0 * angle) + 0.06 * cos(5.0 * angle + 0.8);
          float alpha = 1.0 - smoothstep(edge - 0.18, edge, length(p));
          gl_FragColor = vec4(0.0, 0.0, 0.0, strength * alpha);
        }`,
    });
    this.shadow = new InstancedMesh(new PlaneGeometry(2, 2), shade, capacity * 3);
    this.shadow.name = 'Orbital rock shadows';
    this.shadow.frustumCulled = false;
    this.shadow.instanceMatrix.setUsage(DynamicDrawUsage);
    this.group.add(this.shadow, this.sun, this.sun.target, this.earth, this.earth.target, this.ambient);
    this.group.matrixAutoUpdate = false;
  }

  update(tiles: TileNode[], fi: FrameInfo, sun: Vector3, lighting: LightParams, altitude: number, aspect: number) {
    const cam = new Vector3(...fi.camPos), radial = cam.clone().normalize();
    const P = fi.viewportHeight / (2 * Math.tan(fi.fovY / 2));
    const dir = new Vector3(), pos = new Vector3(), view = new Vector3();
    const tangent = new Vector3(), side = new Vector3(), shadowMatrix = new Matrix4();

    this.group.matrix.setFromMatrix3(fi.viewRot);
    this.group.matrixWorldNeedsUpdate = true;
    this.sun.position.copy(sun);
    this.earth.position.copy(lighting.earthDir);
    this.sun.intensity = 2.8 * lighting.sun * MathUtils.smoothstep(radial.dot(sun), -0.03, 0.06);
    this.earth.intensity = 2.8 * lighting.earthshine * MathUtils.smoothstep(radial.dot(lighting.earthDir), -0.05, 0.1);
    this.ambient.intensity = 3 * lighting.ambient;
    const shadows = this.shadow.material as ShaderMaterial;
    shadows.uniforms.strength.value = 0.14 + 0.42 * Math.min(1, this.sun.intensity);

    // Keep instances in a nearby fixed frame and move the batch as a unit while panning.
    // Rebuild when the view footprint, lighting or displayed DEM triangles change.
    const forward = new Vector3(0, 0, -1).applyMatrix3(new Matrix3().copy(fi.viewRot).transpose());
    const scale = Math.max(15, altitude) / P;
    if (cam.distanceTo(this.origin) < Math.max(1, altitude * 0.035)
        && Math.abs(scale / this.previousScale - 1) < 0.06 && aspect === this.previousAspect
        && forward.dot(this.viewForward) > 0.9995 && sun.dot(this.previousSun) > 0.99999
        && tiles.length === this.previousTiles.length && tiles.every((t, i) => t === this.previousTiles[i])) {
      this.group.matrix.setPosition(pos.subVectors(this.origin, cam).applyMatrix3(fi.viewRot));
      return;
    }
    this.origin.copy(cam);
    this.viewForward.copy(forward);
    this.previousSun.copy(sun);
    this.previousScale = scale;
    this.previousAspect = aspect;
    this.previousTiles = tiles.slice();
    for (const levels of this.batches) for (const mesh of levels) mesh.count = 0;
    this.shadow.count = 0;

    const slopeY = Math.tan(fi.fovY / 2) * 1.18, slopeX = slopeY * aspect;
    const planeX = Math.hypot(1, slopeX), planeY = Math.hypot(1, slopeY);
    for (const tile of tiles) {
      const face = axes[tile.face], dn = face.n.dot(radial);
      if (dn < 0.55 || !tile.q) continue;
      const cx = R_MOON * Math.atan2(face.u.dot(radial), dn);
      const cy = R_MOON * Math.atan2(face.v.dot(radial), dn);
      const span = 2 * halfFace / tile.n, left = tile.x * span - halfFace, bottom = tile.y * span - halfFace;
      const step = span / MESH_N;
      let bounds = this.bounds.get(tile.q);
      if (!bounds) this.bounds.set(tile.q, bounds = new Map());
      const planes = new Map<number, ReturnType<typeof groundPlane>>();
      for (const [layer, band] of boulderBands.entries()) {
        const range = Math.min(6000, P * band.max / 1.25, band.radius * 3);
        if (altitude > range * 1.15) continue;
        // Face coordinates stretch near a cube edge. Cull in actual metres below.
        const reach = range * 1.8, width = band.cell;
        const minX = Math.floor(Math.max(left, cx - reach) / width);
        const maxX = Math.floor(Math.min(left + span, cx + reach) / width);
        const minY = Math.floor(Math.max(bottom, cy - reach) / width);
        const maxY = Math.floor(Math.min(bottom + span, cy + reach) / width);
        if (minX > maxX || minY > maxY) continue;
        const blockSize = width * cellsPerBlock;
        for (let by = Math.floor(minY / cellsPerBlock); by <= Math.floor(maxY / cellsPerBlock); by++) {
          const columns: number[] = [];
          for (let bx = Math.floor(minX / cellsPerBlock); bx <= Math.floor(maxX / cellsPerBlock); bx++) {
            const key = layer + '/' + bx + '/' + by;
            let block = bounds.get(key);
            if (!block) {
              block = blockBounds(tile, left, bottom, step, bx, by, blockSize);
              if (bounds.size >= 4096) bounds.delete(bounds.keys().next().value!);
              bounds.set(key, block);
            }
            view.subVectors(block.center, cam);
            const r = block.radius;
            if (view.lengthSq() > (range + r) ** 2) continue;
            view.applyMatrix3(fi.viewRot);
            if (view.z > r || Math.abs(view.x) + view.z * slopeX > planeX*r + band.max
                || Math.abs(view.y) + view.z * slopeY > planeY*r + band.max) continue;
            columns.push(bx);
          }
          // Preserve row-major scatter order, including when an instance batch fills.
          for (let y = Math.max(minY, by*cellsPerBlock); y <= Math.min(maxY, (by+1)*cellsPerBlock-1); y++) {
            for (const bx of columns) for (let x = Math.max(minX,bx*cellsPerBlock); x <= Math.min(maxX,(bx+1)*cellsPerBlock-1); x++) {
              for (const rock of this.fields[tile.face].tile(layer, x, y)) {
                const u = (rock.x - left) / step, v = (rock.z - bottom) / step;
                if (u < 0 || v < 0 || u >= MESH_N || v >= MESH_N) continue;
                direction(tile.face, rock.x, rock.z, dir);
                const col = Math.floor(u), row = Math.floor(v), upper = v - row > u - col;
                const key = 2 * (row * MESH_N + col) + Number(upper);
                let plane = planes.get(key);
                if (!plane) {
                  plane = groundPlane(tile, col, row, upper, left, bottom, step);
                  planes.set(key, plane);
                }
                pos.copy(dir).multiplyScalar(plane.distance / plane.normal.dot(dir)).sub(cam);
                const dist = pos.length(), pixels = P * rock.diameter / Math.max(1, dist);
                if (pixels <= 1.25 || dist >= range) continue;
                view.copy(pos).applyMatrix3(fi.viewRot);
                const halfHeight = -view.z * Math.tan(fi.fovY / 2);
                if (halfHeight < 0 || Math.abs(view.x) > halfHeight * aspect * 1.18 + rock.diameter || Math.abs(view.y) > halfHeight * 1.18 + rock.diameter) continue;
                const variant = Math.floor(hash(rock.i, rock.j, 6) * this.batches.length);
                const mesh = this.batches[variant][pixels > 42 ? 0 : pixels > 10 ? 1 : 2];
                if (mesh.count >= capacity) continue;
                const fade = (1 - MathUtils.smoothstep(dist, range * 0.8, range)) * MathUtils.smoothstep(pixels, 1.25, 3);
                const radius = rock.diameter * 0.5 * fade;
                const normal = plane.normal;
                this.orient.setFromUnitVectors(axisY, normal);
                this.stamp.rotation.set(hash(rock.i, rock.j, 8) * 0.45, hash(rock.i, rock.j, 9) * 2 * Math.PI, 0, 'YXZ');
                this.stamp.quaternion.premultiply(this.orient);
                this.stamp.position.copy(pos).addScaledVector(normal, radius * 0.07);
                this.stamp.scale.set(radius, radius * (0.75 + 0.25 * hash(rock.i, rock.j, 10)), radius);
                this.stamp.updateMatrix();
                mesh.setMatrixAt(mesh.count++, this.stamp.matrix);
                if (this.shadow.count >= this.shadow.instanceMatrix.count) continue;
                const incidence = normal.dot(sun);
                tangent.copy(sun).addScaledVector(normal, -incidence);
                if (tangent.lengthSq() < 1e-8) tangent.copy(face.u).addScaledVector(normal, -face.u.dot(normal));
                tangent.normalize().negate();
                side.crossVectors(normal, tangent);
                const length = incidence > 0 && this.sun.intensity > 0.1
                  ? Math.min(radius * 3.8, radius * 0.48 / Math.max(0.09, incidence)) : 0;
                shadowMatrix.makeBasis(tangent.multiplyScalar(radius + length / 2), side.multiplyScalar(radius * 0.85), normal);
                shadowMatrix.setPosition(pos.addScaledVector(tangent, length / (2 * radius + length)).addScaledVector(normal, 0.012));
                this.shadow.setMatrixAt(this.shadow.count++, shadowMatrix);
              }
            }
          }
        }
      }
    }
    for (const levels of this.batches) for (const mesh of levels) {
      mesh.visible = mesh.count > 0;
      if (mesh.visible) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    this.shadow.visible = this.shadow.count > 0;
    if (this.shadow.visible) {
      this.shadow.instanceMatrix.clearUpdateRanges();
      this.shadow.instanceMatrix.addUpdateRange(0, this.shadow.count * 16);
      this.shadow.instanceMatrix.needsUpdate = true;
    }
  }
}
