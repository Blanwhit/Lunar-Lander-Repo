import { Mesh, MeshBasicMaterial, Ray, RingGeometry, Vector3 } from 'three';
import type { WalkGround } from './walkGround';

export class TerrainPointer {
  readonly ring = new Mesh(new RingGeometry(.77, 1, 32),
    new MeshBasicMaterial({color: 0xd9ebad, toneMapped: false}));
  private readonly towardsEye = new Vector3();
  private nextAim = 0;

  constructor() { this.hide(); }

  hide() {
    this.ring.visible = false;
    this.nextAim = 0;
  }

  aim(pressed: boolean, ray: Ray | undefined, eye: Vector3, ground: WalkGround, time: number) {
    if (!pressed || !ray) { this.hide(); return; }
    if (time < this.nextAim) return;
    this.nextAim = time + 85;
    const hit = ground.intersect(ray);
    this.ring.visible = !!hit;
    if (!hit) return;
    this.towardsEye.subVectors(eye, hit);
    const distance = this.towardsEye.length();
    this.ring.position.copy(hit).addScaledVector(this.towardsEye.normalize(), Math.max(.015, distance * .001));
    this.ring.lookAt(eye);
    this.ring.scale.setScalar(Math.max(.025, distance * .005));
  }

  dispose() {
    this.ring.geometry.dispose();
    this.ring.material.dispose();
  }
}
