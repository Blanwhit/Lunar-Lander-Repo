import {
  AdditiveBlending, BackSide, BufferGeometry, CylinderGeometry, DirectionalLight, Float32BufferAttribute, CanvasTexture, DataTexture, EquirectangularReflectionMapping, Group,
  MathUtils, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, Points, PointsMaterial,
  Quaternion, SphereGeometry, ShaderMaterial, DoubleSide, TextureLoader, SRGBColorSpace, Texture, Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { centreHeight, padRadius, LanderDynamics, LandingBed } from './landerDynamics';
import { LunarObserver } from './lunarObserver';
import { createMissionCabin } from './missionCabin';

export const missionViews = ['Outside','Cockpit','Surface'] as const;
export type MissionView = typeof missionViews[number];
const base = import.meta.env.BASE_URL + 'mission/';
let models: Promise<Group[]> | undefined;
export function preloadMission() {
  return models ??= Promise.all(['saturn-v','csm','lander'].map(async name =>
    (await new GLTFLoader().loadAsync(base+name+'.glb')).scene)).catch(error => {models=undefined;throw error;});
}
const departureEnd=3.6, transferEnd=7.2;

const contactStep=1/120;

export class LandingMission {
  readonly group=new Group();
  readonly intro=new Group();
  readonly cabin=createMissionCabin();
  readonly rocket:Object3D;
  readonly csm:Object3D;
  readonly lander:Object3D;
  private stage?:Object3D;
  private stageRest=new Vector3();
  private transferLander:Object3D;
  private moon:Mesh<SphereGeometry,MeshStandardMaterial>;
  private environment:DataTexture;
  private surfaces=new Map<MeshStandardMaterial,MeshStandardMaterial>();
  private earthPhoto:Texture;
  private earth:Mesh<SphereGeometry,MeshStandardMaterial>;
  private atmosphere:Mesh<SphereGeometry,MeshBasicMaterial>;
  private engines=new Group();
  private plumeMaterial=new ShaderMaterial({
    transparent:true,depthWrite:false,side:DoubleSide,blending:AdditiveBlending,uniforms:{clock:{value:0}},
    vertexShader:`varying vec2 st;void main(){st=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`varying vec2 st;uniform float clock;void main(){
      float travel=1.-st.y;float swirl=sin(st.x*50.+travel*11.-clock*20.)*.5+.5;
      float strength=(1.-smoothstep(.22,1.,travel))*(.45+.55*swirl);
      vec3 tint=mix(vec3(1.,.88,.56),vec3(1.,.23,.045),smoothstep(.05,.65,travel));
      gl_FragColor=vec4(tint,strength*.73);
    }`,
  });
  private dustGeometry=new BufferGeometry();
  private dustMaterial=new PointsMaterial({color:0xb3aaa0,size:.075,transparent:true,opacity:.57,depthWrite:false});
  private dust=new Points(this.dustGeometry,this.dustMaterial);
  private grains=new Float32Array(220*3);
  private grainDir=new Float32Array(220*2);
  private dustFade=1;
  readonly focus=new Vector3();
  readonly eye=new Vector3();
  readonly viewRotation=new Quaternion();
  private destination=new Vector3();
  private bed!:LandingBed;
  private dynamics!:LanderDynamics;
  private time=0;
  private accumulator=0;
  private off=false;
  private phase='Earth departure';
  private lastPosition=new Vector3();
  readonly observer = new LunarObserver();
  height=0;
  speed=0;
  view:MissionView='Outside';
  constructor(assets:Group[],private sun:Vector3,earthMap:Texture|undefined, private floor:(x:number,z:number)=>number,
    private surface:(x:number,z:number)=>number, private originElevation:()=>number) {
    [this.rocket,this.csm,this.lander]=assets.map(asset=>asset.clone(true));
    this.environment=this.reflections();
    this.lander.traverse(node=>{
      if(!(node instanceof Mesh) || !(node.material instanceof MeshStandardMaterial))return;
      const source=node.material;
      let surface=this.surfaces.get(source);
      if(!surface){surface=source.clone();surface.envMap=this.environment;this.surfaces.set(source,surface);}
      node.material=surface;
    });
    this.transferLander=this.lander.clone(true);this.transferLander.rotation.z=Math.PI;
    this.csm.add(this.transferLander);
    const moonMap=new TextureLoader().load(import.meta.env.BASE_URL+'lunar-soil/global-albedo.jpg');
    moonMap.colorSpace=SRGBColorSpace;
    this.moon=new Mesh(new SphereGeometry(1,72,40),new MeshStandardMaterial({map:moonMap,roughness:1}));
    this.moon.rotation.y=1.5;
    this.stage=this.rocket.getObjectByName('S_IC');
    if(this.stage)this.stageRest.copy(this.stage.position);
    this.lander.traverse(o=>{if(o instanceof Mesh){o.castShadow=true;o.receiveShadow=true;}});
    this.earth=new Mesh(new SphereGeometry(1,96,64),new MeshStandardMaterial({map:earthMap ?? null,roughness:1}));
    this.earthPhoto=new TextureLoader().load(base+'earth.webp',tex=>{this.earth.material.map=tex;this.earth.material.needsUpdate=true;});
    this.earthPhoto.colorSpace=SRGBColorSpace;this.earthPhoto.anisotropy=4;
    this.earth.rotation.y=1.35;
    this.atmosphere=new Mesh(new SphereGeometry(1,96,64),new MeshBasicMaterial({color:0x548dc3,side:BackSide,transparent:true,opacity:.27,depthWrite:false}));
    this.earth.add(this.atmosphere);this.atmosphere.scale.setScalar(1.003);
    const plume=new CylinderGeometry(1,2.25,1,32,1,true);
    plume.translate(0,-.5,0);
    // Exhaust expands away from each F-1 bell.
    for(const [x,z] of [[0,0],[-3.94,-2.85],[-2.84,3.88],[2.83,-3.88],[3.90,2.83]]){
      const nozzle=new Mesh(plume,this.plumeMaterial);
      nozzle.position.set(x,0,z);nozzle.scale.set(1.74,16,1.74);
      this.engines.add(nozzle);
    }
    this.rocket.add(this.engines);
    const key=new DirectionalLight(0xfff2db,2.4);key.position.set(-3,5,4);
    this.intro.add(this.earth,this.moon,this.rocket,this.csm,key);
    this.group.add(this.intro,this.lander,this.cabin.group,this.dust);
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
    this.rocket.rotation.set(0,0,-.15);this.rocket.position.set(x,14000,z);
    if(this.stage)this.stage.position.copy(this.stageRest);
    this.lander.quaternion.identity();this.lander.position.copy(this.destination);
    this.observer.reset(x,z,this.originElevation(),this.floor);
    this.advance(0);
  }
  get inSpace(){return this.time<transferEnd;}
  get flightVisible(){return this.inSpace && this.view==='Cockpit';}
  get status(){return this.phase;}
  get atRest(){return this.dynamics.settled;}
  get landed(){return this.dynamics.contacted;}
  get telemetry(){
    return this.inSpace ? this.phase : this.phase+' · '+Math.max(0,this.height).toFixed(this.height<10?1:0)+' m · '+this.speed.toFixed(1)+' m/s';
  }
  advance(dt:number){
    this.time+=dt;
    const t=this.time, p=this.destination;
    this.intro.visible=this.flightVisible;
    this.rocket.visible=t<departureEnd;this.csm.visible=!this.rocket.visible;
    this.lander.visible=!this.inSpace && this.view!=='Cockpit';
    this.cabin.group.visible=this.view==='Cockpit';
    if(this.inSpace){
      const transfer=t>=departureEnd;
      const rocketTime=Math.min(t,departureEnd);
      this.rocket.position.set(p.x+rocketTime*rocketTime*1.4,14000+rocketTime*17,p.z);
      this.rocket.rotation.z=-.15-rocketTime*.07;
      if(this.stage && t>2.5)this.stage.position.y=this.stageRest.y-14*(t-2.5)**2;
      this.engines.visible=t<2.5;this.plumeMaterial.uniforms.clock.value=t;
      this.engines.scale.y=.83+.15*Math.sin(t*43);
      this.csm.position.set(p.x+17+(t-departureEnd)*2.5,14048,p.z);
      this.csm.rotation.set(.85,.2,t*.08-.9);
      const arrival=MathUtils.smootherstep(t,5.6,transferEnd);
      this.transferLander.position.set(0,17.9+arrival*9,0);
      this.moon.visible=transfer;
      this.moon.scale.setScalar(18+arrival*260);
      this.moon.position.set(this.csm.position.x+85,this.csm.position.y-45-arrival*130,this.csm.position.z-440);

      const vehicle=transfer?this.csm:this.rocket;
      this.focus.set(0,transfer?9:50,0).applyQuaternion(vehicle.quaternion).add(vehicle.position);
      const progress=MathUtils.smootherstep(t,departureEnd,transferEnd);
      const radius=transfer?MathUtils.lerp(380,62,progress):1150;
      this.earth.scale.setScalar(radius);
      this.earth.position.set(this.focus.x-radius*.42,this.focus.y-radius*.64,this.focus.z-(transfer?620:1080));
      this.earth.rotation.y=1.35+t*.021;
      this.phase=arrival>.3?'Lunar arrival':transfer?'Translunar coast':'Earth departure';
      this.height=0;this.speed=0;
      this.cabin.setVehicle('command');
    }else{
      this.cabin.setVehicle('lunar');
      let freeDt=dt;
      if(!this.off){
        const s=Math.max(0,t-transferEnd);
        const rem=Math.max(0,1-s/22);
        // Braking removes horizontal velocity before the near-vertical final descent.
        const h=115*rem**3+.63*(22-s)+.05;
        const trail=135*rem**3;
        const x=p.x+.18*trail+.12*(22-s),z=p.z-trail;
        const terrain=this.floor(x,z);
        this.lander.position.set(x,Math.max(p.y,terrain)+h,z);
        this.lander.rotation.set(-.38*rem,0,.015*rem);
        this.height=this.lander.position.y-this.floor(this.lander.position.x,this.lander.position.z);
        this.speed=.63+345/22*rem**2;
        if(this.height<16 && this.probeContact()){
          this.off=true;freeDt=0;const body=this.dynamics;
          body.rotation.copy(this.lander.quaternion);
          body.position.set(0,centreHeight,0).applyQuaternion(body.rotation).add(this.lander.position);
          body.velocity.set(-.12-.18*405/22*rem**2,-this.speed,405/22*rem**2);
        }
      }
      if(this.off){
        const body=this.dynamics;
        this.accumulator+=freeDt;
        while(this.accumulator>=contactStep){body.step(contactStep);this.accumulator-=contactStep;}
        this.lander.quaternion.copy(body.rotation);
        this.lander.position.set(0,-centreHeight,0).applyQuaternion(body.rotation).add(body.position);
        this.speed=body.velocity.length();this.height=Math.max(0,this.lander.position.y-this.floor(this.lander.position.x,this.lander.position.z));
      }
      this.phase=this.off?(this.dynamics.tilt>Math.PI/4?'Lander tipped':this.dynamics.settled?'At rest':this.landed?'Touchdown':'Engine cutoff'):
        this.height<12?'Final descent':'Powered descent';
      this.focus.set(0,3.25,0).applyQuaternion(this.lander.quaternion).add(this.lander.position);
    }
    this.updateDust(dt);
    this.cabin.update(this.height,this.speed,this.landed);
    this.frameCamera();
  }
  private probeContact(){
    // The forward (ladder) pad has no probe. A ridge under the nozzle can strike first.
    for(const [x,y,z] of [[padRadius,-.6,0],[-padRadius,-.6,0],[0,-.6,padRadius],[0,0,-padRadius],[0,.38,0]]){
      const point=this.lastPosition.set(x,y,z).applyQuaternion(this.lander.quaternion).add(this.lander.position);
      if(point.y<=this.bed.at(point.x,point.z))return true;
    }
    return false;
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
  private frameCamera(){
    if(this.view==='Cockpit'){
      if(this.inSpace){
        const launch=this.rocket.visible;
        const vehicle=launch?this.rocket:this.csm;
        this.eye.set(0,launch?98:9,-.48).applyQuaternion(vehicle.quaternion).add(vehicle.position);
        this.viewRotation.copy(vehicle.quaternion);
      }else{
        this.eye.set(-.55,5.45,-1.4).applyQuaternion(this.lander.quaternion).add(this.lander.position);
        this.viewRotation.copy(this.lander.quaternion);
      }
      this.cabin.group.position.copy(this.eye);this.cabin.group.quaternion.copy(this.viewRotation);
      this.rocket.visible=false;this.csm.visible=false;
    }else if(this.view==='Outside'){
      this.eye.copy(this.observer.eye);
      this.viewRotation.copy(this.observer.rotation);
    }
  }
  dispose(){
    // GLTF geometry and textures belong to the shared model cache.
    this.cabin.dispose();this.earth.geometry.dispose();this.earth.material.dispose();this.earthPhoto.dispose();
    this.moon.geometry.dispose();this.moon.material.map?.dispose();this.moon.material.dispose();
    this.environment.dispose();for(const m of this.surfaces.values())m.dispose();
    this.atmosphere.geometry.dispose();this.atmosphere.material.dispose();
    (this.engines.children[0] as Mesh).geometry.dispose();this.plumeMaterial.dispose();
    this.dustGeometry.dispose();this.dustMaterial.map?.dispose();this.dustMaterial.dispose();this.group.removeFromParent();
  }
}
