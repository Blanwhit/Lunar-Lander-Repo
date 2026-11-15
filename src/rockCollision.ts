import { BufferGeometry, Matrix4, Vector3 } from 'three';

const binsPerAxis = 8;
const soleHeight = 0.025;
interface Point { x: number; z: number; y: number; height: number }
interface Face { a: Point; b: Point; c: Point }

function atSoil(a: Point, b: Point): Point {
  const t = a.height / (a.height - b.height);
  return { x: a.x + t * (b.x - a.x), z: a.z + t * (b.z - a.z), y: a.y + t * (b.y - a.y), height: 0 };
}

function cross(a: Point, b: Point, x: number, z: number) {
  return (b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x);
}

/** Horizontal footprint of the visible scan, clipped to the soil in its placed orientation. */
export class RockCollision {
  private readonly bins: Face[][] = Array.from({ length: binsPerAxis ** 2 }, () => []);
  private minX = Infinity;
  private minZ = Infinity;
  private maxX = -Infinity;
  private maxZ = -Infinity;

  constructor(geometry: BufferGeometry, pose: Matrix4, floorAt: (x: number, z: number) => number) {
    const positions = geometry.getAttribute('position'), index = geometry.index;
    const vertices: Point[] = [];
    const v = new Vector3();
    for (let i = 0; i < positions.count; i++) {
      v.fromBufferAttribute(positions, i).applyMatrix4(pose);
      vertices.push({ x: v.x, z: v.z, y: v.y, height: v.y - floorAt(v.x, v.z) - soleHeight });
      this.minX = Math.min(this.minX, v.x); this.maxX = Math.max(this.maxX, v.x);
      this.minZ = Math.min(this.minZ, v.z); this.maxZ = Math.max(this.maxZ, v.z);
    }
    const count = index?.count ?? positions.count;
    for (let i = 0; i < count; i += 3) {
      const a = vertices[index ? index.getX(i) : i];
      const b = vertices[index ? index.getX(i + 1) : i + 1];
      const c = vertices[index ? index.getX(i + 2) : i + 2];
      if (a.height < 0 && b.height < 0 && c.height < 0) continue;
      if (a.height >= 0 && b.height >= 0 && c.height >= 0) {
        this.insert(a, b, c);
        continue;
      }
      const polygon: Point[] = [];
      let previous = c;
      for (const next of [a, b, c]) {
        if ((previous.height < 0) !== (next.height < 0)) polygon.push(atSoil(previous, next));
        if (next.height >= 0) polygon.push(next);
        previous = next;
      }
      for (let n = 2; n < polygon.length; n++) this.insert(polygon[0], polygon[n - 1], polygon[n]);
    }
  }

  private bin(value: number, min: number, max: number) {
    return Math.max(0, Math.min(binsPerAxis - 1, Math.floor((value - min) * binsPerAxis / (max - min || 1))));
  }

  private insert(a: Point, b: Point, c: Point) {
    const face = { a, b, c };
    const left = this.bin(Math.min(a.x, b.x, c.x), this.minX, this.maxX);
    const right = this.bin(Math.max(a.x, b.x, c.x), this.minX, this.maxX);
    const top = this.bin(Math.min(a.z, b.z, c.z), this.minZ, this.maxZ);
    const bottom = this.bin(Math.max(a.z, b.z, c.z), this.minZ, this.maxZ);
    for (let j = top; j <= bottom; j++) for (let i = left; i <= right; i++) {
      this.bins[j * binsPerAxis + i].push(face);
    }
  }

  /** Highest exposed triangle under this point, in the walk scene's vertical coordinates. */
  topAt(x: number, z: number) {
    if (x < this.minX || x > this.maxX || z < this.minZ || z > this.maxZ) return -Infinity;
    const col = this.bin(x, this.minX, this.maxX), row = this.bin(z, this.minZ, this.maxZ);
    let top = -Infinity;
    for (const {a, b, c} of this.bins[row * binsPerAxis + col]) {
      const area = cross(a, b, c.x, c.z);
      if (Math.abs(area) < 1e-15) continue;
      const u = cross(b, c, x, z) / area, v = cross(c, a, x, z) / area, w = 1 - u - v;
      if (u >= -1e-9 && v >= -1e-9 && w >= -1e-9) top = Math.max(top, u*a.y + v*b.y + w*c.y);
    }
    return top;
  }
}
