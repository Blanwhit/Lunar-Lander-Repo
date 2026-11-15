import { Group, Mesh, Quaternion, Vector3, type MeshStandardMaterial, type BufferGeometry } from 'three';
import { lunarGravity } from './walkGait';
import { specimenInfo } from './specimenInfo';
import type { WalkGround } from './walkGround';

interface SampleBed {
  floorAt(x: number, z: number): number;
  impact(x: number, z: number, diameter: number, normalSpeed: number, slide: Vector3): void;
}

interface Stone {
  mesh: Mesh<BufferGeometry, MeshStandardMaterial>;
  key: string;
  diameter: number;
  velocity: Vector3;
  spin: Vector3;
  // Decimated scan vertices in scaled object coordinates, for resting on the lowest face.
  hull: Vector3[];
  resting: boolean;
  inContact: boolean;
}

export class HandSamples {
  readonly group = new Group();
  private readonly stones: Stone[] = [];
  private held?: Stone;
  lastKey?: string;
  private pressed = false;
  private tracked = false;
  private readonly offset = new Vector3();
  private readonly relative = new Quaternion();
  private readonly previous = new Vector3();
  private readonly previousQ = new Quaternion();
  private readonly linear = new Vector3();
  private readonly angular = new Vector3();
  private readonly v = new Vector3();
  private readonly q = new Quaternion();
  private readonly axis = new Vector3();
  private readonly up = new Vector3();
  private readonly contact = new Vector3();
  private readonly slide = new Vector3();

  get inspection() { return this.lastKey ? specimenInfo[this.lastKey] : undefined; }

  private pick(ground: WalkGround, hand: Vector3, rotation: Quaternion) {
    let closest: Stone | undefined, gap = .105;
    for (const stone of this.stones) {
      const d = hand.distanceTo(stone.mesh.position) - stone.diameter*.4;
      if (d < gap) { closest = stone; gap = d; }
    }
    if (!closest) {
      const item = ground.takeStone(hand);
      if (!item) return;
      const { sample, diameter } = item;
      // The loose scan has its own model matrix; its photographed material shares the scan textures.
      const mesh = new Mesh(sample.near.geometry, sample.near.material.clone());
      mesh.castShadow = mesh.receiveShadow = true;
      item.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
      const p = sample.far.geometry.getAttribute('position');
      const hull = Array.from({length:p.count}, (_,i) => new Vector3().fromBufferAttribute(p,i).multiply(mesh.scale));
      closest = { mesh, diameter, key: sample.key, velocity: new Vector3(), spin: new Vector3(), hull, resting: false, inContact: false };
      this.group.add(mesh); this.stones.push(closest);
    }
    this.held = closest;
    closest.resting = false;
    closest.inContact = false;
    this.lastKey = closest.key;
    const inverse = this.q.copy(rotation).invert();
    this.offset.copy(closest.mesh.position).sub(hand).applyQuaternion(inverse);
    this.relative.multiplyQuaternions(inverse, closest.mesh.quaternion);
  }

  hand(ground: WalkGround, hand: Vector3 | undefined, rotation: Quaternion, pressed: boolean, dt: number) {
    if (!hand) { this.release(); return; }
    if (this.tracked && dt > 0) {
      const blend = -Math.expm1(-dt/.035);
      this.linear.lerp(this.v.copy(hand).sub(this.previous).multiplyScalar(1/dt).clampLength(0,12),blend);
      this.q.copy(this.previousQ).invert().premultiply(rotation).normalize();
      if (this.q.w < 0) this.q.set(-this.q.x,-this.q.y,-this.q.z,-this.q.w);
      const angle = 2*Math.acos(Math.min(1,this.q.w));
      this.axis.set(this.q.x,this.q.y,this.q.z).normalize().multiplyScalar(Math.min(20,angle/dt));
      this.angular.lerp(this.axis,blend);
    }
    this.previous.copy(hand); this.previousQ.copy(rotation); this.tracked = true;
    if (pressed && !this.pressed) this.pick(ground, hand, rotation);
    if (this.held) {
      const s = this.held;
      s.mesh.position.copy(this.offset).applyQuaternion(rotation).add(hand);
      s.mesh.quaternion.multiplyQuaternions(rotation,this.relative);
      if (!pressed) {
        s.spin.copy(this.angular);
        s.velocity.crossVectors(s.spin,this.v.copy(s.mesh.position).sub(hand)).add(this.linear);
        this.held = undefined;
      }
    }
    this.pressed = pressed;
  }

