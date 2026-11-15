import {
  Bone, BufferGeometry, Color, Group, LatheGeometry, Matrix4, Quaternion, MathUtils, Mesh, MeshPhysicalMaterial, MeshStandardMaterial,
  Skeleton, SkinnedMesh,
  Uint16BufferAttribute, Float32BufferAttribute, Vector2, Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { addSuitGear, type SuitGear } from './suitGear';
import { buildGlove, gloveParts } from './suitGlove';
import { WalkFeet, type BootPose } from './walkFeet';
import { restSole, WalkOutsole } from './walkOutsole';

// In the model the fingers point down and the thumb forward. In grip space they
// point forward (-Z) and up, respectively, with the palms facing each other.
const gloveToGrip = new Quaternion(0, Math.SQRT1_2, Math.SQRT1_2, 0);
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

/** The suit's outer layer as cloth: the model's maps on a physical material with a soft sheen
 *  (woven fabric scatters light at grazing angles) and a faint warm off-white, like the
 *  white Ortho-fabric of a real suit, instead of flat matte grey. */
function fabric(source: MeshStandardMaterial): MeshPhysicalMaterial {
  const m = new MeshPhysicalMaterial({
    map: source.map, normalMap: source.normalMap, normalScale: source.normalScale.clone(),
    aoMap: source.aoMap, roughnessMap: source.roughnessMap, vertexColors: source.vertexColors,
    color: source.color.clone().multiply(new Color(1.0, .985, .955)),
    roughness: Math.max(.82, source.roughness), metalness: 0,
    sheen: .55, sheenRoughness: .55, sheenColor: new Color(.92, .92, .9),
  });
  m.name = source.name;
  source.dispose();
  // markings and relief in the model's own frame (attribute bodyPos: rest position before the
  // legs were lengthened), so the edges stay crisp at any mesh density:
  //  * red commander stripes round both thighs, as on the lead EVA crew member's suit
  //  * convolutes: pleated bellows rings at the knees and elbows (the suit's flexible joints)
  //  * stitched seams down the outer and inner sides of the lower legs
  //  * grey lunar dust worked into the boots and shins, patchy and fading up the leg
  // The pleats and seams are a height field turned into a normal tilt (bump mapping), so they
  // catch the low Sun without adding vertices.
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', 'attribute vec3 bodyPos;\nvarying vec3 vBody;\n#include <common>')
      .replace('#include <begin_vertex>', 'vBody = bodyPos;\n#include <begin_vertex>');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `varying vec3 vBody;
#include <common>
float suitHash(vec3 p) { p = fract(p * .3183099 + .1); p *= 17.; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float suitNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
  return mix(mix(mix(suitHash(i), suitHash(i + vec3(1, 0, 0)), f.x), mix(suitHash(i + vec3(0, 1, 0)), suitHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(suitHash(i + vec3(0, 0, 1)), suitHash(i + vec3(1, 0, 1)), f.x), mix(suitHash(i + vec3(0, 1, 1)), suitHash(i + 1.), f.x), f.y), f.z);
}
// bellows profile: rounded ridges, sharp creases (0 in a crease, 1 on a ridge)
float suitPleat(float t, float period) { return sqrt(abs(sin(3.14159265 * t / period))); }
// height field h (metres) -> perturbed normal, from screen-space derivatives (Mikkelsen 2010)
vec3 suitBump(vec3 pos, vec3 n, float h, float faceDir) {
  vec3 sx = dFdx(pos), sy = dFdy(pos);
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return normalize(abs(det) * n - grad);
}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      normal = suitBump(-vViewPosition, normal, suitHeight, faceDirection);`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
      // dyed stripes and dust: no white sheen over them
      material.sheenColor *= (1. - .9 * suitStripe) * (1. - .6 * suitDust);`)
      .replace('#include <color_fragment>', `#include <color_fragment>
      float suitStripe = 0., suitHeight = 0., suitDust = 0.;
      {
        float ax = abs(vBody.x), y = vBody.y;
        float arm = step(.31, ax) * step(.69, y);
        float leg = (1. - arm) * step(.05, ax) * (1. - step(.70, y));
        float aa = fwidth(y) + .0015;
        float stripe = leg * smoothstep(.598 - aa, .598, y) * (1. - smoothstep(.652, .652 + aa, y));
        suitStripe = stripe;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.36, .025, .03), stripe);

        // round the leg: c from the leg's axis, a = 0 outside, pi/2 front, pi inside
        vec2 c = vec2(ax - .16, vBody.z - .085);
        float a = atan(c.y, c.x), r = length(c);
        float front = .5 + .5 * sin(a);

        // knee convolutes: seven rings, deepest in front, fading into the thigh and shin
        float knee = leg * smoothstep(.425, .45, y) * (1. - smoothstep(.53, .555, y));
        float kp = suitPleat(y - .425, .0185);
        suitHeight += knee * (.2 + .8 * front) * .0042 * kp;
        diffuseColor.rgb *= 1. - knee * (.2 + .6 * front) * .16 * (1. - kp);
        // elbow convolutes, across the arm's axis at the elbow
        vec3 e = vec3(ax, y, vBody.z) - vec3(.425, 1.11, .03);
        float t = dot(e, normalize(vec3(.19, -.97, .06)));
        float elbow = arm * smoothstep(.13, .09, length(e)) * (1. - smoothstep(.035, .055, abs(t)));
        float ep = suitPleat(t + .055, .016);
        suitHeight += elbow * .0032 * ep;
        diffuseColor.rgb *= 1. - elbow * .12 * (1. - ep);

        // side seams on the lower legs: a shallow groove with a row of stitches either side
        float seamRun = leg * smoothstep(.15, .18, y) * (1. - smoothstep(.405, .425, y));
        float d = min(abs(a), 3.14159265 - abs(a)) * r;
        suitHeight -= seamRun * .0012 * exp(-pow(d / .0024, 2.));
        float fine = 1. - smoothstep(.0015, .004, fwidth(y)); // stitches only where they resolve
        float stitch = seamRun * fine * exp(-pow((d - .0052) / .0009, 2.)) * step(.45, fract(y / .0065));
        diffuseColor.rgb *= 1. - .22 * stitch;

        // lunar dust: up the boots and shins with a ragged edge, patchy, and scuffed onto the knees
        float n1 = suitNoise(vBody * 9.), n2 = .6 * suitNoise(vBody * 23.) + .4 * suitNoise(vBody * 67.);
        float dust = (1. - arm) * (1. - smoothstep(.12 + .1 * n1, .3 + .12 * n1, y));
        dust += leg * .45 * front * exp(-pow((y - .48) / .045, 2.)) * smoothstep(.35, .75, n1);
        dust = clamp(dust, 0., 1.) * smoothstep(.15, .85, n2);
        suitDust = dust;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(.6, .58, .55), dust * .7);
      }`);
  };
  m.customProgramCacheKey = () => 'suit-fabric-markings-relief';
  return m;
}

/** Glove geometry in the suit model (metres, +x arm): the wrist is the narrowest slice of the
 *  sleeve, y ~ 0.88; everything below it is the glove. */
const WRIST = new Vector3(.487, .884, .152); // before the legs are lengthened (stretchY)
const GLOVE_TOP = .862, CUFF_TOP = .894; // glove fully on the hand bone below GLOVE_TOP, blended up to CUFF_TOP
/** the model's own gloves are small, thin-fingered and low-poly for its bulky sleeves: they are
 *  folded away into the sleeve and replaced by a pressurized EVA glove (suitGlove.ts) */
const isGlove = (x: number, y: number) => x > .31 && y > .69 && y < WRIST.y + .001;
/** where the old glove is folded to: just above the wrist, inside the ring, so the sleeve's open
 *  end closes in a short cone hidden by the ring and the new glove's gauntlet */
const FOLD_Y = WRIST.y + .008;
/** share of the palms-up roll taken by the forearm; the wrist turns the rest (like a real arm),
 *  so the sleeve is not wrung at the elbow */
const FOREARM_ROLL = .45;

/** Knee in the suit model: a helper bone there takes half the knee's bend, and the leg is
 *  blended thigh -> knee -> shin over two short bands instead of one long one, so a bent knee
 *  keeps its volume (like the suit's articulated knee joint) instead of crumpling. */
const KNEE_SHIN = [.37, .47] as const, KNEE_THIGH = [.51, .63] as const;
/** The model's legs are short for its bulky torso: stretch them between ankle and hip, and lift
 *  everything above (arms included) by the same amount. The suit is sized from the wearer's eye
 *  height, so the whole figure keeps its height and the legs gain a larger share of it. */
const LEG_STRETCH = 1.12, ANKLE_Y = .13, HIP_Y = .91;
const LIFT = (HIP_Y - ANKLE_Y) * (LEG_STRETCH - 1);
/** model eye height the suit is sized from (was 1.78 before the legs were lengthened) */
const MODEL_EYE = 1.78 + LIFT;
/** model y after lengthening the legs (arm vertices only move up) */
const stretchY = (y: number, arm: boolean) =>
  arm || y >= HIP_Y ? y + LIFT : y <= ANKLE_Y ? y : ANKLE_Y + (y - ANKLE_Y) * LEG_STRETCH;
/** baseline pelvis drop (fraction of the suit's height) that keeps the knees soft when standing */
const STANCE_DROP = .022;

/** EVA wrist-disconnect ring: a rounded metal band that bridges sleeve and glove */
function wristRingGeometry() {
  const r0 = .070, r1 = .083, h = .032, c = .006;
  const profile = [
    new Vector2(r0, -h / 2), new Vector2(r1 - c, -h / 2), new Vector2(r1, -h / 2 + c), new Vector2(r1, -h * .12),
    new Vector2(r1 - .004, 0), new Vector2(r1, h * .12), new Vector2(r1, h / 2 - c), new Vector2(r1 - c, h / 2),
    new Vector2(r0, h / 2),
  ];
  return new LatheGeometry(profile, 40);
}

export class WalkSuit {
  readonly group = new Group();
  readonly outsoles: WalkOutsole[];
  private readonly hips = new Bone();
  private readonly torso = new Bone();
  private sprintLean = 0;
  private readonly legs: Limb[] = [];
  private readonly arms: Limb[] = [];
  /** wrist bones: the gloves (below the sleeve cuffs) hang on these */
  private readonly hands = [new Bone(), new Bone()];
  /** knee helper bones: half the knee bend, carrying the kneecap region */
  private readonly knees = [new Bone(), new Bone()];
  private readonly rings: Mesh<LatheGeometry, MeshStandardMaterial>[] = [];
  /** helmet, backpack, hoses and flag (suitGear.ts) */
  private readonly gear: SuitGear;
  private readonly gloveParts = gloveParts();
  private readonly skin: SkinnedMesh<BufferGeometry, MeshStandardMaterial>;
  private readonly castNodes:(Bone | Group)[];
  private readonly target = new Vector3();
  private readonly raisedHand = new Vector3();
  private readonly forearmAxis = new Vector3();
  private readonly roll = new Quaternion();
  /**
   * 0..1: gloves raised in front of the chest with the forearms level and turned palms-up
   * (desktop arms only; tracked controllers take precedence)
   */
  handsRaised = 0;
  /** seconds driving a slight bob of the raised palms */
  handsClock = 0;
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
      const leg = new Limb(new Vector3(side*.15,stretchY(.91,false),.07), new Vector3(side*.16,stretchY(.49,false),.10),
        new Vector3(side*.15,.12,.04));
      const arm = new Limb(new Vector3(side*.255,1.44+LIFT,.07), new Vector3(side*.425,1.11+LIFT,.03), new Vector3(side*.49,.83+LIFT,.14));
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
    // wrists: one bone per glove, at the narrowest slice of the sleeve, with a metal ring around it
    const ringMaterial = new MeshStandardMaterial({ color: 0xc9ccd1, metalness: .35, roughness: .42 });
    const ringGeometry = wristRingGeometry();
    const handIndex: number[] = [];
    for (let i = 0; i < 2; i++) {
      const side = i * 2 - 1, arm = this.arms[i], hand = this.hands[i];
      const wrist = WRIST.clone().setX(side * WRIST.x).setY(WRIST.y + LIFT);
      hand.position.copy(wrist).sub(arm.origin).sub(arm.lower.position);
      arm.lower.add(hand);
      handIndex.push(bones.push(hand) - 1);
      const ring = new Mesh(ringGeometry, ringMaterial);
      // on the forearm, not the (scaled, rolling) wrist bone: the ring is round, so the wrist's
      // roll does not matter, and it keeps the sleeve's size
      ring.position.copy(hand.position);
      ring.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), arm.endOffset.clone().normalize());
      ring.scale.setScalar(1.05);
      ring.receiveShadow = true;
      arm.lower.add(ring);
      this.rings.push(ring);
      hand.add(buildGlove(side as 1 | -1, this.gloveParts));
    }
    const kneeIndex: number[] = [];
    for (let i = 0; i < 2; i++) {
      const leg = this.legs[i], knee = this.knees[i];
      knee.position.copy(leg.lower.position);
      leg.upper.add(knee);
      kneeIndex.push(bones.push(knee) - 1);
    }
    const g = source.geometry, p = g.getAttribute('position');
    const indices = [], weights = [];
    for (let i=0; i<p.count; i++) {
      const x=Math.abs(p.getX(i)), y=p.getY(i), side=p.getX(i)<0 ? 1 : 5;
      const arm = x > 0.31 && y > 0.69;
      const upper = side + (arm ? 2 : 0);
      const influence = arm ? MathUtils.smoothstep(x,.30,.385) : 1-MathUtils.smoothstep(y,.77,.98);
      const lower = 1-MathUtils.smoothstep(y, arm ? 1.02 : .41, arm ? 1.20 : .57);
      const boot = arm ? 0 : 1-MathUtils.smoothstep(y,.13,.24);
      if (arm) {
        // the glove follows the wrist bone; the cuff blends it into the forearm
        const glove = 1-MathUtils.smoothstep(y, GLOVE_TOP, CUFF_TOP);
        indices.push(y > .91 ? torsoIndex : 0,upper,upper+1,handIndex[side === 1 ? 0 : 1]);
        weights.push(1-influence, influence*(1-lower), influence*lower*(1-glove), influence*lower*glove);
        continue;
      }
      // leg: hips -> thigh -> knee helper -> shin -> boot (at most two neighbours overlap)
      const shinSide = MathUtils.smoothstep(y, KNEE_SHIN[0], KNEE_SHIN[1]);   // 0 on the shin
      const thighSide = MathUtils.smoothstep(y, KNEE_THIGH[0], KNEE_THIGH[1]); // 1 on the thigh
      const thigh = influence*thighSide, knee = influence*shinSide*(1-thighSide), shin = influence*(1-shinSide);
      const kneeBone = kneeIndex[side === 1 ? 0 : 1], ankleBone = side === 1 ? 9 : 10;
      if (y > .30) {
        indices.push(y > .91 ? torsoIndex : 0, upper, kneeBone, upper+1);
        weights.push(1-influence, thigh, knee, shin);
      } else {
        indices.push(0, upper, upper+1, ankleBone);
        weights.push(1-influence, thigh, shin*(1-boot), shin*boot);
      }
    }
    // rest positions before the legs are lengthened: the shader paints the markings from them
    g.setAttribute('bodyPos', p.clone());
    for (let i=0; i<p.count; i++) {
      const x=Math.abs(p.getX(i)), y=p.getY(i);
      if (isGlove(x, y)) {
        // collapse onto the wrist centre (inside the cuff): the old hand leaves no triangles or shadow
        p.setXYZ(i, Math.sign(p.getX(i))*WRIST.x, stretchY(FOLD_Y, true), WRIST.z);
        continue;
      }
      p.setY(i, stretchY(y, x > 0.31 && y > 0.69));
    }
    p.needsUpdate = true;
    g.computeBoundingBox(); g.computeBoundingSphere();
    g.setAttribute('skinIndex', new Uint16BufferAttribute(indices,4));
    g.setAttribute('skinWeight', new Float32BufferAttribute(weights,4));
    this.skin = new SkinnedMesh(g, fabric(source.material));
    this.skin.add(this.hips);
    this.skin.bind(new Skeleton(bones));
    this.castNodes=[this.group,...bones];
    this.skin.frustumCulled = false;
    this.skin.castShadow = this.skin.receiveShadow = true;
    this.group.add(this.skin);
    // the wearer's left arm is the model's +x one (arms[1])
    this.gear = addSuitGear(this.torso, { bone: this.arms[1].upper, origin: this.arms[1].origin }, LIFT);
    this.group.visible = false;
  }

  castPose():number[] {
    const pose=new Array<number>(this.castNodes.length*7+1);
    for(let i=0;i<this.castNodes.length;i++){
      this.castNodes[i].position.toArray(pose,i*7);
      this.castNodes[i].quaternion.toArray(pose,i*7+3);
    }
    pose[pose.length-1]=this.group.scale.x;
    return pose;
  }

  applyCastPose(pose:number[]) {
    const nodes=this.castNodes;
    if(pose.length!==nodes.length*7+1)return;
    for(let i=0;i<nodes.length;i++){
      nodes[i].position.fromArray(pose,i*7);
      nodes[i].quaternion.fromArray(pose,i*7+3).normalize();
    }
    this.group.scale.setScalar(pose[pose.length-1]);
    this.group.visible=true;
  }

  resetFeet() {
    this.feet.reset();
    this.standingEye = 0;
    this.bodyYaw = NaN;
    this.kneeDrop=this.kneeVelocity=this.hipShift=this.sprintLean=0;
  }

  update(x:number, y:number, z:number, facing:Vector3, eye:number, dx:number, dz:number, dt:number,
         airborne:boolean, lift:number, bothFeet:boolean, floor:(x:number,z:number)=>number,
         grips: readonly (Vector3 | undefined)[], gripRotations: readonly Quaternion[], onSupport:(pose:BootPose, scale:number)=>void, impactSpeed:number,
         bedAt:(boot:BootPose,scale:number)=>number|null) {
    this.group.visible = true;
    // Size the suit once per tracking session. Crouching flexes the knees without resizing the soles.
    if (!this.standingEye) this.standingEye = MathUtils.clamp(eye,.68,2.21);
    const scale = MathUtils.clamp(this.standingEye/MODEL_EYE,.38,1.24);
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
    const waist=HIP_Y+LIFT;
    this.torso.position.set(0,waist*(1-Math.cos(lean)),-waist*Math.sin(lean));
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
    this.group.position.y-=scale*(STANCE_DROP+Math.min(.16,this.kneeDrop)+.025*this.motion+.055*this.sprintLean);
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
      this.knees[i].quaternion.identity().slerp(leg.lower.quaternion, .5);
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
        // a pressurized suit holds the arms a little away from the body, gloves clear of the thigh pockets
        this.target.set(side*(.395+.03*this.motion),.84+.065*this.motion+.18*this.sprintLean,.14-(.50+.45*this.sprintLean)*legLead);
        if (this.handsRaised > 0) {
          // Elbows bent, forearms level and forward, gloves about waist height, bobbing slightly together.
          const bob = .012*Math.sin(this.handsClock*2.2);
          const raised = this.raisedHand.set(side*.24, 1.0+bob, .44);
          this.target.lerp(raised, MathUtils.smootherstep(this.handsRaised,0,1));
        }
      }
      this.arms[i].aim(this.target,this.pole.set(side,.05,-.65));
      const hand = this.hands[i];
      hand.quaternion.identity();
      if (grip) {
        this.arms[i].lower.getWorldQuaternion(this.inverse).invert();
        hand.quaternion.copy(this.inverse).multiply(gripRotations[1-i]).multiply(gloveToGrip);
      } else if (this.handsRaised > 0) {
        // Supinate until the palm (inward at rest) faces up: the forearm rolls part of the way
        // about its own axis and the wrist the rest, so neither the elbow nor the cuff is wrung.
        const arm = this.arms[i];
        const angle = -side*Math.PI/2*MathUtils.smootherstep(this.handsRaised,.2,1);
        this.forearmAxis.copy(arm.endOffset).normalize();
        arm.lower.quaternion.multiply(this.roll.setFromAxisAngle(this.forearmAxis, angle*FOREARM_ROLL));
        hand.quaternion.setFromAxisAngle(this.forearmAxis, angle*(1-FOREARM_ROLL));
      }
    }
  }

  dispose() {
    this.gear.dispose();
    for (const g of this.gloveParts.geometries) g.dispose();
    for (const m of this.gloveParts.materials) m.dispose();
    this.rings[0]?.geometry.dispose();
    this.rings[0]?.material.dispose();
    this.skin.skeleton.dispose();
    this.skin.geometry.dispose();
    this.skin.material.map?.dispose();
    this.skin.material.normalMap?.dispose();
    this.skin.material.dispose();
  }
}
