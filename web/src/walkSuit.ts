import {
  Bone, BufferGeometry, Group, Matrix4, Quaternion, MathUtils, Mesh, MeshStandardMaterial, Skeleton, SkinnedMesh,
  Uint16BufferAttribute, Float32BufferAttribute, Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { WalkFeet, type BootPose } from './walkFeet';
import { restSole, WalkOutsole } from './walkOutsole';

const lowerDirection = new Vector3();
const rest = new Vector3(), direction = new Vector3(), bend = new Vector3(), joint = new Vector3();

class Limb {
  readonly upper = new Bone();
  readonly lower = new Bone();
  readonly endOffset: Vector3;
  constructor(readonly origin: Vector3, middle: Vector3, end: Vector3) {
    this.upper.position.copy(origin);
    this.lower.position.copy(middle).sub(origin);
    this.upper.add(this.lower);
    this.endOffset = end.clone().sub(middle);
  }

  aim(target: Vector3, bendTowards: Vector3) {
    direction.copy(target).sub(this.origin);
    const a = this.lower.position.length(), b = this.endOffset.length();
    const dist = MathUtils.clamp(direction.length(), Math.abs(a - b) + 0.001, a + b - 0.001);
    direction.normalize();
    const axis = (a*a + dist*dist - b*b) / (2*dist);
    bend.copy(bendTowards).addScaledVector(direction, -bendTowards.dot(direction)).normalize();
    joint.copy(direction).multiplyScalar(axis).addScaledVector(bend, Math.sqrt(Math.max(0, a*a - axis*axis)));
    this.upper.quaternion.setFromUnitVectors(rest.copy(this.lower.position).normalize(), lowerDirection.copy(joint).normalize());
    direction.multiplyScalar(dist).sub(joint).applyQuaternion(this.lower.quaternion.copy(this.upper.quaternion).invert()).normalize();
    this.lower.quaternion.setFromUnitVectors(rest.copy(this.endOffset).normalize(), direction);
  }
}

let suitBytes: Promise<ArrayBuffer> | undefined;

export class WalkSuit {
  readonly group = new Group();
  readonly outsoles: WalkOutsole[];
  private readonly hips = new Bone();
  private readonly torso = new Bone();
  private sprintLean = 0;
  private readonly legs: Limb[] = [];
  private readonly arms: Limb[] = [];
  private readonly skin: SkinnedMesh<BufferGeometry, MeshStandardMaterial>;
  private readonly target = new Vector3();
  private readonly pole = new Vector3();
  private readonly feet = new WalkFeet();
  private readonly ankles = [new Bone(), new Bone()];
  private readonly soleRest = [restSole(-1), restSole(1)];
  private readonly ankleTargets = [new Vector3(),new Vector3()];
  private readonly soleRotations = [new Quaternion(),new Quaternion()];
  private readonly basis = new Matrix4();
  private readonly inverse = new Quaternion();
  private standingEye = 0;
  private bodyYaw = NaN;
  private kneeDrop = 0;
  private kneeVelocity = 0;
  private hipShift = 0;
  private motion = 0;

  /** fetch the suit model once (prefetchable); each landing parses its own copy, since
   *  dispose() frees the parsed geometry and material */
  static preload(): Promise<ArrayBuffer> {
    return suitBytes ??= fetch(import.meta.env.BASE_URL + 'astronaut/eva-suit.glb')
      .then((response) => {
        if (!response.ok) throw new Error('Could not load the suit model');
        return response.arrayBuffer();
      })
      .catch((error) => { suitBytes = undefined; throw error; });
  }

  static async load() {
    const bytes = await WalkSuit.preload();
    const gltf = await new GLTFLoader().parseAsync(bytes.slice(0), import.meta.env.BASE_URL + 'astronaut/');
    const source = gltf.scene.getObjectByProperty('isMesh', true) as Mesh<BufferGeometry, MeshStandardMaterial>;
    return new WalkSuit(source);
  }

  private constructor(source: Mesh<BufferGeometry, MeshStandardMaterial>) {
    this.outsoles = [-1,1].map(side => new WalkOutsole(source.geometry,side));
    const bones = [this.hips];
    for (const side of [-1, 1]) {
      const leg = new Limb(new Vector3(side*.15,.91,.07), new Vector3(side*.16,.49,.10), new Vector3(side*.15,.12,.04));
      const arm = new Limb(new Vector3(side*.255,1.44,.07), new Vector3(side*.425,1.11,.03), new Vector3(side*.49,.83,.14));
      this.hips.add(leg.upper, arm.upper);
      this.legs.push(leg); this.arms.push(arm);
      bones.push(leg.upper, leg.lower, arm.upper, arm.lower);
    }
    for (let i=0; i<2; i++) {
      const ankle = this.ankles[i];
      ankle.position.copy(this.soleRest[i]).sub(this.legs[i].origin).sub(this.legs[i].lower.position);
      this.legs[i].lower.add(ankle);
      bones.push(ankle);
    }
    this.hips.add(this.torso);
    for (const arm of this.arms) this.torso.add(arm.upper);
    const torsoIndex = bones.push(this.torso) - 1;
    const g = source.geometry, p = g.getAttribute('position');
    const indices = [], weights = [];
    for (let i=0; i<p.count; i++) {
      const x=Math.abs(p.getX(i)), y=p.getY(i), side=p.getX(i)<0 ? 1 : 5;
      const arm = x > 0.31 && y > 0.69;
      const upper = side + (arm ? 2 : 0);
      const influence = arm ? MathUtils.smoothstep(x,.30,.385) : 1-MathUtils.smoothstep(y,.77,.98);
      const lower = 1-MathUtils.smoothstep(y, arm ? 1.02 : .41, arm ? 1.20 : .57);
      const boot = arm ? 0 : 1-MathUtils.smoothstep(y,.13,.24);
      indices.push(y > .91 ? torsoIndex : 0,upper,upper+1,side === 1 ? 9 : 10);
      weights.push(1-influence, influence*(1-lower), influence*lower*(1-boot), influence*lower*boot);
    }
    g.setAttribute('skinIndex', new Uint16BufferAttribute(indices,4));
    g.setAttribute('skinWeight', new Float32BufferAttribute(weights,4));
    this.skin = new SkinnedMesh(g,source.material);
    this.skin.add(this.hips);
    this.skin.bind(new Skeleton(bones));
    this.skin.frustumCulled = false;
    this.skin.receiveShadow = true;
    this.group.add(this.skin);
    this.group.visible = false;
  }

  resetFeet() {
    this.feet.reset();
    this.standingEye = 0;
    this.bodyYaw = NaN;
    this.kneeDrop=this.kneeVelocity=this.hipShift=this.sprintLean=0;
  }

  update(x:number, y:number, z:number, facing:Vector3, eye:number, dx:number, dz:number, dt:number,
         airborne:boolean, lift:number, bothFeet:boolean, floor:(x:number,z:number)=>number,
         grips: readonly (Vector3 | undefined)[], onSupport:(pose:BootPose, scale:number)=>void, impactSpeed:number,
         bedAt:(boot:BootPose,scale:number)=>number|null) {
    this.group.visible = true;
    // Size the suit once per tracking session. Crouching flexes the knees without resizing the soles.
    if (!this.standingEye) this.standingEye = MathUtils.clamp(eye,.68,2.21);
    const scale = MathUtils.clamp(this.standingEye/1.78,.38,1.24);
    const crouch = MathUtils.clamp(eye-this.standingEye,-.55*scale,.08*scale);
    this.group.scale.setScalar(scale);
    const yaw=Math.atan2(facing.x,facing.z);
    if (!Number.isFinite(this.bodyYaw)) this.bodyYaw=yaw;
    const travel = Math.hypot(dx,dz), speed=travel/Math.max(.001,dt);
    const forwardSpeed = (dx*Math.sin(yaw)+dz*Math.cos(yaw))/Math.max(.001,dt);
    this.sprintLean = MathUtils.damp(this.sprintLean,MathUtils.smoothstep(forwardSpeed,1.5,4.2),7,dt);
    const lean = .27*this.sprintLean;
    this.torso.rotation.x = lean;
    // Pivot the chest about the waist while the tracked head and planted boots keep their poses.
    this.torso.position.set(0,.91*(1-Math.cos(lean)),-.91*Math.sin(lean));
    this.motion=MathUtils.damp(this.motion,Math.min(1,speed/1.5),10,dt);
    const difference=Math.atan2(Math.sin(yaw-this.bodyYaw),Math.cos(yaw-this.bodyYaw));
    // The head can look over a shoulder before the pelvis needs to step around.
    const freeLook=.36*(1-this.motion);
    this.bodyYaw += (difference-MathUtils.clamp(difference,-freeLook,freeLook))*(-Math.expm1(-dt*9));
    this.group.rotation.y=this.bodyYaw;
    const sin=Math.sin(this.bodyYaw), cos=Math.cos(this.bodyYaw);
    this.group.position.set(x-sin*.44*scale,y+crouch,z-cos*.44*scale);
    this.feet.update(this.group.position,this.bodyYaw,scale,dx,dz,dt,airborne,lift,bothFeet,floor,impactSpeed,bedAt);
    const [right,left]=this.feet.boots;
    const strike=Math.max(right.contact?right.impactSpeed:0,left.contact?left.impactSpeed:0);
    this.kneeVelocity+=strike*.70;
    // Critically damp the absorption of touchdown. This moves the pelvis and leaves headset tracking intact.
    const w=10, q=this.kneeVelocity+w*this.kneeDrop, decay=Math.exp(-w*dt);
    this.kneeVelocity=(this.kneeVelocity-w*q*dt)*decay;
    this.kneeDrop=(this.kneeDrop+q*dt)*decay;
    const support=(Number(left.loadedFor>=0)-Number(right.loadedFor>=0))*.028*scale;
    this.hipShift=MathUtils.damp(this.hipShift,support,9,dt);
    this.group.position.x+=cos*this.hipShift; this.group.position.z-=sin*this.hipShift;
    this.group.position.y-=scale*(.048+Math.min(.16,this.kneeDrop)+.025*this.motion+.055*this.sprintLean);
    // Lower the pelvis when a planted ankle would otherwise pull the knee past full extension.
    let yieldAtHip=0;
    for(let i=0;i<2;i++) {
      const leg=this.legs[i],sole=this.feet.boots[i];
      const rotation=this.soleRotations[i].setFromRotationMatrix(this.basis.makeBasis(sole.across,sole.up,sole.along));
      const target=this.ankleTargets[i].copy(leg.origin).add(leg.lower.position).add(leg.endOffset)
        .sub(this.soleRest[i]).multiplyScalar(scale).applyQuaternion(rotation).add(sole.center);
      const hipX=this.group.position.x+scale*(cos*leg.origin.x+sin*leg.origin.z);
      const hipZ=this.group.position.z+scale*(cos*leg.origin.z-sin*leg.origin.x);
      const reach=(leg.lower.position.length()+leg.endOffset.length()-.002)*scale;
      const height=Math.sqrt(Math.max(0,reach*reach-(target.x-hipX)**2-(target.z-hipZ)**2));
      yieldAtHip=Math.max(yieldAtHip,this.group.position.y+leg.origin.y*scale-target.y-height);
    }
    this.group.position.y-=Math.min(.15*scale,yieldAtHip);
    this.group.updateMatrixWorld();
    for (let i=0; i<2; i++) {
      const side=i*2-1;      const pose = this.feet.boots[i], leg = this.legs[i], ankle = this.ankles[i];
      this.group.worldToLocal(this.target.copy(this.ankleTargets[i]));
      leg.aim(this.target,this.pole.set(0,0,1));
      // Resolve the rigid outsole in shin space, independent of knee flexion and IK reach.
      leg.lower.worldToLocal(ankle.position.copy(pose.center));
      leg.lower.getWorldQuaternion(this.inverse).invert();
      ankle.quaternion.multiplyQuaternions(this.inverse,this.soleRotations[i]);
      if (pose.loadedFor>=0) onSupport(pose,scale);
      // Model +Z faces forward, so its negative X arm is the wearer's right.
      const grip=grips[1-i];
      if (grip) this.torso.worldToLocal(this.target.copy(grip));
      else {
        const legLead=((pose.center.x-pose.home.x)*sin+(pose.center.z-pose.home.z)*cos)/scale;
        this.target.set(side*(.325+.032*this.motion),.84+.065*this.motion+.18*this.sprintLean,.14-(.50+.45*this.sprintLean)*legLead);
      }
      this.arms[i].aim(this.target,this.pole.set(side,.05,-.65));
    }
  }

  dispose() {
    this.skin.skeleton.dispose();
    this.skin.geometry.dispose();
    this.skin.material.map?.dispose();
    this.skin.material.normalMap?.dispose();
    this.skin.material.dispose();
  }
}
