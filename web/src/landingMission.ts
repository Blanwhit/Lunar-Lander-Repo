import {
  BufferGeometry, CanvasTexture, DataTexture, EquirectangularReflectionMapping, Float32BufferAttribute,
  Group, MathUtils, Mesh, MeshStandardMaterial, Points, PointsMaterial, Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { centreHeight, padRadius, LanderDynamics, LandingBed } from './landerDynamics';
import { LunarObserver } from './lunarObserver';

export const missionViews = ['Outside','Surface'] as const;
export type MissionView = typeof missionViews[number];
const base = import.meta.env.BASE_URL + 'mission/';
let landerAsset: Promise<Group> | undefined;
export function preloadMission() {
  return landerAsset ??= new GLTFLoader().loadAsync(base+'lander.glb').then(asset => asset.scene)
    .catch(error => { landerAsset=undefined; throw error; });
}
const departureEnd=3.6, transferEnd=7.2, descentDuration=22;

const contactStep=1/120;
const solidContacts=[
  [padRadius,0,0],[-padRadius,0,0],[0,0,padRadius],[0,0,-padRadius],[0,.38,0],
].map(([x,y,z])=>new Vector3(x,y,z));

interface SensingProbe {
  weights: number[];
  foldedIndex: number;
  extended: Vector3;
  folded: Vector3;
}

export class LandingMission {
  readonly group=new Group();
  readonly lander:Group;
  private environment:DataTexture;
  private surfaces=new Map<MeshStandardMaterial,MeshStandardMaterial>();
  private dustGeometry=new BufferGeometry();
  private dustMaterial=new PointsMaterial({color:0xb3aaa0,size:.075,transparent:true,opacity:.57,depthWrite:false});
  private dust=new Points(this.dustGeometry,this.dustMaterial);
  private grains=new Float32Array(220*3);
  private grainDir=new Float32Array(220*2);
  private dustFade=1;
  readonly focus=new Vector3();
  private destination=new Vector3();
  private bed!:LandingBed;
  private dynamics!:LanderDynamics;
  private time=0;
  private accumulator=0;
  private off=false;
  private phase='Earth departure';
  private worldPoint=new Vector3();
  private probeTip=new Vector3();
  private probes:SensingProbe[]=[];
  private firstProbeContact?:number;
  readonly observer = new LunarObserver();
  height=0;
  speed=0;
  view:MissionView='Outside';
  constructor(asset:Group,private sun:Vector3, private floor:(x:number,z:number)=>number,
    private surface:(x:number,z:number)=>number, private originElevation:()=>number) {
    this.lander=asset.clone(true);
    this.lander.updateMatrixWorld(true);
    this.environment=this.reflections();
    this.lander.traverse(node=>{
      if(!(node instanceof Mesh))return;
      node.castShadow=node.receiveShadow=true;
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
  restart(x:number,z:number){
    for(const m of this.surfaces.values())m.envMapIntensity=this.sun.y>0?1.1:.36;
    this.destination.set(x,this.floor(x,z),z);
    this.bed=new LandingBed(this.surface);this.dynamics=new LanderDynamics(this.bed);
    this.group.visible=true;this.off=false;this.time=0;this.accumulator=0;this.dustFade=1;
    this.firstProbeContact=undefined;
    for(const probe of this.probes)probe.weights[probe.foldedIndex]=0;
    this.lander.quaternion.identity();this.lander.position.copy(this.destination);
    this.observer.reset(x,z,this.originElevation(),this.floor);
    this.advance(0);
  }
  get inSpace(){return this.time<transferEnd;}
  enterSurfaceVR() {
    // Start a fresh headset landing with the final approach already visible.
    // Entering a mission later preserves its current descent or resting pose.
    if(this.inSpace)this.time=transferEnd+descentDuration-10;
    this.advance(0);
  }
  get status(){return this.phase;}
  get atRest(){return this.dynamics.settled;}
  get landed(){return this.dynamics.contacted;}
  get telemetry(){
    return this.inSpace ? this.phase : this.phase+' · '+Math.max(0,this.height).toFixed(this.height<10?1:0)+' m · '+this.speed.toFixed(1)+' m/s';
  }
  advance(dt:number){
    this.time+=dt;
    const t=this.time, p=this.destination;
    this.lander.visible=!this.inSpace;
    if(this.inSpace){
      this.phase=t<departureEnd?'Earth departure':t<6?'Translunar coast':'Lunar arrival';
      this.height=0;this.speed=0;
    }else{
      let freeDt=dt;
      if(!this.off){
        const s=Math.max(0,t-transferEnd);
        const rem=Math.max(0,1-s/descentDuration);
        // Braking removes horizontal velocity before the near-vertical final descent.
        const h=115*rem**3+.63*(descentDuration-s)+.05;
        const trail=135*rem**3;
        const x=p.x+.18*trail+.12*(descentDuration-s),z=p.z+trail;
        const terrain=this.floor(x,z);
        this.lander.position.set(x,Math.max(p.y,terrain)+h,z);
        this.lander.rotation.set(.38*rem,0,.015*rem);
        this.height=this.lander.position.y-this.floor(this.lander.position.x,this.lander.position.z);
        this.speed=.63+345/descentDuration*rem**2;
        if(this.height<16 && this.shouldCutOff()){
          this.off=true;freeDt=0;const body=this.dynamics;
          body.rotation.copy(this.lander.quaternion);
          body.position.set(0,centreHeight,0).applyQuaternion(body.rotation).add(this.lander.position);
          body.velocity.set(-.12-.18*405/descentDuration*rem**2,-this.speed,-405/descentDuration*rem**2);
        }
      }
      if(this.off && !this.dynamics.settled){
        const body=this.dynamics;
        this.accumulator+=freeDt;
        while(this.accumulator>=contactStep){body.step(contactStep);this.accumulator-=contactStep;}
        this.lander.quaternion.copy(body.rotation);
        this.lander.position.set(0,-centreHeight,0).applyQuaternion(body.rotation).add(body.position);
        this.foldProbes();
        this.speed=body.velocity.length();this.height=Math.max(0,this.lander.position.y-this.floor(this.lander.position.x,this.lander.position.z));
      }
      this.phase=this.off?(this.dynamics.tilt>Math.PI/4?'Lander tipped':this.dynamics.settled?'At rest':this.landed?'Touchdown':'Engine cutoff'):
        this.height<12?'Final descent':'Powered descent';
      this.focus.set(0,3.25,0).applyQuaternion(this.lander.quaternion).add(this.lander.position);
    }
    this.updateDust(dt);
  }
  private clearance(local:Vector3){
    const p=this.worldPoint.copy(local).applyQuaternion(this.lander.quaternion).add(this.lander.position);
    return p.y-this.bed.at(p.x,p.z);
  }
  private foldProbes(){
    for(const probe of this.probes){
      let low=probe.weights[probe.foldedIndex], high=1;
      if(low>=1)continue;
      const tip=this.probeTip.lerpVectors(probe.extended,probe.folded,low);
      if(this.clearance(tip)>0)continue;
      this.firstProbeContact??=this.time;
      // Landed probes stay bent. Resolve each tip against the soil under that leg.
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
  private shouldCutOff(){
    this.foldProbes();
    // The Apollo press kit allows one second for the crew to respond to the contact light.
    if(this.firstProbeContact!==undefined && this.time-this.firstProbeContact>=1)return true;
    return solidContacts.some(local=>this.clearance(local)<=0);
  }
  private updateDust(dt:number){
    if(this.off)this.dustFade=Math.max(0,this.dustFade-dt*1.8);
    const intensity=(1-MathUtils.smoothstep(this.height,1,17))*this.dustFade;
    this.dust.visible=!this.inSpace && intensity>.01;
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
  dispose(){
    // The shared GLTF owns the geometry and maps. Each mission owns its reflective materials.
    this.environment.dispose();for(const m of this.surfaces.values())m.dispose();
    this.dustGeometry.dispose();this.dustMaterial.map?.dispose();this.dustMaterial.dispose();this.group.removeFromParent();
  }
}