  release() {
    if (this.held) { this.held.velocity.set(0,0,0); this.held.spin.set(0,0,0); this.held = undefined; }
    this.tracked = this.pressed = false;
    this.linear.set(0,0,0); this.angular.set(0,0,0);
  }

  advance(ground: WalkGround, dt: number, bed?: SampleBed) {
    const steps = Math.ceil(dt*120), h = dt/steps;
    const surface = (x:number,z:number) => ground.surfaceAt(x,z,0,bed?.floorAt(x,z));
    for (const s of this.stones) {
      if (s === this.held || s.resting) continue;
      for (let i=0;i<steps;i++) {
        const m = s.mesh, p = m.position, v = s.velocity;
        p.addScaledVector(v,h); p.y -= .5*lunarGravity*h*h; v.y -= lunarGravity*h;
        const spin = s.spin.length();
        if (spin > .001) m.quaternion.premultiply(this.q.setFromAxisAngle(this.axis.copy(s.spin).divideScalar(spin),spin*h));
        if (p.y - s.diameter > surface(p.x,p.z)) { s.inContact=false; continue; }
        const e = Math.max(.012,s.diameter*.18);
        const normal = this.v.set(surface(p.x-e,p.z)-surface(p.x+e,p.z),2*e,
          surface(p.x,p.z-e)-surface(p.x,p.z+e)).normalize();
        this.up.copy(normal).applyQuaternion(this.q.copy(m.quaternion).invert());
        let bottom = Infinity;
        for (const vertex of s.hull) {
          const height = vertex.dot(this.up);
          if (height < bottom) { bottom=height; this.contact.copy(vertex); }
        }
        const hit = this.contact.applyQuaternion(m.quaternion).add(p);
        const soilHeight = bed?.floorAt(hit.x,hit.z);
        let floor = ground.surfaceAt(hit.x,hit.z,0,soilHeight);
        if (hit.y >= floor) {
          if (hit.y-floor > .0005) s.inContact=false;
          continue;
        }
        const inward = v.dot(normal);
        if (!s.inContact && inward < -.09 && bed && floor === soilHeight) {
          this.slide.copy(v).addScaledVector(normal,-inward);
          bed.impact(hit.x,hit.z,s.diameter,-inward,this.slide);
          floor=surface(hit.x,hit.z);
        }
        s.inContact=true;
        p.y += floor-hit.y;
        if (inward < 0) {
          v.addScaledVector(normal,-inward);
          const slide = v.length();
          v.multiplyScalar(Math.max(0,1 - .68*Math.abs(inward)/(slide || 1)));
          if (inward < -.18) v.addScaledVector(normal,-.24*inward);
          s.spin.multiplyScalar(.65);
        }
        if (v.lengthSq()<.005 && normal.y>.75) {
          s.resting=true; v.set(0,0,0); s.spin.set(0,0,0); break;
        }
      }
    }
  }

  /** A new landing has its own tangent frame. Carry the held sample across the frame change. */
  rebase() {
    for (let i=this.stones.length-1;i>=0;i--) {
      const s=this.stones[i];
      if (s===this.held) continue;
      this.group.remove(s.mesh); s.mesh.material.dispose(); this.stones.splice(i,1);
    }
    this.tracked=false; this.linear.set(0,0,0); this.angular.set(0,0,0);
  }
  dispose() { this.release(); this.rebase(); }
}
