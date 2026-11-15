// The landing shown when arriving at a site: the lunar module's last seconds of descent (a
// second of free fall, descent-engine ignition, a smooth vertical braking drop onto the pad,
// then the contact dynamics of landerDynamics.ts), watched by a camera that slowly orbits it.
// One second after touchdown the camera glides down to the astronaut standing nearby; walk.ts
// then hands control to the surface walk.
import {
  AdditiveBlending, CanvasTexture, BufferGeometry, CylinderGeometry, DataTexture, DoubleSide, EquirectangularReflectionMapping,
  Float32BufferAttribute, Group, MathUtils, Mesh, MeshStandardMaterial, Object3D, Points, PointsMaterial, Quaternion,
  ShaderMaterial, Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { centreHeight, padRadius, LanderDynamics, LandingBed } from './landerDynamics';

export type MissionView = 'Outside' | 'Surface';
const base = import.meta.env.BASE_URL + 'mission/';
let models: Promise<Group[]> | undefined;
export function preloadMission() {
  return models ??= Promise.all(['lander'].map(async name =>
    (await new GLTFLoader().loadAsync(base+name+'.glb')).scene)).catch(error => {models=undefined;throw error;});
}

const contactStep=1/120;
/** rigid points that stop the engine at once if they touch: footpads and the descent-engine bell */
const solidContacts=[
  [padRadius,0,0],[-padRadius,0,0],[0,0,padRadius],[0,0,-padRadius],[0,.38,0],
].map(([x,y,z])=>new Vector3(x,y,z));
/** crew response after the contact light: the Apollo 11 press kit's nominal second */
const CONTACT_RESPONSE_S=1;
/** a surface-sensing probe of the model: a "Folded" morph between its extended and folded tips */
interface SensingProbe {
  weights: number[];
  foldedIndex: number;
  extended: Vector3;
  folded: Vector3;
}
const G_MOON=1.62;
// Descent: FREE_FALL_S of free fall from V0 (engine off), then the descent engine brakes the
// lander over BRAKE_S, easing to TOUCHDOWN_SPEED as it reaches the ground (velocity follows
// 1 - smoothstep, so the deceleration builds up and dies away smoothly).
const FREE_FALL_S=1, BRAKE_S=5, V0=.5, TOUCHDOWN_SPEED=.6;
const V1=V0+G_MOON*FREE_FALL_S;
const BRAKE_H=BRAKE_S*(TOUCHDOWN_SPEED+(V1-TOUCHDOWN_SPEED)/2);
const START_H=BRAKE_H+V0*FREE_FALL_S+G_MOON*FREE_FALL_S**2/2;
/** nominal time of touchdown (the probes touch a little earlier) */
const DESCENT_S=FREE_FALL_S+BRAKE_S;
/** descent engine: ignition ramp and shutdown fade (s) */
const IGNITION_S=.35, SHUTDOWN_S=.15;
/** the camera keeps orbiting this long after touchdown, then glides to the astronaut over GLIDE_S */
const HOLD_S=1, GLIDE_S=2.2;
/** orbit camera: distance from the lander, elevation, angular speed (rad/s) */
const ORBIT_R=13, ORBIT_PITCH=.21, ORBIT_RATE=.2;
/** bearing (rad, from +z towards +x) at which the glide starts: close to the astronaut's side */
const GLIDE_BEARING=.75;
const up=new Vector3(0,1,0);

export class LandingMission {
  readonly group=new Group();
  readonly lander:Object3D;
  private environment:DataTexture;
  private surfaces=new Map<MeshStandardMaterial,MeshStandardMaterial>();
  private dustGeometry=new BufferGeometry();
  private dustMaterial=new PointsMaterial({color:0xb3aaa0,size:.075,transparent:true,opacity:.57,depthWrite:false});
  private dust=new Points(this.dustGeometry,this.dustMaterial);
  private grains=new Float32Array(220*3);
  private grainDir=new Float32Array(220*2);
  private dustFade=1;
  /** descent engine thrust 0..1 (drives the plume and the dust) */
  private throttle=0;
  private plume:Mesh<CylinderGeometry,ShaderMaterial>;
  /** what the camera looks at: the lander's centre */
  readonly focus=new Vector3();
  /** the camera for this frame (world position + orientation) */
  readonly eye=new Vector3();
  readonly viewRotation=new Quaternion();
  private destination=new Vector3();
  private bed!:LandingBed;
  private dynamics!:LanderDynamics;
  private time=0;
  private accumulator=0;
  private off=false;
  private touchdownAt=-1;
  private phase='Final descent';
  private worldPoint=new Vector3();
  private probeTip=new Vector3();
  private probes:SensingProbe[]=[];
  private firstProbeContact?:number;
  private bearing=0;
  private glideFrom={bearing:0,radius:0,height:0,rotation:new Quaternion()};
  private glideTo={eye:new Vector3(),rotation:new Quaternion()};
  height=0;
  speed=0;
  view:MissionView='Outside';
  constructor(assets:Group[],private sun:Vector3,private floor:(x:number,z:number)=>number,
    private surface:(x:number,z:number)=>number) {
    this.lander=assets[0].clone(true);
    this.lander.updateMatrixWorld(true);
    this.environment=this.reflections();
    this.lander.traverse(node=>{
      if(!(node instanceof Mesh))return;
      node.castShadow=node.receiveShadow=true;
      // the model's surface-sensing probes fold through a "Folded" morph target
      const index=node.morphTargetDictionary?.Folded;
      if(index!==undefined && node.morphTargetInfluences && node.userData.extendedTip && node.userData.foldedTip){
        this.probes.push({
          weights:node.morphTargetInfluences,foldedIndex:index,
          extended:new Vector3().fromArray(node.userData.extendedTip).applyMatrix4(node.matrixWorld),
          folded:new Vector3().fromArray(node.userData.foldedTip).applyMatrix4(node.matrixWorld),
        });
      }
      if(!(node.material instanceof MeshStandardMaterial))return;
      const source=node.material;
      let surface=this.surfaces.get(source);
      if(!surface){surface=source.clone();surface.envMap=this.environment;this.surfaces.set(source,surface);}
      node.material=surface;
    });
    // Descent-engine exhaust: a faint flickering cone below the bell (additive, so it reads
    // as a glow over the ground and vanishes when the engine stops).
    const cone=new CylinderGeometry(.42,1.5,3.2,28,1,true);cone.translate(0,-1.6,0);
    this.plume=new Mesh(cone,new ShaderMaterial({
      transparent:true,depthWrite:false,side:DoubleSide,blending:AdditiveBlending,
      uniforms:{clock:{value:0},throttle:{value:0}},
      vertexShader:`varying vec2 st;void main(){st=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader:`varying vec2 st;uniform float clock;uniform float throttle;void main(){
        float along=1.-st.y;float swirl=sin(st.x*44.+along*9.-clock*24.)*.5+.5;
        float strength=(1.-smoothstep(.1,1.,along))*(.55+.45*swirl)*throttle;
        vec3 tint=mix(vec3(1.,.93,.75),vec3(1.,.5,.2),smoothstep(.0,.7,along));
        gl_FragColor=vec4(tint,strength*.55);
      }`,
    }));
    this.plume.position.set(0,1.15,0);this.plume.frustumCulled=false;this.plume.visible=false;
    this.lander.add(this.plume);
    this.group.add(this.lander,this.dust);
    const grainImage=document.createElement('canvas');grainImage.width=grainImage.height=32;
    const brush=grainImage.getContext('2d')!,falloff=brush.createRadialGradient(16,16,0,16,16,16);
    falloff.addColorStop(0,'rgba(255,255,255,.8)');falloff.addColorStop(.35,'rgba(255,255,255,.32)');
    falloff.addColorStop(1,'rgba(255,255,255,0)');brush.fillStyle=falloff;brush.fillRect(0,0,32,32);
    this.dustMaterial.map=new CanvasTexture(grainImage);this.dustMaterial.size=.42;
    this.dust.frustumCulled=false;
    this.dustGeometry.setAttribute('position',new Float32BufferAttribute(this.grains,3));
    for(let i=0;i<220;i++){
      const angle=i*2.399963;this.grainDir[i*2]=Math.sin(angle);this.grainDir[i*2+1]=Math.cos(angle);
    }
    this.restart(0,0);
  }
  private reflections(){
    // Low-frequency lunar soil bounce and dark sky for the lander's reflective foil.
    const w=96,h=48,data=new Uint8Array(w*h*4);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const elevation=(y+.5)/h*Math.PI-Math.PI/2, azimuth=(x+.5)/w*Math.PI*2-Math.PI;
      const low=Math.max(0,-Math.sin(elevation)),horizon=Math.exp(-Math.abs(elevation)*6);
      const light=(.22+.42*low+.30*horizon)*(.80+.20*Math.cos(azimuth))*(elevation>0?.23:1);
      const i=(y*w+x)*4;data[i]=255*light;data[i+1]=249*light;data[i+2]=239*light;data[i+3]=255;
    }
    const tex=new DataTexture(data,w,h);tex.mapping=EquirectangularReflectionMapping;tex.needsUpdate=true;return tex;
  }
  /** start the descent onto (x, z) */
  restart(x:number,z:number){
    for(const m of this.surfaces.values())m.envMapIntensity=this.sun.y>0?1.1:.36;
    this.destination.set(x,this.floor(x,z),z);
    this.bed=new LandingBed(this.surface);this.dynamics=new LanderDynamics(this.bed);
    this.group.visible=true;this.off=false;this.time=0;this.accumulator=0;this.dustFade=1;this.touchdownAt=-1;this.throttle=0;
    this.firstProbeContact=undefined;
    for(const probe of this.probes)probe.weights[probe.foldedIndex]=0;
    this.lander.quaternion.identity();this.lander.position.copy(this.destination);
    // orbit so that the glide starts from GLIDE_BEARING if touchdown comes on schedule
    this.bearing=GLIDE_BEARING-ORBIT_RATE*(DESCENT_S+HOLD_S);
    this.view='Outside';this.advance(0);
  }
  get status(){return this.phase;}
  get atRest(){return this.dynamics.settled;}
  get landed(){return this.dynamics.contacted;}
  get telemetry(){
    return this.phase+' · '+Math.max(0,this.height).toFixed(this.height<10?1:0)+' m · '+this.speed.toFixed(1)+' m/s';
  }
  /**
   * Seconds since the glide to the astronaut started (0 before), so walk.ts knows when to
   * take over; the glide lasts GLIDE_S.
   */
  get glideProgress(){
    if(this.touchdownAt<0)return 0;
    return MathUtils.clamp((this.time-this.touchdownAt-HOLD_S)/GLIDE_S,0,1);
  }
  /**
   * Advance by dt. astronautEye / astronautRotation: where the glide ends (the walk's
   * first-person camera), only read once the glide starts.
   */
  advance(dt:number,astronautEye?:Vector3,astronautRotation?:Quaternion){
    this.time+=dt;
    const p=this.destination;
    let freeDt=dt;
    if(!this.off){
      const t=this.time;
      let h:number;
      if(t<FREE_FALL_S){
        // engine off: falling under lunar gravity
        h=START_H-V0*t-G_MOON*t*t/2;
        this.speed=V0+G_MOON*t;
      }else{
        // braking: v = vT + (v1 - vT)(1 - smoothstep(u)), h = what is left of its integral
        const tau=t-FREE_FALL_S,u=Math.min(1,tau/BRAKE_S);
        const fall=TOUCHDOWN_SPEED*tau+(V1-TOUCHDOWN_SPEED)*BRAKE_S*(u-u**3+u**4/2);
        h=BRAKE_H-fall;
        this.speed=TOUCHDOWN_SPEED+(V1-TOUCHDOWN_SPEED)*(1-u*u*(3-2*u));
      }
      this.lander.position.set(p.x,p.y+h,p.z);
      this.lander.quaternion.identity();
      this.height=this.lander.position.y-this.floor(p.x,p.z);
      if(this.shouldCutOff() || t>=DESCENT_S){
        this.off=true;freeDt=0;const body=this.dynamics;
        body.rotation.copy(this.lander.quaternion);
        body.position.set(0,centreHeight,0).applyQuaternion(body.rotation).add(this.lander.position);
        body.velocity.set(0,-this.speed,0);
      }
    }
    if(this.off){
      const body=this.dynamics;
      this.accumulator+=freeDt;
      while(this.accumulator>=contactStep){body.step(contactStep);this.accumulator-=contactStep;}
      this.lander.quaternion.copy(body.rotation);
      this.lander.position.set(0,-centreHeight,0).applyQuaternion(body.rotation).add(body.position);
      if(!body.settled)this.foldProbes();
      this.speed=body.velocity.length();this.height=Math.max(0,this.lander.position.y-this.floor(this.lander.position.x,this.lander.position.z));
      if(this.touchdownAt<0 && this.landed)this.touchdownAt=this.time;
    }
    // engine: ignites after the free fall (quick ramp with a startup flicker), cut at contact
    const burning=!this.off && this.time>=FREE_FALL_S;
    if(burning){
      const ramp=MathUtils.clamp((this.time-FREE_FALL_S)/IGNITION_S,0,1);
      this.throttle=ramp*(ramp<1?.75+.25*Math.sin(this.time*90):1);
    }else this.throttle=Math.max(0,this.throttle-dt/SHUTDOWN_S);
    this.plume.visible=this.throttle>.01;
    this.plume.material.uniforms.throttle.value=this.throttle;
    this.plume.material.uniforms.clock.value=this.time;
    this.plume.scale.set(1,.85+.15*Math.sin(this.time*37),1);
    this.phase=this.off?(this.dynamics.tilt>Math.PI/4?'Lander tipped':this.dynamics.settled?'At rest':this.landed?'Touchdown':'Engine cutoff')
      :this.time<FREE_FALL_S?'Free fall':this.time<FREE_FALL_S+IGNITION_S+.4?'Engine start'
      :this.firstProbeContact!==undefined?'Contact light':'Final descent';
    this.focus.set(0,3.25,0).applyQuaternion(this.lander.quaternion).add(this.lander.position);
    this.updateDust(dt);
    this.frameCamera(dt,astronautEye,astronautRotation);
  }
  /** height of a lander-local point above the soil under it */
  private clearance(local:Vector3){
    const p=this.worldPoint.copy(local).applyQuaternion(this.lander.quaternion).add(this.lander.position);
    return p.y-this.bed.at(p.x,p.z);
  }
  /** fold each probe that reaches the soil just enough to rest on it (they stay bent) */
  private foldProbes(){
    for(const probe of this.probes){
      let low=probe.weights[probe.foldedIndex], high=1;
      if(low>=1)continue;
      const tip=this.probeTip.lerpVectors(probe.extended,probe.folded,low);
      if(this.clearance(tip)>0)continue;
      this.firstProbeContact??=this.time;
      if(this.clearance(probe.folded)>0){
        for(let i=0;i<8;i++){
          const mid=(low+high)/2;
          if(this.clearance(this.probeTip.lerpVectors(probe.extended,probe.folded,mid))<0)low=mid;
          else high=mid;
        }
      }
      probe.weights[probe.foldedIndex]=high;
    }
  }
  /** engine cutoff: a second after the first probe touches, or at once if pads or bell touch */
  private shouldCutOff(){
    this.foldProbes();
    if(this.firstProbeContact!==undefined && this.time-this.firstProbeContact>=CONTACT_RESPONSE_S)return true;
    return solidContacts.some(local=>this.clearance(local)<=0);
  }
  private updateDust(dt:number){
    if(this.off)this.dustFade=Math.max(0,this.dustFade-dt*1.8);
    // the exhaust raises the dust: none before ignition, settling after cutoff
    const intensity=(1-MathUtils.smoothstep(this.height,1,17))*this.dustFade*Math.min(1,this.throttle*1.5+(this.off?1:0));
    this.dust.visible=intensity>.01;
    if(!this.dust.visible)return;
    const pos=this.dustGeometry.getAttribute('position');
    const x=this.lander.position.x,z=this.lander.position.z;
    const count=Math.ceil(220*intensity);this.dustGeometry.setDrawRange(0,count);
    for(let i=0;i<count;i++){
      const age=(this.time*(.8+(i%7)*.045)+i*.618)%1;
      const r=.65+age*(6+(i%11)*.65);
      const px=x+r*this.grainDir[2*i],pz=z+r*this.grainDir[2*i+1];
      pos.setXYZ(i,px,this.floor(px,pz)+.035+age*(1-age)*(.4+(i%5)*.08),pz);
    }
    pos.needsUpdate=true;this.dustMaterial.opacity=.5*intensity;
  }
  /** slow orbit around the lander; after touchdown + HOLD_S, a glide to the astronaut's eye */
  private frameCamera(dt:number,astronautEye?:Vector3,astronautRotation?:Quaternion){
    const g=this.glideProgress;
    if(g<=0 || !astronautEye || !astronautRotation){
      this.bearing+=ORBIT_RATE*dt;
      const radius=ORBIT_R*Math.cos(ORBIT_PITCH);
      this.eye.set(Math.sin(this.bearing)*radius,ORBIT_R*Math.sin(ORBIT_PITCH),Math.cos(this.bearing)*radius).add(this.focus);
      this.eye.y=Math.max(this.eye.y,this.floor(this.eye.x,this.eye.z)+.48);
      this.lookAt(this.focus,this.viewRotation);
      // remember where the glide starts (refreshed every frame until it does)
      this.glideFrom.bearing=this.bearing;this.glideFrom.radius=radius;
      this.glideFrom.height=this.eye.y;this.glideFrom.rotation.copy(this.viewRotation);
      return;
    }
    // the glide: around the lander (bearing / distance / height), not straight through it
    const e=MathUtils.smootherstep(g,0,1);
    const to=this.glideTo;
    to.eye.copy(astronautEye);to.rotation.copy(astronautRotation);
    const dx=to.eye.x-this.focus.x,dz=to.eye.z-this.focus.z;
    let toBearing=Math.atan2(dx,dz);
    const from=this.glideFrom;
    while(toBearing-from.bearing>Math.PI)toBearing-=2*Math.PI;
    while(toBearing-from.bearing<-Math.PI)toBearing+=2*Math.PI;
    const bearing=MathUtils.lerp(from.bearing,toBearing,e);
    const radius=MathUtils.lerp(from.radius,Math.hypot(dx,dz),e);
    this.eye.set(Math.sin(bearing)*radius,0,Math.cos(bearing)*radius).add(this.focus);
    this.eye.y=MathUtils.lerp(from.height,to.eye.y,e);
    if(g>=1)this.eye.copy(to.eye);
    this.viewRotation.slerpQuaternions(from.rotation,to.rotation,e);
  }
  private right=new Vector3(1,0,0);
  private cameraPitch=new Quaternion();
  private lookAt(target:Vector3,out:Quaternion){
    const dx=this.eye.x-target.x,dy=this.eye.y-target.y,dz=this.eye.z-target.z;
    out.setFromAxisAngle(up,Math.atan2(dx,dz)).multiply(
      this.cameraPitch.setFromAxisAngle(this.right,-Math.atan2(dy,Math.hypot(dx,dz))));
  }
  dispose(){
    // GLTF geometry and textures belong to the shared model cache.
    this.environment.dispose();for(const m of this.surfaces.values())m.dispose();
    this.plume.geometry.dispose();this.plume.material.dispose();
    this.dustGeometry.dispose();this.dustMaterial.map?.dispose();this.dustMaterial.dispose();this.group.removeFromParent();
  }
}
